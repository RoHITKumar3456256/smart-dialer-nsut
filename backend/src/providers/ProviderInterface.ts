/**
 * Telecom Provider Interface
 * 
 * All providers must implement this interface. The dialer is completely
 * decoupled from provider internals — it only sees this abstraction.
 */

export interface ProviderCallResult {
  success: boolean;
  callSid?: string;
  error?: string;
}

export interface ProviderHealth {
  healthy: boolean;
  successRate: number;   // 0-1
  avgLatencyMs: number;
  recentFailures: number;
  recentAttempts: number;
}

export type ProviderEventCallback = (
  callId: string,
  event: ProviderEvent
) => void;

export interface ProviderEvent {
  type: 'RINGING' | 'ANSWERED' | 'COMPLETED' | 'FAILED';
  callSid: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}

export interface TelecomProvider {
  readonly name: string;

  /** Initiate an outbound call */
  initiateCall(
    callId: string,
    toPhone: string,
    fromPhone: string,
    metadata?: Record<string, unknown>
  ): Promise<ProviderCallResult>;

  /** Terminate a call in progress */
  terminateCall(callSid: string): Promise<boolean>;

  /** Register a callback for incoming provider events */
  onEvent(callback: ProviderEventCallback): void;

  /** Get current provider health */
  getHealth(): ProviderHealth;
}
