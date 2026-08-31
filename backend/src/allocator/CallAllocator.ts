/**
 * Call Allocator
 *
 * Orchestrates the full call lifecycle:
 * 1. Atomically reserves an agent (exactly one worker can win)
 * 2. Atomically reserves a borrower (prevents double-dialing)
 * 3. Initiates the call through the provider
 * 4. Handles all call events from the provider
 * 5. Releases agent on call completion
 *
 * Idempotency: each call gets a unique idempotency_key.
 * Worker crash recovery is handled by AgentStateMachine.recoverStaleAgents()
 * and CallStateMachine.recoverStaleCalls().
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import Database from 'better-sqlite3';
import { AgentStateMachine } from '../state/AgentStateMachine';
import { CallStateMachine } from '../state/CallStateMachine';
import { TelecomProvider, ProviderEvent } from '../providers/ProviderInterface';
import { EventEmitter } from 'events';

export interface AllocationResult {
  success: boolean;
  callId?: string;
  agentId?: string;
  borrowerId?: string;
  error?: string;
}

export class CallAllocator extends EventEmitter {
  private db: Database.Database;
  private agentSM: AgentStateMachine;
  private callSM: CallStateMachine;
  private provider: TelecomProvider;
  private workerId: string;

  constructor(provider: TelecomProvider, workerId: string) {
    super();
    this.db = getDb();
    this.agentSM = new AgentStateMachine();
    this.callSM = new CallStateMachine();
    this.provider = provider;
    this.workerId = workerId;

    // Listen for provider events
    this.provider.onEvent(this.handleProviderEvent.bind(this));
  }

  /**
   * Attempt to start one call: reserve agent + borrower + initiate.
   * This entire sequence is idempotent via the idempotency_key.
   */
  async allocateAndDial(campaignId: string): Promise<AllocationResult> {
    // ── Step 1: Atomically reserve an available agent ──────────────────────
    const agent = this.atomicReserveAgent();
    if (!agent) {
      return { success: false, error: 'No available agents' };
    }

    // ── Step 2: Atomically reserve a pending borrower ──────────────────────
    const borrower = this.atomicReserveBorrower(campaignId);
    if (!borrower) {
      // Release agent — no borrower available
      this.agentSM.release(agent.id, this.workerId);
      return { success: false, error: 'No pending borrowers' };
    }

    // ── Step 3: Create call record (idempotency key prevents duplicates) ───
    const callId = uuidv4();
    const idempotencyKey = `${campaignId}-${agent.id}-${borrower.id}-${Date.now()}`;

    try {
      this.db.prepare(`
        INSERT INTO calls (id, campaign_id, agent_id, borrower_id, provider, status, worker_id, idempotency_key, last_heartbeat)
        VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?)
      `).run(callId, campaignId, agent.id, borrower.id, this.provider.name, this.workerId, idempotencyKey, Date.now());
    } catch {
      // Duplicate idempotency_key → release and bail
      this.agentSM.release(agent.id, this.workerId);
      this.releaseBorrower(borrower.id);
      return { success: false, error: 'Duplicate call allocation' };
    }

    // ── Step 4: Transition agent to DIALING ────────────────────────────────
    this.agentSM.transition(agent.id, 'RESERVED', 'DIALING', this.workerId);
    this.callSM.transition(callId, 'INITIATED', undefined, undefined, this.workerId);

    // ── Step 5: Initiate call via provider ─────────────────────────────────
    try {
      this.updateHeartbeat(callId);
      const result = await this.provider.initiateCall(
        callId,
        borrower.phone,
        '+1800SMARTDIAL',
        { agentId: agent.id, campaignId }
      );

      if (!result.success) {
        // Call failed at provider level
        this.callSM.transition(callId, 'FAILED', undefined, result.error ?? 'Provider error', this.workerId);
        this.agentSM.transition(agent.id, 'DIALING', 'AVAILABLE', this.workerId);
        this.releaseBorrower(borrower.id);
        this.db.prepare(`UPDATE borrowers SET attempts=attempts+1, last_attempt_at=? WHERE id=?`)
          .run(Date.now(), borrower.id);
        return { success: false, callId, error: result.error };
      }

      // Update borrower to called state
      this.db.prepare(`UPDATE borrowers SET status='called', last_attempt_at=? WHERE id=?`)
        .run(Date.now(), borrower.id);

      this.emit('call_started', { callId, agentId: agent.id, borrowerId: borrower.id, campaignId });
      return { success: true, callId, agentId: agent.id, borrowerId: borrower.id };

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.callSM.transition(callId, 'FAILED', undefined, message, this.workerId);
      this.agentSM.transition(agent.id, 'DIALING', 'AVAILABLE', this.workerId);
      this.releaseBorrower(borrower.id);
      return { success: false, callId, error: message };
    }
  }

  /**
   * Handle incoming provider events (RINGING, ANSWERED, COMPLETED, FAILED).
   * Idempotent: duplicate events are safely ignored.
   */
  private handleProviderEvent(callId: string, event: ProviderEvent): void {
    const idempotencyKey = `${callId}-${event.type}-${event.timestamp}`;

    // Record event idempotently
    const isNew = this.callSM.recordProviderEvent(
      callId, event.type, this.provider.name, event.payload ?? {}, idempotencyKey
    );

    if (!isNew) {
      // Duplicate event → log and ignore
      this.emit('duplicate_event', { callId, event });
      return;
    }

    const call = this.callSM.getCall(callId);
    if (!call) return;

    let result: string;
    switch (event.type) {
      case 'RINGING':
        result = this.callSM.transition(callId, 'RINGING');
        break;

      case 'ANSWERED':
        result = this.callSM.transition(callId, 'ANSWERED');
        if (result === 'advanced' && call.agent_id) {
          this.agentSM.transition(call.agent_id, 'DIALING', 'CONNECTED', this.workerId);
          this.callSM.transition(callId, 'CONNECTED');
        }
        break;

      case 'COMPLETED':
      case 'FAILED':
        result = this.callSM.transition(callId, event.type === 'COMPLETED' ? 'COMPLETED' : 'FAILED');
        if ((result === 'advanced' || result === 'duplicate') && call.agent_id) {
          const agent = this.agentSM.getAgent(call.agent_id);
          if (agent && ['CONNECTED', 'DIALING', 'RESERVED'].includes(agent.status)) {
            this.agentSM.transition(call.agent_id, agent.status as any, 'WRAP_UP', this.workerId);
            // Auto-complete wrap up after 5s in simulator
            setTimeout(() => {
              this.agentSM.transition(call.agent_id!, 'WRAP_UP', 'AVAILABLE', this.workerId);
            }, 5000);
          }
        }
        this.emit('call_ended', { callId, event });
        break;
    }

    this.emit('event_processed', { callId, event, result: result! });
    this.updateHeartbeat(callId);
  }

  private updateHeartbeat(callId: string): void {
    this.db.prepare('UPDATE calls SET last_heartbeat=? WHERE id=?').run(Date.now(), callId);
  }

  /**
   * Atomic agent reservation using SQLite's serialized writes.
   * SELECT + UPDATE in a transaction with version check.
   * Only ONE worker can win.
   */
  private atomicReserveAgent(): { id: string; phone?: string } | null {
    const reserveTransaction = this.db.transaction(() => {
      const agent = this.db.prepare(`
        SELECT id, version FROM agents WHERE status='AVAILABLE' LIMIT 1
      `).get() as { id: string; version: number } | undefined;

      if (!agent) return null;

      const result = this.db.prepare(`
        UPDATE agents SET status='RESERVED', worker_id=?, reserved_at=?, 
               last_heartbeat=?, version=version+1
        WHERE id=? AND status='AVAILABLE' AND version=?
      `).run(this.workerId, Date.now(), Date.now(), agent.id, agent.version);

      return result.changes === 1 ? { id: agent.id } : null;
    });

    return reserveTransaction() as { id: string } | null;
  }

  /**
   * Atomic borrower reservation — prevents double-dialing the same person.
   */
  private atomicReserveBorrower(campaignId: string): { id: string; phone: string } | null {
    const reserveTransaction = this.db.transaction(() => {
      const borrower = this.db.prepare(`
        SELECT id, phone FROM borrowers WHERE campaign_id=? AND status='pending' LIMIT 1
      `).get(campaignId) as { id: string; phone: string } | undefined;

      if (!borrower) return null;

      const result = this.db.prepare(`
        UPDATE borrowers SET status='reserved', reserved_at=?
        WHERE id=? AND status='pending'
      `).run(Date.now(), borrower.id);

      return result.changes === 1 ? borrower : null;
    });

    return reserveTransaction() as { id: string; phone: string } | null;
  }

  private releaseBorrower(borrowerId: string): void {
    this.db.prepare(`UPDATE borrowers SET status='pending', reserved_at=NULL WHERE id=?`)
      .run(borrowerId);
  }
}
