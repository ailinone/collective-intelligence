// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared raw pg.Pool for HCRA infrastructure (ADR-022, Sprint 3)
 *
 * Why a separate pool from Prisma's adapter pool:
 * - The HCRA layer needs raw SQL: pgvector cosine (`embedding <=> $1::vector`),
 *   pg_trgm `similarity()`, JSONB filters with `jsonb_each` / `@>`, and array
 *   parameter binding. Prisma's query engine doesn't model these.
 * - Prisma 7's adapter does manage a pg.Pool internally, but it's not exposed.
 *   Reaching into private internals would couple us to Prisma upgrades.
 *
 * Why a singleton:
 * - The materialiser, embed worker, search service, search routes, and
 *   scheduled jobs all need raw SQL. If each created its own Pool, we'd
 *   multiply connection count without bound (and a single Pool with `max=10`
 *   keeps us well under the Postgres `max_connections=100` budget shared
 *   with Prisma).
 *
 * Pool sizing: max 10 connections is generous for HCRA — the worker is the
 * heaviest user (one connection per UPDATE in the loop). Search queries are
 * subsecond. If we ever push HCRA onto a separate DB host, this is the only
 * place to retune.
 */

import pg from 'pg';
import { logger } from '@/utils/logger';
import { getRuntimeDatabaseUrl } from '@/database/connection-url';
import { attachPoolMetrics } from '@/database/pool-metrics';

const log = logger.child({ component: 'capability-pool' });

let pool: pg.Pool | null = null;
let poolMetricsSampler: NodeJS.Timeout | null = null;

export function getCapabilityPool(): pg.Pool {
  if (pool) return pool;

  // DATABASE_URL CONSISTENCY FIX (2026-09-07 incident, ci-api production —
  // "getaddrinfo ENOTFOUND old-db-host" on every semantic-cache/HCRA query):
  // this used to read `process.env.DATABASE_URL` directly, lazily, on first
  // use. But `process.env.DATABASE_URL` is intentionally REASSIGNED partway
  // through boot by `config/load-secrets-into-env.ts`, which treats GCP
  // Secret Manager as the source of truth for a list of CRITICAL_SECRETS
  // (including `database-url`) and overwrites process.env with whatever it
  // finds there — see index.ts's documented call order (config imported and
  // Prisma's pool built FIRST at synchronous top-level `import` time, THEN
  // `await loadSecretsIntoEnv()` runs later in async boot). Prisma is safe
  // because `database/client.ts` captures `config.database.url` at that
  // early, top-level-import point, before the reassignment happens. This
  // pool is created LAZILY on first real use (the first semantic-cache/HCRA
  // query, well after boot completes) and was instead reading
  // `process.env.DATABASE_URL` at THAT later point — picking up whatever
  // `loadSecretsIntoEnv()` had already overwritten it with. In production,
  // the GCP secret `<prefix>-database-url` is stale (it still has the Postgres
  // service's pre-rename hostname (old-db-host), not the current one — see
  // docker/docker-compose.production.yml's `DB_HOST:-db` construction),
  // so every semantic-cache/HCRA connection attempt failed DNS resolution
  // while Prisma, pointed at the same real database via the early-captured
  // value, kept working fine. Reading `config.database.url` here instead
  // means this pool always resolves the SAME value, captured at the SAME
  // safe, early point, as Prisma — it can no longer diverge regardless of
  // what a later secrets refresh does to `process.env`.
  //
  // getRuntimeDatabaseUrl() keeps that early capture (resolved once at
  // import from config.database.url) and additionally follows the pooler
  // when DATABASE_USE_POOLER is on, so this pool and Prisma always share
  // the same target. With the pooler off it IS config.database.url.
  const connectionString = getRuntimeDatabaseUrl();
  if (!connectionString) {
    throw new Error('getCapabilityPool: DATABASE_URL is not set');
  }

  pool = new pg.Pool({
    connectionString,
    max: parseInt(process.env.HCRA_POOL_MAX ?? '10', 10),
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 20_000,
  });

  pool.on('error', (err: unknown) => {
    log.warn({ err }, 'capability pool emitted idle-client error');
  });
  if (poolMetricsSampler) {
    clearInterval(poolMetricsSampler);
  }
  poolMetricsSampler = attachPoolMetrics(pool, 'capability');

  log.info({ max: pool.options.max }, 'Capability pg.Pool initialised');
  return pool;
}

/**
 * Close the pool. Used in test teardown and graceful shutdown.
 * Safe to call when the pool was never created.
 */
export async function closeCapabilityPool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  if (poolMetricsSampler) {
    clearInterval(poolMetricsSampler);
    poolMetricsSampler = null;
  }
  try {
    await p.end();
    log.info('Capability pg.Pool closed');
  } catch (err) {
    log.warn({ err }, 'Error closing capability pool');
  }
}
