// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R4 §10 — Multi-source quality snapshot merger.
 *
 * Combines N independent ModelQualityCalibrationSnapshot inputs (e.g.,
 * BenchLM + LMArena + ArtificialAnalysis + Internal) into a single
 * snapshot where each entry preserves all contributing source scores AND
 * exposes a confidence-weighted aggregate.
 *
 * Strategy "B4+B1" (per spec §3.2):
 *   - Preserve `sourceScores[]` array — never collapse multi-source entries
 *   - Per category, weighted average across sources that cover that category
 *   - Top-level `qualityScore` = aggregateQualityFromSources(sourceScores)
 *   - `qualityScoreSources` = union of all contributing source names
 *   - Confidence reflects the BEST contributing source's confidence
 *
 * Manual / catalog source FALLBACK RULE:
 *   - A `manual` source contribution cannot OVERRIDE an `external_benchmark`
 *     source contribution for the same entry. The merger flags this case
 *     in `warnings` and DEMOTES the manual source's effective weight to
 *     'placeholder' confidence regardless of its declared confidence.
 *
 * Pure function — no I/O, no provider calls.
 */
import type {
  ModelQualityCalibrationEntry,
  ModelQualityCalibrationSnapshot,
  ModelQualityConfidence,
  QualityCategory,
  SourceSpecificQualityScore,
  ExternalBenchmarkSource,
} from '../role-selection/model-quality-calibration';
import {
  aggregateQualityFromSources,
  buildSnapshot,
} from '../role-selection/model-quality-calibration';

// ─── Types ────────────────────────────────────────────────────────────────

export interface SnapshotMergeInput {
  /** Snapshots to merge. Order is preserved in warnings but not in output. */
  readonly snapshots: readonly ModelQualityCalibrationSnapshot[];
  /** Output snapshot version (e.g., `1.0.0-merged-2026-05-19`). */
  readonly version: string;
  /** Source artifacts to record in the merged snapshot (union of inputs). */
  readonly sourceArtifacts?: readonly string[];
  /**
   * When true, entries with NO external_benchmark contributing source are
   * dropped from the output. This is the strict mode: only entries with at
   * least one external benchmark are emitted.
   */
  readonly requireExternalBenchmark?: boolean;
}

export interface SnapshotMergeReport {
  readonly snapshot: ModelQualityCalibrationSnapshot;
  /** Per-canonical merge summary for audit. */
  readonly merges: ReadonlyArray<{
    readonly canonicalModelId: string;
    readonly contributingSources: readonly ExternalBenchmarkSource[];
    readonly mergedQualityScore: number;
    readonly mergedConfidence: ModelQualityConfidence;
    readonly categoriesCovered: readonly QualityCategory[];
    readonly demotedManualSources: readonly ExternalBenchmarkSource[];
  }>;
  readonly droppedNoExternal: ReadonlyArray<{
    readonly canonicalModelId: string;
    readonly reason: string;
  }>;
}

// ─── Source classification ────────────────────────────────────────────────

const EXTERNAL_SOURCES: ReadonlySet<ExternalBenchmarkSource> = new Set([
  'benchlm',
  'lmarena',
  'artificial_analysis',
  'internal',
]);

function isExternalSource(s: ExternalBenchmarkSource): boolean {
  return EXTERNAL_SOURCES.has(s);
}

// ─── Confidence ranking (high > medium > low > placeholder) ───────────────

const CONFIDENCE_RANK: Record<ModelQualityConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
  placeholder: 0,
};

function bestConfidence(
  confs: readonly ModelQualityConfidence[],
): ModelQualityConfidence {
  let best: ModelQualityConfidence = 'placeholder';
  for (const c of confs) {
    if (CONFIDENCE_RANK[c] > CONFIDENCE_RANK[best]) best = c;
  }
  return best;
}

// ─── Per-source projection from an entry ──────────────────────────────────

/**
 * Extracts per-source contributions from a single entry. If `entry.sourceScores`
 * is populated, returns it directly. If not, synthesizes a single
 * SourceSpecificQualityScore from the entry's top-level fields, using the
 * `qualityScoreSource` to infer the ExternalBenchmarkSource (best-effort).
 */
function extractSourceScores(
  entry: ModelQualityCalibrationEntry,
): readonly SourceSpecificQualityScore[] {
  if (entry.sourceScores && entry.sourceScores.length > 0) {
    return entry.sourceScores;
  }
  // Backward-compat: infer from qualityScoreSource
  let inferredSource: ExternalBenchmarkSource = 'manual';
  switch (entry.qualityScoreSource) {
    case 'external_benchmark':
      // We can't tell which external benchmark; entry's warnings may hint.
      // Conservative default: classify as 'benchlm' if warnings mention BenchLM,
      // 'lmarena' if mention LMArena, otherwise 'internal'.
      if (entry.warnings.some((w) => /BenchLM/i.test(w))) inferredSource = 'benchlm';
      else if (entry.warnings.some((w) => /LMArena/i.test(w))) inferredSource = 'lmarena';
      else inferredSource = 'internal';
      break;
    case 'internal_benchmark':
    case 'live_probe':
      inferredSource = 'internal';
      break;
    case 'manual_legacy':
    case 'catalog_metadata':
      inferredSource = 'manual';
      break;
    default:
      inferredSource = 'manual';
  }
  return [{
    source: inferredSource,
    score: entry.qualityScore,
    confidence: entry.qualityConfidence,
  }];
}

// ─── Manual demotion ──────────────────────────────────────────────────────

/**
 * Implements the "manual cannot override external" rule.
 * If the sources contain BOTH a manual contribution AND an external one,
 * we DEMOTE the manual contribution's effective confidence to 'placeholder'
 * (so its aggregate weight becomes 0.1 instead of its declared weight).
 *
 * Returns:
 *   - effectiveSources: array used for aggregate calculations
 *   - demoted: list of source names that were demoted
 */
function applyManualDemotion(
  sources: readonly SourceSpecificQualityScore[],
): {
  readonly effectiveSources: readonly SourceSpecificQualityScore[];
  readonly demoted: readonly ExternalBenchmarkSource[];
} {
  const hasExternal = sources.some((s) => isExternalSource(s.source));
  if (!hasExternal) {
    return { effectiveSources: sources, demoted: [] };
  }
  const demoted: ExternalBenchmarkSource[] = [];
  const effective = sources.map((s) => {
    if (!isExternalSource(s.source)) {
      if (s.confidence !== 'placeholder') {
        demoted.push(s.source);
        return { ...s, confidence: 'placeholder' as ModelQualityConfidence };
      }
    }
    return s;
  });
  return { effectiveSources: effective, demoted };
}

// ─── Per-category aggregation across sources ──────────────────────────────

/**
 * Builds the merged `taskCategoryScores` map by averaging per-source
 * category contributions weighted by confidence.
 *
 * For each category present in any contributing source, gather the
 * (score, confidence) pairs and compute a confidence-weighted average.
 */
function mergeCategoryScores(
  sources: readonly SourceSpecificQualityScore[],
): Partial<Record<QualityCategory, number>> {
  const out: Partial<Record<QualityCategory, number>> = {};
  const allCategories = new Set<QualityCategory>();
  for (const s of sources) {
    if (s.categoryScores) {
      for (const cat of Object.keys(s.categoryScores) as QualityCategory[]) {
        allCategories.add(cat);
      }
    }
  }
  for (const cat of allCategories) {
    const contribs: SourceSpecificQualityScore[] = sources
      .filter((s) => s.categoryScores && s.categoryScores[cat] !== undefined)
      .map((s) => ({
        source: s.source,
        score: s.categoryScores![cat]!,
        confidence: s.confidence,
      }));
    const avg = aggregateQualityFromSources(contribs);
    if (avg !== undefined) out[cat] = avg;
  }
  return out;
}

// ─── Entry merge ──────────────────────────────────────────────────────────

/**
 * Merges multiple entries (for the SAME canonical model) into a single
 * merged entry. Combines all sourceScores, applies manual demotion, and
 * computes aggregate qualityScore + taskCategoryScores.
 *
 * The merged entry's modelId comes from the FIRST entry; its family from
 * the first entry that has one. dimensionScores are merged by taking the
 * BEST (max) value per dimension across all entries.
 */
function mergeEntriesForCanonical(
  entries: readonly ModelQualityCalibrationEntry[],
): {
  readonly entry: ModelQualityCalibrationEntry;
  readonly demoted: readonly ExternalBenchmarkSource[];
} {
  // Collect per-source contributions, dedup by source (keeping latest)
  const sourceMap = new Map<ExternalBenchmarkSource, SourceSpecificQualityScore>();
  for (const e of entries) {
    for (const ss of extractSourceScores(e)) {
      const existing = sourceMap.get(ss.source);
      if (!existing) {
        sourceMap.set(ss.source, ss);
        continue;
      }
      // If same source appears in multiple snapshots, keep the one with
      // higher confidence; on tie, keep the one with higher score.
      const newRank = CONFIDENCE_RANK[ss.confidence];
      const oldRank = CONFIDENCE_RANK[existing.confidence];
      if (newRank > oldRank || (newRank === oldRank && ss.score > existing.score)) {
        sourceMap.set(ss.source, ss);
      }
    }
  }
  const allSources = Array.from(sourceMap.values());
  const { effectiveSources, demoted } = applyManualDemotion(allSources);

  const aggregateScore = aggregateQualityFromSources(effectiveSources) ?? 0;
  const taskCategoryScores = mergeCategoryScores(effectiveSources);
  const confidence = bestConfidence(effectiveSources.map((s) => s.confidence));

  // Merge dimensionScores (max per dimension)
  const mergedDimensionScores: ModelQualityCalibrationEntry['dimensionScores'] = {};
  let anyDimension = false;
  for (const e of entries) {
    if (!e.dimensionScores) continue;
    for (const [dim, score] of Object.entries(e.dimensionScores)) {
      if (typeof score !== 'number') continue;
      const cur = mergedDimensionScores![dim as keyof typeof mergedDimensionScores];
      if (cur === undefined || score > cur) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mergedDimensionScores as Record<string, number>)[dim] = score;
        anyDimension = true;
      }
    }
  }

  const sourcesList: ExternalBenchmarkSource[] = Array.from(sourceMap.keys()).sort();
  const first = entries[0];

  const warnings: string[] = [];
  for (const e of entries) {
    for (const w of e.warnings) {
      if (!warnings.includes(w)) warnings.push(w);
    }
  }
  warnings.push(`merged_sources=${sourcesList.join(',')}`);
  warnings.push(`merge_strategy=weighted_average_by_confidence`);
  if (demoted.length > 0) {
    warnings.push(`manual_demoted=${demoted.join(',')} (external sources present)`);
  }

  const sampleCount = entries.reduce(
    (sum, e) => sum + (typeof e.sampleCount === 'number' ? e.sampleCount : 0),
    0,
  );

  const merged: ModelQualityCalibrationEntry = {
    modelId: first.modelId,
    canonicalModelId: first.canonicalModelId ?? first.modelId,
    family: entries.find((e) => e.family)?.family,
    qualityScore: aggregateScore,
    qualityScoreSource: sourcesList.some(isExternalSource) ? 'external_benchmark' : 'manual_legacy',
    qualityConfidence: confidence,
    dimensionScores: anyDimension ? mergedDimensionScores : undefined,
    taskCategoryScores: Object.keys(taskCategoryScores).length > 0 ? taskCategoryScores : undefined,
    sourceScores: allSources,
    qualityScoreSources: sourcesList,
    benchmarkRunId: entries.find((e) => e.benchmarkRunId)?.benchmarkRunId,
    sampleCount: sampleCount > 0 ? sampleCount : undefined,
    costUsd: entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0),
    warnings,
    createdAt: new Date().toISOString(),
  };
  return { entry: merged, demoted };
}

// ─── Top-level merger ─────────────────────────────────────────────────────

/**
 * Merges N snapshots into one. Groups entries by `canonicalModelId`
 * (falling back to `modelId`), runs per-group merge, applies
 * requireExternalBenchmark filtering.
 *
 * Returns a SnapshotMergeReport with per-canonical audit trail.
 */
export function mergeQualitySnapshots(input: SnapshotMergeInput): SnapshotMergeReport {
  if (input.snapshots.length === 0) {
    throw new Error('mergeQualitySnapshots: at least one snapshot required');
  }

  // Group entries by canonical id
  const byCanonical = new Map<string, ModelQualityCalibrationEntry[]>();
  for (const snap of input.snapshots) {
    for (const e of snap.entries) {
      const key = e.canonicalModelId ?? e.modelId;
      if (!byCanonical.has(key)) byCanonical.set(key, []);
      byCanonical.get(key)!.push(e);
    }
  }

  const merges: SnapshotMergeReport['merges'][number][] = [];
  const droppedNoExternal: SnapshotMergeReport['droppedNoExternal'][number][] = [];
  const mergedEntries: ModelQualityCalibrationEntry[] = [];

  for (const [canonical, entries] of byCanonical.entries()) {
    const { entry, demoted } = mergeEntriesForCanonical(entries);
    const hasExternal = (entry.qualityScoreSources ?? []).some(isExternalSource);

    if (input.requireExternalBenchmark && !hasExternal) {
      droppedNoExternal.push({
        canonicalModelId: canonical,
        reason: 'no_external_benchmark_source_after_merge',
      });
      continue;
    }

    mergedEntries.push(entry);
    merges.push({
      canonicalModelId: canonical,
      contributingSources: entry.qualityScoreSources ?? [],
      mergedQualityScore: entry.qualityScore,
      mergedConfidence: entry.qualityConfidence,
      categoriesCovered: Object.keys(entry.taskCategoryScores ?? {}) as QualityCategory[],
      demotedManualSources: demoted,
    });
  }

  // Union sourceArtifacts across inputs
  const allArtifacts = new Set<string>(input.sourceArtifacts ?? []);
  for (const snap of input.snapshots) {
    for (const a of snap.sourceArtifacts) allArtifacts.add(a);
  }

  const snapshot = buildSnapshot({
    version: input.version,
    sourceArtifacts: Array.from(allArtifacts).sort(),
    entries: mergedEntries,
  });

  return { snapshot, merges, droppedNoExternal };
}
