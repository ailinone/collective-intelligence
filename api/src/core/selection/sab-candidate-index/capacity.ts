// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fixed-capacity constants for the SharedArrayBuffer-backed candidate index.
 *
 * Ported from `investigation/sab-worker-feasibility/capacity.mjs` (PR #531,
 * feasibility investigation — see that file's own doc for the "why fixed
 * capacity, not a growable SharedArrayBuffer" reasoning: `maxByteLength`
 * growth only ever extends the END of a buffer, which cannot help a
 * struct-of-arrays layout where every field must grow together).
 *
 * Real production catalog shape (2026-09-11 live audit, ADR-027 "Canary 2"):
 * 112,140 active rows (+5,108 disabled, never loaded), 64 distinct legacy
 * capability strings, `metadata` JSONB averaging 934 bytes/row (max 13,757,
 * 100 MB summed over active rows). Defaults below are sized with real
 * headroom over that (up to 200,000 models) so the buffer survives catalog
 * growth between deploys without a resize — resizing would require
 * reallocating both double-buffer slots and is NOT supported at runtime by
 * this design (same fixed-schema trade-off Postgres itself makes with fixed
 * column widths).
 *
 * Every byte-capacity constant is env-overridable so an operator can shrink
 * the footprint for a smaller deployment (e.g. a staging environment with a
 * few hundred models) or grow it ahead of an anticipated catalog expansion,
 * without a code change — see `readIntEnvOverride` below. The capability
 * mask width is the one deliberate exception (see `CAPABILITY_MASK_WORDS`).
 */

function readIntEnvOverride(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Max total catalog rows (curated + aggregated + invisible/orphan) one
 *  generation can hold. Today's real count: 112,140 active. */
export const MAX_MODELS = readIntEnvOverride('SAB_CANDIDATE_MAX_MODELS', 200_000);
/** `curatedOrder` capacity — today's real count: 37,629. */
export const CURATED_CAP = readIntEnvOverride('SAB_CANDIDATE_CURATED_CAP', 120_000);
/** `aggregatedOrder` capacity — today's real count: 73,782. */
export const AGGREGATED_CAP = readIntEnvOverride('SAB_CANDIDATE_AGGREGATED_CAP', 200_000);
/** Distinct-provider table capacity — today's real count: 95 curated
 *  providers (+ 1 aggregated/huggingface, which does not need a curated-order
 *  slot but does need a provider-table row for decode). */
export const MAX_PROVIDERS = readIntEnvOverride('SAB_CANDIDATE_MAX_PROVIDERS', 1024);
/** Model-id UTF-8 string blob size — today's real usage: ~2.3MB measured. */
export const ID_BLOB_BYTES = readIntEnvOverride('SAB_CANDIDATE_ID_BLOB_BYTES', 12 * 1024 * 1024);

/**
 * Per-model `metadata` JSON budget the default blob size is derived from.
 *
 * The 2026-09-11 canary failed its very first build with "metadata string
 * blob overflow" because the previous default (a flat 64 MiB) had never
 * been multiplied against the real catalog: 112,140 rows x 934 bytes of
 * JSONB (+42 bytes for the `lastSyncedAt` stamp `mapPrismaModel` injects
 * into every row's metadata) is ~109 MB, 1.6x the old ceiling. ADR-027 had
 * even recorded the 982 bytes/row average the day before without anyone
 * doing the multiplication. Deriving the default from MAX_MODELS keeps the
 * two constants from drifting apart again: 200,000 x 1,024 = 200 MiB per
 * generation, ~1.9x today's real usage and enough for the design ceiling
 * at today's average row size. Sizing by AVERAGE with headroom is
 * deliberate: sizing by the observed MAX (13,757 bytes x 200,000 = 2.6 GB)
 * is both unaffordable and beyond the Int32 offset range `schema.ts` uses.
 */
export const METADATA_BYTES_PER_MODEL = readIntEnvOverride(
  'SAB_CANDIDATE_METADATA_BYTES_PER_MODEL',
  1024
);
/**
 * Per-model `metadata` JSON blob (UTF-8 `JSON.stringify(model.metadata)`
 * bytes) — NOT part of the original feasibility investigation's prototype
 * (`investigation/sab-worker-feasibility/encode.mjs` only preserved the two
 * metadata FLAGS the ADR-026 comparison needed: `hubInventoryClass` and
 * `serverless_callable`, folded into `bucketFlag`). Production correctness
 * requires the FULL metadata object, not just those two flags:
 * `findModelsByRequirements`' own `requiredTools`/`requiredEndpoint` filters,
 * `popularityPriorFromMetadata`, and several scoring/ranking reads
 * (`metadata.executionProvider`, `metadata.version`, …) all run AFTER
 * candidate retrieval, unconditionally, against whatever `metadata` the
 * candidate-retrieval path attached — see `dynamic-model-selector.ts`. The
 * existing `getFullCacheFairCandidateModels` (Map-based) path returns real
 * cached `Model` objects with their metadata intact; silently returning
 * `metadata: undefined` from this path would silently break every one of
 * those downstream reads for every SAB-path candidate — a correctness
 * regression, not a performance trade-off.
 *
 * An explicit `SAB_CANDIDATE_METADATA_BLOB_BYTES` override still wins over
 * the derived default. Overflow is a hard rebuild failure (never silently
 * truncated) — see `encode.ts`'s up-front capacity pre-pass.
 */
export const METADATA_BLOB_BYTES = readIntEnvOverride(
  'SAB_CANDIDATE_METADATA_BLOB_BYTES',
  MAX_MODELS * METADATA_BYTES_PER_MODEL
);
/** Provider id+name UTF-8 string blob size. */
export const PROVIDER_BLOB_BYTES = readIntEnvOverride(
  'SAB_CANDIDATE_PROVIDER_BLOB_BYTES',
  256 * 1024
);

/**
 * Number of 32-bit words per model in the capability bitmask
 * (`schema.ts`'s `capabilityBitmask` field is `MAX_MODELS * CAPABILITY_MASK_WORDS`
 * long, row-major). Deliberately NOT env-overridable: the mask width is
 * baked into `capability-mask.ts`'s bit arithmetic on both the encode
 * (worker) and read (main thread) sides, and `worker.ts` refuses to start
 * on any layout-size mismatch, so an env-driven width would only add a way
 * to make the two halves disagree.
 *
 * The 2026-09-11 canary found 64 distinct capability strings in the real
 * catalog against the previous single-word (32-bit) mask, and the encoder
 * of that era TRUNCATED to the first 32 sorted names instead of failing:
 * every capability sorting after `long_context` (including `reasoning`,
 * `tool_use`, `vision`, `web_search`, `streaming`, `text_generation`)
 * vanished from the decoded Model, so the selector's fail-closed
 * post-hydration capability filter emptied the pool for any request
 * requiring one of them. Four words (128 bits) cover the full
 * `ModelCapability` union (79 literals) with 2x headroom over today's 64.
 */
export const CAPABILITY_MASK_WORDS = 4;
/** Capability bitmask width in bits. Exceeding it is a HARD rebuild failure
 *  (`SabEncodeCapacityError` from `encode.ts`, counted by
 *  `ci_sab_candidate_index_build_failures_total{reason="capacity"}`) —
 *  the last-good generation keeps serving; nothing is ever silently
 *  dropped from the mask. */
export const MAX_CAPABILITIES = CAPABILITY_MASK_WORDS * 32;

// `schema.ts` stores string-blob offsets in Int32Array lanes, so a blob
// larger than 2^31-1 bytes would wrap offsets negative without any error.
// Fail at import (both manager and worker) rather than corrupt silently.
const MAX_INT32 = 2 ** 31 - 1;
for (const [name, value] of [
  ['SAB_CANDIDATE_METADATA_BLOB_BYTES', METADATA_BLOB_BYTES],
  ['SAB_CANDIDATE_ID_BLOB_BYTES', ID_BLOB_BYTES],
  ['SAB_CANDIDATE_PROVIDER_BLOB_BYTES', PROVIDER_BLOB_BYTES],
] as const) {
  if (value > MAX_INT32) {
    throw new Error(
      `sab-candidate-index capacity: ${name}=${value} exceeds the Int32 offset range (${MAX_INT32}) the schema stores string offsets in`
    );
  }
}
