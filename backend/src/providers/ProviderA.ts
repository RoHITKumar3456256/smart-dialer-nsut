/**
 * Provider A — Fast, Reliable
 * - Low latency (200-500ms)
 * - High success rate (95%+)
 * - Events arrive in correct order
 * - No duplicate events
 */

import { EventEmitter } from 'events';
import {
  TelecomProvider,
  ProviderCallResult,
  ProviderHealth,
  ProviderEventCallback,
  ProviderEvent,
} from './ProviderInterface';

export class ProviderA implements TelecomProvider {
  readonly name = 'ProviderA';
  private emitter = new EventEmitter();
  private recentAttempts: boolean[] = []; // true=success, false=failure (last 100)

  private failureRate = 0.05;     // 5% base failure rate
  private ringDelayMs = 300;      // fast ringing
  private answerDelayMs = 1500;   // quick answer simulation
  private callDurationMs = 5000;  // avg call duration
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
    // Simulate provider call
    await this.delay(this.ringDelayMs + this.jitter(100));

    if (this.isOutage) {
      this.recordAttempt(false);
      return { success: false, error: 'Provider outage' };
    }

    if (Math.random() < this.failureRate) {
      this.recordAttempt(false);
      return { success: false, error: 'Call initiation failed' };
    }

    this.recordAttempt(true);
    const callSid = `PA-${callId}-${Date.now()}`;

    // Simulate event sequence (in order, no duplicates)
    this.scheduleEvents(callId, callSid, toPhone);
    return { success: true, callSid };
  }

  async terminateCall(callSid: string): Promise<boolean> {
    // No-op for mock — just emit COMPLETED
    return true;
  }

  getHealth(): ProviderHealth {
    const recent = this.recentAttempts.slice(-50);
    const successCount = recent.filter(Boolean).length;
    return {
      healthy: !this.isOutage && (recent.length === 0 || successCount / recent.length > 0.7),
      successRate: recent.length ? successCount / recent.length : 1,
      avgLatencyMs: this.ringDelayMs,
      recentFailures: recent.filter(x => !x).length,
      recentAttempts: recent.length,
    };
  }

  private scheduleEvents(callId: string, callSid: string, toPhone: string): void {
    const answerRate = 0.65; // Provider A has decent answer rate in sim

    // RINGING event
    setTimeout(() => {
      this.emit(callId, { type: 'RINGING', callSid, timestamp: Date.now() });
    }, this.jitter(200));

    // ANSWERED or COMPLETED (no answer)
    setTimeout(() => {
      if (Math.random() < answerRate) {
        this.emit(callId, { type: 'ANSWERED', callSid, timestamp: Date.now() });

        // COMPLETED after talk time
        setTimeout(() => {
          this.emit(callId, { type: 'COMPLETED', callSid, timestamp: Date.now() });
        }, this.callDurationMs + this.jitter(2000));
      } else {
        // Not answered → COMPLETED
        this.emit(callId, { type: 'COMPLETED', callSid, timestamp: Date.now(), payload: { reason: 'no-answer' } });
      }
    }, this.answerDelayMs + this.jitter(500));
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
