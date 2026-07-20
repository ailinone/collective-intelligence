// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RoutingTraceCollector — async, bounded, isolated.
 *
 * MVP 3 invariants:
 *   - `enqueue()` is SYNCHRONOUS and NEVER throws. The hot path can call
 *     this without a try/catch and without `await`.
 *   - Queue has a hard maximum size. When full, the OLDEST trace is
 *     dropped (FIFO eviction) and the metric `routing_trace_dropped_total`
 *     is incremented with `reason='queue_full'`. Eviction is deterministic
 *     so tests can assert on exact behaviour.
 *   - `flush()` is async, drains up to `batchSize` traces per call, and
 *     wraps the persistor in a try/catch so persistor failures NEVER
 *     propagate to the caller. Persist errors increment
 *     `routing_trace_persist_error_total`.
 *   - Redaction is applied BEFORE persistence (the contract that protects
 *     downstream sinks from PII).
 *   - No global singleton. Caller constructs and owns the collector.
 *   - No I/O at module load.
 */

import type {
  RoutingDecisionTrace,
  RoutingTraceMetrics,
} from './routing-decision-trace';
import { noopRoutingTraceMetrics } from './routing-decision-trace';
import { redactRoutingTrace } from './routing-redaction';

// ─── Persistor contract ─────────────────────────────────────────────────

/**
 * The sink the collector drains into. Always async — implementations may
 * be a Postgres COPY, an HTTP POST, a Redis stream, or a file append.
 * The collector treats every implementation identically.
 */
export interface RoutingTracePersistor {
  persist(batch: ReadonlyArray<RoutingDecisionTrace>): Promise<void>;
}

// ─── Constructor options ────────────────────────────────────────────────

export interface RoutingTraceCollectorOptions {
  readonly persistor: RoutingTracePersistor;
  /** Max queue size. Default 5_000. Must be ≥ 1. */
  readonly maxQueueSize?: number;
  /** Max batch size per flush. Default 500. Must be ≥ 1. */
  readonly batchSize?: number;
  /** When true (default), `enqueue` runs `redactRoutingTrace` first. */
  readonly redact?: boolean;
  /** Injected metrics — falls back to no-op when omitted. */
  readonly metrics?: RoutingTraceMetrics;
}

// ─── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_MAX_QUEUE = 5_000;
const DEFAULT_BATCH_SIZE = 500;

// ─── Metric names (string constants so tests can assert) ────────────────

export const ROUTING_TRACE_METRIC_NAMES = Object.freeze({
  DROPPED_TOTAL: 'routing_trace_dropped_total',
  QUEUE_SIZE: 'routing_trace_queue_size',
  PERSIST_ERROR_TOTAL: 'routing_trace_persist_error_total',
  REDACTION_APPLIED_TOTAL: 'routing_trace_redaction_applied_total',
  FLUSH_DURATION_MS: 'routing_trace_flush_duration_ms',
  PERSIST_BATCH_SIZE: 'routing_trace_persist_batch_size',
});

// ─── Collector ──────────────────────────────────────────────────────────

export class RoutingTraceCollector {
  private readonly persistor: RoutingTracePersistor;
  private readonly maxQueueSize: number;
  private readonly batchSize: number;
  private readonly redact: boolean;
  private readonly metrics: RoutingTraceMetrics;

  private queue: RoutingDecisionTrace[] = [];

  constructor(options: RoutingTraceCollectorOptions) {
    this.persistor = options.persistor;
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE);
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.redact = options.redact !== false; // default true
    this.metrics = options.metrics ?? noopRoutingTraceMetrics;
  }

  /**
   * Enqueue a trace. Synchronous, never throws. If the queue is full,
   * the OLDEST entry is dropped (FIFO) and the drop is metricised.
   */
  enqueue(trace: RoutingDecisionTrace): void {
    // Redact first — protects downstream sinks from PII even when the
    // queue evicts the entry before flush.
    const safe = this.redact ? redactRoutingTrace(trace) : trace;
    if (this.redact) {
      this.metrics.increment(
        ROUTING_TRACE_METRIC_NAMES.REDACTION_APPLIED_TOTAL,
      );
    }

    if (this.queue.length >= this.maxQueueSize) {
      // FIFO eviction: drop oldest, push newest.
      this.queue.shift();
      this.metrics.increment(ROUTING_TRACE_METRIC_NAMES.DROPPED_TOTAL, {
        reason: 'queue_full',
      });
    }
    this.queue.push(safe);
    this.metrics.gauge(
      ROUTING_TRACE_METRIC_NAMES.QUEUE_SIZE,
      this.queue.length,
    );
  }

  /**
   * Drain up to `batchSize` traces and call the persistor. Always
   * returns normally; on persistor error, increments the error
   * counter and resolves. NEVER propagates the error.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const start =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const batch = this.queue.splice(0, this.batchSize);
    this.metrics.gauge(
      ROUTING_TRACE_METRIC_NAMES.QUEUE_SIZE,
      this.queue.length,
    );
    try {
      await this.persistor.persist(batch);
      this.metrics.gauge(
        ROUTING_TRACE_METRIC_NAMES.PERSIST_BATCH_SIZE,
        batch.length,
      );
    } catch (err) {
      // Swallow — error is metricised but never propagated. The traces
      // are intentionally dropped because re-queueing would let a broken
      // persistor recursively drown the request path.
      this.metrics.increment(
        ROUTING_TRACE_METRIC_NAMES.PERSIST_ERROR_TOTAL,
        { reason: classifyError(err) },
      );
    } finally {
      const end =
        typeof performance !== 'undefined' &&
        typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      this.metrics.gauge(
        ROUTING_TRACE_METRIC_NAMES.FLUSH_DURATION_MS,
        Math.max(0, end - start),
      );
    }
  }

  /** Current queue depth — used by tests. */
  size(): number {
    return this.queue.length;
  }

  /**
   * Test seam — exposes the queue snapshot WITHOUT draining. Read-only.
   */
  snapshot(): ReadonlyArray<RoutingDecisionTrace> {
    return this.queue.slice();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function classifyError(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof (err as { name?: unknown }).name === 'string') {
    return ((err as { name: string }).name).slice(0, 64);
  }
  return 'unknown';
}
