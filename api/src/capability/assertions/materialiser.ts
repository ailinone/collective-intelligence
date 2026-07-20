// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Assertion Materialiser (ADR-022, Sprint 2)
 *
 * Reads append-only `model_capability_assertions` and rebuilds the materialised
 * projection on `models.capability_uris` / `capability_confidence` /
 * `capability_sources` / `capability_updated_at`.
 *
 * Replaces the interim hierarchical merger (model-capability-merger.ts). The
 * interim merger keeps shipping signals during the migration window; this
 * worker is what consumers actually read.
 *
 * Algorithm (per (model, capability)):
 *
 *   For each non-superseded assertion observed within ttl_days:
 *     w_i = source_weight[source] × confidence × freshness(observed_at)
 *     freshness(t) = exp(-Δdays / ttl_days)
 *
 *   Bayesian noisy-OR fusion of independent sources:
 *     P(cap | sources) = 1 - Π_i (1 - w_i)
 *
 *   Capability is included iff P ≥ INCLUSION_THRESHOLD.
 *
 * Why noisy-OR (not max, not sum):
 * - max: collapses multi-source agreement (3 weak sources don't help).
 * - sum: unbounded; saturates trivially.
 * - noisy-OR: accumulates evidence, bounded in [0,1], degrades gracefully
 *   when sources disagree on confidence. Standard choice for combining
 *   binary classifier outputs (Snorkel, weak-supervision literature).
 *
 * Why this is safe to run concurrently with discovery:
 * - Reads assertions (append-only, no locks needed).
 * - Writes only to models.capability_* columns; one row UPDATE per model.
 * - No FK dependency that discovery would block on.
 *
 * Performance: at 6,859 models × ~4 caps each = ~27k assertion fetches.
 * Single SELECT with LATERAL aggregation keeps round-trips low. Target: <30s
 * for full rebuild on local DB.
 */

import type { Pool } from 'pg';
import { uriToLegacy } from '@/capability/legacy-capability-uri';

// ─── Calibrated source weights (ADR-022 §4) ───────────────────────────────────
//
// "How much do we believe a single assertion from this source, all else equal?"
// Read together with `freshness × confidence` in the noisy-OR.

export type AssertionSource =
  | 'provider-declared'
  | 'helicone-oracle'
  | 'modality-derived'
  | 'parameter-derived'
  | 'name-regex'
  | 'llm-extracted'
  | 'operator-override'
  | 'hierarchy-inherited';

export const SOURCE_WEIGHT: Readonly<Record<AssertionSource, number>> = Object.freeze({
  'operator-override': 1.0,   // Human review — by definition trusted
  'provider-declared': 0.95,  // Provider says so — gold but can be stale
  'helicone-oracle': 0.85,  // Cross-checked but indirect
  'modality-derived': 0.75,  // Strong but inferred from architecture fields
  'parameter-derived': 0.65,  // "API accepts" ≠ "model excels"
  'llm-extracted': 0.60,  // Doc-mined, calibrate via Snorkel later
  'hierarchy-inherited': 0.50,  // Narrower-of inheritance — damped parent evidence
  'name-regex': 0.20,  // Faint signal, never decisive alone
});

// ─── Hierarchical propagation tuning ─────────────────────────────────────────
//
// When a parent capability clears `HIERARCHY_PARENT_MIN` after fusion, each
// narrower descendant receives a synthetic assertion of weight
// `parent.confidence × HIERARCHY_DAMPING`, fused via noisy-OR with any direct
// evidence on the child. Depth-1 only: children do NOT re-propagate to their
// own narrower (avoids runaway inheritance down deep taxonomies).
//
// Rationale for 0.5 damping: matches the intuition that "this model does vision
// well" is about half-evidence that "this model does visual QA specifically"
// — enough to populate orphan children, weak enough that a single direct
// name-regex signal (0.04) still shows through distinctly in the confidence.
export const HIERARCHY_DAMPING = 0.5;
export const HIERARCHY_PARENT_MIN = 0.5;

/**
 * Capability is included in models.capability_uris iff fused P >= this.
 *
 * Set to NOISE_FLOOR (not 0.5) by deliberate choice:
 * - The bandit (L5/L10) reads `confidence` numerically and downweights weak
 *   capabilities. Suppressing here would double-count the penalty.
 * - During the migration window, a single backfill assertion (name-regex,
 *   conf=0.2) produces P = 0.04. Threshold 0.5 would clear all 6,859 models
 *   until Sprint 2 fetchers refresh — a bad transient. Threshold 0.04 keeps
 *   weak signals as weak signals.
 * - Strong sources (provider-declared at conf=0.95 → P≈0.90) easily clear.
 * - For decisive negation, write an explicit `asserted_value = false`
 *   assertion (Sprint 3+ wiring).
 */
// Set to 0.03 (not 0.04 = name-regex × name-regex) to give floating-point
// headroom for freshness decay. A single backfill assertion produces P ≈ 0.0399998
// after the freshness factor; 0.04 threshold rounds it out by epsilon.
export const NOISE_FLOOR = 0.03;
export const INCLUSION_THRESHOLD = NOISE_FLOOR;

/**
 * Legacy-projection floor (2026-07-03, HCRA→legacy bridge). A kept URI is
 * mirrored into the DEPRECATED `models.capabilities` array only when its fused
 * confidence clears this — higher than INCLUSION_THRESHOLD on purpose.
 *
 * Why the bridge exists: the collective's member-selection path (PoolBuilder,
 * role-selection, the consensus planner) reads the legacy `capabilities`
 * column, whose values were ~90% name-regex guesses (ADR-022 context). The
 * single-model arm, by contrast, selects via HCRA semantic search. Mirroring
 * the canonical projection into the legacy column closes that asymmetry —
 * exactly what the schema already intends ("capabilities … derived projection
 * of capabilityUris").
 *
 * Why a HIGHER floor than inclusion: the legacy column is a hard membership
 * gate (a model with `chat` enters the voter pool; without it, it doesn't),
 * whereas `capability_confidence` lets the bandit downweight numerically. A
 * name-regex-only signal (P≈0.04) belongs in the URI projection as a weak
 * hint, but must NOT flip a hard legacy gate on its own. 0.30 keeps
 * modality/parameter/provider-derived signals while dropping regex-only noise.
 */
export const LEGACY_PROJECTION_FLOOR = Number(
  process.env.HCRA_LEGACY_PROJECTION_FLOOR ?? 0.3,
);

/** Opt-out for the HCRA→legacy projection (emergency quiesce). Default ON. */
export function isLegacyProjectionEnabled(): boolean {
  return process.env.HCRA_LEGACY_PROJECTION_DISABLED !== 'true';
}

/**
 * Project kept (URI, confidence) pairs into the deduped legacy capability slug
 * array the collective member-selection path reads. Only URIs at/above
 * LEGACY_PROJECTION_FLOOR are mirrored; malformed URIs are dropped. Order
 * follows `kept` (already confidence-desc), deduped stably.
 *
 * Exported pure for testing.
 */
export function projectLegacyCapabilities(
  kept: readonly Pick<FusedCapability, 'uri' | 'confidence'>[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of kept) {
    if (f.confidence < LEGACY_PROJECTION_FLOOR) continue;
    const slug = uriToLegacy(f.uri);
    if (slug === null || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActiveAssertion {
  model_uid: string;
  capability_uri: string;
  source: AssertionSource;
  confidence: number;
  observed_at: Date;
  ttl_days: number;
}

export interface MaterialiseStats {
  modelsWritten: number;
  modelsCleared: number;          // models that ended up with zero capabilities
  capabilitiesEmitted: number;
  capabilitiesSuppressed: number; // had assertions but fused P < threshold
  elapsedMs: number;
}

interface FusedCapability {
  uri: string;
  confidence: number;             // Fused P, in [0, 1]
  sources: AssertionSource[];     // Distinct contributing sources, strongest-first
}

// ─── Core fusion ──────────────────────────────────────────────────────────────

function freshness(observedAt: Date, ttlDays: number, now: number): number {
  const ageMs = now - observedAt.getTime();
  if (ageMs <= 0) return 1;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / ttlDays);
}

function sortSourcesByWeight(sources: AssertionSource[]): AssertionSource[] {
  return [...new Set(sources)].sort((a, b) => SOURCE_WEIGHT[b] - SOURCE_WEIGHT[a]);
}

/**
 * Fuse a bag of assertions for a single (model, capability) into one fused P.
 * Exposed for testing.
 */
export function fuseAssertions(
  assertions: readonly Pick<ActiveAssertion, 'source' | 'confidence' | 'observed_at' | 'ttl_days'>[],
  now: number = Date.now(),
): { confidence: number; sources: AssertionSource[] } {
  let oneMinusProduct = 1;
  const seenSources: AssertionSource[] = [];
  for (const a of assertions) {
    const w = SOURCE_WEIGHT[a.source] * a.confidence * freshness(a.observed_at, a.ttl_days, now);
    if (w <= 0) continue;
    oneMinusProduct *= 1 - w;
    seenSources.push(a.source);
  }
  return {
    confidence: 1 - oneMinusProduct,
    sources: sortSourcesByWeight(seenSources),
  };
}

/**
 * Propagate confidence from a parent capability to its narrower descendants.
 * Depth-1 only, no cascade: uses a snapshot of `fused` as the set of candidate
 * parents, so a child that only receives inherited evidence cannot then re-
 * propagate to its own narrower.
 *
 * Direct evidence on a child is preserved via noisy-OR — inheritance only
 * raises confidence, never lowers it, and the `hierarchy-inherited` source
 * marker stays separate from the child's direct sources in provenance.
 */
export function propagateHierarchy(
  fused: readonly FusedCapability[],
  narrowerByUri: ReadonlyMap<string, readonly string[]>,
  opts: { damping?: number; parentMin?: number } = {},
): FusedCapability[] {
  const damping = opts.damping ?? HIERARCHY_DAMPING;
  const parentMin = opts.parentMin ?? HIERARCHY_PARENT_MIN;

  const byUri = new Map<string, FusedCapability>();
  for (const f of fused) {
    byUri.set(f.uri, { uri: f.uri, confidence: f.confidence, sources: [...f.sources] });
  }
  const snapshot = [...fused];

  for (const parent of snapshot) {
    if (parent.confidence < parentMin) continue;
    const children = narrowerByUri.get(parent.uri);
    if (!children || children.length === 0) continue;
    const inherited = parent.confidence * damping;
    if (inherited <= 0) continue;

    for (const childUri of children) {
      const existing = byUri.get(childUri);
      if (existing) {
        existing.confidence = 1 - (1 - existing.confidence) * (1 - inherited);
        if (!existing.sources.includes('hierarchy-inherited')) {
          existing.sources = sortSourcesByWeight([...existing.sources, 'hierarchy-inherited']);
        }
      } else {
        byUri.set(childUri, {
          uri: childUri,
          confidence: inherited,
          sources: ['hierarchy-inherited'],
        });
      }
    }
  }

  return [...byUri.values()];
}

/**
 * Load `broader → narrower` adjacency from `capability_ontology`. Cached for
 * the life of a worker run; cheap (60-ish rows). Callers pass it in explicitly
 * so tests can inject a custom taxonomy without touching DB.
 */
let narrowerMapCache: { map: Map<string, string[]>; loadedAt: number } | null = null;
const NARROWER_MAP_TTL_MS = 5 * 60 * 1000;

export async function loadNarrowerMap(pool: Pool): Promise<Map<string, string[]>> {
  if (narrowerMapCache && Date.now() - narrowerMapCache.loadedAt < NARROWER_MAP_TTL_MS) {
    return narrowerMapCache.map;
  }
  const { rows } = await pool.query<{ uri: string; narrower: string[] | null }>(
    `SELECT uri, narrower FROM capability_ontology WHERE status != 'deprecated';`,
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    if (r.narrower && r.narrower.length > 0) map.set(r.uri, r.narrower);
  }
  narrowerMapCache = { map, loadedAt: Date.now() };
  return map;
}

/** Test/ops hook: drop the narrower-map cache so the next call re-queries. */
export function __resetNarrowerMapCacheForTests(): void {
  narrowerMapCache = null;
}

// ─── DB-backed runner ─────────────────────────────────────────────────────────

/**
 * Stream active assertions grouped by model_uid.
 *
 * One ORDER BY model_uid query — Postgres returns rows sorted, so we yield
 * each model's bag as soon as we see the model_uid change. Memory bounded
 * by the largest single model's assertion count (~tens of rows).
 *
 * At 20k models × ~10 assertions each = 200k rows, this is still a single
 * query that streams. If we ever exceed ~1M rows, switch to keyset pagination.
 */
async function* streamGroupedAssertions(pool: Pool): AsyncGenerator<{
  modelUid: string;
  byCapability: Map<string, ActiveAssertion[]>;
}> {
  const { rows } = await pool.query<ActiveAssertion>(
    `SELECT model_uid, capability_uri, source, confidence, observed_at, ttl_days
     FROM model_capability_assertions
     WHERE superseded_at IS NULL
     ORDER BY model_uid, capability_uri;`,
  );

  let currentModel: string | null = null;
  let buffer = new Map<string, ActiveAssertion[]>();
  for (const row of rows) {
    if (row.model_uid !== currentModel) {
      if (currentModel !== null) {
        yield { modelUid: currentModel, byCapability: buffer };
      }
      currentModel = row.model_uid;
      buffer = new Map();
    }
    const bucket = buffer.get(row.capability_uri);
    if (bucket) bucket.push(row);
    else buffer.set(row.capability_uri, [row]);
  }
  if (currentModel !== null) {
    yield { modelUid: currentModel, byCapability: buffer };
  }
}

/**
 * Apply the fused projection for a single model.
 * Caller is responsible for transactional grouping if desired (we don't wrap
 * in a TX here so a long materialise doesn't hold one open for minutes).
 */
async function writeProjection(
  pool: Pool,
  modelUid: string,
  fused: FusedCapability[],
  stats: MaterialiseStats,
): Promise<void> {
  const kept = fused.filter((f) => f.confidence >= INCLUSION_THRESHOLD);
  stats.capabilitiesSuppressed += fused.length - kept.length;

  if (kept.length === 0) {
    // No canonical signal. Clear the HCRA columns, but deliberately leave the
    // legacy `capabilities` column ALONE: overwriting it with [] here would
    // evict the model from every collective/chat pool the moment HCRA is cold
    // or an assertion backfill is mid-flight — the April pool-collapse failure
    // mode. Legacy fallback (normalize-model-capabilities.ts) still serves it.
    await pool.query(
      `UPDATE models
       SET capability_uris = ARRAY[]::text[],
           capability_confidence = '{}'::jsonb,
           capability_sources = '{}'::jsonb,
           capability_updated_at = NOW()
       WHERE uid = $1;`,
      [modelUid],
    );
    stats.modelsCleared += 1;
    return;
  }

  const uris = kept.map((f) => f.uri);
  const confObj: Record<string, number> = {};
  const sourcesObj: Record<string, AssertionSource[]> = {};
  for (const f of kept) {
    confObj[f.uri] = f.confidence < NOISE_FLOOR ? 0 : Number(f.confidence.toFixed(4));
    sourcesObj[f.uri] = f.sources;
  }

  // HCRA→legacy bridge: mirror the canonical projection into the DEPRECATED
  // `capabilities` array that the collective member-selection path reads. Only
  // when there IS a strong-signal projection (>= LEGACY_PROJECTION_FLOOR) — an
  // empty projection must NOT overwrite (and thus empty) a model's legacy
  // capabilities. So this only ever REPLACES the legacy column with a
  // provenance-backed set, never blanks it. See LEGACY_PROJECTION_FLOOR.
  const legacyCaps = isLegacyProjectionEnabled() ? projectLegacyCapabilities(kept) : [];
  if (legacyCaps.length > 0) {
    await pool.query(
      `UPDATE models
       SET capability_uris = $1::text[],
           capability_confidence = $2::jsonb,
           capability_sources = $3::jsonb,
           capabilities = $4::jsonb,
           capability_updated_at = NOW()
       WHERE uid = $5;`,
      [uris, JSON.stringify(confObj), JSON.stringify(sourcesObj), JSON.stringify(legacyCaps), modelUid],
    );
  } else {
    await pool.query(
      `UPDATE models
       SET capability_uris = $1::text[],
           capability_confidence = $2::jsonb,
           capability_sources = $3::jsonb,
           capability_updated_at = NOW()
       WHERE uid = $4;`,
      [uris, JSON.stringify(confObj), JSON.stringify(sourcesObj), modelUid],
    );
  }

  stats.modelsWritten += 1;
  stats.capabilitiesEmitted += kept.length;
}

/** Test hook — exercise `writeProjection` (incl. the legacy bridge) with an
 *  injected pool, without standing up a full materialise run. */
export function writeProjectionForTest(
  pool: Pool,
  modelUid: string,
  fused: FusedCapability[],
  stats: MaterialiseStats,
): Promise<void> {
  return writeProjection(pool, modelUid, fused, stats);
}

/**
 * Full rebuild of the materialised projection. Idempotent — running twice
 * produces the same result (assuming no new assertions land in between).
 */
export async function materialiseAllCapabilities(pool: Pool): Promise<MaterialiseStats> {
  const stats: MaterialiseStats = {
    modelsWritten: 0,
    modelsCleared: 0,
    capabilitiesEmitted: 0,
    capabilitiesSuppressed: 0,
    elapsedMs: 0,
  };
  const startedAt = Date.now();
  const now = Date.now();
  const narrowerMap = await loadNarrowerMap(pool);

  for await (const { modelUid, byCapability } of streamGroupedAssertions(pool)) {
    const fused: FusedCapability[] = [];
    for (const [uri, assertions] of byCapability.entries()) {
      const { confidence, sources } = fuseAssertions(assertions, now);
      fused.push({ uri, confidence, sources });
    }
    const propagated = propagateHierarchy(fused, narrowerMap);
    propagated.sort((a, b) => b.confidence - a.confidence);
    await writeProjection(pool, modelUid, propagated, stats);
  }

  stats.elapsedMs = Date.now() - startedAt;
  return stats;
}

/**
 * Materialise a single model. Used by the discovery hot-path after writing
 * fresh assertions for one model — avoids a full rebuild.
 */
export async function materialiseOneModel(pool: Pool, modelUid: string): Promise<void> {
  const { rows } = await pool.query<ActiveAssertion>(
    `SELECT model_uid, capability_uri, source, confidence, observed_at, ttl_days
     FROM model_capability_assertions
     WHERE superseded_at IS NULL AND model_uid = $1;`,
    [modelUid],
  );

  const byCapability = new Map<string, ActiveAssertion[]>();
  for (const row of rows) {
    const bucket = byCapability.get(row.capability_uri);
    if (bucket) bucket.push(row);
    else byCapability.set(row.capability_uri, [row]);
  }

  const fused: FusedCapability[] = [];
  for (const [uri, assertions] of byCapability.entries()) {
    const { confidence, sources } = fuseAssertions(assertions);
    fused.push({ uri, confidence, sources });
  }
  const narrowerMap = await loadNarrowerMap(pool);
  const propagated = propagateHierarchy(fused, narrowerMap);
  propagated.sort((a, b) => b.confidence - a.confidence);

  const stats: MaterialiseStats = {
    modelsWritten: 0,
    modelsCleared: 0,
    capabilitiesEmitted: 0,
    capabilitiesSuppressed: 0,
    elapsedMs: 0,
  };
  await writeProjection(pool, modelUid, propagated, stats);
}
