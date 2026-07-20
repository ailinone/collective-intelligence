// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pricing-snapshot-loader.ts — adapt CI's existing quality + cost signals into the
 * `BenchmarkPoint[]` the calibrator consumes.
 *
 *   quality ← `ModelQualityCalibrationSnapshot.entries[].qualityScore`
 *             (merged from Artificial Analysis / BenchLM / LMArena / internal c3:v4
 *              / the live LLM-judge), and
 *   cost    ← the catalog `Model.inputCostPer1k` / `outputCostPer1k` (× 1000 → per-1M),
 *
 * joined by model id. The core mapper is pure (snapshot entries + a cost map);
 * `loadBenchmarkPoints` is the thin DB-facing wrapper.
 */

import type { BenchmarkPoint } from './pricing-calibrator';

/** Confidence ordering — placeholder rows carry no measured signal and are excluded. */
const CONFIDENCE_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
  placeholder: 0,
};

/** The subset of a calibration entry this loader reads (structural — avoids tight coupling). */
export interface QualityEntryLike {
  readonly modelId: string;
  readonly canonicalModelId?: string;
  readonly qualityScore: number;
  readonly qualityConfidence: string;
}

export interface ModelCost {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
}

/** A Prisma `Decimal`, a number, or a numeric string — normalise to a finite number. */
type DecimalLike = number | string | null | undefined | { toNumber(): number };

function toNum(v: DecimalLike): number {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v.toNumber === 'function') return v.toNumber();
  return NaN;
}

/** Minimal catalog row shape (subset of Prisma `Model`). */
export interface ModelCostRow {
  id: string;
  inputCostPer1k: DecimalLike;
  outputCostPer1k: DecimalLike;
}

/** Build a `modelId → per-1M cost` map from catalog rows (per-1k × 1000). */
export function buildModelCostMap(rows: readonly ModelCostRow[]): Map<string, ModelCost> {
  const map = new Map<string, ModelCost>();
  for (const r of rows) {
    const inK = toNum(r.inputCostPer1k);
    const outK = toNum(r.outputCostPer1k);
    if (!Number.isFinite(inK) || !Number.isFinite(outK)) continue;
    if (inK < 0 || outK < 0) continue;
    map.set(r.id, { inputPer1MUsd: inK * 1000, outputPer1MUsd: outK * 1000 });
  }
  return map;
}

export interface SnapshotToPointsOptions {
  /** Exclude entries weaker than this confidence. Default 'low' (only placeholders dropped). */
  minConfidence?: 'high' | 'medium' | 'low';
  /** Drop entries priced at exactly $0 (almost always a missing-price stub, not a free model). */
  dropZeroCost?: boolean;
}

/**
 * Pure join: calibration entries × cost map → benchmark points. An entry is kept
 * only when (a) its confidence ≥ the floor, (b) its quality is a usable (0,1], and
 * (c) a catalog cost exists for its id (canonical id tried first, then raw id).
 */
export function snapshotToBenchmarkPoints(
  entries: readonly QualityEntryLike[],
  costMap: ReadonlyMap<string, ModelCost>,
  opts: SnapshotToPointsOptions = {},
): BenchmarkPoint[] {
  const floor = CONFIDENCE_RANK[opts.minConfidence ?? 'low'] ?? 1;
  const dropZero = opts.dropZeroCost ?? true;
  const points: BenchmarkPoint[] = [];

  for (const e of entries) {
    const rank = CONFIDENCE_RANK[e.qualityConfidence] ?? 0;
    if (rank < floor) continue;
    if (!Number.isFinite(e.qualityScore) || e.qualityScore <= 0 || e.qualityScore > 1) continue;

    const cost = costMap.get(e.canonicalModelId ?? '') ?? costMap.get(e.modelId);
    if (!cost) continue;
    if (dropZero && cost.inputPer1MUsd === 0 && cost.outputPer1MUsd === 0) continue;

    points.push({
      modelId: e.canonicalModelId ?? e.modelId,
      quality: e.qualityScore,
      inputPer1MUsd: cost.inputPer1MUsd,
      outputPer1MUsd: cost.outputPer1MUsd,
    });
  }
  return points;
}

/**
 * DB-facing wrapper. Caller supplies the current calibration snapshot (from the
 * existing merge pipeline) and the catalog cost rows (one `prisma.model.findMany`
 * selecting `id, inputCostPer1k, outputCostPer1k`). Kept dependency-injected so the
 * pure mapper above stays unit-testable without a database.
 */
export function loadBenchmarkPoints(input: {
  entries: readonly QualityEntryLike[];
  costRows: readonly ModelCostRow[];
  options?: SnapshotToPointsOptions;
}): BenchmarkPoint[] {
  return snapshotToBenchmarkPoints(input.entries, buildModelCostMap(input.costRows), input.options);
}
