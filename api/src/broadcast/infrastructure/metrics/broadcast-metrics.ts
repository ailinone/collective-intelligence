// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Broadcast metrics — Prometheus counters, histograms, and gauges for the
 * broadcast pipeline. Exposed via the existing /metrics endpoint.
 *
 * Cardinality discipline (ADR-021):
 *   - `destination_type` is enum-bounded (webhook, langfuse, otlp_collector,
 *     datadog) — safe as a label.
 *   - `destination_id` and `tenant_id` are NOT labels — they'd blow up
 *     cardinality. Aggregate-by-destination should be done in traces/logs
 *     downstream, not here.
 *   - `error_class` is enum-bounded by each adapter's classify* function.
 *   - `outcome` is one of success/retryable/permanent — bounded.
 */

import promClient from 'prom-client';

function getOrCreate<T extends promClient.Metric>(name: string, factory: () => T): T {
  const existing = promClient.register.getSingleMetric(name);
  return (existing as T) ?? factory();
}

// ─── Outbox ─────────────────────────────────────────────────────────────

export const broadcastOutboxWritesTotal = getOrCreate(
  'ailin_broadcast_outbox_writes_total',
  () =>
    new promClient.Counter({
      name: 'ailin_broadcast_outbox_writes_total',
      help: 'TraceEnvelopes written to the outbox (pre-delivery).',
      labelNames: ['status'], // 'ok' | 'error'
    }),
);

export const broadcastOutboxLagSeconds = getOrCreate(
  'ailin_broadcast_outbox_lag_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_broadcast_outbox_lag_seconds',
      help: 'Seconds between envelope.occurredAt and poller drain.',
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 300],
    }),
);

export const broadcastOutboxBacklogRows = getOrCreate(
  'ailin_broadcast_outbox_backlog_rows',
  () =>
    new promClient.Gauge({
      name: 'ailin_broadcast_outbox_backlog_rows',
      help: 'Current count of undrained outbox rows (sampled each poll).',
    }),
);

// ─── Deliveries ─────────────────────────────────────────────────────────

export const broadcastDeliveriesTotal = getOrCreate(
  'ailin_broadcast_deliveries_total',
  () =>
    new promClient.Counter({
      name: 'ailin_broadcast_deliveries_total',
      help: 'Total delivery attempts by outcome.',
      labelNames: ['destination_type', 'outcome', 'error_class'],
    }),
);

export const broadcastDeliveryLatencySeconds = getOrCreate(
  'ailin_broadcast_delivery_latency_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_broadcast_delivery_latency_seconds',
      help: 'Wall-clock latency of a single delivery attempt.',
      labelNames: ['destination_type', 'outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    }),
);

export const broadcastDeliveryAttemptsHistogram = getOrCreate(
  'ailin_broadcast_delivery_attempts_total',
  () =>
    new promClient.Histogram({
      name: 'ailin_broadcast_delivery_attempts_total',
      help: 'Attempts consumed before a delivery reached a terminal state.',
      labelNames: ['destination_type', 'terminal_state'], // sent | dlq
      buckets: [1, 2, 3, 4, 5, 10],
    }),
);

// ─── Sampling / Privacy ─────────────────────────────────────────────────

export const broadcastSamplingDecisionsTotal = getOrCreate(
  'ailin_broadcast_sampling_decisions_total',
  () =>
    new promClient.Counter({
      name: 'ailin_broadcast_sampling_decisions_total',
      help: 'Sampling decisions by outcome.',
      labelNames: ['destination_type', 'decision'], // included | sampled_out
    }),
);

export const broadcastRedactionsTotal = getOrCreate(
  'ailin_broadcast_redactions_total',
  () =>
    new promClient.Counter({
      name: 'ailin_broadcast_redactions_total',
      help: 'Fields redacted by the privacy pipeline.',
      labelNames: ['tier'], // pii | secret | custom
    }),
);

// ─── DLQ ────────────────────────────────────────────────────────────────

export const broadcastDlqAdmitsTotal = getOrCreate(
  'ailin_broadcast_dlq_admits_total',
  () =>
    new promClient.Counter({
      name: 'ailin_broadcast_dlq_admits_total',
      help: 'Deliveries that crossed into the DLQ.',
      labelNames: ['destination_type', 'error_class'],
    }),
);

export const broadcastDlqReplaysTotal = getOrCreate(
  'ailin_broadcast_dlq_replays_total',
  () =>
    new promClient.Counter({
      name: 'ailin_broadcast_dlq_replays_total',
      help: 'DLQ entries that were requeued by an operator.',
      labelNames: ['destination_type'],
    }),
);

// ─── SSRF / Egress ──────────────────────────────────────────────────────

export const broadcastEgressBlockedTotal = getOrCreate(
  'ailin_broadcast_egress_blocked_total',
  () =>
    new promClient.Counter({
      name: 'ailin_broadcast_egress_blocked_total',
      help: 'SSRF-guard rejections (private/loopback/link-local/etc).',
      labelNames: ['reason'],
    }),
);

// ─── KEK / KMS ──────────────────────────────────────────────────────────

export const broadcastKekUnwrapsTotal = getOrCreate(
  'ailin_broadcast_kek_unwraps_total',
  () =>
    new promClient.Counter({
      name: 'ailin_broadcast_kek_unwraps_total',
      help: 'KEK unwrap attempts by outcome. Includes breaker fast-fails.',
      // 'ok' | 'failed' | 'fast_failed' (breaker open)
      labelNames: ['result'],
    }),
);

export const broadcastKekUnwrapLatencySeconds = getOrCreate(
  'ailin_broadcast_kek_unwrap_latency_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_broadcast_kek_unwrap_latency_seconds',
      help: 'Latency of KEK unwrap (excluding breaker fast-fails).',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    }),
);

export const broadcastKekCircuitState = getOrCreate(
  'ailin_broadcast_kek_circuit_state',
  () =>
    new promClient.Gauge({
      name: 'ailin_broadcast_kek_circuit_state',
      help: 'KEK circuit breaker state. 0=closed, 1=half_open, 2=open.',
    }),
);

// ─── Admin ──────────────────────────────────────────────────────────────

export const broadcastErasuresTotal = getOrCreate(
  'ailin_broadcast_erasures_total',
  () =>
    new promClient.Counter({
      name: 'ailin_broadcast_erasures_total',
      help: 'GDPR right-to-erasure operations executed.',
      labelNames: ['subject_kind'], // user | organization
    }),
);

// ─── Exports ────────────────────────────────────────────────────────────

export const broadcastMetrics = {
  outboxWrites: broadcastOutboxWritesTotal,
  outboxLag: broadcastOutboxLagSeconds,
  outboxBacklog: broadcastOutboxBacklogRows,
  deliveries: broadcastDeliveriesTotal,
  deliveryLatency: broadcastDeliveryLatencySeconds,
  deliveryAttempts: broadcastDeliveryAttemptsHistogram,
  sampling: broadcastSamplingDecisionsTotal,
  redactions: broadcastRedactionsTotal,
  dlqAdmits: broadcastDlqAdmitsTotal,
  dlqReplays: broadcastDlqReplaysTotal,
  egressBlocked: broadcastEgressBlockedTotal,
  erasures: broadcastErasuresTotal,
  kekUnwraps: broadcastKekUnwrapsTotal,
  kekUnwrapLatency: broadcastKekUnwrapLatencySeconds,
  kekCircuitState: broadcastKekCircuitState,
} as const;

export type BroadcastMetrics = typeof broadcastMetrics;
