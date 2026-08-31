/**
 * Provider B — Slow, Unreliable
 * - Higher latency (800-3000ms)
 * - 20% failure rate
 * - Occasional timeouts
 * - Duplicate events (same event sent 2-3x)
 * - Events arriving out-of-order
 * 
 * This stress-tests the system's idempotency and OOO handling.
 */

import { EventEmitter } from 'events';
import {
  TelecomProvider,
  ProviderCallResult,
  ProviderHealth,
  ProviderEventCallback,
  ProviderEvent,
} from './ProviderInterface';

export class ProviderB implements TelecomProvider {
  readonly name = 'ProviderB';
  private emitter = new EventEmitter();
  private recentAttempts: boolean[] = [];

  private failureRate = 0.20;      // 20% failure
  private timeoutRate = 0.10;      // 10% hard timeout
  private duplicateEventRate = 0.3; // 30% chance of duplicate events
  private oooEventRate = 0.2;       // 20% chance of out-of-order events
  private ringDelayMs = 1200;
  private answerDelayMs = 4000;
  private callDurationMs = 6000;
  private isOutage = false;

  simulateOutage(active: boolean): void {
    this.isOutage = active;
  }

  onEvent(callback: ProviderEventCallback): void {
    this.emitter.on('provider_event', (callId: string, event: ProviderEvent) => {
      callback(callId, event);
    });
  }

  async initiateCall(
    callId: string,
    toPhone: string,
    _fromPhone: string,
    _metadata?: Record<string, unknown>
  ): Promise<ProviderCallResult> {
    // Slow to respond
    await this.delay(this.ringDelayMs + this.jitter(800));

    if (this.isOutage) {
      this.recordAttempt(false);
      return { success: false, error: 'Provider B outage' };
    }

    // Hard timeout
    if (Math.random() < this.timeoutRate) {
      await this.delay(5000); // simulate timeout
      this.recordAttempt(false);
      return { success: false, error: 'Provider B timeout' };
    }

    if (Math.random() < this.failureRate) {
      this.recordAttempt(false);
      return { success: false, error: 'Provider B call failed' };
    }

    this.recordAttempt(true);
    const callSid = `PB-${callId}-${Date.now()}`;
    this.scheduleEvents(callId, callSid);
    return { success: true, callSid };
  }

  async terminateCall(_callSid: string): Promise<boolean> {
    return true;
  }

  getHealth(): ProviderHealth {
    const recent = this.recentAttempts.slice(-50);
    const successCount = recent.filter(Boolean).length;
    return {
      healthy: !this.isOutage && (recent.length === 0 || successCount / recent.length > 0.5),
      successRate: recent.length ? successCount / recent.length : 0.8,
      avgLatencyMs: this.ringDelayMs + 800,
      recentFailures: recent.filter(x => !x).length,
      recentAttempts: recent.length,
    };
  }

  private scheduleEvents(callId: string, callSid: string): void {
    const answerRate = 0.50;
    const events: Array<[number, ProviderEvent]> = [];

    const ringEvent: ProviderEvent = { type: 'RINGING', callSid, timestamp: Date.now() };
    events.push([this.jitter(300) + 100, ringEvent]);

    if (Math.random() < answerRate) {
      const answeredEvent: ProviderEvent = { type: 'ANSWERED', callSid, timestamp: Date.now() };
      events.push([this.answerDelayMs + this.jitter(1000), answeredEvent]);

      const completedEvent: ProviderEvent = { type: 'COMPLETED', callSid, timestamp: Date.now() };
      events.push([this.answerDelayMs + this.callDurationMs + this.jitter(2000), completedEvent]);

      // Duplicate ANSWERED events
      if (Math.random() < this.duplicateEventRate) {
        events.push([this.answerDelayMs + this.jitter(500), { ...answeredEvent }]);
        events.push([this.answerDelayMs + this.jitter(800), { ...answeredEvent }]);
      }

      // Out-of-order: send COMPLETED before ANSWERED  
      if (Math.random() < this.oooEventRate) {
        // Move completed to arrive before answered
        const oooCompleted: ProviderEvent = { type: 'COMPLETED', callSid, timestamp: Date.now() };
        events.push([this.answerDelayMs - 200, oooCompleted]);
      }
    } else {
      const noAnswerCompleted: ProviderEvent = {
        type: 'COMPLETED', callSid, timestamp: Date.now(),
        payload: { reason: 'no-answer' }
      };
      events.push([this.answerDelayMs + this.jitter(2000), noAnswerCompleted]);

      // Duplicate RINGING
      if (Math.random() < this.duplicateEventRate) {
        events.push([this.jitter(400) + 200, { ...ringEvent }]);
      }
    }

    // Schedule all events
    for (const [delay, event] of events) {
      setTimeout(() => {
        this.emitter.emit('provider_event', callId, event);
      }, delay);
    }
  }

  private emit(callId: string, event: ProviderEvent): void {
    this.emitter.emit('provider_event', callId, event);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private jitter(max: number): number {
    return Math.floor(Math.random() * max);
  }

  private recordAttempt(success: boolean): void {
    this.recentAttempts.push(success);
    if (this.recentAttempts.length > 100) this.recentAttempts.shift();
  }
}
