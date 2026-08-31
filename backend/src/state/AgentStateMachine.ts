/**
 * Agent State Machine
 *
 * Valid states: OFFLINE → AVAILABLE → RESERVED → DIALING → CONNECTED → WRAP_UP → AVAILABLE
 *
 * PAUSED can be entered from AVAILABLE at any time.
 *
 * Concurrency safety:
 *   All state transitions use optimistic locking via the `version` column.
 *   UPDATE agents SET status=?, version=version+1 WHERE id=? AND status=? AND version=?
 *   If 0 rows affected → another worker won the race → caller must handle gracefully.
 */

import Database from 'better-sqlite3';
import { getDb } from '../db/index';

export type AgentStatus =
  | 'OFFLINE'
  | 'AVAILABLE'
  | 'RESERVED'
  | 'DIALING'
  | 'CONNECTED'
  | 'WRAP_UP'
  | 'PAUSED';

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  worker_id: string | null;
  reserved_at: number | null;
  connected_at: number | null;
  wrap_up_started_at: number | null;
  last_heartbeat: number;
  version: number;
  created_at: number;
}

// Valid state transitions
const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  OFFLINE:    ['AVAILABLE'],
  AVAILABLE:  ['RESERVED', 'PAUSED', 'OFFLINE'],
  RESERVED:   ['DIALING', 'AVAILABLE', 'OFFLINE'],   // AVAILABLE = reservation released
  DIALING:    ['CONNECTED', 'AVAILABLE', 'OFFLINE'],  // AVAILABLE = call failed
  CONNECTED:  ['WRAP_UP', 'AVAILABLE', 'OFFLINE'],
  WRAP_UP:    ['AVAILABLE', 'PAUSED', 'OFFLINE'],
  PAUSED:     ['AVAILABLE', 'OFFLINE'],
};

export class AgentStateMachine {
  private db: Database.Database;

  constructor() {
    this.db = getDb();
  }

  /**
   * Atomically transitions an agent from expectedStatus → newStatus.
   * Uses optimistic locking (version column) to prevent race conditions.
   * Returns true if transition succeeded, false if another worker won.
   */
  transition(
    agentId: string,
    expectedStatus: AgentStatus,
    newStatus: AgentStatus,
    workerId?: string,
    expectedVersion?: number
  ): boolean {
    if (!VALID_TRANSITIONS[expectedStatus].includes(newStatus)) {
      throw new Error(
        `Invalid agent transition: ${expectedStatus} → ${newStatus}`
      );
    }

    const now = Date.now();
    let sql: string;
    let params: (string | number | null)[];

    if (expectedVersion !== undefined) {
      // Strict optimistic locking with version check
      sql = `
        UPDATE agents
        SET status = ?,
            worker_id = ?,
            reserved_at = CASE WHEN ? = 'RESERVED' THEN ? ELSE reserved_at END,
            connected_at = CASE WHEN ? = 'CONNECTED' THEN ? ELSE connected_at END,
            wrap_up_started_at = CASE WHEN ? = 'WRAP_UP' THEN ? ELSE wrap_up_started_at END,
            last_heartbeat = ?,
            version = version + 1
        WHERE id = ? AND status = ? AND version = ?
      `;
      params = [
        newStatus,
        workerId ?? null,
        newStatus, now,
        newStatus, now,
        newStatus, now,
        now,
        agentId, expectedStatus, expectedVersion,
      ];
    } else {
      // Simpler transition without version (used for recovery)
      sql = `
        UPDATE agents
        SET status = ?,
            worker_id = ?,
            reserved_at = CASE WHEN ? = 'RESERVED' THEN ? ELSE reserved_at END,
            connected_at = CASE WHEN ? = 'CONNECTED' THEN ? ELSE connected_at END,
            wrap_up_started_at = CASE WHEN ? = 'WRAP_UP' THEN ? ELSE wrap_up_started_at END,
            last_heartbeat = ?,
            version = version + 1
        WHERE id = ? AND status = ?
      `;
      params = [
        newStatus,
        workerId ?? null,
        newStatus, now,
        newStatus, now,
        newStatus, now,
        now,
        agentId, expectedStatus,
      ];
    }

    const result = this.db.prepare(sql).run(...params);
    return result.changes === 1;
  }

  /**
   * Atomically reserve an AVAILABLE agent for a specific worker.
   * This is the critical section — only ONE worker can win.
   */
  reserve(agentId: string, workerId: string): boolean {
    const agent = this.getAgent(agentId);
    if (!agent || agent.status !== 'AVAILABLE') return false;
    return this.transition(agentId, 'AVAILABLE', 'RESERVED', workerId, agent.version);
  }

  /**
   * Release a reservation (e.g., call failed to initiate)
   */
  release(agentId: string, workerId: string): boolean {
    const result = this.db.prepare(`
      UPDATE agents SET status='AVAILABLE', worker_id=NULL, reserved_at=NULL, version=version+1, last_heartbeat=?
      WHERE id=? AND worker_id=? AND status IN ('RESERVED','DIALING')
    `).run(Date.now(), agentId, workerId);
    return result.changes === 1;
  }

  getAgent(id: string): Agent | null {
    return (this.db.prepare('SELECT * FROM agents WHERE id=?').get(id) as Agent) ?? null;
  }

  getAvailableAgents(limit: number = 100): Agent[] {
    return this.db.prepare(
      `SELECT * FROM agents WHERE status='AVAILABLE' ORDER BY last_heartbeat ASC LIMIT ?`
    ).all(limit) as Agent[];
  }

  getAgentCounts(): Record<AgentStatus, number> {
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) as count FROM agents GROUP BY status`
    ).all() as { status: AgentStatus; count: number }[];

    const counts: Record<AgentStatus, number> = {
      OFFLINE: 0, AVAILABLE: 0, RESERVED: 0,
      DIALING: 0, CONNECTED: 0, WRAP_UP: 0, PAUSED: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  /**
   * Recovery: find agents stuck in RESERVED/DIALING without a heartbeat
   * (worker crashed). Release them back to AVAILABLE.
   */
  recoverStaleAgents(staleThresholdMs: number = 30000): number {
    const cutoff = Date.now() - staleThresholdMs;
    const result = this.db.prepare(`
      UPDATE agents
      SET status='AVAILABLE', worker_id=NULL, reserved_at=NULL, version=version+1
      WHERE status IN ('RESERVED','DIALING') AND last_heartbeat < ?
    `).run(cutoff);
    return result.changes;
  }
}
