// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-harvester.ts — MVP 8B.6
 *
 * Top-level orchestrator: raw → sanitise → normalise → dedupe → gate.
 *
 *   raw rows  ─▶ sanitiser   ─▶ sanitised
 *                                 │
 *                                 ▼
 *                              normalizer ─▶ normalised
 *                                 │
 *                                 ▼
 *                              deduper    ─▶ unique
 *                                 │
 *                                 ▼
 *                              quality-gate ─▶ decisions
 *
 * Output: `HarvestResult` — frozen, deterministic, auditable.
 *
 * Pure. No I/O.
 */

import type { HistoricalReplayExecution } from '../historical-replay-types';
import { dedupeRows } from './historical-results-deduper';
import { normaliseRows } from './historical-results-normalizer';
import {
  classifyRows,
  type QualityGateResult,
} from './historical-results-quality-gate';
import { sanitiseRows } from './historical-results-sanitizer';
import {
  FORBIDDEN_RAW_FIELDS,
  KEPT_FIELDS,
  type HarvestResult,
  type HistoricalRawRow,
  type HistoricalRowQualityDecision,
  type NormalisedRow,
} from './historical-results-schema';

export function harvestHistoricalResults(
  raw: readonly HistoricalRawRow[],
): HarvestResult {
  // Stage 1 — sanitise.
  const { sanitised } = sanitiseRows(raw);

  // Stage 2 — normalise.
  const { normalised } = normaliseRows(sanitised);

  // Stage 3 — dedupe.
  const { unique } = dedupeRows(normalised);

  // Stage 4 — quality-gate.
  const gate = classifyRows(unique);

  // Stage 5 — promote eligible rows to HistoricalReplayExecution shape.
  const decisionByExecId = new Map<string, HistoricalRowQualityDecision>();
  for (const d of gate.decisions) decisionByExecId.set(d.executionId, d);

  const trainingAndHoldoutCandidates: HistoricalReplayExecution[] = [];
  for (const row of unique) {
    const decision = decisionByExecId.get(row.executionId);
    if (!decision) continue;
    if (decision.usage !== 'usable_for_training' && decision.usage !== 'usable_for_holdout') {
      continue;
    }
    const ex = normalisedRowToReplayExecution(row);
    if (ex) trainingAndHoldoutCandidates.push(ex);
  }

  return Object.freeze({
    trainingAndHoldoutCandidates: Object.freeze(trainingAndHoldoutCandidates),
    decisions: gate.decisions,
    counts: {
      rawRows: raw.length,
      sanitizedRows: sanitised.length,
      normalizedRows: normalised.length,
      usableForTraining: gate.counts.usable_for_training,
      usableForHoldout: gate.counts.usable_for_holdout,
      usableForCostOnly: gate.counts.usable_for_cost_only,
      usableForFailureAnalysisOnly: gate.counts.usable_for_failure_analysis_only,
      excluded: gate.counts.excluded,
    },
    sanitisation: {
      removedFields: FORBIDDEN_RAW_FIELDS,
      keptFields: KEPT_FIELDS,
    },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function normalisedRowToReplayExecution(
  row: NormalisedRow,
): HistoricalReplayExecution | null {
  if (
    row.judgeScoreNormalized === null ||
    row.costUsd === null ||
    !row.taskType
  ) {
    return null;
  }
  const strategy = row.effectiveStrategy ?? row.strategy ?? 'unknown';
  return Object.freeze({
    executionId: row.executionId,
    experimentId: row.experimentId,
    taskId: row.taskId,
    createdAt: row.createdAt,
    taskType: row.taskType,
    complexity: row.complexity,
    strategyId: strategy,
    effectiveStrategyId: row.effectiveStrategy ?? row.strategy ?? strategy,
    modelsUsed: row.modelsUsed,
    providerRoutes: row.providerRoutes.length > 0 ? row.providerRoutes : undefined,
    judgeScore: row.judgeScoreNormalized,
    costUsd: row.costUsd,
    latencyMs: row.latencyMs ?? undefined,
    success: row.success ?? true,
    failureMode: row.failureMode ?? null,
    degraded: row.degraded,
    degradationReason: row.degradationReason ?? null,
    modality: row.modality,
  });
}

// ─── Re-exports for convenience ─────────────────────────────────────────

export type { QualityGateResult };
