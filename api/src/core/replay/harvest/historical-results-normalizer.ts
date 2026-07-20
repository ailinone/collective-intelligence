// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-normalizer.ts — MVP 8B.6
 *
 * Stage 3 of the harvest pipeline. Turns a `SanitisedRow` into a fully
 * typed `NormalisedRow`:
 *   - detects judge-score scale (0..1 / 0..100 / 1..5 / unknown)
 *   - normalises judge to [0,1]
 *   - coerces numeric and array fields
 *   - drops invalid rows by marking `judgeComparable=false`
 *
 * Pure function. No I/O.
 */

import type {
  JudgeScale,
  NormalisedRow,
  SanitisedRow,
} from './historical-results-schema';

export interface NormaliseResult {
  readonly normalised: readonly NormalisedRow[];
  readonly skipped: readonly { readonly raw: unknown; readonly reason: string }[];
}

export function normaliseRows(rows: readonly SanitisedRow[]): NormaliseResult {
  const out: NormalisedRow[] = [];
  const skipped: { raw: unknown; reason: string }[] = [];
  for (const r of rows) {
    const norm = normaliseRow(r);
    if (!norm) {
      skipped.push({ raw: r, reason: 'missing_execution_or_experiment_id' });
      continue;
    }
    out.push(norm);
  }
  return Object.freeze({
    normalised: Object.freeze(out),
    skipped: Object.freeze(skipped),
  });
}

export function normaliseRow(raw: SanitisedRow): NormalisedRow | null {
  const executionId = pickString(raw, 'executionId');
  const experimentId = pickString(raw, 'experimentId');
  if (!executionId || !experimentId) return null;

  const taskIndexRaw = pickNumber(raw, 'taskIndex');
  const taskIndex = taskIndexRaw === null ? undefined : Math.trunc(taskIndexRaw);
  const repetitionRaw = pickNumber(raw, 'repetition');
  const repetition = repetitionRaw === null ? undefined : Math.trunc(repetitionRaw);
  const taskId =
    pickString(raw, 'taskId') ??
    buildTaskId(experimentId, taskIndex, repetition);

  const judgeRaw = pickNumber(raw, 'judgeScore');
  const judgeScale = detectJudgeScale(judgeRaw);
  const judgeNormalized = normaliseJudge(judgeRaw, judgeScale);
  const judgeComparable = judgeNormalized !== null && judgeScale !== 'unknown';

  return Object.freeze({
    executionId,
    experimentId,
    taskId,
    taskIndex,
    repetition,
    createdAt: pickString(raw, 'createdAt') ?? undefined,
    executionMode: pickString(raw, 'executionMode') ?? undefined,
    strategy: pickString(raw, 'strategy') ?? undefined,
    effectiveStrategy: pickString(raw, 'effectiveStrategy') ?? undefined,
    taskType: pickString(raw, 'taskType') ?? undefined,
    complexity: pickComplexity(raw),
    domain: pickString(raw, 'domain') ?? undefined,
    modelsUsed: pickStringArray(raw, 'modelsUsed'),
    providerRoutes: pickStringArray(raw, 'providerRoutes'),
    judgeScoreRaw: judgeRaw,
    judgeScoreNormalized: judgeNormalized,
    judgeScaleDetected: judgeScale,
    judgeNormalizationApplied: judgeNormalized !== null && judgeScale !== '0_1',
    judgeComparable,
    judgeUsed: pickBoolean(raw, 'judgeUsed') ?? false,
    qualityScore: pickNumber(raw, 'qualityScore'),
    heuristicScoreRaw: pickNumber(raw, 'heuristicScoreRaw'),
    costUsd: pickNumber(raw, 'costUsd'),
    latencyMs: pickNumber(raw, 'latencyMs'),
    totalTokens: pickNumber(raw, 'totalTokens'),
    success: pickBoolean(raw, 'success'),
    phase: pickString(raw, 'phase') ?? undefined,
    failureMode: pickString(raw, 'failureMode') ?? undefined,
    degraded: pickBoolean(raw, 'degraded') ?? undefined,
    degradationReason: pickString(raw, 'degradationReason') ?? undefined,
    ablationCondition: pickString(raw, 'ablationCondition') ?? undefined,
    scoringPolicy: pickString(raw, 'scoringPolicy') ?? undefined,
    modality: pickModality(raw),
  });
}

// ─── Judge scale detection ──────────────────────────────────────────────

function detectJudgeScale(v: number | null): JudgeScale {
  if (v === null) return 'unknown';
  if (v >= 0 && v <= 1) return '0_1';
  if (v > 1 && v <= 5) return '1_5';
  if (v > 5 && v <= 100) return '0_100';
  return 'unknown';
}

function normaliseJudge(v: number | null, scale: JudgeScale): number | null {
  if (v === null) return null;
  switch (scale) {
    case '0_1':
      return v;
    case '0_100':
      return v / 100;
    case '1_5':
      // Treat 1..5 as 0..1 anchored at 1 (so 1→0, 5→1).
      return Math.max(0, Math.min(1, (v - 1) / 4));
    case 'unknown':
    default:
      return null;
  }
}

// ─── Pickers ────────────────────────────────────────────────────────────

function pickString(row: SanitisedRow, key: string): string | null {
  const v = (row as Record<string, unknown>)[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

function pickNumber(row: SanitisedRow, key: string): number | null {
  const v = (row as Record<string, unknown>)[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickBoolean(row: SanitisedRow, key: string): boolean | null {
  const v = (row as Record<string, unknown>)[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 't') return true;
  if (v === 'false' || v === 'f') return false;
  return null;
}

function pickStringArray(row: SanitisedRow, key: string): readonly string[] {
  const v = (row as Record<string, unknown>)[key];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) if (typeof item === 'string' && item.length > 0) out.push(item);
    return Object.freeze(out);
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      const inner = t.slice(1, -1);
      if (inner.length === 0) return Object.freeze([]);
      const parts = inner.split(',');
      const out: string[] = [];
      for (const p of parts) {
        let x = p.trim();
        if (x.startsWith('"') && x.endsWith('"')) x = x.slice(1, -1);
        if (x.length > 0) out.push(x);
      }
      return Object.freeze(out);
    }
  }
  return Object.freeze([]);
}

function pickComplexity(row: SanitisedRow): NormalisedRow['complexity'] {
  const v = pickString(row, 'complexity');
  if (v === 'low' || v === 'medium' || v === 'high' || v === 'extreme') return v;
  return undefined;
}

function pickModality(row: SanitisedRow): NormalisedRow['modality'] {
  const v = pickString(row, 'modality');
  if (v === 'text' || v === 'image' || v === 'audio' || v === 'video' || v === 'mixed') {
    return v;
  }
  return undefined;
}

function buildTaskId(
  experimentId: string,
  taskIndex: number | undefined,
  repetition: number | undefined,
): string {
  return `${experimentId}::${taskIndex ?? '_'}::${repetition ?? 0}`;
}
