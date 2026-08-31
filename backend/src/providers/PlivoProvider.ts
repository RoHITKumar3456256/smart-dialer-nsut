/**
 * Plivo Telecom Provider Adapter
 *
 * Optional real-world telecom provider integration (as suggested in assignment spec).
 * Uses standard Plivo REST API endpoints for outbound call initiation and webhook events.
 *
 * If credentials (PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN) are not provided in environment,
 * gracefully acts in sandbox simulated mode.
 */

import { EventEmitter } from 'events';
import {
  TelecomProvider,
  ProviderCallResult,
  ProviderHealth,
  ProviderEventCallback,
  ProviderEvent,
} from './ProviderInterface';

export class PlivoProvider implements TelecomProvider {
  readonly name = 'Plivo';
  private emitter = new EventEmitter();
  private authId: string | null;
  private authToken: string | null;
  private recentAttempts: boolean[] = [];

  constructor() {
    this.authId = process.env.PLIVO_AUTH_ID ?? null;
    this.authToken = process.env.PLIVO_AUTH_TOKEN ?? null;
  }

  isLiveIntegrationConfigured(): boolean {
    return Boolean(this.authId && this.authToken);
  }

  onEvent(callback: ProviderEventCallback): void {
    this.emitter.on('provider_event', (callId: string, event: ProviderEvent) => {
      callback(callId, event);
    });
  }

  /**
   * Initiate call through Plivo REST API or sandbox simulation
   */
  async initiateCall(
    callId: string,
    toPhone: string,
    fromPhone: string,
    metadata?: Record<string, unknown>
  ): Promise<ProviderCallResult> {
    if (this.isLiveIntegrationConfigured()) {
      try {
        const authHeader = 'Basic ' + Buffer.from(`${this.authId}:${this.authToken}`).toString('base64');
        const response = await fetch(`https://api.plivo.com/v1/Account/${this.authId}/Call/`, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromPhone,
            to: toPhone,
            answer_url: `${process.env.PUBLIC_API_URL ?? 'http://localhost:3001'}/api/webhooks/plivo/answer?callId=${callId}`,
            hangup_url: `${process.env.PUBLIC_API_URL ?? 'http://localhost:3001'}/api/webhooks/plivo/hangup?callId=${callId}`,
            extra_dial_string: metadata ? JSON.stringify(metadata) : undefined,
          }),
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          this.recordAttempt(false);
          return { success: false, error: (errData as any).message ?? 'Plivo API error' };
        }

        const data = await response.json() as { request_uuid: string };
        this.recordAttempt(true);
        return { success: true, callSid: data.request_uuid };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Network error connecting to Plivo';
        this.recordAttempt(false);
        return { success: false, error: message };
      }
    } else {
      // Sandbox fallback mode
      this.recordAttempt(true);
      const callSid = `PLIVO-SANDBOX-${callId}-${Date.now()}`;
      this.scheduleSandboxEvents(callId, callSid);
      return { success: true, callSid };
    }
  }

  async terminateCall(callSid: string): Promise<boolean> {
    if (this.isLiveIntegrationConfigured()) {
      try {
        const authHeader = 'Basic ' + Buffer.from(`${this.authId}:${this.authToken}`).toString('base64');
        const response = await fetch(`https://api.plivo.com/v1/Account/${this.authId}/Call/${callSid}/`, {
          method: 'DELETE',
          headers: { 'Authorization': authHeader },
        });
        return response.ok;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Handle incoming webhook event from Plivo HTTP callback
   */
  handleWebhookEvent(callId: string, plivoStatus: string, callSid: string): void {
    let eventType: ProviderEvent['type'] | null = null;

    switch (plivoStatus.toLowerCase()) {
      case 'ringing':
        eventType = 'RINGING';
        break;
      case 'in-progress':
      case 'answered':
        eventType = 'ANSWERED';
        break;
      case 'completed':
        eventType = 'COMPLETED';
        break;
      case 'failed':
      case 'busy':
      case 'no-answer':
        eventType = 'FAILED';
        break;
    }

    if (eventType) {
      this.emitter.emit('provider_event', callId, {
        type: eventType,
        callSid,
        timestamp: Date.now(),
        payload: { plivoStatus },
      });
    }
  }

  getHealth(): ProviderHealth {
    const recent = this.recentAttempts.slice(-50);
    const successCount = recent.filter(Boolean).length;
    return {
      healthy: recent.length === 0 || successCount / recent.length > 0.7,
      successRate: recent.length ? successCount / recent.length : 1.0,
      avgLatencyMs: 400,
      recentFailures: recent.filter(x => !x).length,
      recentAttempts: recent.length,
    };
  }

  private scheduleSandboxEvents(callId: string, callSid: string): void {
    setTimeout(() => {
      this.emitter.emit('provider_event', callId, { type: 'RINGING', callSid, timestamp: Date.now() });
    }, 400);

    setTimeout(() => {
      this.emitter.emit('provider_event', callId, { type: 'ANSWERED', callSid, timestamp: Date.now() });
      setTimeout(() => {
        this.emitter.emit('provider_event', callId, { type: 'COMPLETED', callSid, timestamp: Date.now() });
      }, 5000);
    }, 1800);
  }

  private recordAttempt(success: boolean): void {
    this.recentAttempts.push(success);
    if (this.recentAttempts.length > 100) this.recentAttempts.shift();
  }
}
