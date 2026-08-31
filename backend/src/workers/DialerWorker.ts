/**
 * Dialer Worker
 *
 * Represents one dialing worker process. In production, multiple of these
 * would run on separate machines. Here we simulate N workers running
 * concurrently in the same process to demonstrate distributed system behavior.
 *
 * Each worker:
 * 1. Polls the campaign every TICK_MS
 * 2. Asks the Pacing Engine how many calls to start
 * 3. Routes through Safety Controller
 * 4. Uses CallAllocator to start the approved number of calls
 * 5. Sends heartbeats on active calls
 * 6. Performs recovery of stale agents/calls
 */

import { EventEmitter } from 'events';
import { getDb } from '../db/index';
import Database from 'better-sqlite3';
import { ProgressiveEngine } from '../pacing/ProgressiveEngine';
import { PredictiveEngine } from '../pacing/PredictiveEngine';
import { SafetyController } from '../safety/SafetyController';
import { CallAllocator } from '../allocator/CallAllocator';
import { AgentStateMachine } from '../state/AgentStateMachine';
import { CallStateMachine } from '../state/CallStateMachine';
import { TelecomProvider } from '../providers/ProviderInterface';
import { v4 as uuidv4 } from 'uuid';

export interface WorkerConfig {
  campaignId: string;
  mode: 'progressive' | 'predictive';
  provider: TelecomProvider;
  tickMs?: number;
  maxOversubscription?: number;
  scenarioAnswerRate?: number; // for simulator injection
}

export interface WorkerStats {
  workerId: string;
  campaignId: string;
  isRunning: boolean;
  tickCount: number;
  callsStarted: number;
  callsFailed: number;
  agentsRecovered: number;
  callsRecovered: number;
  lastTick: number;
}

export class DialerWorker extends EventEmitter {
  readonly workerId: string;
  private config: WorkerConfig;
  private db: Database.Database;
  private progressiveEngine: ProgressiveEngine;
  private predictiveEngine: PredictiveEngine;
  private safetyController: SafetyController;
  private allocator: CallAllocator;
  private agentSM: AgentStateMachine;
  private callSM: CallStateMachine;

  private isRunning = false;
  private tickInterval: NodeJS.Timeout | null = null;
  private stats: WorkerStats;
  private isCrashed = false;

  constructor(config: WorkerConfig) {
    super();
    this.workerId = uuidv4().slice(0, 8);
    this.config = config;
    this.db = getDb();
    this.progressiveEngine = new ProgressiveEngine();
    this.predictiveEngine = new PredictiveEngine();
    this.safetyController = new SafetyController();
    this.allocator = new CallAllocator(config.provider, this.workerId);
    this.agentSM = new AgentStateMachine();
    this.callSM = new CallStateMachine();

    this.stats = {
      workerId: this.workerId,
      campaignId: config.campaignId,
      isRunning: false,
      tickCount: 0,
      callsStarted: 0,
      callsFailed: 0,
      agentsRecovered: 0,
      callsRecovered: 0,
      lastTick: 0,
    };

    // Forward allocator events
    this.allocator.on('call_started', (data) => this.emit('call_started', { ...data, workerId: this.workerId }));
    this.allocator.on('call_ended', (data) => this.emit('call_ended', { ...data, workerId: this.workerId }));
    this.allocator.on('duplicate_event', (data) => this.emit('duplicate_event', { ...data, workerId: this.workerId }));
    this.allocator.on('event_processed', (data) => this.emit('event_processed', { ...data, workerId: this.workerId }));
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isCrashed = false;
    this.stats.isRunning = true;
    const tickMs = this.config.tickMs ?? 1000;
    this.tickInterval = setInterval(() => this.tick(), tickMs);
    this.emit('worker_started', { workerId: this.workerId });
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.isRunning = false;
    this.stats.isRunning = false;
    this.emit('worker_stopped', { workerId: this.workerId });
  }

  /**
   * Simulate a worker crash — stops processing but leaves active calls in limbo.
   * Recovery worker will clean up after staleThresholdMs.
   */
  simulateCrash(): void {
    this.isCrashed = true;
    this.stop();
    this.emit('worker_crashed', { workerId: this.workerId });
  }

  private async tick(): Promise<void> {
    if (!this.isRunning || this.isCrashed) return;

    this.stats.tickCount++;
    this.stats.lastTick = Date.now();

    try {
      // ── Recovery pass ─────────────────────────────────────────────────────
      const recoveredAgents = this.agentSM.recoverStaleAgents(30000);
      const recoveredCalls = this.callSM.recoverStaleCalls(30000);
      if (recoveredAgents > 0 || recoveredCalls > 0) {
        this.stats.agentsRecovered += recoveredAgents;
        this.stats.callsRecovered += recoveredCalls;
        this.emit('recovery', { workerId: this.workerId, recoveredAgents, recoveredCalls });
      }

      // ── Calculate pacing ──────────────────────────────────────────────────
      let pacingResult;
      if (this.config.mode === 'progressive') {
        pacingResult = this.progressiveEngine.calculate(this.config.campaignId);
      } else {
        pacingResult = this.predictiveEngine.calculate(
          this.config.campaignId,
          this.config.scenarioAnswerRate
        );
      }

      if (pacingResult.callsToStart === 0) return;

      // ── Safety Controller evaluation ──────────────────────────────────────
      const arState = this.predictiveEngine.getAnswerRateState(this.config.campaignId);
      const safetyDecision = this.safetyController.evaluate({
        campaignId: this.config.campaignId,
        mode: this.config.mode,
        requestedCalls: pacingResult.callsToStart,
        availableAgents: pacingResult.availableAgents,
        connectedCalls: pacingResult.connectedCalls,
        ringingCalls: pacingResult.ringingCalls,
        answerRate: arState.rate,
        prevAnswerRate: arState.prevRate,
        providerHealth: this.config.provider.getHealth(),
        maxOversubscription: this.config.maxOversubscription ?? 1.5,
      });

      this.emit('safety_decision', {
        workerId: this.workerId,
        decision: safetyDecision,
        requested: pacingResult.callsToStart,
        reasoning: pacingResult.reasoning,
      });

      if (safetyDecision.approvedCalls === 0) return;

      // ── Start approved calls (in parallel) ───────────────────────────────
      const promises: Promise<void>[] = [];
      for (let i = 0; i < safetyDecision.approvedCalls; i++) {
        promises.push(
          this.allocator.allocateAndDial(this.config.campaignId).then(result => {
            if (result.success) {
              this.stats.callsStarted++;
            } else {
              this.stats.callsFailed++;
            }
          })
        );
      }
      await Promise.all(promises);

      // ── Snapshot metrics ─────────────────────────────────────────────────
      this.snapshotMetrics();

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.emit('tick_error', { workerId: this.workerId, error: message });
    }
  }

  private snapshotMetrics(): void {
    const agentCounts = this.agentSM.getAgentCounts();
    const callCounts = this.callSM.getCallCounts();
    const totalAgents = Object.values(agentCounts).reduce((a, b) => a + b, 0);
    const busyAgents = agentCounts.CONNECTED + agentCounts.DIALING + agentCounts.RESERVED;
    const utilization = totalAgents > 0 ? busyAgents / totalAgents : 0;
    const totalCompleted = callCounts.COMPLETED + callCounts.FAILED;
    const answerRate = totalCompleted > 0
      ? callCounts.COMPLETED / totalCompleted
      : 0;

    try {
      this.db.prepare(`
        INSERT INTO metrics (campaign_id, agents_available, agents_reserved, agents_connected,
          agents_wrap_up, calls_ringing, calls_connected, calls_completed, calls_failed,
          agent_utilization, answer_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.config.campaignId,
        agentCounts.AVAILABLE,
        agentCounts.RESERVED + agentCounts.DIALING,
        agentCounts.CONNECTED,
        agentCounts.WRAP_UP,
        callCounts.RINGING + callCounts.INITIATED,
        callCounts.CONNECTED + callCounts.ANSWERED,
        callCounts.COMPLETED,
        callCounts.FAILED,
        utilization,
        answerRate
      );
    } catch { /* non-fatal */ }
  }

  getStats(): WorkerStats {
    return { ...this.stats };
  }
}
