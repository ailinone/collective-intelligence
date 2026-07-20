// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R4 §8 — LMArena snapshot adapter.
 *
 * Maps LMArena (https://huggingface.co/spaces/lmarena-ai/chatbot-arena)
 * markdown leaderboard tables to ModelQualityCalibrationEntry. Each row
 * carries an Elo rating + vote count; LMArena exposes per-category
 * leaderboards (chat/text, chat/vision, chat/document, code/web-dev,
 * image/edit, image/t2i, video/*, ...). The adapter aggregates a single
 * model's per-category Elos into one entry with `sourceScores[lmarena]`
 * carrying `categoryScores`.
 *
 * Pure functions: no I/O, no provider calls. The CLI at
 * tmp/01c1b-j2c-r4-build-snapshot-from-lmarena.ts handles file I/O and
 * invokes these helpers.
 *
 * Normalization (spec §3.1):
 *   normalized = clamp((elo - 900) / 600, 0, 1)
 * Reference: LMArena Elo typical range ~900..1500 → linear normalization.
 *
 * Attribution requirement:
 *   All entries produced by this adapter MUST carry a warning citing the
 *   LMArena leaderboard URL and the source kind. See ATTRIBUTION_WARNING.
 *
 * NO external HTTP from this module. NO secret values.
 */
import type {
  ModelQualityCalibrationEntry,
  ModelQualityCalibrationSnapshot,
  ModelQualityConfidence,
  QualityCategory,
  SourceSpecificQualityScore,
  ExternalBenchmarkSource,
} from '../role-selection/model-quality-calibration';
import { buildSnapshot } from '../role-selection/model-quality-calibration';

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Single LMArena leaderboard row as parsed from a category table.
 * `category` is filled by the parser based on the section header.
 */
export interface LmArenaRow {
  readonly category: QualityCategory;
  readonly rank: number;
  readonly modelName: string;
  readonly elo: number;
  readonly votes?: number;
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
  readonly matchKind:
    | 'exact_canonical'
    | 'exact_model_id'
    | 'normalized_name'
    | 'unmatched';
  readonly matchConfidence: ModelQualityConfidence;
  readonly matchReason: string;
}

export interface BuildLmArenaSnapshotInput {
  readonly rows: readonly LmArenaRow[];
  readonly candidates?: readonly CandidateLike[];
  readonly version: string;
  readonly benchmarkRunId?: string;
  readonly sourceArtifacts: readonly string[];
  /** When true, emit entries even for models not matched to candidates. */
  readonly emitUnmatchedRows?: boolean;
}

export interface SnapshotBuildResult {
  readonly snapshot: ModelQualityCalibrationSnapshot;
  readonly matched: ReadonlyArray<{
    readonly modelName: string;
    readonly entryModelId: string;
    readonly categoriesCovered: readonly QualityCategory[];
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

export const ATTRIBUTION_WARNING =
  'source=LMArena | sourceUrl=https://huggingface.co/spaces/lmarena-ai/chatbot-arena | sourceKind=external_benchmark | redistribution requires attribution';

export const SOURCE: ExternalBenchmarkSource = 'lmarena';

// ─── Elo normalization (spec §3.1) ─────────────────────────────────────────

/**
 * Normalizes an LMArena Elo to [0, 1]:
 *
 *   normalized = clamp((elo - 900) / 600, 0, 1)
 *
 * Rationale: LMArena Elos cluster between ~900 (weakest) and ~1500 (top).
 * 900 → 0; 1500 → 1; 1200 → 0.5. Values outside this range are clamped
 * but flagged as suspicious.
 *
 * Returns `undefined` when input is non-finite (NaN, Infinity).
 */
export function normalizeElo(elo: unknown): number | undefined {
  if (elo === null || elo === undefined) return undefined;
  const n = typeof elo === 'number' ? elo : Number(elo);
  if (!Number.isFinite(n)) return undefined;
  const raw = (n - 900) / 600;
  const clamped = Math.max(0, Math.min(1, raw));
  return +clamped.toFixed(4);
}

// ─── Name canonicalization ────────────────────────────────────────────────

/**
 * Canonicalizes an LMArena model name for matching against catalog IDs.
 *   - Lower case
 *   - Strip parenthetical qualifiers (e.g., "(thinking)", "(vision)")
 *   - Normalize whitespace
 *   - Preserve slashes (LMArena uses "moonshotai/Kimi-K2.6" style)
 *
 * Examples:
 *   "claude-opus-4-7 (thinking)"      → "claude-opus-4-7"
 *   "moonshotai/Kimi-K2.6"            → "moonshotai/kimi-k2.6"
 *   "gpt-4o-mini-2024-07-18"          → "gpt-4o-mini-2024-07-18"
 */
export function canonicalizeLmArenaModelName(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ') // drop parentheticals
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compact slug form: drops spaces + slashes for substring compare. */
export function compactSlug(name: string): string {
  return canonicalizeLmArenaModelName(name).replace(/[\s/-]+/g, '');
}

// ─── Markdown parsing ─────────────────────────────────────────────────────

// Match `## Category: <name>` — name may contain letters, digits and underscores
// (e.g., `image_t2i`, `video_i2v`). Case-insensitive on the header literal.
const CATEGORY_HEADER_RE = /^##\s+Category:\s*([a-z0-9_]+)\s*$/i;

const VALID_CATEGORIES: ReadonlySet<QualityCategory> = new Set<QualityCategory>([
  'chat_text',
  'chat_search',
  'chat_vision',
  'chat_document',
  'code_webdev',
  'code_image_to_dev',
  'image_t2i',
  'image_edit',
  'video_t2v',
  'video_i2v',
  'video_edit',
]);

/**
 * Parses an LMArena source markdown document into per-category rows.
 *
 * Recognized format:
 *
 *   ## Category: <category-name>
 *
 *   | Rank | Model | Elo | Votes |
 *   |-----:|-------|----:|------:|
 *   | 1 | model-a | 1500 | 12000 |
 *   | 2 | model-b | 1490 | 11000 |
 *
 * Returns a flat array of LmArenaRow with category attached. Skips rows
 * whose category header is not a valid QualityCategory and skips rows
 * whose Elo cannot be parsed.
 */
export function parseLmArenaMarkdown(text: string): {
  readonly rows: readonly LmArenaRow[];
  readonly warnings: readonly string[];
} {
  const lines = text.split(/\r?\n/);
  const rows: LmArenaRow[] = [];
  const warnings: string[] = [];
  let currentCategory: QualityCategory | undefined;
  let inTableBody = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const header = line.match(CATEGORY_HEADER_RE);
    if (header) {
      const cat = header[1].toLowerCase() as QualityCategory;
      if (!VALID_CATEGORIES.has(cat)) {
        warnings.push(`unknown_category:${cat}`);
        currentCategory = undefined;
      } else {
        currentCategory = cat;
      }
      inTableBody = false;
      continue;
    }
    if (!currentCategory) continue;

    // Table separator line: |----|----|...| → enter body mode
    if (/^\|[\s\-:|]+\|$/.test(line)) {
      inTableBody = true;
      continue;
    }
    if (!inTableBody) continue;
    if (!line.startsWith('|')) {
      // Exiting the table
      inTableBody = false;
      continue;
    }
    // Parse data row: | rank | model | elo | votes |
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c, idx, arr) => idx > 0 && idx < arr.length - 1); // drop edge empties
    if (cells.length < 3) continue;
    const rank = Number(cells[0]);
    const modelName = cells[1];
    const elo = Number(cells[2]);
    const votes = cells.length >= 4 ? Number(cells[3]) : undefined;
    if (!Number.isFinite(rank) || !modelName || !Number.isFinite(elo)) {
      warnings.push(`bad_row:${line}`);
      continue;
    }
    rows.push({
      category: currentCategory,
      rank,
      modelName,
      elo,
      votes: Number.isFinite(votes) ? votes : undefined,
    });
  }
  return { rows, warnings };
}

// ─── Matching ─────────────────────────────────────────────────────────────

/**
 * Heuristic similarity between an LMArena model name and a catalog
 * candidate. Mirrors the BenchLM adapter's strategy:
 *   1. Exact canonicalModelId
 *   2. Exact modelId / logicalModelId
 *   3. Slug substring (both directions, length ≥5 to avoid false matches)
 */
export function matchLmArenaRowToCatalogModel(
  modelName: string,
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
  const benchName = canonicalizeLmArenaModelName(modelName);
  const benchSlug = compactSlug(modelName);

  // 1. Exact canonicalModelId
  for (const c of candidates) {
    const canon = (c.canonicalModelId ?? '').toLowerCase();
    if (canon && benchName === canon) {
      return {
        matched: true,
        candidate: c,
        matchKind: 'exact_canonical',
        matchConfidence: 'high',
        matchReason: 'exact_canonical_match',
      };
    }
  }
  // 2. Exact modelId / logicalModelId
  for (const c of candidates) {
    const m = (c.modelId ?? c.logicalModelId ?? '').toLowerCase();
    if (m && benchName === m) {
      return {
        matched: true,
        candidate: c,
        matchKind: 'exact_model_id',
        matchConfidence: 'high',
        matchReason: 'exact_model_id_match',
      };
    }
  }
  // 3. Slug substring match
  for (const c of candidates) {
    const candSlug = compactSlug(c.canonicalModelId ?? c.modelId ?? c.logicalModelId ?? '');
    if (!candSlug) continue;
    const shorter = candSlug.length < benchSlug.length ? candSlug : benchSlug;
    if (shorter.length >= 5 && (benchSlug.includes(candSlug) || candSlug.includes(benchSlug))) {
      return {
        matched: true,
        candidate: c,
        matchKind: 'normalized_name',
        matchConfidence: 'medium',
        matchReason: `slug_substring_match (${candSlug} ⇔ ${benchSlug})`,
      };
    }
  }
  return {
    matched: false,
    matchKind: 'unmatched',
    matchConfidence: 'placeholder',
    matchReason: `no_match_for_${benchName}`,
  };
}

// ─── Rows → Entry ─────────────────────────────────────────────────────────

/**
 * Combines all per-category rows for a single model into one calibration
 * entry. The entry's `sourceScores[0]` is the LMArena contribution,
 * carrying `categoryScores` indexed by QualityCategory. The top-level
 * `qualityScore` is the mean of all category scores (proxy aggregate for
 * the source in isolation; the merger may overwrite this when combining
 * with other sources).
 *
 * - Rejects when no rows provided.
 * - Per-category Elo with the largest `votes` wins (in case of duplicates,
 *   e.g., same model appearing in both vision and document — different
 *   categories already differentiate; intra-category dedup picks max votes).
 *
 * Returns undefined when all rows have invalid Elos.
 */
export function lmArenaRowsToCalibrationEntry(
  modelName: string,
  rows: readonly LmArenaRow[],
  opts: {
    readonly match?: MatchResult;
    readonly benchmarkRunId?: string;
    readonly attributionWarning?: string;
    readonly capturedAt?: string;
  } = {},
): ModelQualityCalibrationEntry | undefined {
  if (rows.length === 0) return undefined;

  // Dedup per category by votes (max votes wins)
  const bestPerCategory = new Map<QualityCategory, LmArenaRow>();
  for (const r of rows) {
    const existing = bestPerCategory.get(r.category);
    if (!existing || (r.votes ?? 0) > (existing.votes ?? 0)) {
      bestPerCategory.set(r.category, r);
    }
  }

  const categoryScores: Partial<Record<QualityCategory, number>> = {};
  let totalVotes = 0;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const [cat, row] of bestPerCategory.entries()) {
    const score = normalizeElo(row.elo);
    if (score === undefined) continue;
    categoryScores[cat] = score;
    totalVotes += row.votes ?? 0;
    if (row.rank < bestRank) bestRank = row.rank;
  }

  const categoryValues = Object.values(categoryScores) as number[];
  if (categoryValues.length === 0) return undefined;

  // Aggregate score for the source = MAX of category scores (the model's
  // best-known capability, per spec premise that quality is task-specific).
  // The merger may still apply confidence weighting across sources.
  const sourceScore = +Math.max(...categoryValues).toFixed(4);

  const confidence: ModelQualityConfidence = opts.match?.matchConfidence ?? 'medium';

  const canonicalFromCandidate = opts.match?.candidate?.canonicalModelId;
  const modelId =
    canonicalFromCandidate ?? opts.match?.candidate?.modelId ?? canonicalizeLmArenaModelName(modelName);

  const sourceScores: SourceSpecificQualityScore[] = [
    {
      source: SOURCE,
      score: sourceScore,
      confidence,
      sourceUrl: 'https://huggingface.co/spaces/lmarena-ai/chatbot-arena',
      sampleSize: totalVotes > 0 ? totalVotes : undefined,
      rank: Number.isFinite(bestRank) ? bestRank : undefined,
      categoryScores,
      capturedAt: opts.capturedAt,
    },
  ];

  const warnings: string[] = [opts.attributionWarning ?? ATTRIBUTION_WARNING];
  if (opts.match) {
    warnings.push(`match_kind=${opts.match.matchKind} match_confidence=${opts.match.matchConfidence}`);
  }
  warnings.push(`lmarena_categories=${Object.keys(categoryScores).sort().join(',')}`);

  return {
    modelId,
    canonicalModelId: canonicalFromCandidate ?? modelId,
    family: opts.match?.candidate?.family,
    qualityScore: sourceScore,
    qualityScoreSource: 'external_benchmark',
    qualityConfidence: confidence,
    sourceScores,
    taskCategoryScores: categoryScores,
    qualityScoreSources: [SOURCE],
    benchmarkRunId: opts.benchmarkRunId,
    sampleCount: totalVotes > 0 ? totalVotes : undefined,
    costUsd: 0,
    warnings,
    createdAt: new Date().toISOString(),
  };
}

// ─── Snapshot builder ─────────────────────────────────────────────────────

/**
 * Builds a `ModelQualityCalibrationSnapshot` from LMArena rows + optional
 * candidate pool. Groups rows by canonical model name, matches each group
 * against candidates, produces one entry per unique model.
 *
 *  - `matched`     — entries that successfully linked to a catalog candidate
 *                    (with categoriesCovered for coverage analysis)
 *  - `notCovered`  — catalog candidates that have NO LMArena rows
 *  - `skipped`     — rows dropped (e.g., low-confidence match + reject)
 */
export function buildLmArenaQualitySnapshot(
  input: BuildLmArenaSnapshotInput,
): SnapshotBuildResult {
  const candidates = input.candidates ?? [];
  const matchedReports: Array<SnapshotBuildResult['matched'][number]> = [];
  const skippedReports: Array<SnapshotBuildResult['skipped'][number]> = [];
  const matchedCanonicalIds = new Set<string>();

  // Group rows by canonical model name
  const byModel = new Map<string, LmArenaRow[]>();
  for (const row of input.rows) {
    const key = canonicalizeLmArenaModelName(row.modelName);
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key)!.push(row);
  }

  const entries: ModelQualityCalibrationEntry[] = [];
  for (const [modelKey, rows] of byModel.entries()) {
    const match = candidates.length > 0
      ? matchLmArenaRowToCatalogModel(rows[0].modelName, candidates)
      : undefined;

    const allowEmit = input.emitUnmatchedRows === true || (match?.matched === true);
    if (!allowEmit) {
      skippedReports.push({
        modelName: modelKey,
        reason: match ? `no_candidate_match (${match.matchReason})` : 'no_candidate_pool',
      });
      continue;
    }

    const entry = lmArenaRowsToCalibrationEntry(rows[0].modelName, rows, {
      match,
      benchmarkRunId: input.benchmarkRunId,
    });
    if (!entry) {
      skippedReports.push({
        modelName: modelKey,
        reason: 'all_rows_had_unparseable_elo',
      });
      continue;
    }
    entries.push(entry);
    if (match?.matched && match.candidate?.canonicalModelId) {
      matchedCanonicalIds.add(match.candidate.canonicalModelId);
    }
    matchedReports.push({
      modelName: rows[0].modelName,
      entryModelId: entry.modelId,
      categoriesCovered: Object.keys(entry.taskCategoryScores ?? {}) as QualityCategory[],
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
      reason: 'no_lmarena_rows_matched_this_candidate',
    }));

  const snapshot = buildSnapshot({
    version: input.version,
    sourceArtifacts: input.sourceArtifacts,
    entries,
  });

  return { snapshot, matched: matchedReports, notCovered, skipped: skippedReports };
}
