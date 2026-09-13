// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tiered Capability Fingerprint (TCF) Sweep Job.
 *
 * Real, working implementation of the design produced by this session's
 * feasibility investigation: empirically discover EVERY model-assignable
 * capability across the full, growing catalog (111k+ models today, expected
 * to reach 150-200k+) without ever assuming a fixed catalog size.
 *
 *   Tier 0 (0 calls)   — static metadata inference. Already shipped
 *                        (`model-capability-inference.ts`), nothing to do here.
 *   Tier 1 (1 call)    — rich diagnostic probe, structural-first grading.
 *                        See `core/orchestration/tier1-diagnostic-probe.ts`.
 *   Tier 2 (1 call)    — function-calling probe. REUSED VERBATIM from
 *                        `core/orchestration/function-calling-probe.ts`
 *                        (GAP-A13) — this job only decides WHICH models are
 *                        candidates and calls it; no probe logic is
 *                        duplicated.
 *   Tier 3 (~0.15 avg) — gated multimodal probe, only for models whose
 *                        Tier-0 metadata already declares a multimodal
 *                        input. See `core/orchestration/tier3-multimodal-probe.ts`.
 *
 * Two buckets, matching this session's own bucket-fairness terminology
 * (`dynamic-model-selector.ts`'s curated/aggregated split, keyed off the
 * SAME `metadata->>'hubInventoryClass'` tag used there):
 *   - `curated`    — full daily sweep of every active non-aggregated-index
 *                    model (native providers + the ~95-provider hub/proxy
 *                    long tail that is NOT the HuggingFace bulk index).
 *   - `aggregated` — the HuggingFace hub-index bucket (~74k+ rows and
 *                    growing). Too large to sweep daily at reasonable cost,
 *                    so this bucket gets a bounded daily SLICE, rotated by a
 *                    deterministic per-day ordering so the whole population
 *                    cycles through coverage over time instead of the same
 *                    prefix being probed forever.
 *
 * EVERYTHING that could vary with catalog growth is queried fresh, every
 * run: bucket population counts, the provider lanes to pace across, and the
 * candidate row set itself. The only hardcoded numbers in this file are
 * SAFETY CEILINGS (env-overridable upper bounds) — real sweep size is
 * always `MIN(realCount, ceiling)`, never the ceiling alone.
 *
 * Cost/safety guardrails (real, not just documented intent):
 *   - A Redis-backed daily probe budget shared across BOTH buckets — see
 *     `consumeDailyProbeBudget`. Fails CLOSED: if the budget counter can't
 *     be read (Redis down), the run treats remaining budget as zero rather
 *     than proceeding unmetered.
 *   - Bounded concurrency: a GLOBAL cap across the whole sweep
 *     (`CAPABILITY_FINGERPRINT_GLOBAL_CONCURRENCY`) composed with a PER-LANE
 *     (per-provider) cap (`CAPABILITY_FINGERPRINT_LANE_CONCURRENCY`, default
 *     within the 10-20 range the original design's own math called for) plus
 *     inter-task delay+jitter per lane — see `utils/bounded-concurrency.ts`'s
 *     `PerKeyLimiter`. This replaces `provider-balance-probe-job.ts`'s
 *     fully-serial pacing (fine for ~60 cheap balance checks; would take
 *     hours here) while still never bursting any single provider — the
 *     documented deviation from that job's shape.
 *   - This job is registered but NOT enabled by default — see
 *     `isCapabilityFingerprintJobEnabled` and `register-scheduled-jobs.ts`.
 *     A first production run is a deliberate operator decision, not
 *     something this change turns on silently.
 */

import { logger } from '@/utils/logger';
import { getCapabilityPool } from '@/capability/db/capability-pool';
import { runWithBoundedConcurrency, PerKeyLimiter } from '@/utils/bounded-concurrency';
import { runTier1DiagnosticProbe } from '@/core/orchestration/tier1-diagnostic-probe';
import { getFunctionCallingVerdict } from '@/core/orchestration/function-calling-probe';
import {
  isTier3EligibleByDeclaredModality,
  runTier3MultimodalProbe,
} from '@/core/orchestration/tier3-multimodal-probe';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

/** Minimal registry surface this job needs — avoids importing the concrete
 *  `ProviderRegistry` class into this module's type surface just for a
 *  lookup, and keeps `probeOneCandidate` trivially testable with a fake. */
interface AdapterLookup {
  get(name: string): ProviderAdapter | undefined;
}

const log = logger.child({ component: 'capability-fingerprint-job' });

export type FingerprintBucket = 'curated' | 'aggregated';

/**
 * Master kill switch — checked at BOTH job registration (so the BullMQ
 * schedule isn't even created; see `register-scheduled-jobs.ts`) and here
 * (defense in depth, matching `structural-derivation-job.ts`'s own
 * belt-and-suspenders pattern of re-checking its enable flag inside the
 * runner, not only at registration).
 *
 * Default OFF — deliberately, per this change's own explicit mandate: a
 * catalog-wide probing job's first real production run must be an operator
 * decision, not something a merge to main silently activates.
 */
export function isCapabilityFingerprintJobEnabled(): boolean {
  return process.env.CAPABILITY_FINGERPRINT_JOB_ENABLED === 'true';
}

// ─── Safety-ceiling config (upper bounds, never the assumed real size) ──────
//
// Read LAZILY (function calls, not module-level consts) so a config change
// via process.env takes effect on the NEXT run without a process restart,
// and so tests can exercise non-default values without reaching for
// `vi.resetModules()` for every knob this job exposes.

/** Absolute upper bound on how many curated models one run will touch, no
 *  matter how large the real curated population grows. The real curated
 *  population is queried fresh every run via COUNT(*) — this only protects
 *  against an unbounded sweep if that population balloons unexpectedly. */
function getCuratedSafetyCeiling(): number {
  return Number(process.env.CAPABILITY_FINGERPRINT_CURATED_CEILING ?? 60_000);
}
/** Daily slice size for the aggregated/long-tail bucket — the design's own
 *  "~2,500/day" rotating-coverage recommendation, operator-tunable. */
function getAggregatedDailySlice(): number {
  return Number(process.env.CAPABILITY_FINGERPRINT_AGGREGATED_DAILY_LIMIT ?? 2_500);
}
/** Shared daily probe budget across BOTH buckets (one model touched, of
 *  however many tiers ran for it, = 1 unit). Generous enough to cover a full
 *  curated sweep plus the aggregated slice at today's real catalog size;
 *  operators should raise it deliberately as the catalog grows rather than
 *  this job silently assuming growth. */
function getDailyProbeBudget(): number {
  return Number(process.env.CAPABILITY_FINGERPRINT_DAILY_BUDGET ?? 50_000);
}

function getGlobalConcurrency(): number {
  return Number(process.env.CAPABILITY_FINGERPRINT_GLOBAL_CONCURRENCY ?? 40);
}
/** Per-provider-lane cap. Design doc's own math: 10-20 within an oversized
 *  lane (e.g. featherless-ai) rather than fully serial. Clamped below. */
function getLaneConcurrency(): number {
  return Math.min(20, Math.max(1, Number(process.env.CAPABILITY_FINGERPRINT_LANE_CONCURRENCY ?? 15)));
}
function getLaneInterTaskDelayMs(): number {
  return Number(process.env.CAPABILITY_FINGERPRINT_LANE_DELAY_MS ?? 100);
}
function getLaneInterTaskJitterMs(): number {
  return Number(process.env.CAPABILITY_FINGERPRINT_LANE_JITTER_MS ?? 150);
}

const DAILY_BUDGET_REDIS_PREFIX = 'capability-fingerprint:daily-probes:';
const DAILY_BUDGET_TTL_SECONDS = 2 * 24 * 60 * 60; // 2 days — clock-skew margin

interface CandidateRow {
  uid: string;
  provider_id: string;
  model_id: string;
  capability_uris: string[] | null;
  capability_confidence: Record<string, number> | null;
}

async function countBucket(bucket: FingerprintBucket): Promise<number> {
  const pool = getCapabilityPool();
  const sql =
    bucket === 'curated'
      ? `SELECT COUNT(*)::int AS count FROM models
           WHERE status = 'active'
             AND (metadata->>'hubInventoryClass') IS DISTINCT FROM 'aggregated_index'`
      : `SELECT COUNT(*)::int AS count FROM models
           WHERE status = 'active'
             AND metadata @> '{"hubInventoryClass":"aggregated_index"}'::jsonb
             AND metadata @> '{"serverless_callable":true}'::jsonb`;
  const { rows } = await pool.query<{ count: number }>(sql);
  return rows[0]?.count ?? 0;
}

async function loadCandidateRows(bucket: FingerprintBucket, limit: number): Promise<CandidateRow[]> {
  const pool = getCapabilityPool();
  if (bucket === 'curated') {
    const { rows } = await pool.query<CandidateRow>(
      `SELECT uid, provider_id, id AS model_id, capability_uris, capability_confidence
         FROM models
        WHERE status = 'active'
          AND (metadata->>'hubInventoryClass') IS DISTINCT FROM 'aggregated_index'
        ORDER BY usage_count DESC NULLS LAST
        LIMIT $1`,
      [limit]
    );
    return rows;
  }

  // Aggregated bucket: deterministic per-day pseudo-random ordering so a
  // fixed-size daily slice rotates through the WHOLE population over time
  // instead of always returning the same usage_count-sorted prefix (every
  // row in this bucket ties at usage_count=0 in practice — see
  // dynamic-model-selector.ts's own documented audit of this exact bucket).
  const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const { rows } = await pool.query<CandidateRow>(
    `SELECT uid, provider_id, id AS model_id, capability_uris, capability_confidence
       FROM models
      WHERE status = 'active'
        AND metadata @> '{"hubInventoryClass":"aggregated_index"}'::jsonb
        AND metadata @> '{"serverless_callable":true}'::jsonb
      ORDER BY md5(uid || $1)
      LIMIT $2`,
    [dayKey, limit]
  );
  return rows;
}

/**
 * Shared daily probe budget, backed by Redis. Fails CLOSED: any error
 * reading/writing the counter is treated as "no budget available" so a
 * Redis outage cannot silently turn into an unmetered sweep.
 */
async function consumeDailyProbeBudget(requested: number): Promise<number> {
  if (requested <= 0) return 0;
  try {
    const { getGlobalRedisClient } = await import('@/cache/redis-client');
    const client = getGlobalRedisClient();
    const key = `${DAILY_BUDGET_REDIS_PREFIX}${new Date().toISOString().slice(0, 10)}`;
    const current = Number((await client.get(key)) ?? 0);
    const remaining = Math.max(0, getDailyProbeBudget() - current);
    const grant = Math.min(requested, remaining);
    if (grant > 0) {
      await client.incrby(key, grant);
      await client.expire(key, DAILY_BUDGET_TTL_SECONDS);
    }
    return grant;
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Daily probe budget counter unavailable — failing closed (granting zero) rather than sweeping unmetered'
    );
    return 0;
  }
}

const FUNCTION_CALLING_URI = LEGACY_CAPABILITY_TO_URI['function_calling'];

/** True when the model's already-materialised projection has NOT confirmed
 *  function_calling — the same "absent/unknown" condition
 *  `function-calling-probe.ts`'s own module doc says the probe exists for.
 *  A model that already has the capability confirmed skips Tier 2 entirely
 *  (fast path — no wasted call). */
function needsFunctionCallingProbe(row: CandidateRow): boolean {
  if (!FUNCTION_CALLING_URI) return false;
  const uris = row.capability_uris ?? [];
  return !uris.includes(FUNCTION_CALLING_URI);
}

export interface CapabilityFingerprintStats {
  readonly bucket: FingerprintBucket;
  readonly skipped: 'disabled' | 'no-budget' | null;
  readonly realPopulation: number;
  readonly candidatesSelected: number;
  readonly budgetGranted: number;
  readonly lanesProcessed: number;
  readonly modelsProbed: number;
  readonly tier1Confirmed: number;
  readonly tier2Invoked: number;
  readonly tier3Eligible: number;
  readonly tier3Invoked: number;
  readonly errors: number;
  readonly elapsedMs: number;
}

function emptyStats(bucket: FingerprintBucket, skipped: CapabilityFingerprintStats['skipped']): CapabilityFingerprintStats {
  return {
    bucket,
    skipped,
    realPopulation: 0,
    candidatesSelected: 0,
    budgetGranted: 0,
    lanesProcessed: 0,
    modelsProbed: 0,
    tier1Confirmed: 0,
    tier2Invoked: 0,
    tier3Eligible: 0,
    tier3Invoked: 0,
    errors: 0,
    elapsedMs: 0,
  };
}

async function probeOneCandidate(
  row: CandidateRow,
  registry: AdapterLookup
): Promise<{
  tier1Confirmed: number;
  tier2Invoked: boolean;
  tier3Eligible: boolean;
  tier3Invoked: boolean;
  errored: boolean;
}> {
  const adapter = registry.get(row.provider_id);
  if (!adapter) {
    // No registered adapter (no API key / not configured in this
    // deployment) — nothing to probe, not an error.
    return { tier1Confirmed: 0, tier2Invoked: false, tier3Eligible: false, tier3Invoked: false, errored: false };
  }

  let tier1Confirmed = 0;
  let errored = false;
  try {
    const tier1 = await runTier1DiagnosticProbe(adapter, row.provider_id, row.model_id);
    tier1Confirmed = tier1.capabilitiesConfirmed.length;
  } catch (err) {
    errored = true;
    log.debug(
      { provider: row.provider_id, modelId: row.model_id, error: err instanceof Error ? err.message : String(err) },
      'Tier-1 probe threw unexpectedly'
    );
  }

  let tier2Invoked = false;
  if (needsFunctionCallingProbe(row)) {
    tier2Invoked = true;
    try {
      await getFunctionCallingVerdict(adapter, row.provider_id, row.model_id);
    } catch (err) {
      errored = true;
      log.debug(
        { provider: row.provider_id, modelId: row.model_id, error: err instanceof Error ? err.message : String(err) },
        'Tier-2 (function-calling) probe threw unexpectedly'
      );
    }
  }

  const eligibility = isTier3EligibleByDeclaredModality(row.capability_uris);
  let tier3Invoked = false;
  if (eligibility.eligible && eligibility.declaredCapability) {
    tier3Invoked = true;
    try {
      await runTier3MultimodalProbe(
        adapter,
        row.provider_id,
        row.model_id,
        eligibility.declaredCapability
      );
    } catch (err) {
      errored = true;
      log.debug(
        { provider: row.provider_id, modelId: row.model_id, error: err instanceof Error ? err.message : String(err) },
        'Tier-3 probe threw unexpectedly'
      );
    }
  }

  return { tier1Confirmed, tier2Invoked, tier3Eligible: eligibility.eligible, tier3Invoked, errored };
}

export async function runCapabilityFingerprintSweep(
  bucket: FingerprintBucket
): Promise<CapabilityFingerprintStats> {
  const startedAt = Date.now();

  if (!isCapabilityFingerprintJobEnabled()) {
    log.info(
      'CAPABILITY_FINGERPRINT_JOB_ENABLED is not "true" — skipping capability-fingerprint tick (opt-in job, see register-scheduled-jobs.ts)'
    );
    return emptyStats(bucket, 'disabled');
  }

  const realPopulation = await countBucket(bucket);
  const ceiling = bucket === 'curated' ? getCuratedSafetyCeiling() : getAggregatedDailySlice();
  const desiredCandidateCount = Math.min(realPopulation, ceiling);

  const budgetGranted = await consumeDailyProbeBudget(desiredCandidateCount);
  if (budgetGranted <= 0) {
    log.warn(
      { bucket, realPopulation, desiredCandidateCount },
      'No daily probe budget remaining (or budget counter unavailable) — skipping this tick'
    );
    return { ...emptyStats(bucket, 'no-budget'), realPopulation };
  }

  const candidates = await loadCandidateRows(bucket, budgetGranted);
  const lanes = new Set(candidates.map((c) => c.provider_id));

  const { getProviderRegistry } = await import('@/providers/provider-registry.js');
  const registry = getProviderRegistry();

  const limiter = new PerKeyLimiter({
    maxPerKey: getLaneConcurrency(),
    interTaskDelayMs: getLaneInterTaskDelayMs(),
    interTaskJitterMs: getLaneInterTaskJitterMs(),
  });

  let tier1Confirmed = 0;
  let tier2Invoked = 0;
  let tier3Eligible = 0;
  let tier3Invoked = 0;
  let errors = 0;

  const results = await runWithBoundedConcurrency(candidates, getGlobalConcurrency(), (row) =>
    limiter.run(row.provider_id, () => probeOneCandidate(row, registry))
  );

  for (const r of results) {
    if (r.status === 'rejected') {
      errors++;
      continue;
    }
    tier1Confirmed += r.value.tier1Confirmed;
    if (r.value.tier2Invoked) tier2Invoked++;
    if (r.value.tier3Eligible) tier3Eligible++;
    if (r.value.tier3Invoked) tier3Invoked++;
    if (r.value.errored) errors++;
  }

  const stats: CapabilityFingerprintStats = {
    bucket,
    skipped: null,
    realPopulation,
    candidatesSelected: candidates.length,
    budgetGranted,
    lanesProcessed: lanes.size,
    modelsProbed: candidates.length,
    tier1Confirmed,
    tier2Invoked,
    tier3Eligible,
    tier3Invoked,
    errors,
    elapsedMs: Date.now() - startedAt,
  };

  log.info(stats, 'Capability fingerprint sweep tick complete');
  return stats;
}

export async function runCapabilityFingerprintDailyNow(): Promise<CapabilityFingerprintStats> {
  return runCapabilityFingerprintSweep('curated');
}

export async function runCapabilityFingerprintRotationNow(): Promise<CapabilityFingerprintStats> {
  return runCapabilityFingerprintSweep('aggregated');
}
