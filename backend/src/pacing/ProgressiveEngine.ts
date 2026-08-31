/**
 * Progressive Pacing Engine
 *
 * Simple, safe: 1 available agent = 1 outbound call.
 * Never creates more calls than available agents.
 * Predictable, auditable, no risk of abandoned calls.
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
}

export class ProgressiveEngine {
  private db: Database.Database;
  private agentSM: AgentStateMachine;
  private callSM: CallStateMachine;

  constructor() {
    this.db = getDb();
    this.agentSM = new AgentStateMachine();
    this.callSM = new CallStateMachine();
  }

  /**
   * Calculate how many new calls should be started.
   * In progressive mode: calls_to_start = available_agents (max)
   * but we never exceed the count of pending borrowers.
   */
  calculate(campaignId: string): PacingResult {
    const agentCounts = this.agentSM.getAgentCounts();
    const callCounts = this.callSM.getCallCounts();

    const availableAgents = agentCounts.AVAILABLE;
    const connectedCalls = callCounts.CONNECTED + callCounts.ANSWERED;
    const ringingCalls = callCounts.RINGING + callCounts.INITIATED;

    // Count pending borrowers
    const pendingBorrowers = (this.db.prepare(`
      SELECT COUNT(*) as count FROM borrowers 
      WHERE campaign_id=? AND status='pending'
    `).get(campaignId) as { count: number })?.count ?? 0;

    // Progressive: one call per available agent, bounded by pending borrowers
    const callsToStart = Math.min(availableAgents, pendingBorrowers);

    return {
      callsToStart,
      reasoning: `Progressive: min(${availableAgents} available agents, ${pendingBorrowers} pending borrowers) = ${callsToStart}`,
      availableAgents,
      connectedCalls,
      ringingCalls,
    };
  }
}
