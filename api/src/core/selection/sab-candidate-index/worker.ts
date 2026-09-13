// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Production worker_threads entry point for the SharedArrayBuffer-backed
 * candidate index (`SELECTION_USE_SAB_CANDIDATE_INDEX`). See `manager.ts`
 * for the main-thread half (spawn/respawn, scheduling, the read API) and
 * `encode.ts`/`reader.ts`/`schema.ts` for the shared encode/decode logic
 * this worker and the main thread's reader both depend on.
 *
 * ── THE SINGLE MOST IMPORTANT CONSTRAINT IN THIS FILE ──────────────────────
 * This worker fetches catalog rows itself, via its OWN direct Postgres/Redis
 * connections constructed INSIDE this file. It must NEVER receive the raw
 * row array from the main thread via `postMessage`.
 *
 * `investigation/sab-worker-feasibility/postmessage-cost.mjs` (PR #531)
 * measured this directly: structured-clone-serializing 111,666 plain
 * objects for a single `postMessage` call blocks the MAIN thread for
 * 1.2-1.7 SECONDS — comparable to or worse than the very problem this
 * design exists to solve. It is also the single easiest, most
 * natural-looking way to get this wrong ("the main thread already has a
 * warm catalog cache, just pass it to the worker" reads as obviously
 * correct and is not). `manager.ts` only ever sends this worker a
 * zero-payload `{ type: 'rebuild' }` signal — never rows.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ── Prisma Client + worker_threads (task-required investigation) ──────────
 * A `PrismaClient` instance cannot be shared as a live object across a
 * worker_threads boundary — like any object wrapping native bindings/sockets,
 * it is not structured-clone-able, so neither `postMessage` nor `workerData`
 * can carry one, and neither this file nor `manager.ts` attempts to. The
 * CORRECT pattern — used here — is for each worker thread to construct its
 * OWN independent `PrismaClient`, with its OWN connection pool. This falls
 * out naturally from how `worker_threads` actually works: every `Worker`
 * gets a fresh module registry, so importing a module from inside a worker
 * file does NOT reuse whatever the main thread already instantiated from
 * that same module — it silently re-runs the module's top-level code in the
 * worker's own realm. That is exactly what "own direct DB connection"
 * requires, but it comes with a real, easy-to-miss cost if done carelessly:
 * `@/database/client`'s shared `prisma` singleton defaults its pool to
 * `config.database.poolMax` (30 connections in production) — importing THAT
 * module from inside this worker would silently add a SECOND full-size pool
 * per replica on top of the main thread's own, compounding the exact
 * connection-budget risk ADR-026 already flags (`DB_POOL_MAX`/replica × 2
 * replicas + 1 worker ≈ 300 vs Postgres's `max_connections=200`).
 *
 * This file therefore does NOT import `@/database/client`. It constructs its
 * own minimal `PrismaClient` with a SMALL, dedicated pool
 * (`WORKER_DB_POOL_MAX` below) — appropriate because this Postgres path is a
 * low-QPS FALLBACK (see the Redis-first fetch order below), never the
 * request hot path, and never runs more than one query at a time (rebuilds
 * are serialized — see `manager.ts`'s scheduler).
 *
 * ── Fetch order: Redis first, Postgres fallback ────────────────────────────
 * Reads the SAME fleet-wide snapshot key (`CATALOG_REDIS_KEY`,
 * `@/services/catalog-hot-path`) the existing `catalog-cache-refresh` BullMQ
 * job already elects ONE process fleet-wide to publish
 * (`model-catalog-service.ts`). This is a deliberate choice over having
 * every replica's SAB worker hit Postgres independently on its own timer,
 * which would reintroduce the exact "N replicas each hit Postgres for the
 * same full-catalog query" multiplication bug that mechanism was built to
 * fix (see that file's own module doc). Falls back to a direct Postgres
 * query (same `CATALOG_HOT_PATH_SELECT` allowlist + `mapPrismaModel`
 * mapping model-catalog-service.ts's own cold path uses, imported from
 * `@/services/catalog-hot-path` specifically so this file's module graph
 * never needs `@/database/client`) only when Redis has nothing published
 * yet or is unreachable — same fail-open posture as
 * `resolveColdCatalog`/`hydrateCatalogCacheFromRedis`.
 */
import { parentPort, workerData } from 'node:worker_threads';
// Deliberately a RELATIVE import, not `@/generated/prisma/index.js` like
// every other Prisma-client import in this codebase (e.g.
// `database/client.ts`). `api/tsconfig.json` excludes `src/generated/**/*`
// from compilation, so `tsc-alias` (the `pnpm build` step that rewrites
// every other `@/`-aliased import below to a real relative path) never sees
// this specifier and leaves it untouched as the literal string
// `@/generated/prisma/index.js` in the compiled `worker.js`. The main
// thread survives that because `app.cjs`'s `module-alias` bootstrap
// (`addAliases({ '@': distDir, ... })`) patches `require()` to resolve it
// anyway — but this file is spawned directly via
// `new Worker(path.join(__dirname, 'worker.js'))` (`manager.ts`'s
// `resolveWorkerPath()`), which never runs `app.cjs`, so `module-alias` is
// never installed in this worker thread and the literal alias specifier
// fails with `Cannot find module '@/generated/prisma/index.js'`. This is
// exactly the error the reverted `SELECTION_USE_SAB_CANDIDATE_INDEX`
// production canary crash-looped on. See ADR-027's "A second real bug: the
// compiled build was NOT actually alias-free" section for the full root
// cause and the confirmed `dist/` layout this relative path depends on
// (`dist/core/selection/sab-candidate-index/worker.js` -> `../../../` ->
// `dist/` -> `generated/prisma/index.js`, copied there by `api/Dockerfile`'s
// "Setting up Prisma generated files" build step).
import { PrismaClient } from '../../../generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import type { Model } from '@/types';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { getRedisClient } from '@/cache/redis-client';
import { CATALOG_HOT_PATH_SELECT, CATALOG_REDIS_KEY } from '@/services/catalog-hot-path';
import { computeLayout, wrapViews, CONTROL } from './schema';
import { encodeGeneration, SabEncodeCapacityError } from './encode';
import {
  fetchCatalogModelsPaged,
  DEFAULT_POSTGRES_FETCH_PAGE_SIZE,
  type CatalogPageQuerier,
} from './postgres-paged-fetch';
import type {
  MainToWorkerMessage,
  RebuildFailureReason,
  SabWorkerData,
  WorkerToMainMessage,
} from './types';
import { resolveWorkerDatabaseUrl } from './worker-database-url';

const log = logger.child({ component: 'sab-candidate-index-worker' });

// Deliberately tiny — see this file's module doc. The rebuild path never
// runs more than one query concurrently (manager.ts serializes rebuild
// requests), so this pool never needs more than a single live connection;
// `max: 2` leaves one spare for a graceful handover during a slow query
// rather than queueing behind it.
const WORKER_DB_POOL_MAX = Number(process.env.SAB_CANDIDATE_WORKER_DB_POOL_MAX) || 2;

/** Rows per keyset page on the Postgres fallback (see
 *  `postgres-paged-fetch.ts`). ~5 MB of wire payload per page at today's
 *  average row size. */
const WORKER_POSTGRES_PAGE_SIZE =
  Number(process.env.SAB_CANDIDATE_WORKER_FETCH_PAGE_SIZE) || DEFAULT_POSTGRES_FETCH_PAGE_SIZE;

/** Per-page backend ceiling. The main pool's URL carries
 *  `statement_timeout=30000` (`database/client.ts`); this worker's own pool
 *  is built from the raw `DATABASE_URL`, which in production has none, so
 *  the previous full-table query had no server-side bound at all. Applied
 *  with `SET LOCAL` inside the page's transaction (same pattern as
 *  `getCuratedBucketSnapshot` in dynamic-model-selector.ts), which also
 *  works behind pgbouncer transaction pooling. */
const WORKER_STATEMENT_TIMEOUT_MS =
  Number(process.env.SAB_CANDIDATE_WORKER_STATEMENT_TIMEOUT_MS) || 15_000;

/** Bound on the Redis snapshot read. `redis-client.ts` never gives up
 *  reconnecting outside NODE_ENV=test (`maxRetriesPerRequest: null`), so a
 *  Redis outage in production would otherwise leave `redis.get` pending
 *  forever, `rebuildInFlight` stuck true, and every later rebuild request
 *  silently ignored. */
const WORKER_REDIS_TIMEOUT_MS = Number(process.env.SAB_CANDIDATE_WORKER_REDIS_TIMEOUT_MS) || 10_000;

/** Kill switch for the direct Postgres fallback. Default on (unchanged
 *  behavior). Set to `false` on a deployment whose Postgres cannot afford
 *  even the paged scan (the 2026-09-11 `ci_db` OOM incident): the worker
 *  then reports `rebuild-failed{reason="fetch"}` and waits for the elected
 *  `catalog-cache-refresh` job to republish the Redis snapshot, while the
 *  last-good generation keeps serving. */
const WORKER_POSTGRES_FALLBACK_ENABLED = process.env.SAB_CANDIDATE_WORKER_POSTGRES_FALLBACK !== 'false';

/** Distinguishes "could not read the catalog" from encode-side capacity
 *  errors when classifying `rebuild-failed{reason}`. */
class SabFetchError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let workerPrisma: PrismaClient | null = null;
function getWorkerPrisma(): PrismaClient {
  if (!workerPrisma) {
    const pool = new pg.Pool({
      connectionString: resolveWorkerDatabaseUrl(workerData as SabWorkerData),
      max: WORKER_DB_POOL_MAX,
      min: 0,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 20_000,
    });
    pool.on('error', (error: unknown) => {
      log.warn({ error: getErrorMessage(error) }, 'sab-candidate-index worker: pg pool error');
    });
    const adapter = new PrismaPg(pool);
    workerPrisma = new PrismaClient({ adapter });
  }
  return workerPrisma;
}

// Same allowlist the fleet-wide snapshot uses, plus the PK the keyset
// cursor needs (mapPrismaModel ignores it).
const WORKER_POSTGRES_SELECT = { ...CATALOG_HOT_PATH_SELECT, uid: true } as const;

function createPrismaPageQuerier(prisma: PrismaClient): CatalogPageQuerier {
  return {
    fetchPage: (afterUid, take) =>
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${WORKER_STATEMENT_TIMEOUT_MS}`);
          return tx.model.findMany({
            where: {
              status: { not: 'disabled' },
              ...(afterUid !== null ? { uid: { gt: afterUid } } : {}),
            },
            orderBy: { uid: 'asc' },
            take,
            select: WORKER_POSTGRES_SELECT,
          });
        },
        {
          // Prisma's interactive-transaction default (5 s) would expire the
          // page before the server-side statement_timeout above ever fires;
          // the server bound is the one that should win.
          timeout: WORKER_STATEMENT_TIMEOUT_MS + 5_000,
          maxWait: 10_000,
        }
      ),
  };
}

/** Redis-first, Postgres-fallback fetch — see this file's module doc. A
 *  Redis failure falls through to Postgres; a Postgres failure (or a
 *  disabled fallback) throws `SabFetchError`, which `runRebuild` reports as
 *  `rebuild-failed{reason="fetch"}` rather than crashing the worker (see
 *  Finding 2 of the feasibility investigation: a worker crash does not
 *  take down the main process, but there is no reason to crash the WORKER
 *  either when the existing generation can keep serving reads). */
async function fetchCatalogModels(): Promise<{ models: Model[]; source: 'redis' | 'postgres' }> {
  let redisFailure: string | null = null;
  try {
    const redis = getRedisClient();
    const raw = await withTimeout(redis.get(CATALOG_REDIS_KEY), WORKER_REDIS_TIMEOUT_MS, 'Redis snapshot read');
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { models: parsed as Model[], source: 'redis' };
      }
    }
    redisFailure = 'snapshot key empty';
  } catch (error) {
    redisFailure = getErrorMessage(error);
    log.debug(
      { error: redisFailure },
      'sab-candidate-index worker: Redis fetch failed or empty — falling back to direct Postgres query'
    );
  }

  if (!WORKER_POSTGRES_FALLBACK_ENABLED) {
    throw new SabFetchError(
      `Redis snapshot unavailable (${redisFailure}) and the Postgres fallback is disabled ` +
        `(SAB_CANDIDATE_WORKER_POSTGRES_FALLBACK=false) — waiting for the fleet-wide snapshot to be republished`
    );
  }

  try {
    const { models, pages } = await fetchCatalogModelsPaged(
      createPrismaPageQuerier(getWorkerPrisma()),
      WORKER_POSTGRES_PAGE_SIZE
    );
    log.debug(
      { rows: models.length, pages, pageSize: WORKER_POSTGRES_PAGE_SIZE },
      'sab-candidate-index worker: Postgres fallback fetch complete'
    );
    return { models, source: 'postgres' };
  } catch (error) {
    throw new SabFetchError(`Postgres fallback fetch failed: ${getErrorMessage(error)}`);
  }
}

const { layout, totalBytes } = computeLayout();
const data = workerData as SabWorkerData;
if (data.bufferA.byteLength !== totalBytes || data.bufferB.byteLength !== totalBytes) {
  // The manager allocates buffers sized by the SAME computeLayout() this
  // worker also calls — a mismatch means the worker and manager were built
  // from different versions of schema.ts/capacity.ts (e.g. a stale
  // respawned worker after a hot capacity-env change), which would silently
  // corrupt memory if allowed to proceed.
  throw new Error(
    `sab-candidate-index worker: buffer size mismatch (worker computed ${totalBytes} bytes, ` +
      `received bufferA=${data.bufferA.byteLength} bufferB=${data.bufferB.byteLength}) — refusing to start`
  );
}
const viewsA = wrapViews(data.bufferA, layout);
const viewsB = wrapViews(data.bufferB, layout);
const controlView = new Int32Array(data.control);

function postToMain(message: WorkerToMainMessage): void {
  parentPort?.postMessage(message);
}

let rebuildInFlight = false;

async function runRebuild(): Promise<void> {
  if (rebuildInFlight) {
    // manager.ts already serializes rebuild requests (it waits for
    // 'rebuilt'/'rebuild-failed' before scheduling the next one), but this
    // guard makes the invariant structural rather than relying solely on
    // caller discipline.
    log.debug('sab-candidate-index worker: rebuild already in flight — ignoring duplicate request');
    return;
  }
  rebuildInFlight = true;
  const buildStart = performance.now();
  try {
    const { models, source } = await fetchCatalogModels();

    const activeGen = Atomics.load(controlView, CONTROL.ACTIVE_GEN);
    const targetGen: 0 | 1 = activeGen === 0 ? 1 : 0; // always write into the INACTIVE slot
    Atomics.store(controlView, CONTROL.BUILDING_GEN, targetGen);

    const targetViews = targetGen === 0 ? viewsA : viewsB;
    const meta = encodeGeneration(models, targetViews);

    // Publish: every plain (non-atomic) typed-array write above must become
    // visible to the main thread's reads BEFORE it can observe the new
    // ACTIVE_GEN value — see schema.ts's CONTROL doc for the release/acquire
    // reasoning this ordering depends on.
    Atomics.store(controlView, targetGen === 0 ? CONTROL.ROW_COUNT_0 : CONTROL.ROW_COUNT_1, meta.rowCount);
    Atomics.store(controlView, CONTROL.ACTIVE_GEN, targetGen);
    Atomics.add(controlView, CONTROL.VERSION, 1);
    Atomics.store(controlView, CONTROL.BUILDING_GEN, -1);

    const buildMs = performance.now() - buildStart;
    postToMain({ type: 'rebuilt', gen: targetGen, meta, buildMs, source });
  } catch (error) {
    Atomics.store(controlView, CONTROL.BUILDING_GEN, -1);
    let reason: RebuildFailureReason = 'other';
    let message = getErrorMessage(error);
    if (error instanceof SabEncodeCapacityError) {
      reason = 'capacity';
      message = `capacity error: ${error.message}`;
    } else if (error instanceof SabFetchError) {
      reason = 'fetch';
    }
    log.error({ error: message, reason }, 'sab-candidate-index worker: rebuild failed — keeping last-good generation');
    postToMain({ type: 'rebuild-failed', error: message, reason });
  } finally {
    rebuildInFlight = false;
  }
}

if (!parentPort) {
  throw new Error('sab-candidate-index worker: must be run as a worker_thread (parentPort is null)');
}

parentPort.on('message', (msg: MainToWorkerMessage) => {
  if (msg.type === 'rebuild') {
    void runRebuild();
  }
});

postToMain({ type: 'ready' });
