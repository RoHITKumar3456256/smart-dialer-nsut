/**
 * Safety Controller — Hard Boundary
 *
 * This is the ONLY way to authorize new outbound calls.
 * The pacing engine CANNOT bypass this.
 *
 * Safety rules (in order):
 * 1. HARD CAP: active calls (ringing+connected) must not exceed total_agents * oversubscription_cap
 * 2. PROVIDER HEALTH: if provider health < 60%, block new calls
 * 3. AGENT FLOOR: must always have at least 1 available agent in progressive, buffer in predictive
 * 4. ANSWER RATE DROP: if recent answer rate drops > 50% suddenly → fall back to progressive pace
 * 5. RINGING FLOOD: ringing_calls must not exceed available_agents * 2
 */

import { getDb } from '../db/index';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { ProviderHealth } from '../providers/ProviderInterface';

export type SafetyAction =
  | 'APPROVE'
  | 'REDUCE'
  | 'REJECT'
  | 'FALLBACK_PROGRESSIVE';

export interface SafetyRequest {
  campaignId: string;
  mode: 'progressive' | 'predictive';
  requestedCalls: number;
  availableAgents: number;
  connectedCalls: number;
  ringingCalls: number;
  answerRate: number;       // recent EWMA answer rate
  prevAnswerRate: number;   // previous answer rate for drop detection
  providerHealth: ProviderHealth;
  maxOversubscription: number;
}

export interface SafetyDecision {
  approvedCalls: number;
  action: SafetyAction;
  reasoning: string[];
}

export class SafetyController {
  private db: Database.Database;

  // Hard limits — cannot be changed at runtime
  private readonly ABSOLUTE_MAX_OVERSUBSCRIPTION = 2.0;
  private readonly MIN_PROVIDER_HEALTH = 0.60;
  private readonly MAX_RINGING_MULTIPLIER = 2.0;
  private readonly ANSWER_RATE_DROP_THRESHOLD = 0.50; // 50% drop triggers fallback
  private readonly MIN_ANSWER_RATE_FOR_PREDICTIVE = 0.10;

  constructor() {
    this.db = getDb();
  }

  /**
   * Evaluate a pacing request and return the approved number of calls.
   * This method CANNOT be bypassed or disabled.
   */
  evaluate(req: SafetyRequest): SafetyDecision {
    const reasoning: string[] = [];
    let approved = req.requestedCalls;

    // ─── Rule 1: Progressive mode strict cap ────────────────────────────────
    if (req.mode === 'progressive') {
      const cap = req.availableAgents;
      if (approved > cap) {
        approved = cap;
        reasoning.push(`Progressive cap: reduced to ${cap} (= available agents)`);
      }
    }

    // ─── Rule 2: Absolute oversubscription cap ───────────────────────────────
    const activeCalls = req.connectedCalls + req.ringingCalls;
    const totalAgents = req.availableAgents + req.connectedCalls + req.ringingCalls;
    const oversubCap = Math.min(req.maxOversubscription, this.ABSOLUTE_MAX_OVERSUBSCRIPTION);
    const maxNewCalls = Math.max(0, Math.floor(totalAgents * oversubCap) - activeCalls);

    if (approved > maxNewCalls) {
      approved = maxNewCalls;
      reasoning.push(`Oversubscription cap (×${oversubCap}): reduced to ${approved}`);
    }

    // ─── Rule 3: Ringing flood protection ───────────────────────────────────
    const maxRinging = Math.floor(req.availableAgents * this.MAX_RINGING_MULTIPLIER);
    const ringingBudget = Math.max(0, maxRinging - req.ringingCalls);
    if (approved > ringingBudget) {
      approved = ringingBudget;
      reasoning.push(`Ringing flood protection: reduced to ${approved}`);
    }

    // ─── Rule 4: Provider health gate ───────────────────────────────────────
    if (!req.providerHealth.healthy) {
      const action: SafetyDecision = {
        approvedCalls: 0,
        action: 'REJECT',
        reasoning: [...reasoning, `Provider unhealthy (success rate: ${(req.providerHealth.successRate * 100).toFixed(1)}%). Blocking all new calls.`],
      };
      this.persist(req, action);
      return action;
    }

    if (req.providerHealth.successRate < this.MIN_PROVIDER_HEALTH) {
      approved = Math.floor(approved * req.providerHealth.successRate);
      reasoning.push(`Provider health degraded (${(req.providerHealth.successRate * 100).toFixed(1)}%): reduced to ${approved}`);
    }

    // ─── Rule 5: Answer rate sudden drop → fallback to progressive ───────────
    const answerRateDrop =
      req.prevAnswerRate > 0
        ? (req.prevAnswerRate - req.answerRate) / req.prevAnswerRate
        : 0;

    if (
      req.mode === 'predictive' &&
      (answerRateDrop > this.ANSWER_RATE_DROP_THRESHOLD ||
        req.answerRate < this.MIN_ANSWER_RATE_FOR_PREDICTIVE)
    ) {
      const fallbackCap = req.availableAgents;
      approved = Math.min(approved, fallbackCap);
      const action: SafetyDecision = {
        approvedCalls: approved,
        action: 'FALLBACK_PROGRESSIVE',
        reasoning: [
          ...reasoning,
          `Answer rate dropped ${(answerRateDrop * 100).toFixed(1)}% (${(req.prevAnswerRate * 100).toFixed(1)}% → ${(req.answerRate * 100).toFixed(1)}%). Falling back to progressive pacing.`,
        ],
      };
      this.persist(req, action);
      return action;
    }

    // ─── Final approval ──────────────────────────────────────────────────────
    approved = Math.max(0, approved);
    let action: SafetyAction;

    if (approved === 0) {
      action = 'REJECT';
      reasoning.push('All safety rules exhausted. No new calls allowed.');
    } else if (approved < req.requestedCalls) {
      action = 'REDUCE';
      reasoning.push(`Reduced from ${req.requestedCalls} to ${approved}.`);
    } else {
      action = 'APPROVE';
      reasoning.push(`Approved: ${approved} new calls.`);
    }

    const decision: SafetyDecision = { approvedCalls: approved, action, reasoning };
    this.persist(req, decision);
    return decision;
  }

  /** Persist decision for audit trail and dashboard */
  private persist(req: SafetyRequest, decision: SafetyDecision): void {
    try {
      this.db.prepare(`
        INSERT INTO pacing_decisions (id, campaign_id, mode, requested_calls, approved_calls,
          safety_action, available_agents, connected_calls, ringing_calls, answer_rate,
          provider_health, reasoning)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), req.campaignId, req.mode, req.requestedCalls, decision.approvedCalls,
        decision.action, req.availableAgents, req.connectedCalls, req.ringingCalls,
        req.answerRate, req.providerHealth.successRate, JSON.stringify(decision.reasoning)
      );
    } catch { /* non-fatal */ }
  }

  /** Get recent decisions for dashboard */
  getRecentDecisions(campaignId: string, limit: number = 50): object[] {
    return this.db.prepare(`
      SELECT * FROM pacing_decisions WHERE campaign_id=? ORDER BY created_at DESC LIMIT ?
    `).all(campaignId, limit) as object[];
  }
}
