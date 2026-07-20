// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Destination Adapter — the interface every Broadcast destination implements.
 *
 * An adapter takes a RedactedEnvelope (already sampled, redacted, and
 * serialized to the destination's native format by upstream stages) and
 * sends it to its target service. The adapter does NOT apply sampling or
 * privacy policy — those are enforced upstream (see ADR-016, ADR-018).
 *
 * Error classification is critical: the delivery executor needs to know
 * whether a failure is RETRYABLE (network glitch, 5xx) or PERMANENT (4xx,
 * auth, schema). Each adapter classifies its own failure modes.
 */

import type { TraceEnvelope } from '@/broadcast/domain/trace-envelope';

/** Canonical destination types supported by the broadcast pipeline. */
export const DESTINATION_TYPES = [
  'webhook',
  'langfuse',
  'datadog',
  'otlp_collector',
] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

/**
 * Outcome of a delivery attempt. RETRYABLE means the executor should back off
 * and retry; PERMANENT means the envelope should go to the DLQ after the
 * current attempt (no point in retrying).
 */
export type DeliveryOutcomeKind = 'success' | 'retryable' | 'permanent';

export interface DeliveryOutcome {
  kind: DeliveryOutcomeKind;
  /** HTTP status (or adapter-specific equivalent) for observability. */
  statusCode?: number;
  /** Human-readable error classification (e.g., "auth_failed", "rate_limit"). */
  errorClass?: string;
  /** Truncated error body for DLQ diagnosis. MUST NOT contain plaintext PII. */
  errorMessage?: string;
  /** Duration in ms. */
  latencyMs: number;
}

/**
 * Context passed to every send call. The envelope is the already-redacted
 * envelope ready to be serialized; adapters serialize to their own wire format.
 */
export interface DeliveryContext {
  /** Canonical broadcast identifier for this attempt (used in logs/metrics). */
  deliveryAttemptId: string;
  /** The envelope after upstream sampling + privacy redaction. */
  envelope: TraceEnvelope;
  /** Decrypted destination config. Each adapter types this further. */
  config: Record<string, unknown>;
  /** Destination row identifier for audit logs. */
  destinationId: string;
  /** Overall timeout for the send attempt, in ms. Adapters MUST respect it. */
  timeoutMs: number;
  /**
   * AbortSignal that fires when the executor decides to give up (e.g., a
   * shutdown signal or higher-level deadline). Adapters SHOULD propagate it
   * to their network client.
   */
  signal?: AbortSignal;
}

export interface DestinationAdapter {
  readonly type: DestinationType;
  /**
   * Send a single envelope. Must not throw — return a `DeliveryOutcome`
   * with `kind = 'retryable' | 'permanent'` on failure.
   */
  send(ctx: DeliveryContext): Promise<DeliveryOutcome>;
}

/** Registry key used by the executor to resolve adapters by destination type. */
export type DestinationAdapterRegistry = Readonly<
  Record<DestinationType, DestinationAdapter>
>;
