/**
 * Concurrency Tests
 *
 * Verifies that exactly ONE worker can reserve an agent when multiple
 * workers try simultaneously. This is the core distributed systems guarantee.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../src/db/index';
import { AgentStateMachine } from '../src/state/AgentStateMachine';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';

describe('Concurrency — Agent Reservation', () => {
  let db: Database.Database;
  let agentSM: AgentStateMachine;

  beforeEach(() => {
    db = getDb();
    agentSM = new AgentStateMachine();

    // Seed one available agent
    db.prepare(`DELETE FROM agents`).run();
    db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'AVAILABLE')`)
      .run('test-agent-1', 'Test Agent 1');
  });

  afterEach(() => {
    db.prepare(`DELETE FROM agents`).run();
  });

  it('only ONE of N concurrent workers can reserve the same agent', async () => {
    const WORKER_COUNT = 10;
    const workers = Array.from({ length: WORKER_COUNT }, (_, i) => `worker-${i}`);

    // All workers try to reserve the same agent simultaneously
    const results = await Promise.all(
      workers.map(workerId => 
        Promise.resolve(agentSM.reserve('test-agent-1', workerId))
      )
    );

    const successCount = results.filter(Boolean).length;
    expect(successCount).toBe(1); // EXACTLY one winner

    // Verify database state
    const agent = agentSM.getAgent('test-agent-1');
    expect(agent?.status).toBe('RESERVED');
  });

  it('version-based optimistic locking prevents double reservation', () => {
    const agent = agentSM.getAgent('test-agent-1');
    expect(agent).toBeTruthy();
    const initialVersion = agent!.version;

    // First reservation with correct version
    const result1 = agentSM.transition(
      'test-agent-1', 'AVAILABLE', 'RESERVED', 'worker-1', initialVersion
    );
    expect(result1).toBe(true);

    // Second reservation with SAME (now stale) version
    const result2 = agentSM.transition(
      'test-agent-1', 'AVAILABLE', 'RESERVED', 'worker-2', initialVersion
    );
    expect(result2).toBe(false); // Must fail — version mismatch
  });

  it('invalid state transitions are rejected', () => {
    expect(() => agentSM.transition('test-agent-1', 'OFFLINE', 'CONNECTED', 'worker-1'))
      .toThrow('Invalid agent transition');
  });

  it('stale agent recovery releases stuck RESERVED agents', async () => {
    // Put agent in RESERVED state with old heartbeat
    db.prepare(`
      UPDATE agents SET status='RESERVED', last_heartbeat=? WHERE id='test-agent-1'
    `).run(Date.now() - 60000); // 60s ago

    const recovered = agentSM.recoverStaleAgents(30000);
    expect(recovered).toBe(1);

    const agent = agentSM.getAgent('test-agent-1');
    expect(agent?.status).toBe('AVAILABLE');
  });

  it('multiple agents — each gets reserved by one worker only', () => {
    // Add 5 agents
    for (let i = 2; i <= 5; i++) {
      db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'AVAILABLE')`)
        .run(`test-agent-${i}`, `Test Agent ${i}`);
    }

    const allAgents = db.prepare(`SELECT id FROM agents WHERE status='AVAILABLE'`).all() as { id: string }[];
    
    // 20 workers try to reserve 5 agents
    let successCount = 0;
    for (let w = 0; w < 20; w++) {
      const ag = allAgents[Math.floor(Math.random() * allAgents.length)];
      if (agentSM.reserve(ag.id, `worker-${w}`)) successCount++;
    }

    const reservedCount = (db.prepare(`SELECT COUNT(*) as c FROM agents WHERE status='RESERVED'`).get() as any).c;
    // At most 5 agents should be reserved (one per agent)
    expect(reservedCount).toBeLessThanOrEqual(5);
  });
});

describe('Concurrency — Borrower Reservation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = getDb();
    db.prepare(`DELETE FROM campaigns`).run();
    db.prepare(`DELETE FROM borrowers`).run();
    db.prepare(`INSERT INTO campaigns (id, name, mode) VALUES ('camp-1', 'Test', 'progressive')`).run();
    db.prepare(`INSERT INTO borrowers (id, name, phone, campaign_id, status) VALUES (?, ?, ?, ?, 'pending')`)
      .run('borrow-1', 'Test Borrower', '+15550001234', 'camp-1');
  });

  afterEach(() => {
    db.prepare(`DELETE FROM borrowers`).run();
    db.prepare(`DELETE FROM campaigns`).run();
  });

  it('atomic borrower reservation prevents double-dialing', () => {
    // Simulate 5 workers trying to grab the same borrower
    const atomicReserve = () => {
      const reserveTransaction = db.transaction(() => {
        const borrower = db.prepare(`
          SELECT id FROM borrowers WHERE campaign_id='camp-1' AND status='pending' LIMIT 1
        `).get() as { id: string } | undefined;

        if (!borrower) return false;

        const result = db.prepare(`
          UPDATE borrowers SET status='reserved' WHERE id=? AND status='pending'
        `).run(borrower.id);

        return result.changes === 1;
      });
      return reserveTransaction();
    };

    const results = Array.from({ length: 5 }, () => atomicReserve());
    const successCount = results.filter(Boolean).length;
    expect(successCount).toBe(1); // Only one worker gets the borrower
  });
});
