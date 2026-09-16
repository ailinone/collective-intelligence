// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Main-thread manager for the SharedArrayBuffer-backed candidate index
 * (`SELECTION_USE_SAB_CANDIDATE_INDEX`). Owns:
 *   - the three SharedArrayBuffers (two double-buffer generations + the
 *     small Atomics control block), allocated ONCE for the process lifetime;
 *   - the long-lived `worker_threads.Worker` that rebuilds them (see
 *     `worker.ts`), including crash detection and automatic respawn;
 *   - the periodic rebuild schedule;
 *   - the synchronous, per-request read API (`getSabCandidateModels`) that
 *     `dynamic-model-selector.ts` calls in place of
 *     `getFullCacheFairCandidateModels` when the flag is on AND the index
 *     has completed at least one build.
 *
 * ── Why the manager owns buffer allocation (a deliberate deviation from the
 *    feasibility prototype) ──────────────────────────────────────────────
 * `investigation/sab-worker-feasibility/worker.mjs` had the WORKER allocate
 * the SharedArrayBuffers and hand them to the main thread via the 'ready'
 * message. That is fine for a one-shot investigation script, but wrong for a
 * long-lived service that must survive worker crashes: if the worker owns
 * allocation, a crash+respawn either re-allocates fresh buffers (orphaning
 * whatever views/data the main thread already has — a full outage until the
 * new worker's first rebuild completes) or requires re-plumbing the SAME
 * buffers into the new worker via a mechanism just as fragile as the
 * postMessage-cost problem this design otherwise avoids.
 *
 * Instead, THIS manager allocates all three buffers once, wraps its own
 * `viewsA`/`viewsB` directly on top of them, and passes the SAME buffers to
 * every worker instance it ever spawns (via `workerData` — SharedArrayBuffer
 * is one of the few types `workerData` carries by real reference, not a
 * structured-clone copy). A worker crash therefore never loses data: the
 * shared memory (and whatever generation was last successfully published
 * into it) is untouched by the crash, because it was never owned by the
 * worker's own JS heap in the first place. Respawn is just "start a new
 * Worker with the same workerData" — reads keep serving the last-good
 * generation uninterrupted throughout.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { getRuntimeDatabaseUrl } from '@/database/connection-url';
import { computeLayout, wrapViews, CONTROL, type GenerationViews } from './schema';
import { buildGenLookup, getCandidatesFromSharedIndex, type GenLookup, type SabCandidateCriteria } from './reader';
import type { FullCacheFairCandidateResult } from '@/core/selection/dynamic-model-selector';
import type { RebuildFailureReason, SabWorkerData, WorkerToMainMessage } from './types';
import { MAX_MODELS, buildCapacityConfig, computeEffectiveMaxModels } from './capacity';
import {
  sabCandidateIndexReady,
  sabCandidateIndexActiveGen,
  sabCandidateIndexVersion,
  sabCandidateIndexBuildsTotal,
  sabCandidateIndexCrashesTotal,
  sabCandidateIndexLastBuildMs,
  sabCandidateIndexLastBuildSource,
  sabCandidateIndexBuildFailuresTotal,
  sabCandidateIndexDistinctCapabilities,
  sabCandidateIndexMetadataBlobUsedBytes,
  sabCandidateIndexMetadataBlobCapacityBytes,
  sabCandidateIndexMaxModelsEffective,
  sabCandidateIndexWorkerPeakRssBytes,
} from '@/observability/ci-metrics';

const log = logger.child({ component: 'sab-candidate-index-manager' });

/** Same env var name pattern as the existing `SELECTION_USE_FULL_CACHE_INDEX`
 *  flag it sits alongside — read live on every call (never module-load
 *  cached) so tests can flip it without re-importing this module. Default
 *  OFF: see this module's own doc + the PR description for why this stays
 *  behind its own independent flag rather than reusing
 *  SELECTION_USE_FULL_CACHE_INDEX (the implementation is architecturally
 *  different enough — worker_threads + SharedArrayBuffer vs an in-process
 *  Map scan — that it needs its own independent rollout lever; see ADR-026
 *  and this PR's description for the full reasoning). */
export function isSabCandidateIndexEnabled(): boolean {
  return process.env.SELECTION_USE_SAB_CANDIDATE_INDEX === 'true';
}

/** Same cadence knob as the existing catalog cache's own TTL
 *  (`CATALOG_CACHE_TTL_MS`, `model-catalog-service.ts`) by default — the SAB
 *  index is a read-optimized derivative of the same underlying catalog data,
 *  so keeping it on the same refresh cadence is the least-surprising
 *  default. Independently overridable because the two caches serve
 *  different purposes (one is the source `Model[]` array itself, the other
 *  a specialized read structure) and may legitimately want different
 *  freshness/cost trade-offs later. */
const REBUILD_INTERVAL_MS =
  Number(process.env.SAB_CANDIDATE_INDEX_REBUILD_INTERVAL_MS) ||
  Number(process.env.CATALOG_CACHE_TTL_MS) ||
  6 * 60_000;

/** Backoff between a worker crash and respawning it. Fixed (not
 *  exponential): a crash loop is expected to be rare and transient (e.g. a
 *  brief Postgres blip on the fallback path) — the goal is "don't hot-loop
 *  respawning tens of times a second", not sophisticated backoff, since the
 *  last-good generation keeps serving reads throughout regardless of how
 *  long the worker stays down. */
const RESPAWN_DELAY_MS = Number(process.env.SAB_CANDIDATE_INDEX_RESPAWN_DELAY_MS) || 2_000;

interface ManagerState {
  bufferA: SharedArrayBuffer;
  bufferB: SharedArrayBuffer;
  control: SharedArrayBuffer;
  controlView: Int32Array;
  viewsA: GenerationViews;
  viewsB: GenerationViews;
  worker: Worker | null;
  /** Resolved once the worker's FIRST rebuild (success or failure) after the
   *  most recent (re)spawn completes — lets `ensureSabCandidateIndexStarted`
   *  callers optionally await initial readiness (used by tests; the request
   *  hot path never awaits this, it just checks `isSabCandidateIndexReady()`
   *  and falls through if not ready, same fail-open posture as every other
   *  candidate-retrieval path in this file). */
  genLookupByGen: [GenLookup | null, GenLookup | null];
  rebuildTimer: ReturnType<typeof setInterval> | null;
  respawnTimer: ReturnType<typeof setTimeout> | null;
  starting: boolean;
  stopped: boolean;
  consecutiveCrashes: number;
  lastBuildMs: number | null;
  lastSource: 'redis' | 'postgres' | null;
  lastError: string | null;
  lastFailureReason: RebuildFailureReason | null;
  builds: number;
  buildFailures: number;
  crashes: number;
  distinctCapabilities: number | null;
  metadataBlobUsedBytes: number | null;
  /** ADR-028 (Layer 1): the effective MAX_MODELS this state's SharedArrayBuffers
   *  were actually allocated for — may be smaller (or larger) than
   *  capacity.ts's fixed MAX_MODELS design ceiling. See
   *  `maybeResizeAfterBuild`/`scheduleResize` for how this changes over the
   *  life of a process. */
  effectiveMaxModels: number;
  /** The metadata blob capacity THIS state's buffers were built with
   *  (`buildCapacityConfig(effectiveMaxModels).metadataBlobBytes`) — replaces
   *  the pre-ADR-028 fixed `METADATA_BLOB_BYTES` constant everywhere this
   *  module reports capacity, since that capacity is now per-allocation. */
  metadataBlobCapacityBytes: number;
  /** ADR-028 (Layer 3): peak `process.memoryUsage().rss` the worker reported
   *  for its most recent rebuild attempt (successful or aborted). */
  lastPeakRssBytes: number | null;
}

let state: ManagerState | null = null;

function isCompiledBuild(): boolean {
  // Compiled production build runs `node dist/index.js` (Dockerfile.api) —
  // `__filename` there ends in `.js`, and the sibling worker module was
  // compiled to `worker.js` by the same `tsc && tsc-alias` build, with every
  // `@/` import already rewritten to a real relative path. Local dev/test
  // runs the raw `.ts` source (package.json's `dev`/`start:prod`/vitest) —
  // `__filename` there ends in `.ts`.
  return __filename.endsWith('.js');
}

function resolveWorkerPath(): string {
  const workerFile = isCompiledBuild() ? 'worker.js' : 'worker.ts';
  return path.join(__dirname, workerFile);
}

/**
 * DEV/TEST ONLY: `--import`-preloads a small custom Node ESM resolve hook
 * that teaches Node's module resolver this project's `@/` -> `src/` path
 * alias, scoped to just this worker thread.
 *
 * This exists because of a real gap this PR's own testing found: `tsx`
 * resolves `@/` for its OWN entry file, but that resolution does NOT
 * propagate into a `worker_threads` Worker spawned from that process — even
 * when the worker's `execArgv` re-imports `tsx` itself. Every module
 * `worker.ts` imports that itself uses `@/` internally (most of this
 * codebase, including `@/utils/logger`) would otherwise fail to load with
 * `ERR_MODULE_NOT_FOUND` in any execution mode that isn't the fully
 * compiled build. See `dev-alias-resolver-hook.mjs`'s own doc for the full
 * empirical investigation and why a hand-written Node `module.register()`
 * hook — not `tsx`, not `module-alias`, not `tsconfig-paths` — is the fix.
 *
 * Returns `[]` for the compiled build: `dist/**\/worker.js` has no `@/`
 * imports left (`tsc-alias` already rewrote them at build time), so the
 * hook would never match anything there — deliberately not shipped to
 * `dist/` at all (these two `.mjs` files are hand-written, never imported by
 * any `.ts` file, so `tsc`'s build has no reason to know about them).
 */
function resolveWorkerExecArgv(): string[] {
  if (isCompiledBuild()) return [];
  const preloadPath = path.join(__dirname, 'dev-alias-resolver-preload.mjs');
  return ['--import', pathToFileURL(preloadPath).href];
}

/**
 * Bounds the worker's OWN V8 isolate heap. Without this, a `new Worker()`
 * does not inherit a scaled-down slice of the main thread's heap budget —
 * it gets its OWN independent V8 isolate whose default old-space ceiling is
 * computed from total system memory, effectively unbounded relative to this
 * container's `--max-old-space-size=3072` (`NODE_OPTIONS`, main thread
 * only). A runaway/looping rebuild in the worker (e.g. a bug that keeps
 * retrying without ever completing, or a pathological catalog growth spike)
 * could then grow the worker's heap independently of, and in addition to,
 * the main thread's own ~2.5-3GB usage — on a container with a single 4GB
 * RSS hard limit (`docker/docker-compose.production.yml`), that is a real
 * path to an uncontrolled OOM-kill of the whole process, not just the
 * worker.
 *
 * Real, MEASURED (not estimated) transient cost of one rebuild cycle,
 * 2026-09-10, against the real production catalog (96,118 non-disabled
 * rows at measurement time — see this PR's description for the full
 * methodology and raw numbers):
 *
 *   - Postgres-fallback fetch path: `prisma.model.findMany(...)` deserializes
 *     the driver's wire rows into plain objects — heapUsed grew from a
 *     ~30MB pre-fetch baseline to ~232MB (raw records) then ~280MB once
 *     `.map(mapPrismaModel)`'s output `Model[]` is also live (both arrays
 *     transiently co-resident, which is the real peak — not a proxy).
 *   - Redis-snapshot fetch path (the normal, cheaper-in-theory path) instead
 *     pays a large `JSON.parse` of the fleet-wide snapshot string —
 *     `JSON.stringify` of the equivalent mapped payload measured 120.38MB
 *     of source text; the parse side of that (source string + the object
 *     graph it decodes into, transiently co-resident) is the more expensive
 *     of the two paths and pushed measured heapUsed to ~521MB at today's
 *     row count.
 *   - `capacity.ts`'s `MAX_MODELS` (200,000) is ~2.1x today's real row
 *     count and is this schema's own designed ceiling, not a hypothetical —
 *     a healthy catalog is expected to grow toward it over time, not stay
 *     at today's snapshot.
 *
 * `maxOldGenerationSizeMb` below is the measured ~521MB Redis-path peak,
 * scaled linearly by that same 2.1x growth ceiling (~1.1GB), rounded up
 * generously for average-metadata-size growth (2026-09-11 audit: 112,140
 * active rows, avg 934 bytes/row, max 13,757 bytes — a fatter average is a
 * realistic future, not a hypothetical) and V8 fragmentation overhead.
 * The Postgres fallback path no longer materializes the whole result set
 * at once (keyset pages of `SAB_CANDIDATE_WORKER_FETCH_PAGE_SIZE` rows, see
 * `postgres-paged-fetch.ts`), which lowers that path's own peak; the Redis
 * path's single `JSON.parse` of the >100 MB snapshot is unchanged.
 * Deliberately kept well under the main thread's own 3072MB ceiling so a
 * worker hitting this limit fails FAST via `worker.on('error')` (`scheduleRespawn`
 * — see below) while the last-good generation keeps serving reads, rather
 * than the worker slowly starving the main thread of the container's shared
 * memory budget first.
 */
function resolveWorkerResourceLimits(): {
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
} {
  return {
    maxOldGenerationSizeMb:
      Number(process.env.SAB_CANDIDATE_WORKER_MAX_OLD_GEN_MB) || 1536,
    maxYoungGenerationSizeMb:
      Number(process.env.SAB_CANDIDATE_WORKER_MAX_YOUNG_GEN_MB) || 256,
  };
}

/**
 * Allocates a full generation's SharedArrayBuffers at a specific effective
 * MAX_MODELS (ADR-028, Layer 1). `maxModels` is normally either `MAX_MODELS`
 * itself (the very first allocation a process ever makes, since there is no
 * live row-count signal yet — see `ensureSabCandidateIndexStarted`) or a
 * value `computeEffectiveMaxModels()` derived from a REAL completed build's
 * row count (see `maybeResizeAfterBuild`). `buildCapacityConfig` is the
 * SAME function `worker.ts` calls with the SAME number (passed via
 * `workerData.effectiveMaxModels`) to independently recompute an identical
 * layout — see that file's own buffer-size mismatch guard.
 */
function allocateState(maxModels: number): ManagerState {
  const capacityConfig = buildCapacityConfig(maxModels);
  const { layout, totalBytes } = computeLayout(capacityConfig);
  const bufferA = new SharedArrayBuffer(totalBytes);
  const bufferB = new SharedArrayBuffer(totalBytes);
  const control = new SharedArrayBuffer(64); // CONTROL_BYTES, see schema.ts
  const controlView = new Int32Array(control);
  Atomics.store(controlView, CONTROL.ACTIVE_GEN, -1); // no generation ready yet
  Atomics.store(controlView, CONTROL.VERSION, 0);
  Atomics.store(controlView, CONTROL.BUILDING_GEN, -1);

  return {
    bufferA,
    bufferB,
    control,
    controlView,
    viewsA: wrapViews(bufferA, layout),
    viewsB: wrapViews(bufferB, layout),
    worker: null,
    genLookupByGen: [null, null],
    rebuildTimer: null,
    respawnTimer: null,
    starting: false,
    stopped: false,
    consecutiveCrashes: 0,
    lastBuildMs: null,
    lastSource: null,
    lastError: null,
    lastFailureReason: null,
    builds: 0,
    buildFailures: 0,
    crashes: 0,
    distinctCapabilities: null,
    effectiveMaxModels: maxModels,
    metadataBlobCapacityBytes: capacityConfig.metadataBlobBytes,
    lastPeakRssBytes: null,
    metadataBlobUsedBytes: null,
  };
}

function handleWorkerMessage(s: ManagerState, msg: WorkerToMainMessage): void {
  // A resize (`scheduleResize`) retires its OLD ManagerState by marking it
  // `stopped` and replacing the module-level `state` with a fresh one
  // BEFORE terminating the old worker — `Worker.terminate()` is async, so a
  // message already in flight from the old worker can still arrive after
  // that swap. Guarding here (rather than only in the 'exit' handler, which
  // already does this) keeps a stale message from a retired generation from
  // mutating a ManagerState nothing reads from anymore, or from triggering a
  // SECOND resize race on top of the one already in progress.
  if (s.stopped) return;
  if (msg.type === 'ready') {
    log.info('sab-candidate-index: worker ready — requesting initial build');
    requestRebuild(s);
    return;
  }
  if (msg.type === 'rebuilt') {
    s.genLookupByGen[msg.gen] = buildGenLookup(msg.meta);
    s.lastBuildMs = msg.buildMs;
    s.lastSource = msg.source;
    s.lastError = null;
    s.lastFailureReason = null;
    s.builds += 1;
    s.distinctCapabilities = msg.meta.distinctCapabilities;
    s.metadataBlobUsedBytes = msg.meta.metadataBlobUsedBytes;
    s.lastPeakRssBytes = msg.peakRssBytes;
    s.consecutiveCrashes = 0; // a successful build resets the crash-loop counter

    // Observability (out-of-scope-turned-in-scope follow-up to
    // getSabCandidateIndexStatus()'s own "can be wired into a health/
    // metrics endpoint later" note) — pushed here rather than polled
    // because this is the exact moment every one of these fields changes.
    sabCandidateIndexBuildsTotal.inc();
    sabCandidateIndexLastBuildMs.set(msg.buildMs);
    sabCandidateIndexLastBuildSource.set(msg.source === 'postgres' ? 1 : 0);
    sabCandidateIndexReady.set(1);
    sabCandidateIndexActiveGen.set(Atomics.load(s.controlView, CONTROL.ACTIVE_GEN));
    sabCandidateIndexVersion.set(Atomics.load(s.controlView, CONTROL.VERSION));
    sabCandidateIndexDistinctCapabilities.set(msg.meta.distinctCapabilities);
    sabCandidateIndexMetadataBlobUsedBytes.set(msg.meta.metadataBlobUsedBytes);
    sabCandidateIndexMaxModelsEffective.set(s.effectiveMaxModels);
    sabCandidateIndexWorkerPeakRssBytes.set(msg.peakRssBytes);
    // Since ADR-028 (Layer 1), 'postgres' is this worker's EXPECTED source on
    // every build by default (SAB_CANDIDATE_WORKER_SOURCE=postgres-only) —
    // no longer a signal that the Redis fleet-wide snapshot is unhealthy, so
    // this no longer warrants a warn-level log on every single rebuild.
    // `lastSource` stays 'redis' only when an operator has explicitly opted
    // back into SAB_CANDIDATE_WORKER_SOURCE=redis-first.
    if (msg.source === 'postgres') {
      log.debug(
        { rowCount: msg.meta.rowCount, buildMs: msg.buildMs },
        'sab-candidate-index: generation built from the Postgres fetch (the default worker source since ADR-028 — see SAB_CANDIDATE_WORKER_SOURCE)'
      );
    }
    log.info(
      {
        gen: msg.gen,
        rowCount: msg.meta.rowCount,
        buildMs: msg.buildMs,
        source: msg.source,
        distinctCapabilities: msg.meta.distinctCapabilities,
        metadataBlobUsedBytes: msg.meta.metadataBlobUsedBytes,
        metadataBlobCapacityBytes: s.metadataBlobCapacityBytes,
        effectiveMaxModels: s.effectiveMaxModels,
        peakRssMb: Math.round(msg.peakRssBytes / (1024 * 1024)),
      },
      'sab-candidate-index: rebuild complete'
    );
    maybeResizeAfterBuild(s, msg.meta.rowCount);
    return;
  }
  if (msg.type === 'rebuild-failed') {
    s.lastError = msg.error;
    s.lastFailureReason = msg.reason;
    s.buildFailures += 1;
    s.lastPeakRssBytes = msg.peakRssBytes;
    sabCandidateIndexBuildFailuresTotal.inc({ reason: msg.reason });
    sabCandidateIndexWorkerPeakRssBytes.set(msg.peakRssBytes);
    const ready = isSabCandidateIndexReady();
    log.error(
      {
        error: msg.error,
        reason: msg.reason,
        ready,
        buildFailures: s.buildFailures,
        peakRssMb: Math.round(msg.peakRssBytes / (1024 * 1024)),
      },
      ready
        ? 'sab-candidate-index: worker reported a failed rebuild — serving last-good generation'
        : 'sab-candidate-index: worker reported a failed rebuild and NO generation has ever been built — selection keeps falling through to the next candidate-retrieval path'
    );
  }
}

/** Exported for the worker-database-url test; the databaseUrl default is the
 *  main thread's early-captured runtime URL, never a later process.env read.
 *  `effectiveMaxModels` defaults to the fixed MAX_MODELS ceiling (matching
 *  this function's pre-ADR-028 behavior) when the caller doesn't pass one —
 *  the worker-database-url test only cares about the buffers/databaseUrl
 *  fields and doesn't need to pass this. */
export function buildSabWorkerData(
  buffers: Pick<ManagerState, 'bufferA' | 'bufferB' | 'control'>,
  databaseUrl: string = getRuntimeDatabaseUrl(),
  effectiveMaxModels: number = MAX_MODELS
): SabWorkerData {
  return {
    bufferA: buffers.bufferA,
    bufferB: buffers.bufferB,
    control: buffers.control,
    databaseUrl,
    effectiveMaxModels,
  };
}

function spawnWorker(s: ManagerState): void {
  if (s.stopped) return;
  const workerData = buildSabWorkerData(s, undefined, s.effectiveMaxModels);
  const worker = new Worker(resolveWorkerPath(), {
    workerData,
    execArgv: resolveWorkerExecArgv(),
    resourceLimits: resolveWorkerResourceLimits(),
  });
  s.worker = worker;

  worker.on('message', (msg: WorkerToMainMessage) => handleWorkerMessage(s, msg));

  worker.on('error', (error) => {
    // Confirmed via investigation/sab-worker-feasibility/worker-crash-test.mjs
    // (PR #531, Finding 2): an uncaught exception inside the worker surfaces
    // here as an 'error' event — it does NOT crash this (main) process. Safe
    // to log, keep serving the last-good generation via the buffers this
    // manager already owns, and respawn.
    log.error({ error: getErrorMessage(error) }, 'sab-candidate-index: worker error — will respawn');
    scheduleRespawn(s);
  });

  worker.on('exit', (code) => {
    if (s.stopped) return; // intentional shutdown (stopSabCandidateIndex) — not a crash
    s.worker = null;
    s.crashes += 1;
    sabCandidateIndexCrashesTotal.inc();
    log.error({ code }, 'sab-candidate-index: worker exited unexpectedly — will respawn');
    scheduleRespawn(s);
  });
}

function scheduleRespawn(s: ManagerState): void {
  if (s.stopped || s.respawnTimer) return; // already scheduled
  s.consecutiveCrashes += 1;
  const delay = RESPAWN_DELAY_MS;
  log.warn(
    { delay, consecutiveCrashes: s.consecutiveCrashes },
    'sab-candidate-index: scheduling worker respawn'
  );
  s.respawnTimer = setTimeout(() => {
    s.respawnTimer = null;
    if (s.stopped) return;
    spawnWorker(s);
  }, delay);
  s.respawnTimer.unref();
}

/** Opt-out for ADR-028's dynamic resize (Layer 1) — read live (not cached),
 *  same convention as `isSabCandidateIndexEnabled()`. Default enabled.
 *  Disabling this does NOT disable dynamic sizing of the very FIRST
 *  allocation a process makes (that always uses the ceiling — see
 *  `ensureSabCandidateIndexStarted`); it only stops `maybeResizeAfterBuild`
 *  from ever reallocating buffers for a running process. Exists mainly for
 *  tests that need a small, fixed-size buffer for the whole test's lifetime
 *  regardless of what row counts they emit through the (possibly fake)
 *  worker — see `manager-rebuild-failed-metrics.test.ts`. */
function isDynamicResizeEnabled(): boolean {
  return process.env.SAB_CANDIDATE_DYNAMIC_RESIZE !== 'false';
}

/** Only grow when the current generation is genuinely running low on
 *  headroom (not merely "not exactly at the freshly-computed ideal size") —
 *  a build that just succeeded already proves the CURRENT capacity was
 *  sufficient, so growing is about staying ahead of FUTURE growth, never
 *  urgent. Only shrink when the current allocation is significantly
 *  oversized relative to what the catalog now needs — a small, constant
 *  difference every rebuild would otherwise thrash (reallocate, respawn,
 *  briefly stop serving) for no real memory benefit. Both are internal
 *  constants rather than env knobs — the margin
 *  (`SAB_CANDIDATE_MAX_MODELS_MARGIN`) is this feature's one operator-facing
 *  tuning lever; these thresholds are an implementation detail of when a
 *  resize fires, not what size it targets. */
const RESIZE_GROW_USAGE_RATIO = 0.9;
const RESIZE_SHRINK_WASTE_RATIO = 0.6;

/**
 * Decides whether the generation that JUST successfully built (row count
 * `rowCount`, current capacity `s.effectiveMaxModels`) should be resized
 * before the NEXT rebuild — ADR-028, Layer 1. A no-op in the overwhelmingly
 * common case (catalog size is roughly stable between rebuilds).
 */
function maybeResizeAfterBuild(s: ManagerState, rowCount: number): void {
  if (!isDynamicResizeEnabled()) return;
  if (s !== state) return; // a resize (or stop) already superseded this state
  const currentCap = s.effectiveMaxModels;
  const desired = computeEffectiveMaxModels(rowCount);

  const atCeiling = currentCap >= MAX_MODELS;
  const usageRatio = currentCap > 0 ? rowCount / currentCap : 1;
  const mustGrow = !atCeiling && desired > currentCap && usageRatio >= RESIZE_GROW_USAGE_RATIO;
  const worthShrinking = desired < currentCap * RESIZE_SHRINK_WASTE_RATIO;

  if (!mustGrow && !worthShrinking) return;
  scheduleResize(s, desired, mustGrow ? 'grow' : 'shrink');
}

/**
 * Reallocates this process's SAB candidate index at a new effective
 * MAX_MODELS and starts a fresh worker against the new buffers — ADR-028,
 * Layer 1. Deliberately a "stop the old, start the new" transition rather
 * than a live three-generation swap: `SharedArrayBuffer`'s own
 * `grow()`/`transfer()` can only extend a single contiguous buffer's END
 * (see capacity.ts's own module doc on why fixed capacity, not a growable
 * buffer, was chosen in the first place) — it cannot re-lay-out a
 * struct-of-arrays schema where every field must grow together, so a real
 * resize needs entirely new buffers, which means a new worker to write into
 * them. During the gap between retiring the old worker and the new one
 * completing its first build, `getSabCandidateModels` returns `null` —
 * exactly the same, already-relied-upon fail-open cold-start contract every
 * caller already handles (`isSabCandidateIndexReady()` false ->
 * `dynamic-model-selector.ts` falls through to the next candidate-retrieval
 * path). This resize path is expected to fire rarely (a handful of times
 * over a long-running replica's life, driven by real catalog growth/shrink
 * crossing the thresholds above — not once per rebuild), so this brief
 * availability gap is an accepted trade-off against the real complexity of
 * a live swap. The NORMAL rebuild path (every cycle that does NOT resize)
 * is completely untouched by this function and keeps its existing
 * zero-downtime double-buffer flip.
 */
function scheduleResize(s: ManagerState, newMaxModels: number, direction: 'grow' | 'shrink'): void {
  if (s.stopped || s !== state) return;
  log.info(
    { from: s.effectiveMaxModels, to: newMaxModels, direction, rowCountCeiling: MAX_MODELS },
    'sab-candidate-index: resizing SharedArrayBuffers for the current catalog size — briefly falls through to the next candidate-retrieval path until the new generation completes its first build'
  );

  if (s.rebuildTimer) clearInterval(s.rebuildTimer);
  if (s.respawnTimer) clearTimeout(s.respawnTimer);
  const oldWorker = s.worker;
  s.stopped = true; // retires this ManagerState — its own 'exit'/'message' handlers become no-ops
  s.worker = null;
  void oldWorker?.terminate();

  const next = allocateState(newMaxModels);
  state = next;
  sabCandidateIndexReady.set(0);
  sabCandidateIndexActiveGen.set(-1);
  sabCandidateIndexVersion.set(0);
  sabCandidateIndexMetadataBlobCapacityBytes.set(next.metadataBlobCapacityBytes);
  sabCandidateIndexMaxModelsEffective.set(next.effectiveMaxModels);
  spawnWorker(next);
  next.rebuildTimer = setInterval(() => requestRebuild(next), REBUILD_INTERVAL_MS);
  next.rebuildTimer.unref();
}

function requestRebuild(s: ManagerState): void {
  if (s.stopped || !s.worker) return;
  try {
    s.worker.postMessage({ type: 'rebuild' });
  } catch (error) {
    // Narrow window between a worker crashing ('error'/'exit' about to fire)
    // and this manager noticing — postMessage on an already-terminated
    // Worker throws. Harmless: the crash handlers below will respawn and the
    // next scheduled tick (or the new worker's own 'ready' message) will
    // successfully request the rebuild instead.
    log.debug({ error: getErrorMessage(error) }, 'sab-candidate-index: rebuild request race with worker teardown — ignoring');
  }
}

/**
 * Requests an out-of-cycle rebuild (in addition to the periodic schedule).
 * A no-op if the index was never started. Not currently wired into
 * `invalidateCatalogCache()` (deliberately out of scope for this PR — the
 * periodic schedule alone matches this PR's "same cadence as the existing
 * catalog cache" requirement) but exported as a small, generally useful
 * primitive: tests use it to deterministically exercise a rebuild without
 * waiting for the periodic timer, and it is a natural, low-risk future hook
 * for a discovery-triggered proactive rebuild.
 */
export function requestSabCandidateIndexRebuild(): void {
  if (!state) return;
  requestRebuild(state);
}

/**
 * Idempotent lazy start — safe to call on every request
 * (`dynamic-model-selector.ts` calls this from the same branch that checks
 * `isSabCandidateIndexEnabled()`). Spawns the worker + starts the periodic
 * rebuild schedule on first call; every subsequent call is a no-op. This
 * mirrors the existing lazy-hydration posture already used throughout this
 * codebase (e.g. `getAllCatalogModels()`'s cold-path resolution) rather than
 * requiring a boot-time wiring change to `index.ts`/`workers/queue-runner.ts`
 * — the worker + its SharedArrayBuffers are only ever allocated in a process
 * that actually has the flag on.
 *
 * ADR-028 (Layer 1): the FIRST allocation a process ever makes always uses
 * the fixed `MAX_MODELS` ceiling — there is no live row-count signal yet to
 * size it any smaller, and `ensureSabCandidateIndexStarted` must stay fully
 * SYNCHRONOUS (no `await` before spawning the worker): it's called
 * fire-and-forget from the request hot path, and several tests
 * (`manager-rebuild-failed-metrics.test.ts`,
 * `sab-worker-concurrent-load-benchmark.test.ts`) assert the worker exists
 * synchronously right after this returns. A separate startup-time
 * `SELECT count(*)` query to pre-size the FIRST allocation was considered
 * and deliberately rejected: it would either have to block that synchronous
 * contract (unacceptable) or race the worker's own first fetch for no real
 * benefit — the first successful build already produces an exact, real row
 * count for free (`GenerationMeta.rowCount`), which `maybeResizeAfterBuild`
 * uses to right-size EVERY subsequent allocation (shrinking away from the
 * ceiling, or growing back toward it) with zero extra queries and zero
 * timing races. See ADR-028 for the full reasoning.
 */
export function ensureSabCandidateIndexStarted(): void {
  if (state && !state.stopped) return;
  if (state?.starting) return;
  const s = allocateState(MAX_MODELS);
  s.starting = true;
  state = s;
  // Explicit initial values (a fresh prom-client Gauge otherwise defaults to
  // 0, which would misleadingly read as "generation 0 active" instead of
  // "not ready yet" — see the -1 sentinel doc on isSabCandidateIndexReady).
  sabCandidateIndexReady.set(0);
  sabCandidateIndexActiveGen.set(-1);
  sabCandidateIndexVersion.set(0);
  sabCandidateIndexMetadataBlobCapacityBytes.set(s.metadataBlobCapacityBytes);
  sabCandidateIndexMaxModelsEffective.set(s.effectiveMaxModels);
  spawnWorker(s);
  s.rebuildTimer = setInterval(() => requestRebuild(s), REBUILD_INTERVAL_MS);
  s.rebuildTimer.unref();
  s.starting = false;
}

/** True once at least one generation has been successfully built (i.e.
 *  `ACTIVE_GEN` has been flipped away from its initial -1 sentinel).
 *  Callers (dynamic-model-selector.ts) treat `false` exactly like a cold
 *  `getCatalogIndices()` — fall through to the next candidate-retrieval
 *  path in the chain, never block/throw waiting for the first build. */
export function isSabCandidateIndexReady(): boolean {
  if (!state) return false;
  return Atomics.load(state.controlView, CONTROL.ACTIVE_GEN) !== -1;
}

/**
 * Synchronous, per-request read. Returns `null` when the index isn't ready
 * yet (never started, or first build not yet complete) — callers MUST treat
 * `null` as "fall back to the next candidate-retrieval path", the same
 * fail-open contract `getFullCacheFairCandidateModels` already has toward a
 * cold `getCatalogIndices()`.
 */
export function getSabCandidateModels(
  criteria: SabCandidateCriteria,
  curatedTake: number,
  aggregatedTake: number,
  curatedMaxProviderShare: number
): FullCacheFairCandidateResult | null {
  if (!state) return null;
  const activeGen = Atomics.load(state.controlView, CONTROL.ACTIVE_GEN);
  if (activeGen !== 0 && activeGen !== 1) return null;
  const gen = state.genLookupByGen[activeGen];
  if (!gen) return null; // ACTIVE_GEN flipped but this process hasn't seen the matching 'rebuilt' message yet (respawn race) — fail open
  const views = activeGen === 0 ? state.viewsA : state.viewsB;
  return getCandidatesFromSharedIndex(views, gen, criteria, curatedTake, aggregatedTake, curatedMaxProviderShare);
}

/** Observability snapshot — used by tests and can be wired into a health/
 *  metrics endpoint later (out of scope for this PR). */
export function getSabCandidateIndexStatus(): {
  started: boolean;
  ready: boolean;
  activeGen: number;
  version: number;
  builds: number;
  buildFailures: number;
  crashes: number;
  lastBuildMs: number | null;
  lastSource: 'redis' | 'postgres' | null;
  lastError: string | null;
  lastFailureReason: RebuildFailureReason | null;
  distinctCapabilities: number | null;
  metadataBlobUsedBytes: number | null;
  metadataBlobCapacityBytes: number;
  /** ADR-028 (Layer 1): the effective MAX_MODELS the currently-allocated
   *  buffers are sized for; `MAX_MODELS` (the fixed design ceiling) before
   *  the index has ever been started. */
  maxModelsEffective: number;
  /** ADR-028 (Layer 3): peak RSS the worker reported for its most recent
   *  rebuild attempt (successful or aborted); `null` before any rebuild has
   *  completed. */
  lastPeakRssBytes: number | null;
} {
  if (!state) {
    return {
      started: false,
      ready: false,
      activeGen: -1,
      version: 0,
      builds: 0,
      buildFailures: 0,
      crashes: 0,
      lastBuildMs: null,
      lastSource: null,
      lastError: null,
      lastFailureReason: null,
      distinctCapabilities: null,
      metadataBlobUsedBytes: null,
      metadataBlobCapacityBytes: buildCapacityConfig(MAX_MODELS).metadataBlobBytes,
      maxModelsEffective: MAX_MODELS,
      lastPeakRssBytes: null,
    };
  }
  return {
    started: true,
    ready: isSabCandidateIndexReady(),
    activeGen: Atomics.load(state.controlView, CONTROL.ACTIVE_GEN),
    version: Atomics.load(state.controlView, CONTROL.VERSION),
    builds: state.builds,
    buildFailures: state.buildFailures,
    crashes: state.crashes,
    lastBuildMs: state.lastBuildMs,
    lastSource: state.lastSource,
    lastError: state.lastError,
    lastFailureReason: state.lastFailureReason,
    distinctCapabilities: state.distinctCapabilities,
    metadataBlobUsedBytes: state.metadataBlobUsedBytes,
    metadataBlobCapacityBytes: state.metadataBlobCapacityBytes,
    maxModelsEffective: state.effectiveMaxModels,
    lastPeakRssBytes: state.lastPeakRssBytes,
  };
}

/** Forces an immediate rebuild request and resolves once it completes
 *  (success or failure) — test-only convenience so correctness/integration
 *  tests don't need to poll `getSabCandidateIndexStatus()` in a loop. Not
 *  used by the request hot path. */
export async function waitForNextBuild(timeoutMs = 30_000): Promise<void> {
  const s = state;
  const worker = s?.worker;
  if (!s || !worker) throw new Error('sab-candidate-index: not started');
  const controlView = s.controlView;
  const startVersion = Atomics.load(controlView, CONTROL.VERSION);
  await new Promise<void>((resolve, reject) => {
    const onMessage = (msg: WorkerToMainMessage): void => {
      if (msg.type === 'rebuilt' || msg.type === 'rebuild-failed') {
        const nowVersion = Atomics.load(controlView, CONTROL.VERSION);
        if (msg.type === 'rebuild-failed' || nowVersion !== startVersion) {
          clearTimeout(timer);
          worker.off('message', onMessage);
          resolve();
        }
      }
    };
    const timer = setTimeout(() => {
      worker.off('message', onMessage);
      reject(new Error(`sab-candidate-index: waitForNextBuild timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    worker.on('message', onMessage);
  });
}

/** Graceful shutdown — test teardown and (optionally, later) process
 *  shutdown hooks. Stops the rebuild schedule and terminates the worker;
 *  does NOT deallocate the SharedArrayBuffers (nothing to do — they are
 *  garbage-collected like any other JS object once `state` is dropped). */
export async function stopSabCandidateIndex(): Promise<void> {
  if (!state) return;
  const s = state;
  s.stopped = true;
  if (s.rebuildTimer) clearInterval(s.rebuildTimer);
  if (s.respawnTimer) clearTimeout(s.respawnTimer);
  if (s.worker) {
    await s.worker.terminate();
  }
  state = null;
}

/** Test-only: force a specific worker instance to be replaced (simulates a
 *  crash without actually throwing inside the worker), used by
 *  `sab-worker-concurrent-load-benchmark.test.ts`'s crash/respawn case. Not
 *  part of the module's public surface used by production code. */
export function __testOnlyKillWorkerForRespawnTest(): Worker | null {
  if (!state?.worker) return null;
  const killed = state.worker;
  void killed.terminate();
  return killed;
}
