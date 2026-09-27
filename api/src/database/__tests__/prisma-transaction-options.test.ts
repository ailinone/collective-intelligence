// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Interactive-transaction defaults handed to PrismaClient.
 *
 * Direct mode: maxWait 8 s (instead of Prisma's 2 s) because the Phase 1f
 * connection budget caps the pg.Pool at a size bursts can fill, so BEGIN
 * may queue briefly; timeout stays at Prisma's 5 s. maxWait must stay below
 * the pool's own connectionTimeoutMillis (read from buildPgPoolOptions, so
 * a DATABASE_CONNECTION_TIMEOUT_MS change is covered) so a saturated pool
 * still surfaces as P2028 before the pool gives up.
 *
 * Pooler mode: a maxWait that stays under pgbouncer's QUERY_WAIT_TIMEOUT
 * (10 s in compose) so a saturated pool surfaces as a retryable P2028
 * instead of a connection killed by the pooler.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config', () => ({
  config: {
    database: {
      url: 'postgresql://app_user:s3cr3t@db:5432/app_db',
      poolMax: 23,
      poolMin: 0,
    },
  },
  isDevelopment: false,
}));

import { buildPgPoolOptions } from '../client';
import { resolveTransactionOptions } from '../connection-url';

const DIRECT_URL = 'postgresql://app_user:s3cr3t@db:5432/app_db';
const PGBOUNCER_QUERY_WAIT_TIMEOUT_MS = 10_000;
const PRISMA_DEFAULT_MAX_WAIT_MS = 2_000;
const PRISMA_DEFAULT_TIMEOUT_MS = 5_000;

function poolConnectionTimeoutMs(): number {
  const ms = buildPgPoolOptions(DIRECT_URL).connectionTimeoutMillis;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    throw new Error(`pg.Pool connectionTimeoutMillis is not a positive number: ${String(ms)}`);
  }
  return ms;
}

describe('resolveTransactionOptions', () => {
  it('sets maxWait 8000 / timeout 5000 in direct mode', () => {
    expect(resolveTransactionOptions({})).toEqual({ maxWait: 8000, timeout: 5000 });
    // Flag without a host is still direct mode.
    expect(resolveTransactionOptions({ DATABASE_USE_POOLER: 'true' })).toEqual({
      maxWait: 8000,
      timeout: 5000,
    });
  });

  it('direct mode waits longer than the Prisma default for a pool connection, but less than the pool itself', () => {
    const options = resolveTransactionOptions({});
    expect(options.maxWait).toBeGreaterThan(PRISMA_DEFAULT_MAX_WAIT_MS);
    expect(options.maxWait).toBeLessThan(poolConnectionTimeoutMs());
  });

  it('direct mode keeps the Prisma default transaction timeout', () => {
    expect(resolveTransactionOptions({}).timeout).toBe(PRISMA_DEFAULT_TIMEOUT_MS);
  });

  it('sets maxWait 8000 / timeout 15000 in pooler mode', () => {
    expect(
      resolveTransactionOptions({ DATABASE_USE_POOLER: 'true', DATABASE_POOLER_HOST: 'pgbouncer' })
    ).toEqual({ maxWait: 8000, timeout: 15000 });
  });

  it('keeps maxWait below the documented QUERY_WAIT_TIMEOUT so the app error wins the race', () => {
    const options = resolveTransactionOptions({
      DATABASE_USE_POOLER: 'true',
      DATABASE_POOLER_HOST: 'pgbouncer',
    });
    expect(options.maxWait).toBeLessThan(PGBOUNCER_QUERY_WAIT_TIMEOUT_MS);
  });
});
