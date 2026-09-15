// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * REAL measurement of the model-selection candidate cap
 * (curatedCandidateTake + aggregatedCandidateTake, prod default 400+400=800).
 *
 * Rule this harness exists to enforce: MEASURE, NEVER ESTIMATE — every number
 * reported by this benchmark comes from a real Postgres (pgvector/pgvector:pg16,
 * same image as prod) running in a Testcontainer, driven through the REAL
 * DynamicModelSelector code paths on current main. No query is mocked.
 *
 * What it measures, per catalog size N (env BENCH_N, one invocation per N):
 *
 *  1. Full-path cost through the real selector at multiple cap settings
 *     (env BENCH_TAKES, default "400:400,1000:1000,2000:2000"):
 *       - findModelsByRequirements() wall time (candidate retrieval + hydration)
 *       - selectModels() wall time (retrieval + all gates + per-candidate scoring
 *         fan-out over the whole candidate pool — the loop the 800 ceiling
 *         exists to bound)
 *       - statement count (statsOut.databaseQueries), pool sizes, peak RSS
 *     Two request shapes: "plain" (chat, no capability requirement) and
 *     "vision" (chat + requiredCapabilities:['vision']) — the latter quantifies
 *     the capability-filter-AFTER-the-cut recall cost that the SAB index's
 *     filter-before-the-cut reader would fix.
 *  2. Isolated DB-only cost of the aggregated-bucket SQL (the one query whose
 *     LIMIT the cap directly sets), at takes 400/1000/2000/4000, with and
 *     without a context_window filter, 50 timed executions each.
 *  3. EXPLAIN (ANALYZE, BUFFERS) for that SQL at this N, per take/variant.
 *
 * Determinism: the catalog is generated from hash-derived fields only (no
 * Math.random), shaped proportionally to the live-prod audit baked into
 * sab-worker-concurrent-load-benchmark.test.ts (37,629 curated / 73,782 HF
 * aggregated / 255 orphan at 111,666 total; featherless-ai 59% of curated,
 * 95 distinct curated providers). Same BENCH_N ⇒ byte-identical catalog.
 *
 * Safety: ONE Postgres testcontainer per invocation, hard-capped at 1 GiB RAM
 * (withResourcesQuota); removed in afterAll. No other database is touched.
 *
 * Run (from api/):
 *   BENCH_N=5000   pnpm exec vitest run --config vitest.selection-cap-bench.config.ts
 *   BENCH_N=20000  ...
 *   BENCH_N=50000  ...
 *   BENCH_N=150000 ...
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Wait } from 'testcontainers';
import { Client as PgClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ── Knobs (env-overridable; defaults = the cells the cap decision needs) ──────
const BENCH_N = Number(process.env.BENCH_N ?? 150_000);
const ITERS = Number(process.env.BENCH_ITERS ?? 20);
const SQL_ITERS = 50;
const TAKES: Array<{ curated: number; aggregated: number }> = (
  process.env.BENCH_TAKES ?? '400:400,1000:1000,2000:2000'
)
  .split(',')
  .map((s) => {
    const [c, a] = s.split(':').map(Number);
    return { curated: c, aggregated: a };
  });
const SQL_TAKES = [400, 1000, 2000, 4000];
const CONTEXT_VARIANT = 8000; // the context_window filter used by the ctx variant
const CONTAINER_MEMORY_BYTES = 1_073_741_824; // 1 GiB hard cap (operator guidance)

// ── Deterministic catalog shape (proportional to the live-prod audit) ─────────
const PROD_TOTAL = 111_666;
const PROD_CURATED_TOTAL = 37_629;
const PROD_HF_TOTAL = 73_782;
const PROD_ORPHAN_TOTAL = 255;
/** Real per-provider curated-bucket breakdown (live 2026-09-07 audit). */
const PROD_CURATED_NAMED: Array<[string, number]> = [
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
const PROD_TAIL_PROVIDERS = 95 - PROD_CURATED_NAMED.length;

function computeModelUid(providerId: string, modelId: string): string {
  return createHash('md5').update(`${providerId}:${modelId}`).digest('hex').substring(0, 25);
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

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
  usageCount: number;
  metadata: Record<string, unknown>;
}

/** Deterministic usage/downloads: prod is tie-heavy (usage_count historically
 *  all-zero; the 60s tracker now writes a small minority of rows). ~2% of rows
 *  get a small non-zero usage_count; every HF row gets a deterministic downloads
 *  figure (the popularity-seed ordering key). */
function usageFor(h: number): number {
  return h % 100 < 2 ? 1 + (h % 50) : 0;
}

function buildCatalog(n: number): { providerIds: string[]; models: SeedModelRow[]; visionCount: number } {
  const f = n / PROD_TOTAL;
  const providerIds = new Set<string>();
  const models: SeedModelRow[] = [];
  let visionCount = 0;

  const capsFor = (h: number): string[] => {
    const capabilities = ['chat'];
    if (h % 100 < 4) capabilities.push('reasoning');
    if (h % 100 < 3) {
      capabilities.push('vision');
      visionCount++;
    }
    return capabilities;
  };

  function pushCurated(id: string, providerName: string) {
    const providerId = `${providerName}-provider-id`;
    providerIds.add(providerId);
    const h = hashStr(id);
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
      capabilities: capsFor(h),
      performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.99 },
      status: 'active',
      usageCount: usageFor(h),
      metadata: {},
    });
  }

  // Curated bucket: named providers at prod proportions, then long-tail fill.
  const curatedTotal = Math.round(PROD_CURATED_TOTAL * f);
  let namedTotal = 0;
  for (const [provider, count] of PROD_CURATED_NAMED) {
    const scaled = Math.max(1, Math.round(count * f));
    for (let i = 0; i < scaled; i++) pushCurated(`${provider}-${i}`, provider);
    namedTotal += scaled;
  }
  const remainingRows = Math.max(0, curatedTotal - namedTotal);
  const perTail = Math.floor(remainingRows / PROD_TAIL_PROVIDERS);
  for (let p = 0; p < PROD_TAIL_PROVIDERS; p++) {
    const providerName = `long-tail-provider-${p}`;
    const rows =
      p === PROD_TAIL_PROVIDERS - 1 ? remainingRows - perTail * (PROD_TAIL_PROVIDERS - 1) : perTail;
    for (let i = 0; i < rows; i++) pushCurated(`${providerName}-${i}`, providerName);
  }

  // Aggregated bucket: HF hub index, callable, with deterministic downloads.
  const hfProviderId = 'huggingface-provider-id';
  providerIds.add(hfProviderId);
  const hfTotal = Math.round(PROD_HF_TOTAL * f);
  for (let i = 0; i < hfTotal; i++) {
    const id = `hf-${i}`;
    const h = hashStr(id);
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
      capabilities: capsFor(h),
      performance: { latencyMs: 800, throughput: 50, quality: 0.6, reliability: 0.9 },
      status: 'active',
      usageCount: usageFor(h),
      metadata: {
        serverless_callable: true,
        hubInventoryClass: 'aggregated_index',
        downloads: h % 5_000_000,
      },
    });
  }

  // Orphan aggregated rows (aggregated_index but NOT callable — excluded from
  // both buckets by construction).
  const orphanProviderId = 'orphan-provider-provider-id';
  providerIds.add(orphanProviderId);
  const orphanTotal = Math.round(PROD_ORPHAN_TOTAL * f);
  for (let i = 0; i < orphanTotal; i++) {
    const id = `orphan-${i}`;
    const h = hashStr(id);
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
      capabilities: capsFor(h),
      performance: { latencyMs: 500, throughput: 100, quality: 0.9, reliability: 0.99 },
      status: 'active',
      usageCount: usageFor(h),
      metadata: { hubInventoryClass: 'aggregated_index' },
    });
  }

  return { providerIds: [...providerIds], models, visionCount };
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

async function seedDatabase(connectionString: string, n: number): Promise<number> {
  const client = new PgClient({ connectionString });
  await client.connect();
  try {
    const { providerIds, models } = buildCatalog(n);

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

    const BATCH_SIZE = 2000; // 12 cols/row ⇒ 24k params/batch, far under the 65,535 cap
    for (let start = 0; start < models.length; start += BATCH_SIZE) {
      const batch = models.slice(start, start + BATCH_SIZE);
      const values: string[] = [];
      const params: unknown[] = [];
      batch.forEach((m, i) => {
        const base = i * 12;
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, now())`
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
          JSON.stringify(m.metadata),
          m.usageCount
        );
      });
      await client.query(
        `INSERT INTO models (uid, id, provider_id, name, display_name, context_window, max_output_tokens, input_cost_per_1k, output_cost_per_1k, capabilities, metadata, usage_count, updated_at)
         VALUES ${values.join(',')}`,
        params
      );
    }

    // Planner stats: a fresh container has empty pg_class.reltuples until
    // autovacuum/ANALYZE runs; without this the planner behaves nothing like
    // the steady-state prod planner this benchmark is meant to reflect.
    await client.query('ANALYZE models');
    await client.query('ANALYZE providers');
    return models.length;
  } finally {
    await client.end();
  }
}

// ── Stats helpers ─────────────────────────────────────────────────────────────
function sorted(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}
function median(arr: number[]): number {
  const s = sorted(arr);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
}
function p95(arr: number[]): number {
  const s = sorted(arr);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(0.95 * s.length))];
}
function min(arr: number[]): number {
  return sorted(arr)[0] ?? 0;
}
function max(arr: number[]): number {
  return sorted(arr)[arr.length - 1] ?? 0;
}
function fmtMs(x: number): string {
  return x >= 100 ? x.toFixed(0) : x.toFixed(1);
}

describe(`selection candidate-cap benchmark — N=${BENCH_N}`, () => {
  let container: StartedPostgreSqlContainer;
  let pg: PgClient;
  let visionCount: number;
  let DynamicModelSelectorClass: typeof import('@/core/selection/dynamic-model-selector').DynamicModelSelector;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('ailin_cap_bench')
      .withUsername('ailin')
      .withPassword('ailin')
      .withResourcesQuota({ memory: CONTAINER_MEMORY_BYTES })
      // pgvector/pgvector:pg16 ships no HEALTHCHECK directive, and
      // @testcontainers/postgresql 12.x defaults to forAll([forHealthCheck(),
      // forListeningPorts()]) — the health probe never leaves `undefined` and
      // times out after 120s. Probe readiness directly instead.
      .withWaitStrategy(
        Wait.forAll([
          Wait.forListeningPorts(),
          Wait.forSuccessfulCommand('pg_isready -U ailin -d ailin_cap_bench'),
        ])
      )
      .start();

    const connectionString = container.getConnectionUri();
    process.env.DATABASE_URL = connectionString;
    // Fail-fast Redis (port 1 refuses immediately): everything that would try
    // Redis in prod deterministically falls through to Postgres here — same
    // trick as sab-worker-concurrent-load-benchmark.test.ts.
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = '1';
    process.env.LOG_LEVEL = 'warn';
    // Measure the DEFAULT SQL candidate path: both alternate retrieval flags OFF.
    delete process.env.SELECTION_USE_SAB_CANDIDATE_INDEX;
    delete process.env.SELECTION_USE_FULL_CACHE_INDEX;

    const projectRoot = path.resolve(__dirname, '..', '..');
    await applyMigrations(connectionString, projectRoot);
    const rowCount = await seedDatabase(connectionString, BENCH_N);
    expect(rowCount).toBeGreaterThan(0);

    pg = new PgClient({ connectionString });
    await pg.connect();

    const { recreatePrismaClient } = await import('@/database/client');
    recreatePrismaClient();
    const mod = await import('@/core/selection/dynamic-model-selector');
    DynamicModelSelectorClass = mod.DynamicModelSelector;
    visionCount = buildCatalog(BENCH_N).visionCount; // deterministic re-derivation

    // Global warm-up: pays every module-level cold start once (catalog hydrate,
    // curated-bucket snapshot, popularity seed, prisma plan caches) so measured
    // iterations reflect warm steady-state per-request cost.
    process.env.SELECTION_CURATED_TAKE = '400';
    process.env.SELECTION_AGGREGATED_TAKE = '400';
    const warmSelector = new DynamicModelSelectorClass();
    const warmCtx = {
      organizationId: 'bench-org',
      requestId: 'warmup',
      models: [],
      taskType: 'chat' as const,
      contextSize: 0,
    };
    const warmPool = await warmSelector.findModelsByRequirements({ taskType: 'chat' }, 2000, {
      cacheHit: false,
      databaseQueries: 0,
    });
    await warmSelector.selectModels(null, { taskType: 'chat' }, warmCtx, 5);
    // eslint-disable-next-line no-console
    console.info(
      `[cap-bench] N=${BENCH_N} seeded rows=${rowCount} visionRows=${visionCount} warmPool=${warmPool.length}`
    );
  }, 1_800_000);

  afterAll(async () => {
    await pg?.end().catch(() => undefined);
    const { disconnectDatabase } = await import('@/database/client');
    await disconnectDatabase().catch(() => undefined);
    await container?.stop();
  }, 120_000);

  it('measures the full selection path across cap settings', async () => {
    const variants = [
      { name: 'plain', criteria: { taskType: 'chat' as const } },
      { name: 'vision', criteria: { taskType: 'chat' as const, requiredCapabilities: ['vision'] } },
    ];

    // eslint-disable-next-line no-console
    console.info(
      `[cap-bench] full-path cells: ${TAKES.length} takes x ${variants.length} variants x ${ITERS} iters (fresh selector per iter = cold selectionCache, warm module caches)`
    );

    for (const take of TAKES) {
      process.env.SELECTION_CURATED_TAKE = String(take.curated);
      process.env.SELECTION_AGGREGATED_TAKE = String(take.aggregated);

      for (const variant of variants) {
        const findMs: number[] = [];
        const selMs: number[] = [];
        const queries = new Set<number>();
        const poolSizes = new Set<number>();
        const selSizes = new Set<number>();
        const rssBase = process.memoryUsage().rss;
        let rssMax = rssBase;

        for (let i = 0; i < ITERS; i++) {
          const ctx = {
            organizationId: 'bench-org',
            requestId: `bench-${i}`,
            models: [],
            taskType: 'chat' as const,
            contextSize: 0,
          };

          const retrieval = new DynamicModelSelectorClass();
          const stats = { cacheHit: false, databaseQueries: 0 };
          const t0 = performance.now();
          const pool = await retrieval.findModelsByRequirements(variant.criteria, 2000, stats);
          const t1 = performance.now();

          const scorer = new DynamicModelSelectorClass();
          const t2 = performance.now();
          const selected = await scorer.selectModels(null, variant.criteria, ctx, 5);
          const t3 = performance.now();

          findMs.push(t1 - t0);
          selMs.push(t3 - t2);
          queries.add(stats.databaseQueries);
          poolSizes.add(pool.length);
          selSizes.add(selected.length);
          rssMax = Math.max(rssMax, process.memoryUsage().rss);
        }

        // eslint-disable-next-line no-console
        console.info(
          `[cap-bench] N=${BENCH_N} take=${take.curated}+${take.aggregated} variant=${variant.name} | ` +
            `findMs med/p95/min/max=${fmtMs(median(findMs))}/${fmtMs(p95(findMs))}/${fmtMs(min(findMs))}/${fmtMs(max(findMs))} | ` +
            `selectMs med/p95/min/max=${fmtMs(median(selMs))}/${fmtMs(p95(selMs))}/${fmtMs(min(selMs))}/${fmtMs(max(selMs))} | ` +
            `dbQueries=${[...queries].join('/')} pool=${[...poolSizes].join('/')} selected=${[...selSizes].join('/')} | ` +
            `rssDeltaMB=${((rssMax - rssBase) / 1_048_576).toFixed(1)} rssMaxMB=${(rssMax / 1_048_576).toFixed(1)}`
        );

        expect(median(findMs)).toBeGreaterThan(0);
        expect([...poolSizes][0]).toBeGreaterThan(0);
      }
    }
  }, 3_600_000);

  it('isolates the aggregated-bucket SQL cost and captures EXPLAIN plans', async () => {
    // The exact query getAggregatedBucketUids issues (dynamic-model-selector.ts
    // getAggregatedBucketUids): Prisma sends LIMIT as a bind param, which is
    // plan-equivalent to the literal used here.
    const sqlFor = (take: number, ctx: number | null) =>
      `SELECT uid FROM models ` +
      `WHERE status <> 'disabled' AND metadata @> '{"serverless_callable":true}'::jsonb` +
      (ctx !== null ? ` AND context_window >= ${ctx}` : '') +
      ` ORDER BY usage_count DESC LIMIT ${take}`;

    // eslint-disable-next-line no-console
    console.info(`[cap-bench] isolated aggregated-SQL timing (${SQL_ITERS} execs/cell):`);
    for (const ctxVariant of [null, CONTEXT_VARIANT] as Array<number | null>) {
      for (const take of SQL_TAKES) {
        const sql = sqlFor(take, ctxVariant);
        // 5 warm-up executions (plan cache + buffers)
        for (let i = 0; i < 5; i++) await pg.query(sql);
        const ms: number[] = [];
        for (let i = 0; i < SQL_ITERS; i++) {
          const t0 = performance.now();
          await pg.query(sql);
          ms.push(performance.now() - t0);
        }
        // eslint-disable-next-line no-console
        console.info(
          `[cap-bench] sqlTake=${take} ctx=${ctxVariant ?? 'none'} med/p95/min/max=` +
            `${fmtMs(median(ms))}/${fmtMs(p95(ms))}/${fmtMs(min(ms))}/${fmtMs(max(ms))} ms`
        );
      }
    }

    // EXPLAIN (ANALYZE, BUFFERS) — one per take at each variant, full text for the doc.
    for (const ctxVariant of [null, CONTEXT_VARIANT] as Array<number | null>) {
      for (const take of SQL_TAKES) {
        const res = await pg.query(
          `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON) ${sqlFor(take, ctxVariant)}`
        );
        // eslint-disable-next-line no-console
        console.info(
          `[cap-bench] EXPLAIN take=${take} ctx=${ctxVariant ?? 'none'}:\n` +
            res.rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n')
        );
      }
    }

    // Table+index sizes at this N (for the memory side of the analysis).
    const sizes = await pg.query(
      `SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total_size ` +
        `FROM pg_class WHERE relname IN ('models','models_pkey','models_usage_count_idx',` +
        `'models_aggregated_context_idx','models_callable_downloads_idx') ORDER BY relname`
    );
    // eslint-disable-next-line no-console
    console.info(
      '[cap-bench] relation sizes:\n' +
        sizes.rows.map((r: { relname: string; total_size: string }) => `  ${r.relname}: ${r.total_size}`).join('\n')
    );

    expect(true).toBe(true);
  }, 600_000);
});
