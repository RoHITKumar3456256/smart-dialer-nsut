/**
 * Call State Machine
 *
 * State ordering (for out-of-order event handling):
 * QUEUED(0) → RESERVED(1) → INITIATED(2) → RINGING(3) → ANSWERED(4) → CONNECTED(5) → COMPLETED(6)
 *                                                                                    → FAILED(6)
 *                                                                                    → CANCELLED(6)
 *
 * Terminal states: COMPLETED, FAILED, CANCELLED
 * Out-of-order events are IGNORED (a later state cannot regress to an earlier one).
 * Duplicate events for the same state are idempotent (no-op).
 */

import Database from 'better-sqlite3';
import { getDb } from '../db/index';

export type CallStatus =
  | 'QUEUED'
  | 'RESERVED'
  | 'INITIATED'
  | 'RINGING'
  | 'ANSWERED'
  | 'CONNECTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface Call {
  id: string;
  campaign_id: string;
  agent_id: string | null;
  borrower_id: string | null;
  provider: string;
  status: CallStatus;
  worker_id: string | null;
  idempotency_key: string | null;
  initiated_at: number | null;
  ringing_at: number | null;
  answered_at: number | null;
  connected_at: number | null;
  completed_at: number | null;
  failed_reason: string | null;
  last_heartbeat: number | null;
  version: number;
  created_at: number;
}

// State ordering — higher number = more advanced state
const STATE_ORDER: Record<CallStatus, number> = {
  QUEUED: 0,
  RESERVED: 1,
  INITIATED: 2,
  RINGING: 3,
  ANSWERED: 4,
  CONNECTED: 5,
  COMPLETED: 6,
  FAILED: 6,
  CANCELLED: 6,
};

const TERMINAL_STATES: Set<CallStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export class CallStateMachine {
  private db: Database.Database;

  constructor() {
    this.db = getDb();
  }

  /**
   * Transition a call to a new status.
   * - Duplicate events (same status): silently ignored → idempotent
   * - Out-of-order events (lower order than current): silently ignored
   * - Terminal state transitions: blocked
   * Returns: 'advanced' | 'duplicate' | 'ignored' | 'terminal'
   */
  transition(
    callId: string,
    newStatus: CallStatus,
    idempotencyKey?: string,
    failedReason?: string,
    workerId?: string
  ): 'advanced' | 'duplicate' | 'ignored' | 'terminal' {
    const call = this.getCall(callId);
    if (!call) throw new Error(`Call not found: ${callId}`);

    const currentOrder = STATE_ORDER[call.status];
    const newOrder = STATE_ORDER[newStatus];

    // Same state → idempotent duplicate
    if (call.status === newStatus) return 'duplicate';

    // Out-of-order: new state is earlier than current → ignore
    if (newOrder < currentOrder) return 'ignored';

    // Already in terminal state
    if (TERMINAL_STATES.has(call.status)) return 'terminal';

    const now = Date.now();
    this.db.prepare(`
      UPDATE calls
      SET status = ?,
          initiated_at = CASE WHEN ? = 'INITIATED' THEN ? ELSE initiated_at END,
          ringing_at = CASE WHEN ? = 'RINGING' THEN ? ELSE ringing_at END,
          answered_at = CASE WHEN ? = 'ANSWERED' THEN ? ELSE answered_at END,
          connected_at = CASE WHEN ? = 'CONNECTED' THEN ? ELSE connected_at END,
          completed_at = CASE WHEN ? IN ('COMPLETED','FAILED','CANCELLED') THEN ? ELSE completed_at END,
          failed_reason = CASE WHEN ? IN ('FAILED','CANCELLED') THEN ? ELSE failed_reason END,
          last_heartbeat = ?,
          worker_id = COALESCE(?, worker_id),
          version = version + 1
      WHERE id = ?
    `).run(
      newStatus,
      newStatus, now,
      newStatus, now,
      newStatus, now,
      newStatus, now,
      newStatus, now,
      newStatus, failedReason ?? null,
      now,
      workerId ?? null,
      callId
    );

    return 'advanced';
  }

  /**
   * Record a provider event idempotently.
   * Returns false if already processed (duplicate).
   */
  recordProviderEvent(
    callId: string,
    eventType: string,
    provider: string,
    payload: object,
    idempotencyKey: string
  ): boolean {
    const eventId = require('uuid').v4();
    try {
      this.db.prepare(`
        INSERT INTO call_events (id, call_id, event_type, provider, payload, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(eventId, callId, eventType, provider, JSON.stringify(payload), idempotencyKey);
      return true;
    } catch {
      // UNIQUE constraint on idempotency_key → duplicate event
      return false;
    }
  }

  getCall(id: string): Call | null {
    return (this.db.prepare('SELECT * FROM calls WHERE id=?').get(id) as Call) ?? null;
  }

  getCallsByStatus(status: CallStatus): Call[] {
    return this.db.prepare('SELECT * FROM calls WHERE status=?').all(status) as Call[];
  }

  getCallCounts(): Record<CallStatus, number> {
    const rows = this.db.prepare(
      'SELECT status, COUNT(*) as count FROM calls GROUP BY status'
    ).all() as { status: CallStatus; count: number }[];

    const counts: Record<CallStatus, number> = {
      QUEUED: 0, RESERVED: 0, INITIATED: 0, RINGING: 0,
      ANSWERED: 0, CONNECTED: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0,
    };
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  /**
   * Recovery: calls stuck in INITIATED/RINGING with no heartbeat → FAILED
   */
  recoverStaleCalls(staleThresholdMs: number = 30000): number {
    const cutoff = Date.now() - staleThresholdMs;
    const result = this.db.prepare(`
      UPDATE calls
      SET status='FAILED', failed_reason='Worker crash recovery', 
          completed_at=?, version=version+1
      WHERE status IN ('INITIATED','RINGING','ANSWERED') AND last_heartbeat < ?
    `).run(Date.now(), cutoff);
    return result.changes;
  }

  isTerminal(status: CallStatus): boolean {
    return TERMINAL_STATES.has(status);
  }
}
