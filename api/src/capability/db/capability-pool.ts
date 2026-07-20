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

const log = logger.child({ component: 'capability-pool' });

let pool: pg.Pool | null = null;

export function getCapabilityPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
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
  try {
    await p.end();
    log.info('Capability pg.Pool closed');
  } catch (err) {
    log.warn({ err }, 'Error closing capability pool');
  }
}
