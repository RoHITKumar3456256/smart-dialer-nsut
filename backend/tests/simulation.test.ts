/**
 * Simulation Tests
 *
 * Verifies the predictive engine EWMA and pacing logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PredictiveEngine } from '../src/pacing/PredictiveEngine';
import { ProgressiveEngine } from '../src/pacing/ProgressiveEngine';
import { getDb } from '../src/db/index';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

describe('Predictive Engine', () => {
  let db: Database.Database;
  let engine: PredictiveEngine;
  const campaignId = 'test-pred-campaign';

  beforeEach(() => {
    db = getDb();
    engine = new PredictiveEngine();

    db.prepare('DELETE FROM call_events').run();
    db.prepare('DELETE FROM calls').run();
    db.prepare('DELETE FROM borrowers').run();
    db.prepare('DELETE FROM agents').run();
    db.prepare('DELETE FROM pacing_decisions').run();
    db.prepare('DELETE FROM metrics').run();
    db.prepare('DELETE FROM campaigns').run();

    db.prepare(`INSERT INTO campaigns (id, name, mode) VALUES (?, 'Test', 'predictive')`)
      .run(campaignId);

    // 20 available agents
    for (let i = 0; i < 20; i++) {
      db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'AVAILABLE')`)
        .run(uuidv4(), `Agent-${i}`);
    }

    // 100 pending borrowers
    for (let i = 0; i < 100; i++) {
      db.prepare(`INSERT INTO borrowers (id, name, phone, campaign_id, status) VALUES (?, ?, ?, ?, 'pending')`)
        .run(uuidv4(), `Borrower-${i}`, `+155500${String(i).padStart(5, '0')}`, campaignId);
    }

    engine.resetState(campaignId);
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

  it('proposes more calls at low answer rate (20%) than high (70%)', () => {
    const result20 = engine.calculate(campaignId, 0.20);
    engine.resetState(campaignId);
    const result70 = engine.calculate(campaignId, 0.70);

    // At 20% answer rate: need 5x calls to fill same agents
    // At 70% answer rate: need ~1.4x calls
    // So low answer rate should propose MORE calls
    expect(result20.callsToStart).toBeGreaterThan(result70.callsToStart);
  });

  it('proposes 0 calls when no borrowers pending', () => {
    db.prepare(`UPDATE borrowers SET status='done'`).run();
    const result = engine.calculate(campaignId, 0.5);
    expect(result.callsToStart).toBe(0);
  });

  it('EWMA smooths out sudden answer rate changes', () => {
    // Initialize with 50% rate
    for (let i = 0; i < 10; i++) engine.calculate(campaignId, 0.50);
    const stable = engine.getAnswerRateState(campaignId);

    // Suddenly drop to 10%
    engine.calculate(campaignId, 0.10);
    const afterDrop = engine.getAnswerRateState(campaignId);

    // EWMA should not fully adopt the new rate immediately
    expect(afterDrop.rate).toBeGreaterThan(0.10);
    expect(afterDrop.rate).toBeLessThan(stable.rate);
  });

  it('answer rate floor prevents divide-by-near-zero explosion', () => {
    // Even with 0% answer rate injected, calls should be bounded
    for (let i = 0; i < 5; i++) engine.calculate(campaignId, 0.01);
    const result = engine.calculate(campaignId, 0.0);

    // Should not crash and should be bounded
    expect(result.callsToStart).toBeLessThanOrEqual(200); // reasonable bound
    expect(result.callsToStart).toBeGreaterThanOrEqual(0);
  });
});

describe('Progressive Engine', () => {
  let db: Database.Database;
  const campaignId = 'test-prog-campaign';

  beforeEach(() => {
    db = getDb();
    db.prepare('DELETE FROM call_events').run();
    db.prepare('DELETE FROM calls').run();
    db.prepare('DELETE FROM borrowers').run();
    db.prepare('DELETE FROM agents').run();
    db.prepare('DELETE FROM pacing_decisions').run();
    db.prepare('DELETE FROM metrics').run();
    db.prepare('DELETE FROM campaigns').run();

    db.prepare(`INSERT INTO campaigns (id, name, mode) VALUES (?, 'Test', 'progressive')`)
      .run(campaignId);

    for (let i = 0; i < 10; i++) {
      db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'AVAILABLE')`)
        .run(uuidv4(), `Agent-${i}`);
    }

    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO borrowers (id, name, phone, campaign_id, status) VALUES (?, ?, ?, ?, 'pending')`)
        .run(uuidv4(), `Borrower-${i}`, `+155500${i}`, campaignId);
    }
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

  it('calls to start = min(available_agents, pending_borrowers)', () => {
    const engine = new ProgressiveEngine();
    const result = engine.calculate(campaignId);
    // 10 agents, 5 borrowers → min = 5
    expect(result.callsToStart).toBe(5);
  });

  it('never proposes more than available agents', () => {
    // Add 100 borrowers
    for (let i = 0; i < 100; i++) {
      db.prepare(`INSERT INTO borrowers (id, name, phone, campaign_id, status) VALUES (?, ?, ?, ?, 'pending')`)
        .run(uuidv4(), `B${i}`, `+1555${i}`, campaignId);
    }
    const engine = new ProgressiveEngine();
    const result = engine.calculate(campaignId);
    expect(result.callsToStart).toBeLessThanOrEqual(10); // 10 agents max
  });

  it('returns 0 when no agents available', () => {
    db.prepare(`UPDATE agents SET status='CONNECTED'`).run();
    const engine = new ProgressiveEngine();
    const result = engine.calculate(campaignId);
    expect(result.callsToStart).toBe(0);
  });
});
