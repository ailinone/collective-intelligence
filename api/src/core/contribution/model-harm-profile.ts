// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * model-harm-profile.ts — MVP 8A
 *
 * Harm-specific signal aggregator. Distinct from
 * `ModelTaskPerformanceProfile.harmScore`: the harm profile carries the
 * raw breakdown so callers can decide WHY a model is harmful (modality
 * mismatch vs zero output vs degraded vs failure-causing).
 *
 * Pure types + a small computer. No I/O.
 */

import type {
  ExecutionModality,
  HistoricalExecution,
} from './historical-execution-types';

export interface ModelHarmProfile {
  readonly modelId: string;
  readonly taskType: string;
  readonly sampleCount: number;

  readonly zeroOutputRate: number;
  readonly degradedRate: number;
  readonly failureRate: number;
  readonly modalityMismatchRate: number;

  /** Aggregated harm score in [0..1]. */
  readonly harmScore: number;

  /** Plain-English summary used by trace/explanations. */
  readonly summary: string;
}

// ─── Computer ───────────────────────────────────────────────────────────

/**
 * Builds a harm profile for one (modelId, taskType) cell from its
 * filtered executions. The caller is responsible for filtering.
 *
 * `expectedModality` is the modality of the TASK (not the model). When
 * an execution's `modality` field disagrees, it counts as a mismatch
 * — even when the judge score is non-zero (a "lucky pass" is still
 * a contract violation).
 */
export function buildModelHarmProfile(
  modelId: string,
  taskType: string,
  executions: readonly HistoricalExecution[],
  expectedModality?: ExecutionModality,
): ModelHarmProfile {
  const n = executions.length;
  if (n === 0) {
    return Object.freeze({
      modelId,
      taskType,
      sampleCount: 0,
      zeroOutputRate: 0,
      degradedRate: 0,
      failureRate: 0,
      modalityMismatchRate: 0,
      harmScore: 0,
      summary: 'no_samples',
    });
  }

  let zero = 0;
  let degraded = 0;
  let failure = 0;
  let modalityMiss = 0;
  for (const ex of executions) {
    if (ex.judgeScore <= 0.1) zero += 1;
    if (ex.degraded === true) degraded += 1;
    if (ex.success === false) failure += 1;
    if (
      expectedModality !== undefined &&
      ex.modality !== undefined &&
      ex.modality !== expectedModality &&
      ex.modality !== 'mixed'
    ) {
      modalityMiss += 1;
    }
  }

  const zeroRate = zero / n;
  const degradedRate = degraded / n;
  const failureRate = failure / n;
  const modalityMismatchRate = modalityMiss / n;

  // Weighted aggregate — modality mismatch and zero output are the most
  // damaging. Failure is bad but often a transient infra issue.
  const harmScore = Math.min(
    1,
    0.45 * zeroRate +
      0.35 * modalityMismatchRate +
      0.15 * degradedRate +
      0.05 * failureRate,
  );

  return Object.freeze({
    modelId,
    taskType,
    sampleCount: n,
    zeroOutputRate: zeroRate,
    degradedRate,
    failureRate,
    modalityMismatchRate,
    harmScore,
    summary: summariseHarm({
      zeroRate,
      degradedRate,
      failureRate,
      modalityMismatchRate,
    }),
  });
}

function summariseHarm(parts: {
  readonly zeroRate: number;
  readonly degradedRate: number;
  readonly failureRate: number;
  readonly modalityMismatchRate: number;
}): string {
  const tokens: string[] = [];
  if (parts.modalityMismatchRate >= 0.25) tokens.push('modality_mismatch');
  if (parts.zeroRate >= 0.25) tokens.push('zero_output');
  if (parts.degradedRate >= 0.25) tokens.push('degraded');
  if (parts.failureRate >= 0.25) tokens.push('failures');
  if (tokens.length === 0) return 'no_significant_harm';
  return tokens.join(',');
}
