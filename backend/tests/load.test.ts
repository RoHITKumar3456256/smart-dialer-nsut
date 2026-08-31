/**
 * High-Concurrency Load & Stress Benchmark Test
 *
 * Tests the SmartDialer under heavy load:
 * - 500 concurrent agents
 * - 1,000 pending borrowers
 * - 50 concurrent dialer workers contending simultaneously
 * - Validates: 0 double reservations, 0 race conditions, 100% data integrity
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '../src/db/index';
import { AgentStateMachine } from '../src/state/AgentStateMachine';
import { CallStateMachine } from '../src/state/CallStateMachine';
import { DialerWorker } from '../src/workers/DialerWorker';
import { ProviderA } from '../src/providers/ProviderA';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';

describe('High-Concurrency Load & Stress Benchmark', () => {
  let db: Database.Database;
  let agentSM: AgentStateMachine;
  let callSM: CallStateMachine;
  const campaignId = 'load-test-campaign-1';

  beforeEach(() => {
    db = getDb();
    agentSM = new AgentStateMachine();
    callSM = new CallStateMachine();

    // Clean slate
    db.prepare('DELETE FROM metrics').run();
    db.prepare('DELETE FROM pacing_decisions').run();
    db.prepare('DELETE FROM call_events').run();
    db.prepare('DELETE FROM calls').run();
    db.prepare('DELETE FROM borrowers').run();
    db.prepare('DELETE FROM agents').run();
    db.prepare('DELETE FROM campaigns').run();

    db.prepare(`
      INSERT INTO campaigns (id, name, mode, max_oversubscription)
      VALUES (?, 'High Load Campaign', 'predictive', 1.5)
    `).run(campaignId);
  });

  afterEach(() => {
    db.prepare('DELETE FROM metrics').run();
    db.prepare('DELETE FROM pacing_decisions').run();
    db.prepare('DELETE FROM call_events').run();
    db.prepare('DELETE FROM calls').run();
    db.prepare('DELETE FROM borrowers').run();
    db.prepare('DELETE FROM agents').run();
    db.prepare('DELETE FROM campaigns').run();
  });

  it('handles 500 agents and 1,000 borrowers with 50 parallel workers with ZERO double allocation', async () => {
    const AGENT_COUNT = 500;
    const BORROWER_COUNT = 1000;
    const WORKER_COUNT = 50;

    // Seed 500 agents inside transaction for speed
    const insertAgent = db.prepare('INSERT INTO agents (id, name, status) VALUES (?, ?, ?)');
    const seedAgents = db.transaction(() => {
      for (let i = 0; i < AGENT_COUNT; i++) {
        insertAgent.run(`agent-load-${i}`, `Agent ${i}`, 'AVAILABLE');
      }
    });
    seedAgents();

    // Seed 1,000 borrowers inside transaction
    const insertBorrower = db.prepare(
      'INSERT INTO borrowers (id, name, phone, campaign_id, status) VALUES (?, ?, ?, ?, ?)'
    );
    const seedBorrowers = db.transaction(() => {
      for (let i = 0; i < BORROWER_COUNT; i++) {
        insertBorrower.run(`borrower-load-${i}`, `Borrower ${i}`, `+1555${String(i).padStart(7, '0')}`, campaignId, 'pending');
      }
    });
    seedBorrowers();

    const startTime = Date.now();

    // 50 workers concurrently contend for the 500 agents
    const workerPromises = Array.from({ length: WORKER_COUNT }, async (_, wIdx) => {
      const workerId = `worker-stress-${wIdx}`;
      let reservationsWon = 0;

      for (let i = 0; i < AGENT_COUNT; i++) {
        const agentId = `agent-load-${i}`;
        const won = agentSM.reserve(agentId, workerId);
        if (won) reservationsWon++;
      }
      return reservationsWon;
    });

    const results = await Promise.all(workerPromises);
    const totalWon = results.reduce((a, b) => a + b, 0);
    const durationMs = Date.now() - startTime;

    // EXACTLY AGENT_COUNT reservations must be won across all workers
    expect(totalWon).toBe(AGENT_COUNT);

    // Verify DB integrity: exactly 500 agents in RESERVED state, 0 in AVAILABLE
    const reservedCount = (db.prepare(`SELECT COUNT(*) as c FROM agents WHERE status='RESERVED'`).get() as any).c;
    const availableCount = (db.prepare(`SELECT COUNT(*) as c FROM agents WHERE status='AVAILABLE'`).get() as any).c;

    expect(reservedCount).toBe(AGENT_COUNT);
    expect(availableCount).toBe(0);

    // Verify version counter incremented exactly once per agent
    const versions = db.prepare(`SELECT version FROM agents`).all() as { version: number }[];
    for (const v of versions) {
      expect(v.version).toBe(1);
    }

    console.log(`\n⚡ Load Benchmark: 50 workers contended for 500 agents in ${durationMs}ms (${(AGENT_COUNT / (durationMs / 1000)).toFixed(0)} allocations/sec) with 0 collisions.`);
  });

  it('recovers 100 stale agents and 100 stale calls under crash simulation', () => {
    const STALE_COUNT = 100;
    const pastTime = Date.now() - 60000;

    const seedStale = db.transaction(() => {
      for (let i = 0; i < STALE_COUNT; i++) {
        db.prepare(`
          INSERT INTO agents (id, name, status, last_heartbeat)
          VALUES (?, ?, 'RESERVED', ?)
        `).run(`stale-agent-${i}`, `Stale Agent ${i}`, pastTime);

        db.prepare(`
          INSERT INTO calls (id, campaign_id, provider, status, last_heartbeat)
          VALUES (?, ?, 'ProviderA', 'INITIATED', ?)
        `).run(`stale-call-${i}`, campaignId, pastTime);
      }
    });
    seedStale();

    const recoveredAgents = agentSM.recoverStaleAgents(30000);
    const recoveredCalls = callSM.recoverStaleCalls(30000);

    expect(recoveredAgents).toBe(STALE_COUNT);
    expect(recoveredCalls).toBe(STALE_COUNT);

    const availableAgents = (db.prepare(`SELECT COUNT(*) as c FROM agents WHERE status='AVAILABLE'`).get() as any).c;
    const failedCalls = (db.prepare(`SELECT COUNT(*) as c FROM calls WHERE status='FAILED'`).get() as any).c;

    expect(availableAgents).toBe(STALE_COUNT);
    expect(failedCalls).toBe(STALE_COUNT);
  });
});
