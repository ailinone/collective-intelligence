// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R3 §8 — BenchLM snapshot adapter.
 *
 * Maps BenchLM leaderboard rows (CSV or JSON) to ModelQualityCalibrationEntry.
 * Pure functions: no I/O, no provider calls. The CLI at
 * tmp/01c1b-j2c-r3-build-snapshot-from-benchlm.mjs handles file I/O and
 * invokes these helpers.
 *
 * Why this is the J2 unlock:
 *   - BenchLM has 8 explicit dimensions that map 1:1 to our enum
 *   - 115+ models, ~weekly refresh, methodology at /methodology
 *   - No PROBE_API_KEY needed; no provider calls; cost = $0
 *   - Provenance: qualityScoreSource='external_benchmark', attribution required
 *
 * Attribution requirement:
 *   All entries produced by this adapter MUST carry a warning citing
 *   `https://benchlm.ai/` and the source kind. See ATTRIBUTION_WARNING.
 *
 * NO external HTTP from this module. NO secret values.
 */
import type {
  ModelQualityCalibrationEntry,
  ModelQualityCalibrationSnapshot,
  ModelQualityDimension,
  ModelQualityConfidence,
} from '../role-selection/model-quality-calibration';
import { buildSnapshot } from '../role-selection/model-quality-calibration';

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Shape of a BenchLM leaderboard row as received from CSV/JSON.
 * Both formats produce the same logical fields; the CLI normalizes them.
 */
export interface BenchLmLeaderboardRow {
  readonly modelName: string;
  readonly modelId?: string;
  readonly provider?: string;
  readonly organization?: string;
  readonly creator?: string;
  readonly sourceType?: 'Proprietary' | 'Open Weight' | string;
  readonly rank?: number;
  readonly overall?: number;
  readonly categoryScores?: {
    readonly agentic?: number | null;
    readonly coding?: number | null;
    readonly reasoning?: number | null;
    readonly knowledge?: number | null;
    readonly math?: number | null;
    readonly multimodalGrounded?: number | null;
    readonly multilingual?: number | null;
    readonly instructionFollowing?: number | null;
  };
  readonly pricing?: {
    readonly input?: number | null;
    readonly output?: number | null;
  };
  readonly updatedAt?: string;
}

export interface MappingOptions {
  /** Attribution warning attached to every produced entry. */
  readonly attributionWarning?: string;
  /** Benchmark run identifier (e.g., snapshot date from BenchLM). */
  readonly benchmarkRunId?: string;
  /** Optional explicit family classifier for the row. */
  readonly familyHint?: string;
  /** Treat low-confidence matches as ineligible (default: true). */
  readonly rejectLowConfidence?: boolean;
}

export interface CandidateLike {
  readonly canonicalModelId?: string;
  readonly modelId?: string;
  readonly logicalModelId?: string;
  readonly family?: string;
  readonly providerId?: string;
}

export interface MatchResult {
  readonly matched: boolean;
  readonly candidate?: CandidateLike;
  readonly matchKind: 'exact_canonical' | 'exact_model_id' | 'normalized_name' | 'alias' | 'unmatched';
  readonly matchConfidence: ModelQualityConfidence;
  readonly matchReason: string;
}

export interface BuildBenchLmSnapshotInput {
  readonly rows: readonly BenchLmLeaderboardRow[];
  readonly candidates?: readonly CandidateLike[];
  readonly version: string;
  readonly benchmarkRunId?: string;
  readonly sourceArtifacts: readonly string[];
  readonly familyHints?: Readonly<Record<string, string>>;
  /** When true, emit entries even for rows not matched to candidates. */
  readonly emitUnmatchedRows?: boolean;
}

export const ATTRIBUTION_WARNING =
  'source=BenchLM | sourceUrl=https://benchlm.ai/ | sourceKind=external_benchmark | redistribution requires attribution';

// ─── Score normalization ──────────────────────────────────────────────────

/**
 * Normalizes a BenchLM score to [0, 1].
 *
 * BenchLM uses 0-100 scale for overall + category scores. Some sources
 * may already be normalized to 0-1. We detect by magnitude:
 *   - value > 1 → assume 0-100, divide by 100
 *   - 0 ≤ value ≤ 1 → assume already normalized
 *   - value < 0 OR > 100 → invalid, return undefined
 *
 * Empty/null/non-numeric → undefined (does not populate dimensionScores).
 */
export function normalizeBenchLmScore(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return undefined;
  if (n > 100) return undefined;
  const normalized = n > 1 ? n / 100 : n;
  return +Math.max(0, Math.min(1, normalized)).toFixed(4);
}

// ─── Dimension mapping ────────────────────────────────────────────────────

/**
 * Maps BenchLM `categoryScores` to our `ModelQualityDimension` partial record.
 *
 * Mapping (per spec §3):
 *   BenchLM.agentic              → tool_use
 *   BenchLM.coding               → coding
 *   BenchLM.reasoning            → reasoning
 *   BenchLM.knowledge            → factuality
 *   BenchLM.math                 → math (new)
 *   BenchLM.multilingual         → multilingual (new)
 *   BenchLM.multimodalGrounded   → multimodal_grounded (new)
 *   BenchLM.instructionFollowing → instruction_following
 *
 * Skip dimensions where source value is null/undefined/invalid — never
 * synthesize 0 for missing data (would be misleading).
 */
export function mapBenchLmDimensions(
  row: BenchLmLeaderboardRow,
): Partial<Record<ModelQualityDimension, number>> {
  const cat = row.categoryScores ?? {};
  const out: Partial<Record<ModelQualityDimension, number>> = {};
  const pairs: Array<[ModelQualityDimension, unknown]> = [
    ['tool_use', cat.agentic],
    ['coding', cat.coding],
    ['reasoning', cat.reasoning],
    ['factuality', cat.knowledge],
    ['math', cat.math],
    ['multilingual', cat.multilingual],
    ['multimodal_grounded', cat.multimodalGrounded],
    ['instruction_following', cat.instructionFollowing],
  ];
  for (const [dim, value] of pairs) {
    const n = normalizeBenchLmScore(value);
    if (n !== undefined) out[dim] = n;
  }
  return out;
}

// ─── Name canonicalization ────────────────────────────────────────────────

/**
 * Canonicalizes a BenchLM model name for matching against catalog IDs.
 *   - Lower case
 *   - Strip parenthetical qualifiers (e.g., "(Max)", "(Adaptive)", "(High)")
 *   - Normalize whitespace and dots/dashes
 *
 * Examples:
 *   "Claude Opus 4.7 (Adaptive)" → "claude opus 4.7"
 *   "DeepSeek V4 Pro (Max)" → "deepseek v4 pro"
 *   "GPT-5.5 (xhigh)" → "gpt-5.5"
 */
export function canonicalizeBenchLmModelName(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')   // drop parenthetical qualifiers
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim();
}

/**
 * Compact slug form: drops spaces + diacritics for direct slug compare.
 *   "claude opus 4.7" → "claudeopus4.7"
 */
export function compactSlug(name: string): string {
  return canonicalizeBenchLmModelName(name).replace(/[\s-]+/g, '');
}

// ─── Matching ─────────────────────────────────────────────────────────────

/**
 * Heuristic similarity between a BenchLM row and a catalog candidate.
 * Returns a MatchResult with confidence + reason. Never uses fuzzy ratio;
 * we only accept stem/substring matches that are unambiguous.
 */
export function matchBenchLmRowToCatalogModel(
  row: BenchLmLeaderboardRow,
  candidates: readonly CandidateLike[],
): MatchResult {
  if (candidates.length === 0) {
    return {
      matched: false,
      matchKind: 'unmatched',
      matchConfidence: 'placeholder',
      matchReason: 'no_candidates_provided',
    };
  }
  const benchName = canonicalizeBenchLmModelName(row.modelName);
  const benchSlug = compactSlug(row.modelName);

  // 1. Exact canonicalModelId
  for (const c of candidates) {
    const canon = (c.canonicalModelId ?? '').toLowerCase();
    if (canon && benchName === canon) {
      return { matched: true, candidate: c, matchKind: 'exact_canonical', matchConfidence: 'high', matchReason: 'exact_canonical_match' };
    }
  }
  // 2. Exact modelId / logicalModelId
  for (const c of candidates) {
    const m = (c.modelId ?? c.logicalModelId ?? '').toLowerCase();
    if (m && benchName === m) {
      return { matched: true, candidate: c, matchKind: 'exact_model_id', matchConfidence: 'high', matchReason: 'exact_model_id_match' };
    }
  }
  // 3. Slug substring match — both directions
  for (const c of candidates) {
    const candSlug = compactSlug(c.canonicalModelId ?? c.modelId ?? c.logicalModelId ?? '');
    if (!candSlug) continue;
    if (candSlug.length >= 5 && (benchSlug.includes(candSlug) || candSlug.includes(benchSlug))) {
      // Substring matches are reliable IF the shorter slug has length ≥5
      // (prevents matching "gpt" against "gpt-4o-mini" etc.)
      const shorter = candSlug.length < benchSlug.length ? candSlug : benchSlug;
      if (shorter.length >= 5) {
        return {
          matched: true,
          candidate: c,
          matchKind: 'normalized_name',
          matchConfidence: 'medium',
          matchReason: `slug_substring_match (${candSlug} ⇔ ${benchSlug})`,
        };
      }
    }
  }
  return {
    matched: false,
    matchKind: 'unmatched',
    matchConfidence: 'placeholder',
    matchReason: `no_match_for_${benchName}`,
  };
}

// ─── Row → Entry ─────────────────────────────────────────────────────────

/**
 * Converts a BenchLM row to a ModelQualityCalibrationEntry. Returns
 * undefined when the row lacks an `overall` score (cannot produce a
 * trustworthy quality score) or when matchConfidence is too low (when
 * rejectLowConfidence=true).
 */
export function benchLmRowToCalibrationEntry(
  row: BenchLmLeaderboardRow,
  opts: MappingOptions & { match?: MatchResult } = {},
): ModelQualityCalibrationEntry | undefined {
  const overall = normalizeBenchLmScore(row.overall);
  if (overall === undefined) {
    return undefined; // never produce external_benchmark without primary score
  }

  const dimensionScores = mapBenchLmDimensions(row);
  const reject = opts.rejectLowConfidence !== false;
  const match = opts.match;

  if (reject && match && match.matchConfidence === 'placeholder') {
    return undefined;
  }

  const canonicalFromCandidate = match?.candidate?.canonicalModelId;
  const modelId = canonicalFromCandidate ?? row.modelId ?? canonicalizeBenchLmModelName(row.modelName);

  const warnings: string[] = [opts.attributionWarning ?? ATTRIBUTION_WARNING];
  if (match) {
    warnings.push(`match_kind=${match.matchKind} match_confidence=${match.matchConfidence}`);
  }
  if (Object.keys(dimensionScores).length === 0) {
    warnings.push('no_category_scores_present_using_overall_only');
  }

  const family = match?.candidate?.family ?? opts.familyHint;

  return {
    modelId,
    canonicalModelId: canonicalFromCandidate ?? modelId,
    family,
    qualityScore: overall,
    qualityScoreSource: 'external_benchmark',
    qualityConfidence: match?.matchConfidence ?? 'medium',
    dimensionScores,
    benchmarkRunId: opts.benchmarkRunId,
    sampleCount: row.rank, // BenchLM provides ranks (not sample count); we use this as a proxy
    costUsd: 0,
    warnings,
    createdAt: new Date().toISOString(),
  };
}

// ─── Snapshot builder ─────────────────────────────────────────────────────

export interface SnapshotBuildResult {
  readonly snapshot: ModelQualityCalibrationSnapshot;
  readonly matched: ReadonlyArray<{
    readonly modelName: string;
    readonly entryModelId: string;
    readonly matchKind: MatchResult['matchKind'];
    readonly matchConfidence: ModelQualityConfidence;
  }>;
  readonly notCovered: ReadonlyArray<{
    readonly candidateModelId: string;
    readonly family?: string;
    readonly reason: string;
  }>;
  readonly skipped: ReadonlyArray<{
    readonly modelName: string;
    readonly reason: string;
  }>;
}

/**
 * Builds a `ModelQualityCalibrationSnapshot` from BenchLM rows + optional
 * candidate pool. The candidate pool drives matching priority — rows that
 * match a candidate get high/medium confidence; rows without candidate
 * matches are either dropped or emitted with low confidence depending on
 * `emitUnmatchedRows`.
 *
 * Also produces:
 *   - `matched`: entries that successfully linked to a catalog candidate
 *   - `notCovered`: catalog candidates that have NO BenchLM row (so the
 *     operator knows where coverage gaps are)
 *   - `skipped`: BenchLM rows that were dropped (missing overall, etc.)
 */
export function buildBenchLmQualitySnapshot(
  input: BuildBenchLmSnapshotInput,
): SnapshotBuildResult {
  const candidates = input.candidates ?? [];
  const matchedReports: Array<SnapshotBuildResult['matched'][number]> = [];
  const skippedReports: Array<SnapshotBuildResult['skipped'][number]> = [];
  const entries: ModelQualityCalibrationEntry[] = [];
  const matchedCanonicalIds = new Set<string>();

  for (const row of input.rows) {
    const match = candidates.length > 0
      ? matchBenchLmRowToCatalogModel(row, candidates)
      : undefined;
    const allowEmit = input.emitUnmatchedRows === true || (match?.matched === true);
    if (!allowEmit) {
      skippedReports.push({
        modelName: row.modelName,
        reason: match ? `no_candidate_match (${match.matchReason})` : 'no_candidate_pool',
      });
      continue;
    }
    const entry = benchLmRowToCalibrationEntry(row, {
      benchmarkRunId: input.benchmarkRunId,
      familyHint: input.familyHints?.[canonicalizeBenchLmModelName(row.modelName)],
      match,
      rejectLowConfidence: true,
    });
    if (!entry) {
      skippedReports.push({
        modelName: row.modelName,
        reason: 'missing_overall_or_low_confidence_match',
      });
      continue;
    }
    entries.push(entry);
    if (match?.matched && match.candidate?.canonicalModelId) {
      matchedCanonicalIds.add(match.candidate.canonicalModelId);
    }
    matchedReports.push({
      modelName: row.modelName,
      entryModelId: entry.modelId,
      matchKind: match?.matchKind ?? 'unmatched',
      matchConfidence: entry.qualityConfidence,
    });
  }

  const notCovered = candidates
    .filter((c) => {
      const canon = c.canonicalModelId;
      return canon && !matchedCanonicalIds.has(canon);
    })
    .map((c) => ({
      candidateModelId: c.canonicalModelId ?? c.modelId ?? 'unknown',
      family: c.family,
      reason: 'no_benchlm_row_matched_this_candidate',
    }));

  // Deduplicate by canonicalModelId — when multiple BenchLM rows map to
  // the same canonical (e.g., "DeepSeek V4 Pro Max" + "High" + base all
  // collapse to canonical "deepseek-v4-pro"), keep the row with HIGHEST
  // qualityScore. We track the dropped variants in warnings.
  const byCanon = new Map<string, ModelQualityCalibrationEntry>();
  const dedupDropped: Array<{ canonicalModelId: string; droppedScore: number; keptScore: number }> = [];
  for (const entry of entries) {
    const key = entry.canonicalModelId ?? entry.modelId;
    const existing = byCanon.get(key);
    if (!existing) { byCanon.set(key, entry); continue; }
    if (entry.qualityScore > existing.qualityScore) {
      byCanon.set(key, entry);
      dedupDropped.push({ canonicalModelId: key, droppedScore: existing.qualityScore, keptScore: entry.qualityScore });
    } else {
      dedupDropped.push({ canonicalModelId: key, droppedScore: entry.qualityScore, keptScore: existing.qualityScore });
    }
  }
  const dedupedEntries = Array.from(byCanon.values()).map((e) =>
    dedupDropped.some((d) => d.canonicalModelId === (e.canonicalModelId ?? e.modelId))
      ? { ...e, warnings: [...e.warnings, `deduplicated_variants_kept_best_score`] }
      : e,
  );

  const snapshot = buildSnapshot({
    version: input.version,
    sourceArtifacts: input.sourceArtifacts,
    entries: dedupedEntries,
  });

  return { snapshot, matched: matchedReports, notCovered, skipped: skippedReports };
}
