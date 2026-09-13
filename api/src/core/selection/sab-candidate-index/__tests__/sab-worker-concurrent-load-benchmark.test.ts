// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Real, DB-backed concurrent-load benchmark for the SAB candidate index —
 * same pattern as the investigation's own methodology
 * (`investigation/sab-worker-feasibility/bench.mjs`, PR #531) and ADR-026's
 * verification section (`full-cache-index-concurrent-load-benchmark-db.test.ts`,
 * PR #523): a REAL Testcontainers-provisioned Postgres, seeded with the
 * real production catalog SHAPE (111,666 rows: 37,629 curated across 95
 * providers, 73,782 aggregated/HF-index, 255 structurally-invisible orphan
 * rows — see `full-cache-index-benchmark.test.ts`'s own module doc for where
 * these exact numbers come from), driving the REAL, shipped
 * `getFullCacheFairCandidateModels` (the current default-OFF flag this PR's
 * design supersedes) against a REAL production worker (`worker.ts` via
 * `manager.ts`) that does its own real Postgres fallback fetch (Redis is
 * deliberately left unreachable in this test — see `REDIS_HOST` below — so
 * every worker rebuild is forced through the Postgres path, the more
 * expensive of the two, making this benchmark's numbers a conservative,
 * not favorable, measurement of the worker's own rebuild cost).
 *
 * This is a SELF-CONTAINED test file (its own `PostgreSqlContainer`
 * lifecycle, not `tests/global-setup.ts`'s heavier harness) so it can be run
 * standalone:
 *
 *   pnpm exec vitest run --config vitest.ci.config.ts \
 *     src/core/selection/sab-candidate-index/__tests__/sab-worker-concurrent-load-benchmark.test.ts
 *
 * ── What "N concurrent" means for synchronous, in-process work ────────────
 * Both `getFullCacheFairCandidateModels` and `getSabCandidateModels` are
 * fully synchronous — no `await` inside either. On Node's single JS thread,
 * N real concurrent HTTP requests hitting the same synchronous code path
 * are NOT actually interleaved; they are serialized back-to-back on the
 * event loop, exactly as ADR-026's own benchmark measured. This test
 * therefore measures N synchronous calls run back-to-back (same convention
 * as `investigation/sab-worker-feasibility/bench.mjs`), together with a
 * REAL event-loop-lag probe (a continuous `setImmediate` chain measuring its
 * own scheduling delay — direct proof of event-loop blockage, not an
 * inference from the batch's own reported duration) running THROUGHOUT each
 * batch, which is the load-bearing evidence: a probe delay that tracks the
 * batch's wall-clock almost exactly means the event loop was unavailable to
 * every OTHER in-flight request for that whole duration (the Map path's
 * failure mode); a probe delay that stays near-zero regardless of batch
 * size means it wasn't (the SAB path's claim).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TEST_TIMEOUT_MS = 10 * 60_000; // container boot + migrations + 111,666-row seed + benchmark

function computeModelUid(providerId: string, modelId: string): string {
  return createHash('md5').update(`${providerId}:${modelId}`).digest('hex').substring(0, 25);
}

async function applyMigrations(connectionString: string, projectRoot: string): Promise<void> {
  const client = new PgClient({ connectionString });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public');
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
    } catch {
      // optional — some migrations may not need it
    }
    const migrationsDir = path.resolve(projectRoot, 'prisma', 'migrations');
    const entries = await readdir(migrationsDir, { withFileTypes: true });
    const migrations = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const migration of migrations) {
      const sqlPath = path.resolve(migrationsDir, migration, 'migration.sql');
      const sql = await readFile(sqlPath, 'utf-8');
      if (!sql.trim()) continue;
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

/** Real per-provider curated-bucket breakdown — same real-prod shape used
 *  throughout this PR's test suite (full-cache-index-benchmark.test.ts,
 *  encode-reader-correctness.test.ts). */
const NAMED_CURATED_PROVIDERS: Array<[string, number]> = [
  ['featherless-ai', 22_144],
  ['orqai', 1_464],
  ['aiml', 1_292],
  ['nanogpt', 1_013],
  ['requesty', 879],
  ['openai', 136],
  ['cohere', 35],
  ['xai', 21],
  ['anthropic', 15],
  ['google', 12],
  ['deepseek', 3],
];

interface SeedModelRow {
  uid: string;
  id: string;
  providerId: string;
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
  capabilities: string[];
  performance: Record<string, number>;
  status: string;
  metadata: Record<string, unknown>;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function buildProvidersAndModels(): { providerIds: string[]; models: SeedModelRow[] } {
  const providerIds = new Set<string>();
  const models: SeedModelRow[] = [];

  function pushCurated(id: string, providerName: string) {
    const providerId = `${providerName}-provider-id`;
    providerIds.add(providerId);
    const h = hashStr(id);
    const capabilities = ['chat'];
    if (h % 100 < 4) capabilities.push('reasoning');
    if (h % 100 < 3) capabilities.push('vision');
    models.push({
      uid: computeModelUid(providerId, id),
      id,
      providerId,
      name: id,
      displayName: id,
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      inputCostPer1k: 0.01,
      outputCostPer1k: 0.03,
      capabilities,
      performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.99 },
      status: 'active',
      metadata: {},
    });
  }

  let namedTotal = 0;
  for (const [provider, count] of NAMED_CURATED_PROVIDERS) {
    namedTotal += count;
    for (let i = 0; i < count; i++) pushCurated(`${provider}-${i}`, provider);
  }
  const remainingProviders = 95 - NAMED_CURATED_PROVIDERS.length;
  const remainingRows = 37_629 - namedTotal;
  const perTail = Math.floor(remainingRows / remainingProviders);
  for (let p = 0; p < remainingProviders; p++) {
    const providerName = `long-tail-provider-${p}`;
    const rows = p === remainingProviders - 1 ? remainingRows - perTail * (remainingProviders - 1) : perTail;
    for (let i = 0; i < rows; i++) pushCurated(`${providerName}-${i}`, providerName);
  }

  const hfProviderId = 'huggingface-provider-id';
  providerIds.add(hfProviderId);
  for (let i = 0; i < 73_782; i++) {
    const id = `hf-${i}`;
    const h = hashStr(id);
    const capabilities = ['chat'];
    if (h % 100 < 4) capabilities.push('reasoning');
    models.push({
      uid: computeModelUid(hfProviderId, id),
      id,
      providerId: hfProviderId,
      name: id,
      displayName: id,
      contextWindow: 32_000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.002,
      capabilities,
      performance: { latencyMs: 800, throughput: 50, quality: 0.6, reliability: 0.9 },
      status: 'active',
      metadata: { serverless_callable: true, hubInventoryClass: 'aggregated_index' },
    });
  }

  const orphanProviderId = 'orphan-provider-provider-id';
  providerIds.add(orphanProviderId);
  for (let i = 0; i < 255; i++) {
    const id = `orphan-${i}`;
    models.push({
      uid: computeModelUid(orphanProviderId, id),
      id,
      providerId: orphanProviderId,
      name: id,
      displayName: id,
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      inputCostPer1k: 0.01,
      outputCostPer1k: 0.03,
      capabilities: ['chat'],
      performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.99 },
      status: 'active',
      metadata: { hubInventoryClass: 'aggregated_index' },
    });
  }

  return { providerIds: [...providerIds], models };
}

async function seedDatabase(connectionString: string): Promise<number> {
  const client = new PgClient({ connectionString });
  await client.connect();
  try {
    const { providerIds, models } = buildProvidersAndModels();

    // Providers — small (~97 rows), single multi-row INSERT is fine.
    // `updated_at` has no DB-level default (Prisma's @updatedAt is applied by
    // the Prisma Client at write time, not a Postgres column default) — this
    // raw SQL seed bypasses Prisma entirely, so it must set both timestamps
    // explicitly or violate the NOT NULL constraint.
    const providerValues: string[] = [];
    const providerParams: unknown[] = [];
    providerIds.forEach((id, i) => {
      const base = i * 3;
      providerValues.push(`($${base + 1}, $${base + 2}, $${base + 3}, now())`);
      providerParams.push(id, id, id);
    });
    await client.query(
      `INSERT INTO providers (id, name, display_name, updated_at) VALUES ${providerValues.join(',')}`,
      providerParams
    );

    // Models — 111,666 rows, batched (Postgres bind-param limit is 65535;
    // 10 columns/row keeps a wide margin at 2000 rows/batch = 20,000 params).
    const BATCH_SIZE = 2000;
    for (let start = 0; start < models.length; start += BATCH_SIZE) {
      const batch = models.slice(start, start + BATCH_SIZE);
      const values: string[] = [];
      const params: unknown[] = [];
      batch.forEach((m, i) => {
        const base = i * 11;
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, now())`
        );
        params.push(
          m.uid,
          m.id,
          m.providerId,
          m.name,
          m.displayName,
          m.contextWindow,
          m.maxOutputTokens,
          m.inputCostPer1k,
          m.outputCostPer1k,
          JSON.stringify(m.capabilities),
          JSON.stringify(m.metadata)
        );
      });
      await client.query(
        `INSERT INTO models (uid, id, provider_id, name, display_name, context_window, max_output_tokens, input_cost_per_1k, output_cost_per_1k, capabilities, metadata, updated_at)
         VALUES ${values.join(',')}`,
        params
      );
    }
    return models.length;
  } finally {
    await client.end();
  }
}

/** Event-loop-lag probe — a continuous setImmediate chain measuring its own
 *  scheduling delay against wall-clock expectation. Same methodology as
 *  ADR-026's own benchmark and the feasibility investigation's bench.mjs.
 *  Returns a stop function yielding the max observed delay (ms). */
function startEventLoopLagProbe(): () => number {
  let maxDelay = 0;
  let stopped = false;
  let last = performance.now();
  function tick() {
    if (stopped) return;
    const now = performance.now();
    const delay = now - last;
    if (delay > maxDelay) maxDelay = delay;
    last = now;
    setImmediate(tick);
  }
  setImmediate(tick);
  return () => {
    stopped = true;
    return maxDelay;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

describe('SAB candidate index — real DB-backed concurrent-load benchmark', () => {
  let container: StartedPostgreSqlContainer;
  let rowCount: number;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('ailin_sab_bench')
      .withUsername('ailin')
      .withPassword('ailin')
      .start();

    const connectionString = container.getConnectionUri();
    process.env.DATABASE_URL = connectionString;
    // Force the Redis-first fetch (both the worker's and the shared
    // getRedisClient() the Map-path benchmark below indirectly touches via
    // model-catalog-service's Redis snapshot publish) to fail FAST and fall
    // through to Postgres deterministically — port 1 on localhost refuses
    // immediately rather than timing out on an unreachable host.
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = '1';

    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
    await applyMigrations(connectionString, projectRoot);
    rowCount = await seedDatabase(connectionString);
    expect(rowCount).toBe(111_666);

    const { recreatePrismaClient } = await import('@/database/client');
    recreatePrismaClient();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    const { stopSabCandidateIndex } = await import('../manager');
    await stopSabCandidateIndex();
    const { disconnectDatabase } = await import('@/database/client');
    await disconnectDatabase();
    await container.stop();
  }, 60_000);

  it(
    'SAB worker builds a real generation from the real seeded Postgres (via its own Postgres-fallback path, Redis deliberately unreachable)',
    async () => {
      const { ensureSabCandidateIndexStarted, waitForNextBuild, getSabCandidateIndexStatus } = await import(
        '../manager'
      );
      ensureSabCandidateIndexStarted();
      await waitForNextBuild(120_000);
      const status = getSabCandidateIndexStatus();
      expect(status.ready).toBe(true);
      expect(status.lastSource).toBe('postgres'); // Redis is unreachable by design in this test
      expect(status.lastError).toBeNull();
      // eslint-disable-next-line no-console
      console.info(
        `[sab-worker-concurrent-load-benchmark] first real build from Postgres: ${status.lastBuildMs?.toFixed(2)}ms, ${rowCount} rows`
      );
    },
    120_000
  );

  it(
    'N=1..500 concurrent-equivalent reads: SAB path matches or beats the Map path\'s wall-clock/event-loop numbers at every N, without blocking the event loop',
    async () => {
      const { getSabCandidateModels } = await import('../manager');
      const { getFullCacheFairCandidateModels } = await import('@/core/selection/dynamic-model-selector');
      const { getAllCatalogModels, invalidateCatalogCache } = await import('@/services/model-catalog-service');

      invalidateCatalogCache();
      const hydrateStart = performance.now();
      const models = await getAllCatalogModels();
      const hydrateMs = performance.now() - hydrateStart;
      expect(models.length).toBe(111_666);
      // eslint-disable-next-line no-console
      console.info(`[sab-worker-concurrent-load-benchmark] Map-path catalog hydrate+index build: ${hydrateMs.toFixed(2)}ms`);

      const CRITERIA = { contextSize: 1000 } as const;
      const CURATED_TAKE = 400;
      const AGGREGATED_TAKE = 300;
      const MAX_PROVIDER_SHARE = 0.15;

      const Ns = [1, 10, 50, 100, 300, 500];
      const results: Array<{
        n: number;
        mapWallMs: number;
        mapP50Ms: number;
        mapMaxLagMs: number;
        sabWallMs: number;
        sabP50Ms: number;
        sabMaxLagMs: number;
      }> = [];

      for (const n of Ns) {
        // ── Map path (current SELECTION_USE_FULL_CACHE_INDEX default-OFF path) ──
        {
          const stopProbe = startEventLoopLagProbe();
          const perCall: number[] = [];
          const wallStart = performance.now();
          for (let i = 0; i < n; i++) {
            const callStart = performance.now();
            const result = getFullCacheFairCandidateModels(
              CRITERIA,
              CURATED_TAKE,
              AGGREGATED_TAKE,
              MAX_PROVIDER_SHARE
            );
            perCall.push(performance.now() - callStart);
            expect(result.models.length).toBeGreaterThan(0);
            // yield to the event loop between calls so the lag probe's
            // setImmediate chain actually gets a chance to run BETWEEN
            // synchronous scans (same as real Node request handling, where
            // each incoming request is its own macrotask) — without this,
            // a tight synchronous for-loop would never yield at all and the
            // probe would report a single giant gap only at the very end.
            await new Promise((resolve) => setImmediate(resolve));
          }
          const wallMs = performance.now() - wallStart;
          const maxLagMs = stopProbe();
          perCall.sort((a, b) => a - b);
          results.push({
            n,
            mapWallMs: wallMs,
            mapP50Ms: percentile(perCall, 50),
            mapMaxLagMs: maxLagMs,
            sabWallMs: 0,
            sabP50Ms: 0,
            sabMaxLagMs: 0,
          });
        }

        // ── SAB path ──────────────────────────────────────────────────────
        {
          const stopProbe = startEventLoopLagProbe();
          const perCall: number[] = [];
          const wallStart = performance.now();
          for (let i = 0; i < n; i++) {
            const callStart = performance.now();
            const result = getSabCandidateModels(CRITERIA, CURATED_TAKE, AGGREGATED_TAKE, MAX_PROVIDER_SHARE);
            perCall.push(performance.now() - callStart);
            expect(result).not.toBeNull();
            expect(result?.models.length ?? 0).toBeGreaterThan(0);
            await new Promise((resolve) => setImmediate(resolve));
          }
          const wallMs = performance.now() - wallStart;
          const maxLagMs = stopProbe();
          perCall.sort((a, b) => a - b);
          const last = results[results.length - 1];
          last.sabWallMs = wallMs;
          last.sabP50Ms = percentile(perCall, 50);
          last.sabMaxLagMs = maxLagMs;
        }
      }

      // eslint-disable-next-line no-console
      console.table(
        results.map((r) => ({
          N: r.n,
          'Map wall (ms)': r.mapWallMs.toFixed(1),
          'Map p50 (ms)': r.mapP50Ms.toFixed(3),
          'Map max event-loop lag (ms)': r.mapMaxLagMs.toFixed(1),
          'SAB wall (ms)': r.sabWallMs.toFixed(1),
          'SAB p50 (ms)': r.sabP50Ms.toFixed(3),
          'SAB max event-loop lag (ms)': r.sabMaxLagMs.toFixed(1),
        }))
      );

      const n500 = results.find((r) => r.n === 500);
      expect(n500).toBeDefined();
      if (n500) {
        // The headline claim: at the highest tested concurrency, the SAB
        // path's wall-clock AND its event-loop-lag must both be strictly
        // better than the Map path's — not just "not worse", the whole
        // point of this architecture. Bounds are generous (CI-machine
        // variance) — the qualitative claim (which this test would fail to
        // prove otherwise) is what matters, not a specific multiplier.
        expect(n500.sabWallMs).toBeLessThan(n500.mapWallMs);
        expect(n500.sabMaxLagMs).toBeLessThan(n500.mapMaxLagMs);
        // The SAB path's own max event-loop lag should stay low in absolute
        // terms (not just relative to the Map path) — this is the actual
        // "does not block the event loop" claim, not a relative one.
        expect(n500.sabMaxLagMs).toBeLessThan(500);
      }
    },
    5 * 60_000
  );

  it(
    'reads stay fast and correct WHILE a full rebuild runs concurrently on the worker thread',
    async () => {
      const { getSabCandidateModels, waitForNextBuild, requestSabCandidateIndexRebuild, ensureSabCandidateIndexStarted } =
        await import('../manager');
      ensureSabCandidateIndexStarted();

      // Fire an explicit out-of-cycle rebuild but do not await it — reads
      // below race against it. (The periodic schedule alone would not fire
      // again within this test's lifetime — its default interval is
      // minutes, not seconds.)
      const rebuildPromise = waitForNextBuild(120_000);
      requestSabCandidateIndexRebuild();

      const CRITERIA = { contextSize: 1000 } as const;
      const perCall: number[] = [];
      for (let i = 0; i < 500; i++) {
        const start = performance.now();
        const result = getSabCandidateModels(CRITERIA, 400, 300, 0.15);
        perCall.push(performance.now() - start);
        expect(result).not.toBeNull();
        expect(result?.models.length ?? 0).toBeGreaterThan(0);
      }
      await rebuildPromise;

      perCall.sort((a, b) => a - b);
      const p50 = percentile(perCall, 50);
      // eslint-disable-next-line no-console
      console.info(
        `[sab-worker-concurrent-load-benchmark] 500 reads during a concurrent rebuild: p50=${p50.toFixed(3)}ms, max=${Math.max(...perCall).toFixed(3)}ms`
      );
      expect(p50).toBeLessThan(50);
    },
    180_000
  );

  it(
    'worker crash: reads keep serving the last-good generation, then a respawned worker rebuilds successfully',
    async () => {
      const {
        getSabCandidateModels,
        getSabCandidateIndexStatus,
        waitForNextBuild,
        requestSabCandidateIndexRebuild,
        __testOnlyKillWorkerForRespawnTest,
      } = await import('../manager');

      const statusBefore = getSabCandidateIndexStatus();
      expect(statusBefore.ready).toBe(true);
      const crashesBefore = statusBefore.crashes;

      // Reads must keep working immediately BEFORE the simulated crash —
      // baseline sanity so the "still works after" assertion below is
      // meaningful (not vacuously true because reads were already broken).
      const before = getSabCandidateModels({ contextSize: 1000 }, 400, 300, 0.15);
      expect(before).not.toBeNull();
      expect(before?.models.length ?? 0).toBeGreaterThan(0);

      // Simulate a crash: kill the live worker (Finding 2 of the feasibility
      // investigation — a worker crash does not take down this process).
      __testOnlyKillWorkerForRespawnTest();

      // Reads must keep serving the LAST-GOOD generation throughout the
      // crash/respawn window — this is the entire point of the manager
      // owning buffer allocation independently of any one worker instance
      // (see manager.ts's own module doc).
      const duringCrash = getSabCandidateModels({ contextSize: 1000 }, 400, 300, 0.15);
      expect(duringCrash).not.toBeNull();
      expect(duringCrash?.models.length ?? 0).toBeGreaterThan(0);
      expect(duringCrash?.models.map((m) => m.id).sort()).toEqual(before?.models.map((m) => m.id).sort());

      // Wait for the respawn (fixed backoff, see RESPAWN_DELAY_MS) + a fresh
      // successful rebuild on the new worker instance.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const rebuildPromise = waitForNextBuild(120_000);
      requestSabCandidateIndexRebuild();
      await rebuildPromise;

      const statusAfter = getSabCandidateIndexStatus();
      expect(statusAfter.ready).toBe(true);
      expect(statusAfter.crashes).toBeGreaterThan(crashesBefore);
      expect(statusAfter.lastError).toBeNull();

      const after = getSabCandidateModels({ contextSize: 1000 }, 400, 300, 0.15);
      expect(after).not.toBeNull();
      expect(after?.models.length ?? 0).toBeGreaterThan(0);
    },
    60_000
  );
});
