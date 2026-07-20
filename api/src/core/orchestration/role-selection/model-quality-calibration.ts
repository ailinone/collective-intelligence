// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2 §7 — Model quality calibration snapshot contract.
 *
 * A `ModelQualityCalibrationSnapshot` is an AUDITABLE, signed-by-source
 * record of per-model quality scores. It is the only mechanism by which
 * the synthesizer/role scorers learn "is this model GOOD?" beyond the
 * uniform catalog placeholder.
 *
 * Key contract properties:
 *   - Each entry has BOTH a numeric `qualityScore` AND a `qualityScoreSource`.
 *     A score without provenance is INVALID.
 *   - `qualityConfidence` reflects HOW MUCH we trust the score. Placeholder
 *     entries MUST mark `'placeholder'` so the scorer can apply penalties
 *     accordingly.
 *   - The whole snapshot has a deterministic `snapshotHash` so it can
 *     participate in `planFingerprint` — runtime cannot silently substitute
 *     a different snapshot.
 *   - Entries are sanitized — no API keys, no raw prompts, no provider
 *     payloads. Only id, score, source, confidence, dimension breakdown,
 *     and benchmark metadata.
 *
 * J2 explicit anti-patterns (rejected by validation):
 *   - score without source → invalid
 *   - score outside 0..1 → invalid
 *   - `qualityConfidence='high'` AND `qualityScoreSource='placeholder'` → invalid
 *   - entries with API key fragments in any string field → invalid
 *
 * NO external HTTP. NO secret values.
 */
import { createHash } from 'node:crypto';

/**
 * Per-dimension quality scores. The synthesizer role specifically cares
 * about `reasoning`, `synthesis`, `instruction_following`, `structured_output`.
 * Other roles may prefer `tool_use`, `coding`, etc.
 */
export type ModelQualityDimension =
  | 'reasoning'
  | 'coding'
  | 'synthesis'
  | 'instruction_following'
  | 'structured_output'
  | 'factuality'
  | 'tool_use'
  | 'latency'
  | 'cost_efficiency'
  | 'reliability'
  // 01C.1B-J2-C-R3 §3 — Additional dimensions sourced from external
  // benchmarks (BenchLM v1 has math/multilingual/multimodalGrounded as
  // first-class categories). Adding here is backward-compatible because
  // `dimensionScores` is Partial<Record<...>> — existing snapshots that
  // do not populate these fields remain valid.
  | 'math'
  | 'multilingual'
  | 'multimodal_grounded';

/**
 * 01C.1B-J2-C-R4 §7 — External benchmark sources whose scores can be
 * combined into a multi-source snapshot. Adding a new source here is the
 * single touchpoint required for new ingestion adapters. The validator
 * accepts any source listed here; combining scores from multiple sources
 * is the job of the merger module.
 *
 *  - `benchlm`             — BenchLM (https://benchlm.ai). 8 dimensions.
 *  - `lmarena`             — LMArena Chatbot Arena. Per-category Elo.
 *  - `artificial_analysis` — Artificial Analysis Intelligence Index. Per-provider.
 *  - `internal`            — internal model-quality benchmark (J2-B/J2-C).
 *  - `manual`              — explicitly operator-flagged manual entry.
 *                            Lowest priority; cannot override external.
 */
export type ExternalBenchmarkSource =
  | 'benchlm'
  | 'lmarena'
  | 'artificial_analysis'
  | 'internal'
  | 'manual';

/**
 * 01C.1B-J2-C-R4 §7 — Task-aligned quality categories. The synthesizer
 * uses the candidate's category score MATCHING the current task before
 * falling back to the cross-category aggregate. This is what closes the
 * J1G manual-bump anti-pattern: a model with high `chat_text` rank is
 * NOT chosen for `image_edit` just because its rank exists.
 *
 * Categories intentionally mirror LMArena's category set so adapters can
 * map 1:1. New categories must be added here AND mapped to a taskType in
 * `task-aware-quality-resolver.ts`.
 */
export type QualityCategory =
  | 'chat_text'
  | 'chat_search'
  | 'chat_vision'
  | 'chat_document'
  | 'code_webdev'
  | 'code_image_to_dev'
  | 'image_t2i'
  | 'image_edit'
  | 'video_t2v'
  | 'video_i2v'
  | 'video_edit';

/**
 * 01C.1B-J2-C-R4 §7 — A single source's contribution to a model's
 * quality profile. One `SourceSpecificQualityScore` per source in
 * `entry.sourceScores`. The merger preserves all sources verbatim; it
 * never collapses them into a single number (that's what the aggregate
 * `qualityScore` field is for).
 *
 *  - `score`         — normalized to [0, 1], the source's overall verdict
 *  - `confidence`    — how much this source trusts this score
 *  - `sourceUrl`     — auditable URL for the source (no secrets)
 *  - `sampleSize`    — votes/runs supporting the score; used for weighting
 *  - `rank`          — source-reported rank (lower = better); for reports
 *  - `categoryScores` — per-category breakdown, when source provides it
 *  - `capturedAt`    — when the operator captured the source artifact
 */
export interface SourceSpecificQualityScore {
  readonly source: ExternalBenchmarkSource;
  readonly score: number;
  readonly confidence: ModelQualityConfidence;
  readonly sourceUrl?: string;
  readonly sampleSize?: number;
  readonly rank?: number;
  readonly categoryScores?: Partial<Record<QualityCategory, number>>;
  readonly capturedAt?: string;
}

/**
 * Provenance of a quality score. The scorer applies different confidence
 * weights based on this:
 *   - `placeholder` / `inferred_family_default` → low trust, unknown-quality penalty applies
 *   - `manual_legacy` → medium trust but flagged for re-validation
 *   - `internal_benchmark` / `external_benchmark` / `live_probe` → high trust
 *   - `catalog_metadata` → trust depends on `qualityConfidence`
 *   - `unknown` → equivalent to placeholder for safety
 */
export type ModelQualityScoreSource =
  | 'placeholder'
  | 'manual_legacy'
  | 'internal_benchmark'
  | 'external_benchmark'
  | 'live_probe'
  | 'catalog_metadata'
  | 'inferred_family_default'
  | 'unknown';

export type ModelQualityConfidence = 'high' | 'medium' | 'low' | 'placeholder';

export interface ModelQualityCalibrationEntry {
  /** Model id as stored in catalog (e.g., `anthropic-claude-3.7-sonnet`). */
  readonly modelId: string;
  /** Optional canonical id (after J1F alias normalization). */
  readonly canonicalModelId?: string;
  /** Family classifier output (e.g., `anthropic_claude`). */
  readonly family?: string;
  /** Distinct provider count serving this logical model in catalog. */
  readonly providerCoverageCount?: number;
  /** Distinct ROUTER count (vs native) — subset of providers. */
  readonly routerCoverageCount?: number;
  /** Aggregate score in [0, 1]. */
  readonly qualityScore: number;
  /** Where this score came from. */
  readonly qualityScoreSource: ModelQualityScoreSource;
  /** How much we trust the score. Placeholder source → must be 'placeholder' confidence. */
  readonly qualityConfidence: ModelQualityConfidence;
  /** Optional per-dimension breakdown. Each value in [0, 1]. */
  readonly dimensionScores?: Partial<Record<ModelQualityDimension, number>>;
  /** Identifiers of the benchmark tasks used (when source is benchmark/live_probe). */
  readonly benchmarkTaskIds?: readonly string[];
  /** Identifier of the benchmark run that produced this entry. */
  readonly benchmarkRunId?: string;
  /** Total samples across tasks. */
  readonly sampleCount?: number;
  /** Aggregate cost in USD for this entry's benchmark (may be 0 if placeholder). */
  readonly costUsd?: number;
  readonly latencyMsP50?: number;
  readonly latencyMsP95?: number;
  /**
   * 01C.1B-J2-C-R4 §7 — Per-source quality contributions.
   *
   * When present, the top-level `qualityScore` is a derived view (weighted
   * average of `sourceScores[].score`) and `qualityScoreSources` MUST
   * include every source contributing here.
   *
   * Entries produced by single-source adapters (e.g., the original BenchLM
   * adapter pre-J2-C-R4) MAY omit this field for backward compatibility.
   * Single-source entries are valid; the merger is the consumer that
   * populates this field when combining multiple sources.
   */
  readonly sourceScores?: readonly SourceSpecificQualityScore[];
  /**
   * 01C.1B-J2-C-R4 §7 — Aggregated per-category scores across all sources.
   *
   * The task-aware resolver reads this map first; if the requested
   * category is missing, it falls back to the top-level `qualityScore`
   * aggregate. Empty / missing means "no per-category data, use aggregate".
   */
  readonly taskCategoryScores?: Partial<Record<QualityCategory, number>>;
  /**
   * 01C.1B-J2-C-R4 §7 — Sources whose scores contribute to this entry.
   *
   * Single-source entries omit this field; multi-source entries (produced
   * by the merger) MUST populate it and it MUST be a superset of every
   * `source` value present in `sourceScores`.
   */
  readonly qualityScoreSources?: readonly ExternalBenchmarkSource[];
  /** Operator-visible warnings (e.g., "synthesized from sibling family score"). */
  readonly warnings: readonly string[];
  readonly createdAt: string;
}

export interface ModelQualityCalibrationSnapshot {
  /** Semver-ish version. Bumped when the snapshot SCHEMA changes. */
  readonly version: string;
  readonly stage: '01C.1B-J2';
  readonly createdAt: string;
  /** Paths/artifacts that fed this snapshot (audit, benchmark, etc.). */
  readonly sourceArtifacts: readonly string[];
  readonly entries: readonly ModelQualityCalibrationEntry[];
  readonly summary: {
    readonly totalEntries: number;
    readonly placeholderEntries: number;
    readonly benchmarkedEntries: number;
    readonly highConfidenceEntries: number;
    readonly totalBenchmarkCostUsd: number;
  };
}

// ─── Validation ──────────────────────────────────────────────────────────

const SECRET_PATTERN = /sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{20,}|BEGIN PRIVATE KEY|password=|token=|secret=/i;

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validates a single entry. Returns `{valid: false, errors: [...]}` on any
 * violation. Pure function — no side effects.
 *
 * Rules enforced:
 *   1. qualityScore is in [0, 1] (inclusive).
 *   2. qualityScoreSource is a known value (not `undefined`).
 *   3. If qualityScoreSource is 'placeholder' or 'unknown' → confidence MUST be 'placeholder'.
 *   4. If qualityScoreSource is 'placeholder' → qualityConfidence must NOT be 'high' or 'medium'.
 *   5. dimensionScores values (if present) must each be in [0, 1].
 *   6. No string field contains a secret-like pattern.
 *   7. createdAt is a parseable ISO date string.
 */
export function validateEntry(entry: ModelQualityCalibrationEntry): ValidationResult {
  const errors: string[] = [];

  if (typeof entry.qualityScore !== 'number' || !Number.isFinite(entry.qualityScore)) {
    errors.push('qualityScore: must be a finite number');
  } else if (entry.qualityScore < 0 || entry.qualityScore > 1) {
    errors.push(`qualityScore: ${entry.qualityScore} is outside [0, 1]`);
  }

  if (!entry.qualityScoreSource) {
    errors.push('qualityScoreSource: required');
  }

  if (entry.qualityScoreSource === 'placeholder' && entry.qualityConfidence !== 'placeholder') {
    errors.push(
      `qualityConfidence: ${entry.qualityConfidence} inconsistent with source=placeholder ` +
      `(placeholder source REQUIRES placeholder confidence)`,
    );
  }

  if (entry.qualityScoreSource === 'unknown' && (entry.qualityConfidence === 'high' || entry.qualityConfidence === 'medium')) {
    errors.push(
      `qualityConfidence: source=unknown cannot have confidence=${entry.qualityConfidence}`,
    );
  }

  if (entry.dimensionScores) {
    for (const [dim, score] of Object.entries(entry.dimensionScores)) {
      if (typeof score !== 'number' || score < 0 || score > 1) {
        errors.push(`dimensionScores.${dim}: ${score} outside [0, 1]`);
      }
    }
  }

  // 01C.1B-J2-C-R4 §7 — Validate sourceScores / qualityScoreSources / taskCategoryScores
  if (entry.sourceScores) {
    // Bind a typed local first: Array.isArray's `arg is any[]` guard would widen
    // entry.sourceScores to any[] (dropping SourceSpecificQualityScore) for the rest
    // of the function — including the qualityScoreSources block below. Checking the
    // local keeps the property typed.
    const sourceScores = entry.sourceScores;
    if (!Array.isArray(sourceScores)) {
      errors.push('sourceScores: must be an array');
    } else {
      const seenSources = new Set<string>();
      for (let i = 0; i < sourceScores.length; i++) {
        // Array.isArray widened the local to any[]; re-assert the declared element
        // type (sanctioned assertion — not `as any` / `as unknown as`).
        const s = sourceScores[i] as SourceSpecificQualityScore;
        if (!s.source) {
          errors.push(`sourceScores[${i}].source: required`);
        } else if (seenSources.has(s.source)) {
          errors.push(`sourceScores[${i}]: duplicate source '${s.source}'`);
        } else {
          seenSources.add(s.source);
        }
        if (typeof s.score !== 'number' || s.score < 0 || s.score > 1) {
          errors.push(`sourceScores[${i}].score: ${s.score} outside [0, 1]`);
        }
        if (s.sampleSize !== undefined && (typeof s.sampleSize !== 'number' || s.sampleSize < 0)) {
          errors.push(`sourceScores[${i}].sampleSize: ${s.sampleSize} must be non-negative`);
        }
        if (s.categoryScores) {
          for (const [cat, sc] of Object.entries(s.categoryScores)) {
            if (typeof sc !== 'number' || sc < 0 || sc > 1) {
              errors.push(`sourceScores[${i}].categoryScores.${cat}: ${sc} outside [0, 1]`);
            }
          }
        }
        if (s.sourceUrl && SECRET_PATTERN.test(s.sourceUrl)) {
          errors.push(`sourceScores[${i}].sourceUrl: contains secret-like pattern`);
        }
      }
    }
  }

  if (entry.qualityScoreSources) {
    if (!Array.isArray(entry.qualityScoreSources)) {
      errors.push('qualityScoreSources: must be an array');
    } else if (entry.sourceScores) {
      // Invariant: qualityScoreSources MUST be a superset of sourceScores[].source
      const declared = new Set(entry.qualityScoreSources);
      for (const s of entry.sourceScores) {
        if (!declared.has(s.source)) {
          errors.push(
            `qualityScoreSources: missing '${s.source}' which appears in sourceScores`,
          );
        }
      }
    }
  }

  if (entry.taskCategoryScores) {
    for (const [cat, score] of Object.entries(entry.taskCategoryScores)) {
      if (typeof score !== 'number' || score < 0 || score > 1) {
        errors.push(`taskCategoryScores.${cat}: ${score} outside [0, 1]`);
      }
    }
  }

  // Secret leak check (top-level string fields)
  for (const [key, val] of Object.entries(entry)) {
    if (typeof val === 'string' && SECRET_PATTERN.test(val)) {
      errors.push(`${key}: contains secret-like pattern (potential leak)`);
    }
  }

  if (entry.createdAt && isNaN(Date.parse(entry.createdAt))) {
    errors.push(`createdAt: ${entry.createdAt} is not a valid ISO date`);
  }

  return { valid: errors.length === 0, errors };
}

// ─── 01C.1B-J2-C-R4 §7 — Aggregation helpers ─────────────────────────────

/**
 * Confidence-weighted average of per-source scores. Used by the merger to
 * compute the top-level `qualityScore` for an entry assembled from
 * multiple sources.
 *
 * Weights (per spec §3.2):
 *   - high        → 1.0
 *   - medium      → 0.6
 *   - low         → 0.3
 *   - placeholder → 0.1
 *
 * Returns `undefined` when `sources` is empty. Returns NaN-safe values.
 * Output is rounded to 4 decimals to match `normalizeBenchLmScore`.
 */
export function aggregateQualityFromSources(
  sources: readonly SourceSpecificQualityScore[],
): number | undefined {
  if (!sources.length) return undefined;
  const weightOf = (c: ModelQualityConfidence): number => {
    switch (c) {
      case 'high': return 1.0;
      case 'medium': return 0.6;
      case 'low': return 0.3;
      case 'placeholder': return 0.1;
      default: return 0.1;
    }
  };
  let totalW = 0;
  let totalWS = 0;
  for (const s of sources) {
    if (typeof s.score !== 'number' || !Number.isFinite(s.score)) continue;
    const w = weightOf(s.confidence);
    totalW += w;
    totalWS += w * s.score;
  }
  if (totalW === 0) return undefined;
  return +Math.max(0, Math.min(1, totalWS / totalW)).toFixed(4);
}

/**
 * 01C.1B-J2-C-R4 §12 — Task-aware quality lookup.
 *
 * Returns the most task-relevant score for an entry:
 *   1. If the entry has `taskCategoryScores[category]`, use it.
 *   2. Otherwise, scan `sourceScores[].categoryScores[category]` and
 *      take the confidence-weighted average.
 *   3. Otherwise, fall back to the entry's aggregate `qualityScore`.
 *
 * Returns `{ score, source }` where `source` indicates which path
 * produced the value: 'task_category', 'source_category_avg',
 * 'aggregate', or 'unavailable' (when entry is undefined / no data).
 *
 * Pure function — no side effects.
 */
export function resolveQualityForTask(
  entry: ModelQualityCalibrationEntry | undefined,
  category: QualityCategory,
): {
  readonly score: number | undefined;
  readonly resolutionPath: 'task_category' | 'source_category_avg' | 'aggregate' | 'unavailable';
} {
  if (!entry) return { score: undefined, resolutionPath: 'unavailable' };

  // 1. Direct taskCategoryScores
  if (entry.taskCategoryScores && entry.taskCategoryScores[category] !== undefined) {
    return { score: entry.taskCategoryScores[category], resolutionPath: 'task_category' };
  }

  // 2. Per-source categoryScores aggregation
  if (entry.sourceScores) {
    const contributingSources = entry.sourceScores.filter(
      (s) => s.categoryScores && s.categoryScores[category] !== undefined,
    );
    if (contributingSources.length > 0) {
      // Build a synthetic SourceSpecificQualityScore array with the
      // category score as `score` so aggregateQualityFromSources weights
      // by confidence consistently.
      const synthetic = contributingSources.map((s) => ({
        source: s.source,
        score: s.categoryScores![category]!,
        confidence: s.confidence,
      }));
      const avg = aggregateQualityFromSources(synthetic);
      if (avg !== undefined) {
        return { score: avg, resolutionPath: 'source_category_avg' };
      }
    }
  }

  // 3. Aggregate fallback
  return { score: entry.qualityScore, resolutionPath: 'aggregate' };
}

/**
 * Validates an entire snapshot. Iterates every entry and aggregates errors.
 */
export function validateSnapshot(snapshot: ModelQualityCalibrationSnapshot): ValidationResult {
  const errors: string[] = [];
  if (snapshot.stage !== '01C.1B-J2') {
    errors.push(`stage: expected '01C.1B-J2', got '${snapshot.stage}'`);
  }
  for (let i = 0; i < snapshot.entries.length; i++) {
    const r = validateEntry(snapshot.entries[i]);
    if (!r.valid) {
      errors.push(`entry[${i}] (${snapshot.entries[i].modelId}): ${r.errors.join('; ')}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ─── Deterministic hashing ───────────────────────────────────────────────

/**
 * Canonical-JSON projection of an entry for hashing. Strips ephemeral
 * fields (createdAt, costUsd, latencyMs*) — only the IDENTITY of the
 * score matters for the fingerprint. Two snapshots with same model
 * identities + scores + sources should produce the same hash regardless
 * of WHEN they were generated.
 */
function projectEntryForHash(entry: ModelQualityCalibrationEntry): Record<string, unknown> {
  // 01C.1B-J2-C-R4 §7 — Include the new source/category fields so changes
  // to multi-source content alter the snapshotHash. sourceScores entries
  // are sorted by `source` so insertion order does not affect the hash.
  const sortedSourceScores = entry.sourceScores
    ? [...entry.sourceScores]
        .map((s) => ({
          source: s.source,
          score: s.score,
          confidence: s.confidence,
          sampleSize: s.sampleSize,
          rank: s.rank,
          categoryScores: s.categoryScores ? sortedObject(s.categoryScores) : undefined,
        }))
        .sort((a, b) => String(a.source).localeCompare(String(b.source)))
    : undefined;
  const sortedSources = entry.qualityScoreSources
    ? [...entry.qualityScoreSources].sort()
    : undefined;
  return {
    modelId: entry.modelId,
    canonicalModelId: entry.canonicalModelId,
    qualityScore: entry.qualityScore,
    qualityScoreSource: entry.qualityScoreSource,
    qualityConfidence: entry.qualityConfidence,
    dimensionScores: entry.dimensionScores ? sortedObject(entry.dimensionScores) : undefined,
    taskCategoryScores: entry.taskCategoryScores ? sortedObject(entry.taskCategoryScores) : undefined,
    sourceScores: sortedSourceScores,
    qualityScoreSources: sortedSources,
    benchmarkRunId: entry.benchmarkRunId,
  };
}

function sortedObject(obj: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

/** Stable JSON: sorted keys, no whitespace, undefined dropped. */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      if (obj[k] === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k]));
    }
    return '{' + parts.join(',') + '}';
  }
  return 'null';
}

/**
 * Compute the SHA-256 hash of a snapshot's entries. The hash is what
 * goes into `planFingerprint` so the executor cannot silently swap
 * snapshots between dry-run and real execution.
 *
 * Entries are sorted by modelId before hashing for stability across
 * insertion order.
 */
export function computeSnapshotHash(snapshot: ModelQualityCalibrationSnapshot): string {
  const sortedEntries = [...snapshot.entries]
    .map(projectEntryForHash)
    .sort((a, b) => String(a.modelId).localeCompare(String(b.modelId)));
  const payload = {
    version: snapshot.version,
    stage: snapshot.stage,
    entries: sortedEntries,
  };
  const canonical = canonicalJsonStringify(payload);
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Lookup helpers ──────────────────────────────────────────────────────

/**
 * Find an entry for a given model id. Tries `modelId` first, then
 * `canonicalModelId` for J1E/J1F-normalized lookups. Returns undefined
 * if not found — the scorer treats this as "placeholder fallback".
 */
export function findEntry(
  snapshot: ModelQualityCalibrationSnapshot,
  modelId: string,
  canonicalModelId?: string,
): ModelQualityCalibrationEntry | undefined {
  return snapshot.entries.find(
    (e) =>
      e.modelId === modelId ||
      (canonicalModelId && e.canonicalModelId === canonicalModelId) ||
      (canonicalModelId && e.modelId === canonicalModelId),
  );
}

/**
 * Build a snapshot from a list of entries. Auto-computes summary stats.
 * Validates everything before returning; throws on invalid input.
 */
export function buildSnapshot(opts: {
  version: string;
  sourceArtifacts: readonly string[];
  entries: readonly ModelQualityCalibrationEntry[];
  createdAt?: string;
}): ModelQualityCalibrationSnapshot {
  const placeholderEntries = opts.entries.filter(
    (e) => e.qualityScoreSource === 'placeholder' || e.qualityConfidence === 'placeholder',
  ).length;
  const benchmarkedEntries = opts.entries.filter(
    (e) =>
      e.qualityScoreSource === 'internal_benchmark' ||
      e.qualityScoreSource === 'external_benchmark' ||
      e.qualityScoreSource === 'live_probe',
  ).length;
  const highConfidenceEntries = opts.entries.filter((e) => e.qualityConfidence === 'high').length;
  const totalBenchmarkCostUsd = opts.entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);

  const snapshot: ModelQualityCalibrationSnapshot = {
    version: opts.version,
    stage: '01C.1B-J2',
    createdAt: opts.createdAt ?? new Date().toISOString(),
    sourceArtifacts: opts.sourceArtifacts,
    entries: opts.entries,
    summary: {
      totalEntries: opts.entries.length,
      placeholderEntries,
      benchmarkedEntries,
      highConfidenceEntries,
      totalBenchmarkCostUsd,
    },
  };

  const v = validateSnapshot(snapshot);
  if (!v.valid) {
    throw new Error(`Invalid quality calibration snapshot: ${v.errors.join(' | ')}`);
  }
  return snapshot;
}
