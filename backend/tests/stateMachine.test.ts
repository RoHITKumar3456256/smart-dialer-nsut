/**
 * State Machine Tests
 *
 * Tests for:
 * - Out-of-order event handling
 * - Duplicate event idempotency
 * - Terminal state protection
 * - Call lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '../src/db/index';
import { CallStateMachine } from '../src/state/CallStateMachine';
import { AgentStateMachine } from '../src/state/AgentStateMachine';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';

describe('Call State Machine — Out-of-Order Events', () => {
  let db: Database.Database;
  let callSM: CallStateMachine;
  let callId: string;

  beforeEach(() => {
    db = getDb();
    callSM = new CallStateMachine();
    callId = uuidv4();

    // Clean slate
    db.prepare('DELETE FROM call_events').run();
    db.prepare('DELETE FROM calls').run();
    db.prepare('DELETE FROM borrowers').run();
    db.prepare('DELETE FROM agents').run();
    db.prepare('DELETE FROM pacing_decisions').run();
    db.prepare('DELETE FROM metrics').run();
    db.prepare('DELETE FROM campaigns').run();
    db.prepare(`INSERT INTO campaigns (id, name, mode) VALUES ('c1', 'Test', 'progressive')`).run();

    // Create a call in RINGING state
    db.prepare(`
      INSERT INTO calls (id, campaign_id, provider, status) VALUES (?, 'c1', 'ProviderA', 'RINGING')
    `).run(callId);
  });

  afterEach(() => {
    db.prepare('DELETE FROM call_events').run();
    db.prepare('DELETE FROM calls').run();
    db.prepare('DELETE FROM borrowers').run();
    db.prepare('DELETE FROM agents').run();
    db.prepare('DELETE FROM pacing_decisions').run();
    db.prepare('DELETE FROM metrics').run();
    db.prepare('DELETE FROM campaigns').run();
  });

  it('duplicate ANSWERED event is idempotent (no double state change)', () => {
    callSM.transition(callId, 'ANSWERED');
    expect(callSM.getCall(callId)?.status).toBe('ANSWERED');

    const result = callSM.transition(callId, 'ANSWERED'); // duplicate
    expect(result).toBe('duplicate');
    expect(callSM.getCall(callId)?.status).toBe('ANSWERED'); // unchanged
  });

  it('out-of-order RINGING after COMPLETED is ignored', () => {
    callSM.transition(callId, 'ANSWERED');
    callSM.transition(callId, 'CONNECTED');
    callSM.transition(callId, 'COMPLETED');

    const result = callSM.transition(callId, 'RINGING'); // OOO
    expect(result).toBe('ignored');
    expect(callSM.getCall(callId)?.status).toBe('COMPLETED');
  });

  it('COMPLETED after ANSWERED is valid and terminal', () => {
    callSM.transition(callId, 'ANSWERED');
    const result = callSM.transition(callId, 'COMPLETED');
    expect(result).toBe('advanced');
    expect(callSM.getCall(callId)?.status).toBe('COMPLETED');
  });

  it('cannot transition out of terminal COMPLETED state', () => {
    callSM.transition(callId, 'ANSWERED');
    callSM.transition(callId, 'COMPLETED');

    const result = callSM.transition(callId, 'FAILED');
    expect(result).toBe('terminal');
    expect(callSM.getCall(callId)?.status).toBe('COMPLETED');
  });

  it('ANSWERED → COMPLETED → ANSWERED is ignored (classic Provider B scenario)', () => {
    // This is the exact scenario from the PDF:
    // Provider sends: ANSWERED, ANSWERED, ANSWERED, COMPLETED
    callSM.transition(callId, 'ANSWERED');  // advance
    callSM.transition(callId, 'ANSWERED');  // duplicate → no-op
    callSM.transition(callId, 'ANSWERED');  // duplicate → no-op
    callSM.transition(callId, 'COMPLETED'); // advance

    // Then: COMPLETED, ANSWERED, RINGING (out-of-order)
    callSM.transition(callId, 'COMPLETED'); // duplicate of terminal
    const r1 = callSM.transition(callId, 'ANSWERED'); // should be ignored
    const r2 = callSM.transition(callId, 'RINGING');  // should be ignored

    expect(r1).toBe('ignored');
    expect(r2).toBe('ignored');
    expect(callSM.getCall(callId)?.status).toBe('COMPLETED');
  });

  it('provider event idempotency key prevents duplicate recording', () => {
    const key = 'test-idempotency-key-123';
    const result1 = callSM.recordProviderEvent(callId, 'ANSWERED', 'ProviderA', {}, key);
    const result2 = callSM.recordProviderEvent(callId, 'ANSWERED', 'ProviderA', {}, key);
    expect(result1).toBe(true);
    expect(result2).toBe(false); // duplicate
  });

  it('stale call recovery marks stuck calls as FAILED', () => {
    // Create a call stuck in INITIATED with old heartbeat
    const staleCallId = uuidv4();
    db.prepare(`
      INSERT INTO calls (id, campaign_id, provider, status, last_heartbeat)
      VALUES (?, 'c1', 'ProviderA', 'INITIATED', ?)
    `).run(staleCallId, Date.now() - 60000);

    const recovered = callSM.recoverStaleCalls(30000);
    expect(recovered).toBe(1);
    expect(callSM.getCall(staleCallId)?.status).toBe('FAILED');
  });
});

describe('Agent State Machine', () => {
  let db: Database.Database;
  let agentSM: AgentStateMachine;

  beforeEach(() => {
    db = getDb();
    agentSM = new AgentStateMachine();
    db.prepare('DELETE FROM agents').run();
    db.prepare(`INSERT INTO agents (id, name, status) VALUES ('a1', 'Agent 1', 'AVAILABLE')`).run();
  });

  afterEach(() => {
    db.prepare('DELETE FROM agents').run();
  });

  it('valid lifecycle: AVAILABLE → RESERVED → DIALING → CONNECTED → WRAP_UP → AVAILABLE', () => {
    expect(agentSM.transition('a1', 'AVAILABLE', 'RESERVED', 'w1')).toBe(true);
    expect(agentSM.transition('a1', 'RESERVED', 'DIALING', 'w1')).toBe(true);
    expect(agentSM.transition('a1', 'DIALING', 'CONNECTED', 'w1')).toBe(true);
    expect(agentSM.transition('a1', 'CONNECTED', 'WRAP_UP', 'w1')).toBe(true);
    expect(agentSM.transition('a1', 'WRAP_UP', 'AVAILABLE', 'w1')).toBe(true);
    expect(agentSM.getAgent('a1')?.status).toBe('AVAILABLE');
  });

  it('AVAILABLE → PAUSED is valid', () => {
    expect(agentSM.transition('a1', 'AVAILABLE', 'PAUSED', 'w1')).toBe(true);
  });

  it('CONNECTED → RESERVED is invalid and throws', () => {
    agentSM.transition('a1', 'AVAILABLE', 'RESERVED', 'w1');
    agentSM.transition('a1', 'RESERVED', 'DIALING', 'w1');
    agentSM.transition('a1', 'DIALING', 'CONNECTED', 'w1');

    expect(() => agentSM.transition('a1', 'CONNECTED', 'RESERVED', 'w1'))
      .toThrow('Invalid agent transition');
  });
});
