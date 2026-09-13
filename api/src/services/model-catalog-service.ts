// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { Prisma } from '@/generated/prisma/index.js';
import { Prisma as PrismaNamespace, prisma } from '@/database/client';
import type { Model } from '@/types';
import { logger } from '@/utils/logger';
import { getErrorMessage, isError } from '@/utils/type-guards';
import { modelCacheService } from '@/services/model-cache-service';
import { computeModelUid } from '@/database/model-uid';
import { toInputJson } from '@/utils/json';
import { createHash } from 'node:crypto';
import { getRedisClient } from '@/cache/redis-client';
import {
  CATALOG_HOT_PATH_SELECT,
  CATALOG_REDIS_KEY,
  CATALOG_REDIS_META_KEY,
  mapPrismaModel,
  parseCatalogSnapshotMeta,
  type CatalogSnapshotMeta,
} from '@/services/catalog-hot-path';
// Re-exported for backward compatibility — nothing outside this module
// imported these before the extraction (verified via repo-wide grep), but
// keeping them accessible here avoids a silent breaking change for any
// future caller that expects them at this path.
export { CATALOG_HOT_PATH_SELECT, CATALOG_REDIS_KEY, mapPrismaModel };

export type ProviderCatalogEntry = {
  name: string;
  displayName: string;
  status: 'active' | 'maintenance' | 'disabled';
  metadata?: Record<string, unknown>;
  models: CatalogModelEntry[];
};

export type CatalogModelEntry = {
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1K: number;
  outputCostPer1K: number;
  capabilities: Model['capabilities'];
  performance?: Model['performance'];
  status?: Model['status'];
  metadata?: Record<string, unknown>;
  // GPT-5.1 awareness (November 2025)
  gpt5Features?: {
    isGPT5?: boolean;
    releaseDate?: string;
    enhancedCapabilities?: string[];
    performanceImprovements?: Record<string, number>;
  };
};

const log = logger.child({ component: 'model-catalog-service' });

function decimal(value: number): PrismaNamespace.Decimal {
  return new PrismaNamespace.Decimal(value);
}

export async function syncModelCatalog(catalog: ProviderCatalogEntry[]): Promise<void> {
  const syncLog = log.child({ stage: 'sync' });
  const start = Date.now();
  const updatedModelIds: string[] = [];

  try {
    syncLog.info({ catalogSize: catalog.length }, 'Starting model catalog synchronization');

    await prisma.$transaction(
      async (tx) => {
        for (const providerEntry of catalog) {
          syncLog.debug(
            { provider: providerEntry.name, modelCount: providerEntry.models.length },
            'Syncing provider'
          );
          const providerCreate: Prisma.ProviderUncheckedCreateInput = {
            id: providerEntry.name,
            name: providerEntry.name,
            displayName: providerEntry.displayName,
            status: providerEntry.status,
            metadata: toInputJson(providerEntry.metadata ?? null),
          };

          const providerUpdate: Prisma.ProviderUncheckedUpdateInput = {
            displayName: providerEntry.displayName,
            status: providerEntry.status,
            metadata: toInputJson(providerEntry.metadata ?? null),
            updatedAt: new Date(),
          };

          const provider = await tx.provider.upsert({
            where: { name: providerEntry.name },
            update: providerUpdate,
            create: providerCreate,
          });

          for (const modelEntry of providerEntry.models) {
            const modelId = `${providerEntry.name}-${modelEntry.name}`;
            const modelCreate: Prisma.ModelCreateInput = {
              uid: computeModelUid(provider.id, modelId),
              id: modelId,
              provider: { connect: { id: provider.id } },
              name: modelEntry.name,
              displayName: modelEntry.displayName,
              contextWindow: modelEntry.contextWindow,
              maxOutputTokens: modelEntry.maxOutputTokens,
              inputCostPer1k: decimal(modelEntry.inputCostPer1K),
              outputCostPer1k: decimal(modelEntry.outputCostPer1K),
              capabilities: toInputJson(modelEntry.capabilities),
              performance: toInputJson(modelEntry.performance ?? {}),
              status: modelEntry.status ?? 'active',
              metadata: toInputJson(modelEntry.metadata ?? {}),
            };

            const modelUpdate: Prisma.ModelUpdateInput = {
              displayName: modelEntry.displayName,
              contextWindow: modelEntry.contextWindow,
              maxOutputTokens: modelEntry.maxOutputTokens,
              inputCostPer1k: decimal(modelEntry.inputCostPer1K),
              outputCostPer1k: decimal(modelEntry.outputCostPer1K),
              capabilities: toInputJson(modelEntry.capabilities),
              performance: toInputJson(modelEntry.performance ?? {}),
              status: modelEntry.status ?? 'active',
              metadata: toInputJson(modelEntry.metadata ?? {}),
              updatedAt: new Date(),
            };

            const result = await tx.model.upsert({
              where: {
                providerId_name: {
                  providerId: provider.id,
                  name: modelEntry.name,
                },
              },
              update: modelUpdate,
              create: modelCreate,
            });

            updatedModelIds.push(result.id);
          }
        }
      },
      {
        timeout: 60000, // 60 second timeout for large catalogs
      }
    );

    syncLog.info(
      { modelsSynced: updatedModelIds.length },
      'Transaction completed, invalidating cache...'
    );

    await modelCacheService.invalidateAll();

    if (updatedModelIds.length > 0) {
      await modelCacheService.bulkGet(updatedModelIds);
    }

    const duration = Date.now() - start;
    syncLog.info(
      {
        providers: catalog.length,
        models: updatedModelIds.length,
        duration,
        durationSeconds: Math.round(duration / 1000),
      },
      '✅ Model catalog synchronized successfully'
    );
  } catch (error) {
    const duration = Date.now() - start;
    syncLog.error(
      {
        error: getErrorMessage(error),
        stack: isError(error) ? error.stack : undefined,
        providers: catalog.length,
        modelsSynced: updatedModelIds.length,
        duration,
      },
      '❌ Model catalog synchronization failed'
    );
    throw error; // Re-throw to be handled by caller
  }
}

// In-process cache for the full catalog list.
// The orchestration engine and dynamic-model-selector call getAllCatalogModels()
// on every chat request (often multiple times per request). With ~5700 rows and
// a `include: { provider: true }` generating a very large IN clause against the
// providers table, hitting Postgres on every call crushes throughput — each
// query is ~1s, 180+ calls per second under experiment load.
//
// We cache the mapped result for a short TTL so that most calls hit memory.
// This is safe because:
//   - Model discovery writes go through upsert() which doesn't invalidate
//     this cache directly, but the TTL keeps staleness bounded to a minute.
//   - Consumers already tolerate the catalog being slightly stale between
//     discovery cycles (which run every ~5 minutes).
// 6min — the catalog only changes when discovery rebuilds it (~5min cycle), and
// consumers already tolerate that staleness (see above). The old 60s TTL expired
// ~5×/cycle on sparse traffic, forcing a cold ~69k-row re-load on the chat hot path
// that contends with the discovery write burst (~32s cold tax). onPoolRebuilt
// (index.ts) invalidates+re-warms this AFTER each rebuild, so the cache stays fresh
// AND warm and the heavy load never lands on a request. Env-overridable.
const CATALOG_CACHE_TTL_MS = Number(process.env.CATALOG_CACHE_TTL_MS) || 6 * 60_000;
let catalogCache: { expiresAt: number; models: Model[] } | null = null;
// Fingerprint of the snapshot content currently held in catalogCache (null
// when unknown: never populated, invalidated, or hydrated from a producer
// that did not publish CATALOG_REDIS_META_KEY). Compared against the meta
// key in hydrateCatalogCacheFromRedis to skip the >100 MB GET + JSON.parse
// when the fleet-wide snapshot has not changed since this process last
// installed it. Set by the rebuild path too, so the elected process does not
// re-parse the snapshot it just published itself.
let installedFingerprint: string | null = null;
// Per-provider list cache (Camada 5 follow-up): getModelsByProvider is hit on the
// execution hot path (adapter.getModels()) and for a huge provider like
// `huggingface` the findMany returns ~60k rows (~1.2s observed). Cache the mapped
// list per provider with the same short TTL so repeated calls within the window
// hit memory instead of re-running the heavy query.
const byProviderCache = new Map<string, { expiresAt: number; models: Model[] }>();
// Single-flight guards (residual fix): on a cold cache, N concurrent callers would
// each fire the same heavy findMany (thundering-herd — observed at deploy/restart
// when the catalog query ran 3-5× concurrently). These hold the in-flight promise
// so concurrent misses await ONE query instead of all racing the DB.
// Two separate trackers, not one shared one: `catalogInFlight` covers the
// cold-path resolver below (which may resolve via a cheap Redis hydrate,
// never touching Postgres), while `catalogRefreshInFlight` covers ONLY the
// real Postgres rebuild (see rebuildCatalogCacheFromPostgres). Sharing a
// single tracker between them would let a fleet-wide refresh tick silently
// no-op onto an in-flight Redis-only hydrate on the same process and skip
// its one job: actually refreshing Postgres and republishing to Redis.
let catalogInFlight: Promise<Model[]> | null = null;
let catalogRefreshInFlight: Promise<Model[]> | null = null;
const byProviderInFlight = new Map<string, Promise<Model[]>>();

// ── Fleet-wide catalog snapshot (capacity-scaling plan, Track 1 §2.3) ──────
// Capacity investigation (docs/CAPACITY-SCALING-PLAN-10K-USERS.md) found this
// full-catalog query (all non-disabled models — 111k+ rows and growing, no
// static cap) firing independently, undeduplicated, from a 4-minute timer
// in EVERY `ci_api` replica AND `ci_worker` (services/cache-refresh-ahead.ts,
// called unconditionally at boot from index.ts and workers/queue-runner.ts) —
// the same per-replica-multiplication bug class the REL-01 fix already
// closed for every other scheduled job (jobs/register-scheduled-jobs.ts).
//
// Fix reuses that exact mechanism: `catalog-cache-refresh` is registered as
// a BullMQ repeatable job (register-scheduled-jobs.ts), which guarantees via
// a Redis lock that exactly ONE process fleet-wide — whichever of the 2
// `ci_api` replicas or `ci_worker` wins that tick's claim, not a hardcoded
// "worker only" rule — actually runs `refreshCatalogCacheAhead()` below and
// publishes the result here. Every replica's own cold path
// (`getAllCatalogModels()`) and per-process keep-warm timer
// (cache-refresh-ahead.ts) hydrate from this key FIRST, falling back to a
// direct Postgres rebuild only when Redis has nothing published yet (fresh
// environment boot, or the elected process hasn't ticked yet) or is
// unavailable — the same fail-open-to-degraded idiom already used by
// core/resilience/distributed-bulkhead.ts and
// middleware/api-key-rate-limit-middleware.ts. This NEVER risks serving an
// empty catalog: the Postgres path is always the fallback, never removed.
//
// Deliberately on the evictable `redis-cache` instance (getRedisClient() →
// config.redis → REDIS_HOST=redis-cache in production), matching
// model-cache-service.ts's existing choice for the same reason: this is a
// rebuildable derived cache, not durable state, so it has no business on the
// `noeviction` queue Redis that also holds billing idempotency state.
//
// CATALOG_REDIS_KEY itself now lives in `@/services/catalog-hot-path`
// (imported + re-exported above) — extracted alongside CATALOG_HOT_PATH_SELECT
// so the SAB candidate-index worker can read the exact same key without
// importing this module's heavier dependency graph.
// Generous relative to CATALOG_CACHE_TTL_MS so a slightly-late elected tick
// (GC pause, transient DB slowness) doesn't expire the shared snapshot out
// from under replicas relying on it between BullMQ ticks.
const CATALOG_REDIS_TTL_MS = Number(process.env.CATALOG_REDIS_TTL_MS) || CATALOG_CACHE_TTL_MS * 3;

// ── In-memory catalog indices (SELECTION_USE_FULL_CACHE_INDEX follow-up) ───
// Flag-gated candidate-retrieval work in dynamic-model-selector.ts wants to
// filter/rank directly against the full cached catalog instead of issuing a
// bounded SQL query (curatedTake/aggregatedTake ~400 rows each today, capped
// regardless of how large the catalog grows). These indices are the
// in-memory structures that make that filtering cheap: O(1) capability/
// provider membership lookups instead of an O(catalog) scan per request.
//
// Built from the SAME `Model[]` snapshot at the SAME two points catalogCache
// itself is ever assigned (rebuildCatalogCacheFromPostgres's direct rebuild,
// and hydrateCatalogCacheFromRedis's fleet-wide-snapshot pull) via the
// `setCatalogCache` helper below — there is no third path that mutates
// catalogCache, so the indices can never be stale relative to the catalog
// they were derived from. Rebuilt wholesale on every refresh (no incremental
// update) — simplest-correct, and cheap enough to do every ~4min (see
// buildCatalogIndices' own perf note) that incremental maintenance isn't
// worth the complexity/bug surface yet.
export interface CatalogIndices {
  /** Legacy capability string (Model.capabilities entries) -> set of catalog
   *  model `id`s that declare it. NOT keyed by the canonical `capability_uris`
   *  HCRA projection — CATALOG_HOT_PATH_SELECT deliberately excludes that
   *  column (wire-size optimization, see the Phase 6 Fix 2 comment above), so
   *  this index (and any consumer of it) only ever sees the legacy
   *  projection, same as every other catalog-cache consumer today. */
  byCapability: Map<string, Set<string>>;
  /** Provider name (Model.provider) -> ordered list of catalog model `id`s
   *  under that provider, in catalog-scan order. */
  byProvider: Map<string, string[]>;
  /** Catalog model `id` -> Model, for O(1) lookup after index intersection
   *  (avoids re-scanning the full array to hydrate matched ids). */
  byId: Map<string, Model>;
  /** When these indices were built (Date.now()) — same wall-clock cadence as
   *  catalogCache.expiresAt, exposed for observability/debugging. */
  builtAt: number;
}

let catalogIndices: CatalogIndices | null = null;

/**
 * O(catalog) single pass, no I/O. Measured locally (see
 * api/src/services/__tests__/catalog-indices.test.ts's perf case) at
 * comfortably sub-100ms for a synthetic 111k-row catalog — negligible next to
 * the ~1.2-1.9s the underlying full-catalog Postgres query itself already
 * costs when it actually runs (see cache-refresh-ahead.ts's doc), and it only
 * runs on that SAME cadence (once per refresh), never per-request.
 *
 * PERF NOTE (2026-09-08, see dynamic-model-selector.ts's
 * getFullCacheFairCandidateModels for the full writeup): a precomputed
 * curated/aggregated-bucket classification Set (built here, once per
 * refresh, checked via O(1) Set.has(model.id) in the per-request consumer
 * instead of re-parsing `model.metadata` there) was implemented and profiled
 * end to end — it made the consumer's request-time loop SLOWER (~26ms ->
 * ~60ms average on the real-catalog-scale benchmark), not faster. Two
 * ~40-110k-entry Sets don't stay CPU-cache-resident, so each lookup is a
 * cache-unfriendly random-access hash probe, while reading `model.metadata`
 * directly is cache-friendly (the consumer is already touching that same
 * Model object for other fields in the same loop iteration). Reverted;
 * documented here so it isn't re-attempted without a real before/after
 * measurement.
 */
function buildCatalogIndices(models: Model[]): CatalogIndices {
  const byCapability = new Map<string, Set<string>>();
  const byProvider = new Map<string, string[]>();
  const byId = new Map<string, Model>();
  for (const model of models) {
    byId.set(model.id, model);

    const providerList = byProvider.get(model.provider);
    if (providerList) {
      providerList.push(model.id);
    } else {
      byProvider.set(model.provider, [model.id]);
    }

    const caps = Array.isArray(model.capabilities) ? model.capabilities : [];
    for (const cap of caps) {
      let set = byCapability.get(cap);
      if (!set) {
        set = new Set();
        byCapability.set(cap, set);
      }
      set.add(model.id);
    }
  }
  return { byCapability, byProvider, byId, builtAt: Date.now() };
}

/**
 * The ONLY function that assigns `catalogCache` — replaces the two direct
 * `catalogCache = {...}` assignments that used to live in
 * rebuildCatalogCacheFromPostgres and hydrateCatalogCacheFromRedis, so the
 * indices are structurally guaranteed to be rebuilt at exactly the same
 * moments the catalog itself changes, never separately and never stale.
 */
function setCatalogCache(models: Model[], fingerprint: string | null): void {
  catalogCache = { expiresAt: Date.now() + CATALOG_CACHE_TTL_MS, models };
  catalogIndices = buildCatalogIndices(models);
  installedFingerprint = fingerprint;
}

/**
 * Content fingerprint of the catalog this process currently serves, or null
 * when unknown. Consumers that only need to re-run work when the catalog
 * actually changed (cache-refresh-ahead.ts's selection prewarm gate) compare
 * successive values instead of re-running on every tick.
 */
export function getCatalogFingerprint(): string | null {
  return installedFingerprint;
}

/**
 * Produces the exact bytes published to Redis plus a content fingerprint.
 *
 * The JSON is assembled from per-row strings so it stays byte-identical to
 * `JSON.stringify(models)` (consumers keep seeing the scan order) while the
 * fingerprint hashes a SORTED copy of those rows: the producer query has no
 * ORDER BY, so two consecutive rebuilds of an unchanged table can come back
 * in different scan orders, and an order-sensitive hash would then differ on
 * every tick and readers would never get to skip. Sorting `models` itself
 * instead would change the first-match order provider-registry's
 * findModelByName and the byProvider index observe, which is out of scope.
 *
 * sha256 is used as a collision-resistant fingerprint, not for security.
 */
function serializeCatalogSnapshot(models: Model[]): { json: string; meta: CatalogSnapshotMeta } {
  const rows = models.map((model) => JSON.stringify(model));
  const json = `[${rows.join(',')}]`;
  const hash = createHash('sha256');
  for (const row of [...rows].sort()) {
    hash.update(row);
    hash.update('\n');
  }
  return {
    json,
    meta: { fingerprint: hash.digest('hex'), rowCount: models.length, generatedAt: Date.now() },
  };
}

/**
 * Read-only accessor for the in-memory catalog indices (SELECTION_USE_FULL_CACHE_INDEX
 * consumer: dynamic-model-selector.ts's getFullCacheFairCandidateModels). Returns
 * null when the catalog cache has never been populated in this process (fresh
 * boot, before the first getAllCatalogModels()/hydrate call) — callers must
 * treat null as "indices not ready yet", the same fail-open posture every
 * other consumer of this module already takes toward a cold cache, NOT as
 * "catalog is empty".
 */
export function getCatalogIndices(): CatalogIndices | null {
  return catalogIndices;
}

async function publishCatalogSnapshotToRedis(snapshot: {
  json: string;
  meta: CatalogSnapshotMeta;
}): Promise<void> {
  try {
    const redis = getRedisClient();
    // Snapshot first, meta second, as two plain SETs (no MULTI: the fake
    // clients in this module's tests only expose get/set/del). A reader that
    // fetches meta and then the snapshot can therefore never pair a NEW
    // fingerprint with an OLD snapshot; the reverse pairing (old meta, new
    // snapshot) only costs one redundant parse on the next tick.
    await redis.set(CATALOG_REDIS_KEY, snapshot.json, 'PX', CATALOG_REDIS_TTL_MS);
    await redis.set(
      CATALOG_REDIS_META_KEY,
      JSON.stringify(snapshot.meta),
      'PX',
      CATALOG_REDIS_TTL_MS
    );
  } catch (error) {
    log.warn(
      { error },
      'Catalog cache: failed to publish fleet-wide Redis snapshot (other replicas fall back to their own direct Postgres rebuild)'
    );
  }
}

/**
 * Redis-only read: hydrates the LOCAL in-process cache from the fleet-wide
 * snapshot if one exists. Returns null (never throws) when Redis has nothing
 * published yet, the payload is malformed/empty, or Redis is unreachable —
 * callers treat null as "fall back to a direct Postgres rebuild", so this
 * can never be the cause of an empty catalog being served.
 *
 * Reads CATALOG_REDIS_META_KEY first. When its fingerprint matches what this
 * process already holds, the snapshot GET + JSON.parse (>100 MB string,
 * ~500 MB of transient heap, measured 2026-09-10) is skipped and the local
 * TTL is simply extended: the elected producer republishes every 4 minutes
 * regardless of change, and until now every process in the fleet re-parsed
 * that identical payload on every tick. Returning the existing models (not
 * null) on that path matters: resolveColdCatalog treats null as "rebuild
 * from Postgres". A missing or malformed meta (producer still on the
 * previous version) degrades to the old parse-every-time behavior.
 */
async function hydrateCatalogCacheFromRedis(): Promise<Model[] | null> {
  try {
    const redis = getRedisClient();
    const meta = parseCatalogSnapshotMeta(await redis.get(CATALOG_REDIS_META_KEY));
    if (
      meta &&
      catalogCache &&
      catalogCache.models.length > 0 &&
      installedFingerprint !== null &&
      installedFingerprint === meta.fingerprint
    ) {
      catalogCache.expiresAt = Date.now() + CATALOG_CACHE_TTL_MS;
      log.debug(
        { fingerprint: meta.fingerprint, rowCount: meta.rowCount },
        'Catalog cache: fleet-wide snapshot unchanged, parse skipped'
      );
      return catalogCache.models;
    }
    const raw = await redis.get(CATALOG_REDIS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const models = parsed as Model[];
    // A rowCount mismatch means meta and snapshot were read across a
    // republish; record "unknown" so the next tick re-parses instead of
    // trusting a fingerprint that may describe a different payload.
    const fingerprint = meta && meta.rowCount === models.length ? meta.fingerprint : null;
    setCatalogCache(models, fingerprint);
    log.debug(
      { fingerprint, rowCount: models.length },
      'Catalog cache: hydrated from fleet-wide snapshot'
    );
    return models;
  } catch (error) {
    log.debug(
      { error },
      'Catalog cache: Redis hydrate failed or empty — falling back to direct Postgres rebuild'
    );
    return null;
  }
}

async function deleteCatalogRedisSnapshot(): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.del(CATALOG_REDIS_KEY);
    await redis.del(CATALOG_REDIS_META_KEY);
  } catch (error) {
    log.debug(
      { error },
      'Catalog cache: failed to clear fleet-wide Redis snapshot on invalidate (non-fatal — next read falls back to Postgres anyway)'
    );
  }
}

export function invalidateCatalogCache(): void {
  catalogCache = null;
  catalogIndices = null;
  installedFingerprint = null;
  byProviderCache.clear();
  // Best-effort, fire-and-forget: a caller that explicitly invalidated to
  // force a fresh reload (e.g. index.ts's post-discovery-rebuild re-warm)
  // wants THIS replica's next getAllCatalogModels() call to see genuinely
  // fresh data, not immediately re-hydrate the stale pre-invalidation
  // snapshot still sitting in Redis. If this delete itself fails (Redis
  // down), the subsequent getAllCatalogModels() falls through to Postgres
  // anyway, so correctness never depends on it succeeding.
  void deleteCatalogRedisSnapshot();
}

export async function getAllCatalogModels(): Promise<Model[]> {
  // IMPORTANT: The schema has UNIQUE(id, provider_id) — the same model `id`
  // can legitimately exist under multiple providers (e.g. `claude-opus-4-6`
  // is available via native `anthropic`, `aihubmix`, `cometapi`, etc.).
  //
  // Previous implementation used `new Set(ids)` + a cache keyed by `id` alone,
  // which silently collapsed all provider variants into ONE arbitrary record,
  // dropping hundreds of models from the orchestration pool — including every
  // native provider entry that happened to share an id with a hub variant.
  //
  // Fix: load ALL rows directly with their provider relation, preserving every
  // (id, providerId) combination, and cache the mapped array in-process with a
  // short TTL to avoid pounding Postgres on every chat request.
  //
  // INTENTIONAL FULL ENUMERATION — do NOT add `take:` cap. The orchestration
  // engine, model-fallback strategy, and dynamic-model-selector all depend on
  // the catalog being complete. Truncation would silently degrade routing
  // quality without raising errors. The CATALOG_CACHE_TTL_MS gate amortizes
  // the cost across all chat requests within the window.
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) {
    return catalogCache.models;
  }
  // Single-flight: dedup concurrent cold-cache misses onto ONE resolution.
  if (catalogInFlight) {
    return catalogInFlight;
  }
  const promise = resolveColdCatalog().finally(() => {
    if (catalogInFlight === promise) catalogInFlight = null;
  });
  catalogInFlight = promise;
  return promise;
}

/**
 * Cold-path resolver used only by getAllCatalogModels(): try the fleet-wide
 * Redis snapshot first (cheap, published by whichever process the BullMQ
 * "catalog-cache-refresh" job elected this tick — see
 * jobs/register-scheduled-jobs.ts), falling back to a direct Postgres
 * rebuild ONLY when Redis has nothing yet or is unavailable. Guarantees a
 * correct, non-empty catalog on first boot of a fresh environment (nothing
 * published yet) exactly as before this change (a bare Postgres rebuild),
 * just cheaper on every replica that isn't the one doing that rebuild.
 */
async function resolveColdCatalog(): Promise<Model[]> {
  const fromRedis = await hydrateCatalogCacheFromRedis();
  if (fromRedis) return fromRedis;
  return rebuildCatalogCacheFromPostgres();
}

/**
 * The ONLY function in this module that queries Postgres for the full
 * catalog. Runs the full enumeration query (see the INTENTIONAL FULL
 * ENUMERATION comment above — no `take:` cap, ever), swaps the local cache
 * atomically, and best-effort publishes the mapped result to Redis so other
 * replicas can hydrate from it instead of repeating this query themselves.
 */
async function rebuildCatalogCacheFromPostgres(): Promise<Model[]> {
  const records = await prisma.model.findMany({
    where: { status: { not: 'disabled' } },
    select: CATALOG_HOT_PATH_SELECT,
  });
  const mapped = records.map((record) => mapPrismaModel(record));
  const snapshot = serializeCatalogSnapshot(mapped);
  setCatalogCache(mapped, snapshot.meta.fingerprint);
  await publishCatalogSnapshotToRedis(snapshot);
  return mapped;
}

/**
 * Fleet-wide single-writer refresh (keep-warm): ALWAYS runs the real
 * Postgres rebuild and republishes to Redis — never resolves via Redis
 * itself, since its entire purpose IS to be the thing that keeps the Redis
 * snapshot fresh. Invoked exactly once per tick, fleet-wide, by the elected
 * process for the BullMQ "catalog-cache-refresh" repeatable job
 * (jobs/register-scheduled-jobs.ts) — BullMQ's Redis lock is what guarantees
 * single execution across every `ci_api` replica and `ci_worker`, the same
 * mechanism REL-01 already established for every other scheduled job in
 * this codebase. No-ops onto an in-flight call to itself (not onto
 * getAllCatalogModels()'s cold path — see the catalogInFlight vs
 * catalogRefreshInFlight comment above) if a refresh is already running in
 * this same process.
 */
export async function refreshCatalogCacheAhead(): Promise<void> {
  if (catalogRefreshInFlight) {
    await catalogRefreshInFlight;
    return;
  }
  const promise = rebuildCatalogCacheFromPostgres().finally(() => {
    if (catalogRefreshInFlight === promise) catalogRefreshInFlight = null;
  });
  catalogRefreshInFlight = promise;
  await promise;
}

/**
 * Per-process keep-warm step (see services/cache-refresh-ahead.ts's
 * per-replica timer). Unlike refreshCatalogCacheAhead() above, this NEVER
 * touches Postgres — it only pulls the latest fleet-wide Redis snapshot into
 * THIS replica's in-process cache ahead of its local TTL expiry, so no
 * request on this replica ever pays even a cold Redis round-trip. A no-op
 * (not an error) when Redis has nothing published yet or is unreachable: the
 * existing local cache, if any, keeps serving until its own TTL lapses, at
 * which point getAllCatalogModels()'s cold path (resolveColdCatalog) takes
 * over and falls back to a direct, correct, non-empty Postgres rebuild on
 * this same replica. When the published snapshot's fingerprint matches what
 * this process already holds, the pull is a single small meta GET and the
 * local TTL is extended (see hydrateCatalogCacheFromRedis).
 */
export async function hydrateCatalogCacheAhead(): Promise<void> {
  await hydrateCatalogCacheFromRedis();
}

/**
 * INTENTIONAL FULL ENUMERATION (per-provider) — do NOT add `take:` cap.
 *
 * Caller contract: this returns every active model for the named provider.
 * Adding a hard cap would silently truncate the result for any provider
 * whose model count exceeds the cap (HuggingFace Hub serves ~58K models;
 * Together / OpenRouter aggregate thousands). Callers that want bounded
 * pagination should use `searchModels({ providers: [name], limit })` on
 * `ModelRepository` instead.
 */
export async function getModelsByProvider(providerName: string): Promise<Model[]> {
  const now = Date.now();
  const cachedList = byProviderCache.get(providerName);
  if (cachedList && cachedList.expiresAt > now) {
    return cachedList.models;
  }
  // Hot-path fix (P0.8, 2026-08-18): the global catalog cache is kept warm by
  // the refresh-ahead timer and holds the SAME rows (status != disabled, same
  // CATALOG_HOT_PATH_SELECT). Filtering it in memory is O(n) over an already-
  // materialized array (~52k) and costs ~1ms, while the DB path re-runs the
  // per-provider findMany — ~1.5s for `huggingface` (~60k rows, measured in
  // prod inside an anonymous "oi" request when byProviderCache expired; the
  // refresh-ahead timer does NOT renew byProviderCache, so this fired on the
  // request path once per TTL window). Prefer the warm global cache; only fall
  // through to the DB when the global cache itself is cold/expired.
  if (catalogCache && catalogCache.expiresAt > now) {
    const fromGlobal = catalogCache.models
      .filter((m) => m.provider === providerName)
      .sort((a, b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id));
    byProviderCache.set(providerName, {
      expiresAt: Math.min(catalogCache.expiresAt, now + CATALOG_CACHE_TTL_MS),
      models: fromGlobal,
    });
    return fromGlobal;
  }
  // Single-flight: dedup concurrent cold-cache misses for the same provider (e.g.
  // the ~60k-row `huggingface` query) onto ONE findMany.
  const existing = byProviderInFlight.get(providerName);
  if (existing) {
    return existing;
  }
  const p = (async (): Promise<Model[]> => {
    try {
      const provider = await prisma.provider.findUnique({ where: { name: providerName } });
      if (!provider) {
        return [];
      }

      const models = await prisma.model.findMany({
        where: { providerId: provider.id, status: { not: 'disabled' } },
        select: CATALOG_HOT_PATH_SELECT,
        orderBy: { displayName: 'asc' },
      });

      if (models.length === 0) {
        return [];
      }

      const mapped = models.map((record) => mapPrismaModel(record));

      byProviderCache.set(providerName, {
        expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
        models: mapped,
      });
      await modelCacheService.setMany(mapped);

      return mapped;
    } finally {
      byProviderInFlight.delete(providerName);
    }
  })();
  byProviderInFlight.set(providerName, p);
  return p;
}

export async function getModelById(
  modelId: string,
  preferredProvider?: string
): Promise<Model | null> {
  // Fast path: check the in-process catalog cache first. This avoids hammering
  // Postgres with per-model findFirst queries during orchestration — the
  // dynamic-model-selector and other consumers call getModelById in tight
  // loops over the candidate pool (5700+ models), and each DB round-trip
  // was ~1s under load (index scans over a large table with the `include:
  // provider` JOIN), collapsing overall throughput.
  //
  // The catalog cache has a 60s TTL which is well within the staleness
  // tolerance of model lookups during experiment execution.
  const now = Date.now();
  if (!catalogCache || catalogCache.expiresAt <= now) {
    // Cache is cold or expired — warm it with a single bulk query. This trades
    // one slightly-expensive findMany for hundreds of per-model findFirst
    // queries that would otherwise fire during the scoring/selection loops.
    try {
      await getAllCatalogModels();
    } catch {
      // If warming fails, fall through to the direct DB path below.
    }
  }
  if (catalogCache) {
    if (preferredProvider) {
      const hit = catalogCache.models.find(
        (m) => m.id === modelId && m.provider === preferredProvider
      );
      if (hit) return hit;
    }
    // Match any non-disabled entry in cache (catalog query already filters
    // status != 'disabled'). The previous strict `=== 'active'` check would
    // fall through to DB for `experimental`, `preview`, etc. — causing the
    // per-model N+1 to re-appear for non-active variants.
    const hit = catalogCache.models.find((m) => m.id === modelId);
    if (hit) return hit;
    // Not in cache → fall through to DB (rare — only for models inserted
    // between cache builds).
  }

  // With the multi-provider schema (uid PK, composite unique id+provider_id),
  // the same model ID can exist under multiple providers. When preferredProvider
  // is set, use findFirst with provider filter to select the correct entry.
  if (preferredProvider) {
    const record = await prisma.model.findFirst({
      where: { id: modelId, provider: { name: preferredProvider } },
      select: CATALOG_HOT_PATH_SELECT,
    });
    if (record) return mapPrismaModel(record);
    // Fallback: try without provider filter
  }

  // No provider preference: return any active entry. The provider-registry's
  // findModel() handles operability checking — it will try all providers
  // dynamically if the first one isn't operational. No hardcoded provider
  // lists here; operability is a runtime concern, not a catalog concern.
  const record = await prisma.model.findFirst({
    where: { id: modelId, status: 'active' },
    select: CATALOG_HOT_PATH_SELECT,
  });
  return record ? mapPrismaModel(record) : null;
}

export async function listCatalogModels(): Promise<Model[]> {
  return getAllCatalogModels();
}

export async function listCatalogModelsByProvider(providerName: string): Promise<Model[]> {
  return getModelsByProvider(providerName);
}

export async function getCatalogModel(
  modelId: string,
  preferredProvider?: string
): Promise<Model | null> {
  return getModelById(modelId, preferredProvider);
}

/**
 * Get models that are actually eligible for chat execution.
 *
 * Filters the full catalog to exclude:
 * - Models without 'chat' or 'text_generation' capability
 * - Audio-only, embedding-only, image-only, video-only models
 * - Self-hosted/local models (unless explicitly requested)
 *
 * This prevents the misleading "5700 models in pool" number when most
 * are not usable for chat. The C3 pilot showed 606 models tracked in
 * model_health but many were TTS, STT, embedding, or defunct endpoints.
 */
/**
 * Pure chat-eligibility predicate for a single catalog model (unit-testable;
 * extracted from getChatEligibleModels so the guard/classifier exclusion can
 * be tested without a DB).
 */
export function isChatEligibleModel(
  model: Pick<Model, 'id' | 'name' | 'provider' | 'capabilities'>,
  allowSelfHostedIds: Set<string>,
  includeSelfHosted = false
): boolean {
  const CHAT_CAPABILITIES = new Set(['chat', 'text_generation', 'function_calling', 'streaming']);
  const EXCLUDED_CAPABILITIES = new Set([
    'text_to_speech',
    'tts',
    'audio_generation',
    'speech_to_text',
    'transcription',
    'diarization',
    'embeddings',
    'embedding',
    'image_generation',
    'image_editing',
    'video_generation',
    'video_editing',
    'moderation',
  ]);
  const SELF_HOSTED_PROVIDERS = new Set([
    'self-hosted',
    'ollama',
    'local-llama',
    'local-kobold',
    'local-embeddings',
    'vllm',
    'lm-studio',
    'xinference',
    'triton',
    'local-ocr',
    'local-docling',
    'local-piper',
    'local-nllb',
  ]);

  // Exclude self-hosted unless explicitly requested or individually pinned
  if (
    !includeSelfHosted &&
    !allowSelfHostedIds.has(model.id) &&
    !allowSelfHostedIds.has(model.name)
  ) {
    const provider = (model.provider || '').toLowerCase();
    if (
      SELF_HOSTED_PROVIDERS.has(provider) ||
      provider.startsWith('local-') ||
      provider.includes('local')
    ) {
      return false;
    }
  }

  // Must have at least one chat capability
  const caps = Array.isArray(model.capabilities) ? (model.capabilities as string[]) : [];
  const hasChatCapability = caps.some((c) => CHAT_CAPABILITIES.has(c));
  if (!hasChatCapability) return false;

  // Must not be primarily a non-chat model
  const isExcludedOnly = caps.length > 0 && caps.every((c) => EXCLUDED_CAPABILITIES.has(c));
  if (isExcludedOnly) return false;

  // Safety/classifier models that advertise 'chat' capability but cannot serve
  // synthesis (observed live 2026-08-17: cost-cascade rung picked Groq's
  // `llama-prompt-guard-2-22m` — a prompt-classification endpoint — and every
  // attempt returned HTTP 400, burning a rung of every cheap-tier ladder).
  // Name-based on purpose: catalogs tag these as 'chat' because they share the
  // chat wire format, so capability filtering alone cannot catch them.
  const id = (model.id || '').toLowerCase();
  if (/(^|\/)llama-guard|^prompt-guard|[-_]prompt-guard([-_]|$)|guardian|^guard-/.test(id)) {
    return false;
  }

  return true;
}

export async function getChatEligibleModels(options?: {
  includeSelfHosted?: boolean;
  /**
   * Self-hosted models are excluded by default (see SELF_HOSTED_PROVIDERS
   * below). When the caller pinned an exact model id (`user_specified_model`
   * on the request), that one self-hosted model is let through even though
   * `includeSelfHosted` is not set — otherwise a pin to e.g. an Ollama model
   * is silently dropped from the pool before the exact-match lookup in
   * SingleModelStrategy.selectBestModel() ever runs, and the request falls
   * through to DynamicModelSelector, which substitutes an unrelated external
   * model (observed: `qwen3:8b`/`llama3.2:3b` pins served by
   * `Qwen/Qwen3-8B`/`DeepSeek-V4-Flash` on hosted providers — H-B mini-run
   * routing-fidelity audit, 0/283 executions actually reached the pin).
   * Auto-routing (no pin) is unaffected: self-hosted models still never
   * appear in the pool DynamicModelSelector picks from.
   */
  allowSelfHostedModelIds?: string[];
}): Promise<Model[]> {
  const all = await getAllCatalogModels();
  const allowSelfHostedIds = new Set(options?.allowSelfHostedModelIds ?? []);

  return all.filter((model) =>
    isChatEligibleModel(model, allowSelfHostedIds, options?.includeSelfHosted)
  );
}

/**
 * Get ALL entries for a model across all providers, including variant IDs.
 *
 * Models exist under different IDs across providers:
 *   gpt-5.4-pro (native) vs openai/gpt-5.4-pro (OpenRouter) vs openai/gpt-5.4 (EdenAI)
 *
 * This function searches for:
 * 1. Exact ID match
 * 2. Provider-prefixed variants (e.g., "openai/gpt-5.4-pro" for "gpt-5.4-pro")
 * 3. Base name from prefixed ID (e.g., "gpt-5.4-pro" from "openai/gpt-5.4-pro")
 */
export async function getAllEntriesForModel(modelId: string): Promise<Model[]> {
  // Strategy 1: Equivalence service (L2) — finds cross-provider matches via embedding similarity
  try {
    const { getModelEquivalenceService } = await import('@/services/model-equivalence-service');
    const equivalenceService = getModelEquivalenceService();
    const group = equivalenceService.getEquivalentModels(modelId);

    if (group && group.members.length > 0) {
      // Fetch full model records for all members in the equivalence group
      const uids = group.members.map((m) => m.uid);
      const records = await prisma.model.findMany({
        where: { uid: { in: uids }, status: 'active' },
        // Phase 6 Fix 2: catalog hot-path allowlist. We additionally need
        // `uid` here so we can preserve the equivalence-group sort order.
        select: { ...CATALOG_HOT_PATH_SELECT, uid: true },
      });
      if (records.length > 0) {
        // Sort by source type (native first) — already done by equivalence service
        const uidOrder = new Map(uids.map((uid, i) => [uid, i]));
        records.sort((a, b) => (uidOrder.get(a.uid) ?? 99) - (uidOrder.get(b.uid) ?? 99));
        return records.map(mapPrismaModel);
      }
    }
  } catch {
    // Equivalence service not initialized or failed — fall through to prefix matching
  }

  // Strategy 2: Prefix-based variant matching (fallback)
  const variants: string[] = [modelId];

  if (!modelId.includes('/')) {
    const familyPrefixes: Record<string, string[]> = {
      gpt: ['openai'],
      o1: ['openai'],
      o3: ['openai'],
      o4: ['openai'],
      chatgpt: ['openai'],
      claude: ['anthropic'],
      gemini: ['google'],
      gemma: ['google'],
      grok: ['xai', 'x-ai'],
      deepseek: ['deepseek'],
      mistral: ['mistralai', 'mistral'],
    };
    for (const [prefix, families] of Object.entries(familyPrefixes)) {
      if (modelId.toLowerCase().startsWith(prefix)) {
        for (const fam of families) variants.push(`${fam}/${modelId}`);
      }
    }
  } else {
    const base = modelId.split('/').slice(1).join('/');
    if (base) variants.push(base);
  }

  // Strategy 3: Also search for date-stripped variants (e.g., gpt-5.4-pro-2026-03-05 → gpt-5.4-pro)
  const dateStripped = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (dateStripped !== modelId) variants.push(dateStripped);
  // And reverse: if searching for gpt-5.4-pro, also find gpt-5.4-pro-2026-*
  const baseName = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, '');

  const records = await prisma.model.findMany({
    where: {
      OR: [
        { id: { in: [...new Set(variants)] }, status: 'active' },
        // LIKE query for date-versioned variants (e.g., baseName-YYYY-MM-DD)
        { id: { startsWith: baseName + '-' }, status: 'active' },
      ],
    },
    select: CATALOG_HOT_PATH_SELECT,
    orderBy: { usageCount: 'desc' },
  });
  // Filter Strategy 3 LIKE results to only date-versioned variants (baseName-YYYY-MM-DD)
  const variantSet = new Set(variants);
  const filtered = records.filter((r) => {
    if (variantSet.has(r.id)) return true; // Strategy 2 exact match — keep
    const suffix = r.id.slice(baseName.length);
    return /^-\d{4}-\d{2}-\d{2}/.test(suffix);
  });
  return filtered.map(mapPrismaModel);
}

export async function removeDisabledCatalogEntries(
  validProviders: ProviderCatalogEntry[]
): Promise<void> {
  const validProviderNames = new Set(validProviders.map((provider) => provider.name));
  const providers = await prisma.provider.findMany();

  const providersToDisable = providers.filter((provider) => !validProviderNames.has(provider.name));

  for (const provider of providersToDisable) {
    await prisma.provider.update({
      where: { id: provider.id },
      data: { status: 'disabled', updatedAt: new Date() },
    });
    await prisma.model.updateMany({
      where: { providerId: provider.id },
      data: { status: 'disabled', updatedAt: new Date() },
    });
  }

  if (providersToDisable.length > 0) {
    await modelCacheService.invalidateAll();
  }
}

export const modelCatalogService = {
  syncModelCatalog,
  listModels: listCatalogModels,
  listModelsByProvider: listCatalogModelsByProvider,
  getCatalogIndices,
  getModel: getCatalogModel,
  getAllCatalogModels,
  getModelsByProvider,
  getModelById,
  getAllEntriesForModel,
  removeDisabledCatalogEntries,
} as const;
