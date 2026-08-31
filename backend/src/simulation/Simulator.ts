/**
 * Simulator
 *
 * Runs the four PDF scenarios (A/B/C/D) and failure demonstrations.
 * Seeds the database with agents and borrowers, then runs workers.
 *
 * Scenarios:
 *   A: 20% answer rate, 120s avg talk time
 *   B: 50% answer rate, 90s avg talk time  
 *   C: 70% answer rate, 180s avg talk time
 *   D: Changing answer rate + talk time (stress test)
 *
 * Failure scenarios:
 *   1. Worker crash mid-call
 *   2. Provider outage
 *   3. Mass agent dropout (100→60 agents)
 *   4. Duplicate + out-of-order events (Provider B)
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import Database from 'better-sqlite3';
import { DialerWorker } from '../workers/DialerWorker';
import { ProviderA } from '../providers/ProviderA';
import { ProviderB } from '../providers/ProviderB';
import { AgentStateMachine } from '../state/AgentStateMachine';
import { EventEmitter } from 'events';

export interface ScenarioConfig {
  name: string;
  agentCount: number;
  borrowerCount: number;
  mode: 'progressive' | 'predictive';
  answerRate: number;
  avgTalkTimeSec: number;
  workerCount: number;
  provider: 'A' | 'B';
  durationMs: number;
  maxOversubscription?: number;
}

export const SCENARIOS: Record<string, ScenarioConfig> = {
  A: {
    name: 'Scenario A — Low answer rate (20%)',
    agentCount: 20,
    borrowerCount: 200,
    mode: 'predictive',
    answerRate: 0.20,
    avgTalkTimeSec: 120,
    workerCount: 2,
    provider: 'A',
    durationMs: 30000,
    maxOversubscription: 1.5,
  },
  B: {
    name: 'Scenario B — Medium answer rate (50%)',
    agentCount: 20,
    borrowerCount: 200,
    mode: 'predictive',
    answerRate: 0.50,
    avgTalkTimeSec: 90,
    workerCount: 2,
    provider: 'A',
    durationMs: 30000,
    maxOversubscription: 1.5,
  },
  C: {
    name: 'Scenario C — High answer rate (70%)',
    agentCount: 20,
    borrowerCount: 200,
    mode: 'predictive',
    answerRate: 0.70,
    avgTalkTimeSec: 180,
    workerCount: 2,
    provider: 'A',
    durationMs: 30000,
    maxOversubscription: 1.3,
  },
  D: {
    name: 'Scenario D — Changing conditions (stress test)',
    agentCount: 30,
    borrowerCount: 500,
    mode: 'predictive',
    answerRate: 0.40,
    avgTalkTimeSec: 90,
    workerCount: 3,
    provider: 'B', // unreliable provider for extra stress
    durationMs: 45000,
    maxOversubscription: 1.5,
  },
};

export class Simulator extends EventEmitter {
  private db: Database.Database;
  private activeWorkers: DialerWorker[] = [];
  private providerA: ProviderA;
  private providerB: ProviderB;
  private activeCampaignId: string | null = null;

  constructor() {
    super();
    this.db = getDb();
    this.providerA = new ProviderA();
    this.providerB = new ProviderB();
  }

  async runScenario(scenarioKey: string): Promise<string> {
    const config = SCENARIOS[scenarioKey];
    if (!config) throw new Error(`Unknown scenario: ${scenarioKey}`);

    // Stop any existing simulation
    this.stopAll();
    this.clearDatabase();

    const campaignId = uuidv4();
    this.activeCampaignId = campaignId;

    this.emit('scenario_start', { scenarioKey, config, campaignId });

    // Seed campaign
    this.db.prepare(`
      INSERT INTO campaigns (id, name, mode, max_oversubscription)
      VALUES (?, ?, ?, ?)
    `).run(campaignId, config.name, config.mode, config.maxOversubscription ?? 1.5);

    // Seed agents
    const agentSM = new AgentStateMachine();
    for (let i = 0; i < config.agentCount; i++) {
      this.db.prepare(`
        INSERT INTO agents (id, name, status) VALUES (?, ?, 'AVAILABLE')
      `).run(uuidv4(), `Agent-${i + 1}`);
    }

    // Seed borrowers
    for (let i = 0; i < config.borrowerCount; i++) {
      this.db.prepare(`
        INSERT INTO borrowers (id, name, phone, campaign_id, status) 
        VALUES (?, ?, ?, ?, 'pending')
      `).run(uuidv4(), `Borrower-${i + 1}`, `+1555${String(i).padStart(7, '0')}`, campaignId);
    }

    // Choose provider
    const provider = config.provider === 'A' ? this.providerA : this.providerB;

    // Start workers
    for (let w = 0; w < config.workerCount; w++) {
      const worker = new DialerWorker({
        campaignId,
        mode: config.mode,
        provider,
        tickMs: 1000,
        maxOversubscription: config.maxOversubscription,
        scenarioAnswerRate: config.answerRate,
      });

      this.wireWorkerEvents(worker, campaignId);
      worker.start();
      this.activeWorkers.push(worker);
    }

    // For Scenario D: change conditions mid-way
    if (scenarioKey === 'D') {
      setTimeout(() => {
        this.emit('scenario_change', { message: 'Answer rate dropping to 15%' });
        this.activeWorkers.forEach(w => {
          (w as any).config.scenarioAnswerRate = 0.15;
        });
      }, config.durationMs * 0.4);

      setTimeout(() => {
        this.emit('scenario_change', { message: 'Agent dropout: removing 10 agents' });
        this.simulateAgentDropout(10);
      }, config.durationMs * 0.6);
    }

    return campaignId;
  }

  // ── Failure Scenario Demonstrations ───────────────────────────────────────

  simulateWorkerCrash(): string {
    if (this.activeWorkers.length === 0) return 'No active workers';
    const worker = this.activeWorkers[0];
    worker.simulateCrash();
    this.emit('failure_demo', {
      type: 'worker_crash',
      workerId: worker.workerId,
      message: `Worker ${worker.workerId} crashed. Stale agent/call recovery will trigger in ~30s.`,
    });
    return `Worker ${worker.workerId} crashed`;
  }

  simulateProviderOutage(provider: 'A' | 'B'): string {
    if (provider === 'A') this.providerA.simulateOutage(true);
    else this.providerB.simulateOutage(true);

    this.emit('failure_demo', {
      type: 'provider_outage',
      provider,
      message: `Provider ${provider} outage started. Safety controller will block new calls.`,
    });

    // Auto-recover after 10s
    setTimeout(() => {
      if (provider === 'A') this.providerA.simulateOutage(false);
      else this.providerB.simulateOutage(false);
      this.emit('failure_demo', { type: 'provider_recovery', provider, message: `Provider ${provider} recovered.` });
    }, 10000);

    return `Provider ${provider} outage started (auto-recover in 10s)`;
  }

  simulateAgentDropout(count: number): string {
    const result = this.db.prepare(`
      UPDATE agents SET status='OFFLINE' WHERE status='AVAILABLE' LIMIT ?
    `).run(count);
    this.emit('failure_demo', {
      type: 'agent_dropout',
      count: result.changes,
      message: `${result.changes} agents went offline. Dialer will react within 1 tick.`,
    });
    return `${result.changes} agents went offline`;
  }

  addAgents(count: number): string {
    for (let i = 0; i < count; i++) {
      this.db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'AVAILABLE')`)
        .run(uuidv4(), `Agent-New-${Date.now()}-${i}`);
    }
    this.emit('failure_demo', { type: 'agents_added', count, message: `${count} new agents came online.` });
    return `${count} agents added`;
  }

  stopAll(): void {
    for (const worker of this.activeWorkers) {
      worker.stop();
    }
    this.activeWorkers = [];
  }

  getActiveCampaignId(): string | null {
    return this.activeCampaignId;
  }

  getActiveWorkerStats() {
    return this.activeWorkers.map(w => w.getStats());
  }

  private wireWorkerEvents(worker: DialerWorker, campaignId: string): void {
    const events = [
      'call_started', 'call_ended', 'duplicate_event',
      'event_processed', 'safety_decision', 'recovery',
      'worker_started', 'worker_stopped', 'worker_crashed', 'tick_error'
    ];
    for (const event of events) {
      worker.on(event, (data) => this.emit('worker_event', { event, data, campaignId }));
    }
  }

  private clearDatabase(): void {
    this.db.exec(`
      DELETE FROM metrics;
      DELETE FROM pacing_decisions;
      DELETE FROM call_events;
      DELETE FROM calls;
      DELETE FROM borrowers;
      DELETE FROM agents;
      DELETE FROM campaigns;
    `);
  }
}
