// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Tracing (F2.5)
 *
 * OpenTelemetry-style span buffer scoped to one coordination run.
 * The CI codebase does not yet ship a global OT instrumentation
 * stack, so this module provides a self-contained span model that:
 *
 *   - mirrors OT semantics (parentSpanId, attributes, status,
 *     start/end timestamps) so a future migration to a real OT
 *     exporter is mechanical;
 *   - bounds memory by capping spans per run (default 256);
 *   - sanitizes string attributes through `collective-prompt-safety`
 *     so a malicious agent's rationale cannot escape into the trace
 *     view as if it were operator commentary;
 *   - never captures private chain-of-thought — only structural
 *     signal IDs, durations, costs, and stop reasons. This matches
 *     the safety posture documented in MEMORY for the coordination
 *     layer.
 *
 * Two consumers today:
 *   1. `SensitivityConsensusStrategy` (when integrated in a follow-up)
 *      adds spans for round/aggregate/converge/finalize phases.
 *   2. The `GET /v1/collective/runs/:id` endpoint can hydrate the
 *      trace alongside the persisted run for post-mortem analysis
 *      (a future endpoint extension).
 */

import { sanitizeForPromptContext } from './collective-prompt-safety';

// ─── Public types ───────────────────────────────────────────────────────

/**
 * Span phases enumerated explicitly so the trace consumer can group
 * spans by lifecycle stage. Open enum (TypeScript `string & {}`) is
 * not used here — we want the lint check to flag unknown phases.
 */
export type CollectiveSpanPhase =
  | 'run_init'
  | 'round_start'
  | 'collect_signals'
  | 'validate_signals'
  | 'aggregate'
  | 'synthesis_call'
  | 'convergence_evaluate'
  | 'topology_filter'
  | 'consensus_finalize'
  | 'persist'
  | 'fallback';

export type CollectiveSpanStatus = 'ok' | 'error' | 'cancelled';

export interface CollectiveSpan {
  spanId: string;
  parentSpanId?: string;
  runId: string;
  phase: CollectiveSpanPhase;
  /** ISO 8601 — pinned at start time. */
  startedAt: string;
  /** Set on `endSpan`. */
  endedAt?: string;
  /** Set on `endSpan`. Convenience derived from start/end. */
  durationMs?: number;
  status: CollectiveSpanStatus;
  /**
   * Optional structured attributes. Strings are sanitized to
   * neutralize prompt-injection markers; numbers / booleans / nested
   * primitives pass through unchanged.
   */
  attributes: Record<string, AttributeValue>;
  /** Set when status = 'error'. */
  errorMessage?: string;
}

type AttributeValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<string | number | boolean | null>;

// ─── Counter / id generation ────────────────────────────────────────────

let _spanCounter = 0;

/**
 * Generate a span id. Uses a monotonic counter + run-scoped prefix
 * so spans are reproducibly ordered when reading the trace.
 */
export function generateSpanId(runId: string): string {
  _spanCounter = (_spanCounter + 1) >>> 0;
  return `${runId}-span-${_spanCounter.toString(16).padStart(8, '0')}`;
}

// ─── Sanitization ───────────────────────────────────────────────────────

const ATTRIBUTE_VALUE_MAX_LENGTH = 256;

function sanitizeAttribute(value: unknown): AttributeValue {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return sanitizeForPromptContext(value, ATTRIBUTE_VALUE_MAX_LENGTH);
  if (Array.isArray(value)) {
    const out: Array<string | number | boolean | null> = [];
    for (const item of value) {
      if (item === null) {
        out.push(null);
      } else if (typeof item === 'boolean') {
        out.push(item);
      } else if (typeof item === 'number' && Number.isFinite(item)) {
        out.push(item);
      } else if (typeof item === 'string') {
        out.push(sanitizeForPromptContext(item, ATTRIBUTE_VALUE_MAX_LENGTH));
      }
      // Nested objects intentionally dropped — keeps the trace shape flat
      // and prevents arbitrarily-deep structures from bloating memory.
    }
    return out;
  }
  // Fallback for objects / undefined / functions — JSON.stringify and
  // sanitize so the trace never leaks raw model output.
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string') {
      return sanitizeForPromptContext(serialized, ATTRIBUTE_VALUE_MAX_LENGTH);
    }
  } catch {
    /* ignore */
  }
  return '[unrepresentable]';
}

function sanitizeAttributes(attrs: Record<string, unknown> | undefined): Record<string, AttributeValue> {
  if (!attrs) return {};
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    // Drop any key that doesn't look like an OT attribute key
    // (alphanumeric + underscore + dot). Defense against attribute
    // names being injected with control characters.
    if (!/^[a-zA-Z0-9_.]+$/.test(key)) continue;
    out[key] = sanitizeAttribute(value);
  }
  return out;
}

// ─── CollectiveTrace class ──────────────────────────────────────────────

const DEFAULT_MAX_SPANS = 256;

export interface CollectiveTraceOptions {
  /** Maximum spans retained per trace. Default 256. */
  maxSpans?: number;
}

export class CollectiveTrace {
  readonly runId: string;
  private readonly maxSpans: number;
  private readonly spans: CollectiveSpan[] = [];
  private readonly openSpans = new Map<string, CollectiveSpan>();
  /** True after `markComplete()` is called; further writes are ignored. */
  private completed = false;

  constructor(runId: string, options: CollectiveTraceOptions = {}) {
    this.runId = runId;
    this.maxSpans = Math.max(8, options.maxSpans ?? DEFAULT_MAX_SPANS);
  }

  /**
   * Begin a new span. Returns the span id which the caller MUST pass
   * to `endSpan` to record the duration. When `parentSpanId` is
   * supplied, the span nests under that parent for hierarchical
   * inspection.
   */
  startSpan(
    phase: CollectiveSpanPhase,
    options: {
      parentSpanId?: string;
      attributes?: Record<string, unknown>;
    } = {},
  ): string {
    if (this.completed) return '';
    if (this.spans.length >= this.maxSpans) {
      // Drop oldest open span quietly to keep the buffer bounded. We
      // only drop spans that have already been completed; open spans
      // are preserved so their `endSpan` calls still find them.
      const evictTarget = this.spans.findIndex((s) => s.endedAt !== undefined);
      if (evictTarget >= 0) {
        this.spans.splice(evictTarget, 1);
      }
    }

    const spanId = generateSpanId(this.runId);
    const span: CollectiveSpan = {
      spanId,
      parentSpanId: options.parentSpanId,
      runId: this.runId,
      phase,
      startedAt: new Date().toISOString(),
      status: 'ok',
      attributes: sanitizeAttributes(options.attributes),
    };
    this.spans.push(span);
    this.openSpans.set(spanId, span);
    return spanId;
  }

  /**
   * Close a previously-opened span. Adds duration and marks status.
   * Idempotent — calling endSpan twice on the same id is a no-op.
   */
  endSpan(
    spanId: string,
    options: {
      status?: CollectiveSpanStatus;
      attributes?: Record<string, unknown>;
      errorMessage?: string;
    } = {},
  ): void {
    if (this.completed) return;
    const span = this.openSpans.get(spanId);
    if (!span) return;

    const endedAt = new Date();
    span.endedAt = endedAt.toISOString();
    span.durationMs = endedAt.getTime() - new Date(span.startedAt).getTime();
    span.status = options.status ?? 'ok';

    if (options.errorMessage !== undefined) {
      span.errorMessage = sanitizeForPromptContext(options.errorMessage, 240);
    }

    if (options.attributes) {
      const merged = { ...span.attributes };
      for (const [key, value] of Object.entries(sanitizeAttributes(options.attributes))) {
        merged[key] = value;
      }
      span.attributes = merged;
    }

    this.openSpans.delete(spanId);
  }

  /**
   * Auto-close any spans still open. Useful when a strategy aborts
   * unexpectedly and `endSpan` was not reached. Subsequent writes are
   * silently ignored so the trace is immutable post-completion.
   */
  markComplete(): void {
    if (this.completed) return;
    const closeAt = new Date();
    for (const span of this.openSpans.values()) {
      span.endedAt = closeAt.toISOString();
      span.durationMs = closeAt.getTime() - new Date(span.startedAt).getTime();
      if (span.status === 'ok') span.status = 'cancelled';
    }
    this.openSpans.clear();
    this.completed = true;
  }

  /**
   * Snapshot the trace as a plain array. Returns a frozen copy so
   * callers cannot mutate the internal state.
   */
  getSpans(): ReadonlyArray<CollectiveSpan> {
    return this.spans.map((s) => ({ ...s, attributes: { ...s.attributes } }));
  }

  /**
   * Stats for log lines / metadata. Cheap to compute.
   */
  describe(): {
    runId: string;
    spanCount: number;
    completed: boolean;
    statusCounts: Record<CollectiveSpanStatus, number>;
    phaseCounts: Record<string, number>;
  } {
    const statusCounts: Record<CollectiveSpanStatus, number> = { ok: 0, error: 0, cancelled: 0 };
    const phaseCounts: Record<string, number> = {};
    for (const span of this.spans) {
      statusCounts[span.status] = (statusCounts[span.status] ?? 0) + 1;
      phaseCounts[span.phase] = (phaseCounts[span.phase] ?? 0) + 1;
    }
    return {
      runId: this.runId,
      spanCount: this.spans.length,
      completed: this.completed,
      statusCounts,
      phaseCounts,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Convenience that wraps an async operation in a span automatically:
 * starts the span, awaits the function, ends the span with status
 * 'ok' on success or 'error' on throw. The span id is exposed to the
 * caller so additional attributes can be added pre-end.
 */
export async function tracedSpan<T>(
  trace: CollectiveTrace,
  phase: CollectiveSpanPhase,
  fn: (spanId: string) => Promise<T>,
  options: {
    parentSpanId?: string;
    attributes?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const spanId = trace.startSpan(phase, options);
  try {
    const result = await fn(spanId);
    trace.endSpan(spanId, { status: 'ok' });
    return result;
  } catch (err) {
    trace.endSpan(spanId, {
      status: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
