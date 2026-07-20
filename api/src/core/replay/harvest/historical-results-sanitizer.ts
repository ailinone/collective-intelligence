// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-sanitizer.ts — MVP 8B.6
 *
 * Strips PII-bearing fields from a raw row and normalises field-name
 * casing to camelCase. Pure function.
 *
 * Sanitisation rules (single source of truth: schema FORBIDDEN_RAW_FIELDS):
 *   - any forbidden key (in any case-variant) is dropped
 *   - snake_case columns get camelCase aliases (executionId, taskType, …)
 *   - never throws; missing fields are tolerated
 */

import {
  FORBIDDEN_RAW_FIELDS,
  type HistoricalRawRow,
  type SanitisedRow,
} from './historical-results-schema';

const FORBIDDEN_SET = new Set(FORBIDDEN_RAW_FIELDS);
const FORBIDDEN_LOWER = new Set(FORBIDDEN_RAW_FIELDS.map((s) => s.toLowerCase()));

/**
 * snake_case → camelCase aliases for known schema columns. Anything
 * not in this map is dropped silently if it isn't already camelCase
 * (so unrecognised columns don't leak into the dataset).
 */
const COLUMN_ALIASES: Record<string, string> = Object.freeze({
  execution_id: 'executionId',
  id: 'executionId',
  experiment_id: 'experimentId',
  task_id: 'taskId',
  task_index: 'taskIndex',
  execution_mode: 'executionMode',
  task_type: 'taskType',
  effective_strategy: 'effectiveStrategy',
  models_used: 'modelsUsed',
  provider_routes: 'providerRoutes',
  judge_score: 'judgeScore',
  quality_score: 'qualityScore',
  judge_used: 'judgeUsed',
  heuristic_score_raw: 'heuristicScoreRaw',
  cost_usd: 'costUsd',
  latency_ms: 'latencyMs',
  total_tokens: 'totalTokens',
  failure_mode: 'failureMode',
  degradation_reason: 'degradationReason',
  ablation_condition: 'ablationCondition',
  scoring_policy: 'scoringPolicy',
  created_at: 'createdAt',
});

const PASSTHROUGH_KEYS = new Set([
  'executionId',
  'experimentId',
  'taskId',
  'taskIndex',
  'repetition',
  'createdAt',
  'executionMode',
  'strategy',
  'effectiveStrategy',
  'taskType',
  'complexity',
  'domain',
  'modelsUsed',
  'providerRoutes',
  'judgeScore',
  'qualityScore',
  'judgeUsed',
  'heuristicScoreRaw',
  'costUsd',
  'latencyMs',
  'totalTokens',
  'success',
  'phase',
  'failureMode',
  'degraded',
  'degradationReason',
  'ablationCondition',
  'scoringPolicy',
  'modality',
]);

export interface SanitiseResult {
  readonly sanitised: SanitisedRow;
  /** Keys dropped from this specific row (per-row audit). */
  readonly droppedKeys: readonly string[];
}

export function sanitiseRow(raw: HistoricalRawRow): SanitiseResult {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_SET.has(k) || FORBIDDEN_LOWER.has(k.toLowerCase())) {
      dropped.push(k);
      continue;
    }
    const target = COLUMN_ALIASES[k] ?? (PASSTHROUGH_KEYS.has(k) ? k : undefined);
    if (!target) {
      dropped.push(k);
      continue;
    }
    out[target] = v;
  }
  return Object.freeze({
    sanitised: Object.freeze(out),
    droppedKeys: Object.freeze(dropped),
  });
}

export function sanitiseRows(
  rows: readonly HistoricalRawRow[],
): {
  readonly sanitised: readonly SanitisedRow[];
  readonly droppedKeyCounts: Readonly<Record<string, number>>;
} {
  const sanitised: SanitisedRow[] = [];
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const { sanitised: clean, droppedKeys } = sanitiseRow(r);
    sanitised.push(clean);
    for (const k of droppedKeys) counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.freeze({
    sanitised: Object.freeze(sanitised),
    droppedKeyCounts: Object.freeze(counts),
  });
}
