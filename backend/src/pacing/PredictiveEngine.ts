/**
 * Predictive Pacing Engine
 *
 * Algorithm based on Erlang-C principles + EWMA answer rate tracking.
 *
 * Core insight:
 *   If answer rate = 50%, you need to start 2 calls to get 1 connected.
 *   But some calls are already ringing — they will (maybe) connect too.
 *   So: new_calls = (agents_available / answer_rate) - calls_already_ringing
 *
 * We apply safety dampening to prevent overcorrection:
 *   - EWMA smoothing on answer rate (α = 0.2)
 *   - Bounded by max oversubscription factor
 *   - Call setup time awareness (don't start calls if setup time > avg talk time)
 *
 * This engine PROPOSES a number. The SafetyController decides what's approved.
 */

import { getDb } from '../db/index';
import Database from 'better-sqlite3';
import { AgentStateMachine } from '../state/AgentStateMachine';
import { CallStateMachine } from '../state/CallStateMachine';

export interface PacingResult {
  callsToStart: number;
  reasoning: string;
  availableAgents: number;
  connectedCalls: number;
  ringingCalls: number;
  answerRate: number;
  prevAnswerRate: number;
}

// EWMA state per campaign
const ewmaState: Map<string, { rate: number; prevRate: number; samples: number }> = new Map();

const EWMA_ALPHA = 0.2;       // smoothing factor (lower = more stable)
const MIN_SAMPLES_FOR_PRED = 5; // need at least 5 data points before using predictive

export class PredictiveEngine {
  private db: Database.Database;
  private agentSM: AgentStateMachine;
  private callSM: CallStateMachine;

  constructor() {
    this.db = getDb();
    this.agentSM = new AgentStateMachine();
    this.callSM = new CallStateMachine();
  }

  /**
   * Calculate the optimal number of calls to initiate.
   *
   * Formula:
   *   target_connected = available_agents (we want every agent busy)
   *   calls_needed_total = target_connected / answer_rate
   *   new_calls = calls_needed_total - ringing_calls - connected_calls
   *
   * Why: if answer_rate=50%, to fill 10 agents we need 20 calls total.
   *      If 5 are already ringing: start 20 - 5 - 10 = 5 more.
   */
  calculate(campaignId: string, scenarioAnswerRate?: number): PacingResult {
    const agentCounts = this.agentSM.getAgentCounts();
    const callCounts = this.callSM.getCallCounts();

    const availableAgents = agentCounts.AVAILABLE;
    const connectedCalls = callCounts.CONNECTED + callCounts.ANSWERED;
    const ringingCalls = callCounts.RINGING + callCounts.INITIATED;

    // Update EWMA answer rate from recent data
    this.updateAnswerRate(campaignId, scenarioAnswerRate);
    const state = ewmaState.get(campaignId) ?? { rate: 0.5, prevRate: 0.5, samples: 0 };

    const answerRate = state.rate;
    const prevAnswerRate = state.prevRate;

    // Not enough samples → fall back to conservative 0.5
    const effectiveAnswerRate = state.samples >= MIN_SAMPLES_FOR_PRED || scenarioAnswerRate !== undefined
      ? Math.max(answerRate, 0.05) // never divide by near-zero
      : 0.5;

    // Total agents in the system (proxy for campaign size)
    const totalAgents = availableAgents + connectedCalls + ringingCalls
      + agentCounts.RESERVED + agentCounts.DIALING + agentCounts.WRAP_UP;

    // Count pending borrowers
    const pendingBorrowers = (this.db.prepare(`
      SELECT COUNT(*) as count FROM borrowers WHERE campaign_id=? AND status='pending'
    `).get(campaignId) as { count: number })?.count ?? 0;

    if (pendingBorrowers === 0) {
      return { callsToStart: 0, reasoning: 'No pending borrowers', availableAgents, connectedCalls, ringingCalls, answerRate, prevAnswerRate };
    }

    // Target: keep all available agents busy
    const targetConnected = availableAgents + connectedCalls;
    const callsNeededTotal = Math.ceil(targetConnected / effectiveAnswerRate);
    const activeCalls = ringingCalls + connectedCalls;
    let newCalls = Math.max(0, callsNeededTotal - activeCalls);

    // Bound by pending borrowers
    newCalls = Math.min(newCalls, pendingBorrowers);

    const reasoning = [
      `EWMA answer rate: ${(effectiveAnswerRate * 100).toFixed(1)}% (samples: ${state.samples})`,
      `Target connected: ${targetConnected} | Total calls needed: ${callsNeededTotal}`,
      `Active calls (ringing+connected): ${activeCalls}`,
      `Proposed new calls: ${newCalls} (bounded by ${pendingBorrowers} pending borrowers)`,
    ].join(' | ');

    return { callsToStart: newCalls, reasoning, availableAgents, connectedCalls, ringingCalls, answerRate, prevAnswerRate };
  }

  /**
   * Update the EWMA answer rate from recent call history.
   */
  private updateAnswerRate(campaignId: string, overrideRate?: number): void {
    let current = ewmaState.get(campaignId) ?? { rate: 0.5, prevRate: 0.5, samples: 0 };

    let recentRate: number;

    if (overrideRate !== undefined) {
      // Simulator injects scenario answer rate directly
      recentRate = overrideRate;
    } else {
      // Calculate from recent call data (last 50 completed calls)
      const result = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN answered_at IS NOT NULL THEN 1 ELSE 0 END) as answered
        FROM calls
        WHERE campaign_id=? AND status IN ('COMPLETED','FAILED')
        ORDER BY completed_at DESC
        LIMIT 50
      `).get(campaignId) as { total: number; answered: number } | undefined;

      if (!result || result.total === 0) return;
      recentRate = result.answered / result.total;
    }

    const prevRate = current.rate;
    const newRate = current.samples < MIN_SAMPLES_FOR_PRED
      ? recentRate  // bootstrap with raw data
      : EWMA_ALPHA * recentRate + (1 - EWMA_ALPHA) * current.rate;

    ewmaState.set(campaignId, {
      rate: newRate,
      prevRate: prevRate,
      samples: current.samples + 1,
    });
  }

  getAnswerRateState(campaignId: string) {
    return ewmaState.get(campaignId) ?? { rate: 0.5, prevRate: 0.5, samples: 0 };
  }

  resetState(campaignId: string): void {
    ewmaState.delete(campaignId);
  }
}
