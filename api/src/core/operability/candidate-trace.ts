// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CandidateTrace — end-to-end observability for the lifecycle of a
 * provider/model candidate within a single request or experiment.
 *
 * Phase 1: append-only ring buffer in process memory + structured log line
 * per emission. Future phases add an outbox table and OpenTelemetry span
 * propagation; the call site doesn't need to change.
 *
 * Use cases this enables:
 *   - "Why was provider X with credit not considered?"
 *     → query traces WHERE providerId='X' AND included=false GROUP BY stage, reason
 *   - "Why did fallback try aihubmix when native openai was healthy?"
 *     → trace shows openai stage='health_filtered' reason='auth_failed'
 *   - "Which providers were attempted via HTTP for request R?"
 *     → trace stage='attempted' WHERE requestId='R'
 *
 * Cardinality control: the in-memory buffer caps at MAX_RING_SIZE entries.
 * Older entries are evicted FIFO. Tests can read the buffer; production
 * pipelines should rely on the structured log lines (one per emission).
 */

import { logger } from '@/utils/logger';
import {
  incrementCounter,
  METRIC_NAMES,
} from './metrics';
import type { CandidateTrace, CandidateStage, ProviderHealthState } from './types';

const log = logger.child({ component: 'candidate-trace' });

// ─── Ring buffer ───────────────────────────────────────────────────────────

const MAX_RING_SIZE = 5_000;
const ring: CandidateTrace[] = [];

function append(trace: CandidateTrace): void {
  ring.push(trace);
  if (ring.length > MAX_RING_SIZE) {
    ring.splice(0, ring.length - MAX_RING_SIZE);
  }
}

// ─── Emission API ──────────────────────────────────────────────────────────

export interface EmitTraceInput {
  providerId: string;
  modelId?: string;
  modelFamily?: string;
  stage: CandidateStage;
  included: boolean;
  reason?: string;
  latencyMs?: number;
  healthState?: ProviderHealthState;
  policyKind?: string;
  score?: number;
  requestId?: string;
  experimentId?: string;
  armId?: string;
}

/**
 * Emits a CandidateTrace event. Side effects (in order):
 *   1. Append to ring buffer (capped, FIFO eviction)
 *   2. Increment `candidate_trace_total{stage,included,reason}` counter
 *   3. Emit structured log line at INFO level (downgrade to DEBUG for noisy
 *      stages like `attempted` if needed; current default is INFO for all)
 */
export function emitCandidateTrace(input: EmitTraceInput): CandidateTrace {
  const trace: CandidateTrace = {
    timestamp: new Date().toISOString(),
    providerId: input.providerId,
    modelId: input.modelId,
    modelFamily: input.modelFamily,
    stage: input.stage,
    included: input.included,
    reason: input.reason,
    latencyMs: input.latencyMs,
    healthState: input.healthState,
    policyKind: input.policyKind,
    score: input.score,
    requestId: input.requestId,
    experimentId: input.experimentId,
    armId: input.armId,
  };

  append(trace);

  incrementCounter(METRIC_NAMES.CANDIDATE_TRACE_TOTAL, {
    stage: input.stage,
    included: String(input.included),
    reason: input.reason ?? 'none',
  });

  log.info(
    {
      ...trace,
      msg_kind: 'candidate_trace',
    },
    'candidate.trace',
  );

  return trace;
}

// ─── Query API (for diagnostics endpoints + tests) ─────────────────────────

export interface TraceQuery {
  requestId?: string;
  experimentId?: string;
  providerId?: string;
  stage?: CandidateStage;
  included?: boolean;
  sinceTimestamp?: string;
  /** Default 100; max 1000. */
  limit?: number;
}

export function queryTraces(query: TraceQuery = {}): readonly CandidateTrace[] {
  const limit = Math.min(query.limit ?? 100, 1000);
  const since = query.sinceTimestamp ? Date.parse(query.sinceTimestamp) : undefined;

  const result: CandidateTrace[] = [];
  // Iterate from newest (end) to oldest, return newest-first capped to limit.
  for (let i = ring.length - 1; i >= 0 && result.length < limit; i--) {
    const t = ring[i];
    if (query.requestId && t.requestId !== query.requestId) continue;
    if (query.experimentId && t.experimentId !== query.experimentId) continue;
    if (query.providerId && t.providerId !== query.providerId) continue;
    if (query.stage && t.stage !== query.stage) continue;
    if (query.included !== undefined && t.included !== query.included) continue;
    if (since !== undefined && Date.parse(t.timestamp) < since) continue;
    result.push(t);
  }
  return result;
}

// ─── Test helpers ──────────────────────────────────────────────────────────

export function clearTraceBufferForTesting(): void {
  ring.length = 0;
}

export function getRingSizeForTesting(): number {
  return ring.length;
}
