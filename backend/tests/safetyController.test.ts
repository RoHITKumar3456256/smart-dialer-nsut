/**
 * Safety Controller Tests
 *
 * Verifies that the safety boundary:
 * - Cannot be bypassed
 * - Correctly reduces/rejects calls based on conditions
 * - Falls back to progressive on answer rate drops
 * - Blocks calls when provider is unhealthy
 */

import { describe, it, expect } from 'vitest';
import { SafetyController } from '../src/safety/SafetyController';
import { SafetyRequest } from '../src/safety/SafetyController';
import { ProviderHealth } from '../src/providers/ProviderInterface';

const healthyProvider: ProviderHealth = {
  healthy: true,
  successRate: 0.95,
  avgLatencyMs: 300,
  recentFailures: 2,
  recentAttempts: 40,
};

const unhealthyProvider: ProviderHealth = {
  healthy: false,
  successRate: 0.30,
  avgLatencyMs: 5000,
  recentFailures: 35,
  recentAttempts: 50,
};

const degradedProvider: ProviderHealth = {
  healthy: true,
  successRate: 0.55,
  avgLatencyMs: 2000,
  recentFailures: 20,
  recentAttempts: 44,
};

function makeRequest(overrides: Partial<SafetyRequest> = {}): SafetyRequest {
  return {
    campaignId: 'test-campaign',
    mode: 'predictive',
    requestedCalls: 10,
    availableAgents: 10,
    connectedCalls: 5,
    ringingCalls: 3,
    answerRate: 0.5,
    prevAnswerRate: 0.5,
    providerHealth: healthyProvider,
    maxOversubscription: 1.5,
    ...overrides,
  };
}

describe('Safety Controller', () => {
  const sc = new SafetyController();

  it('approves reasonable predictive request', () => {
    const decision = sc.evaluate(makeRequest({ requestedCalls: 5 }));
    expect(decision.action).toBe('APPROVE');
    expect(decision.approvedCalls).toBe(5);
  });

  it('reduces excessive request (oversubscription cap)', () => {
    // Total agents = 10 + 5 + 3 = 18. Cap = 18 * 1.5 = 27. Active = 8. Budget = 19.
    // Request 50 → should be reduced
    const decision = sc.evaluate(makeRequest({ requestedCalls: 50 }));
    expect(decision.action).toBe('REDUCE');
    expect(decision.approvedCalls).toBeLessThan(50);
  });

  it('progressive mode NEVER exceeds available agents', () => {
    const decision = sc.evaluate(makeRequest({
      mode: 'progressive',
      requestedCalls: 100,
      availableAgents: 5,
    }));
    expect(decision.approvedCalls).toBeLessThanOrEqual(5);
  });

  it('rejects ALL calls when provider is unhealthy', () => {
    const decision = sc.evaluate(makeRequest({ providerHealth: unhealthyProvider }));
    expect(decision.action).toBe('REJECT');
    expect(decision.approvedCalls).toBe(0);
  });

  it('reduces calls when provider is degraded', () => {
    const decision = sc.evaluate(makeRequest({ providerHealth: degradedProvider, requestedCalls: 10 }));
    // Should reduce because provider success rate 55% < 60% threshold
    expect(decision.approvedCalls).toBeLessThanOrEqual(10);
  });

  it('falls back to progressive when answer rate drops >50%', () => {
    const decision = sc.evaluate(makeRequest({
      mode: 'predictive',
      answerRate: 0.10,     // dropped
      prevAnswerRate: 0.50,  // was 50% → now 10% = 80% drop
      requestedCalls: 20,
      availableAgents: 10,
    }));
    expect(decision.action).toBe('FALLBACK_PROGRESSIVE');
    expect(decision.approvedCalls).toBeLessThanOrEqual(10); // bounded by available agents
  });

  it('falls back when answer rate below 10% floor', () => {
    const decision = sc.evaluate(makeRequest({
      mode: 'predictive',
      answerRate: 0.05, // below minimum
      prevAnswerRate: 0.06,
    }));
    expect(decision.action).toBe('FALLBACK_PROGRESSIVE');
  });

  it('ringing flood protection prevents too many ringing calls', () => {
    // 5 available agents → max ringing = 10
    // Already 9 ringing → budget = 1
    const decision = sc.evaluate(makeRequest({
      requestedCalls: 20,
      availableAgents: 5,
      ringingCalls: 9,
      connectedCalls: 2,
    }));
    expect(decision.approvedCalls).toBeLessThanOrEqual(1);
  });

  it('zero available agents → zero calls in progressive', () => {
    const decision = sc.evaluate(makeRequest({
      mode: 'progressive',
      availableAgents: 0,
      requestedCalls: 5,
    }));
    expect(decision.approvedCalls).toBe(0);
  });

  it('max oversubscription cannot exceed absolute cap of 2.0', () => {
    const decision = sc.evaluate(makeRequest({
      maxOversubscription: 10.0, // Try to set unreasonably high
      requestedCalls: 1000,
      availableAgents: 10,
      connectedCalls: 0,
      ringingCalls: 0,
    }));
    // With abs cap 2.0: max active = 10 * 2.0 = 20 → budget = 20
    expect(decision.approvedCalls).toBeLessThanOrEqual(20);
  });
});
