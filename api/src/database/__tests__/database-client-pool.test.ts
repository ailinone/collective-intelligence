// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * database-client-pool.test.ts — the DATABASE_POOL_MAX / DB_POOL_MAX
 * footgun, proved at the actual pg.Pool construction site.
 *
 * Until this fix, `database/client.ts`'s `createPgPool()` sized the real
 * Postgres connection pool from a bare `Number(process.env.DB_POOL_MAX)`
 * read, completely bypassing `config.database.poolMax` — an operator
 * setting the discoverable, documented `DATABASE_POOL_MAX` env var (which
 * `config/index.ts` DID define) had zero effect on the pool that Prisma
 * actually used, silently.
 *
 * `buildPgPoolOptions()` is now the single, exported, pure function that
 * decides the pool's `max`/`min` — and it reads ONLY `config.database.poolMax`
 * / `poolMin` (config/index.ts's `resolveDatabasePoolMax()` /
 * `resolveDatabasePoolMin()` are the single source of truth for those
 * values; see `config/__tests__/database-pool-config.test.ts` for that
 * resolution/precedence contract).
 *
 * This test mirrors `capability/db/__tests__/capability-pool.test.ts`'s
 * technique: mock `@/config` to a value that diverges from whatever
 * `process.env` says, and prove the pool follows config, never a direct env
 * read — the exact asymmetry this footgun created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MOCKED_POOL_MAX = 37;
const MOCKED_POOL_MIN = 4;
const FAKE_CONNECTION_STRING = 'postgresql://ci_user:secret@localhost:5432/ci_test';

vi.mock('@/config', () => ({
  config: {
    database: {
      url: FAKE_CONNECTION_STRING,
      poolMax: MOCKED_POOL_MAX,
      poolMin: MOCKED_POOL_MIN,
    },
  },
  isDevelopment: false,
}));

describe('database/client.ts pg.Pool sizing — config.database.poolMax/poolMin is the source of truth', () => {
  const originalDbPoolMax = process.env.DB_POOL_MAX;
  const originalDatabasePoolMax = process.env.DATABASE_POOL_MAX;

  beforeEach(() => {
    vi.resetModules();
    // A rogue DB_POOL_MAX / DATABASE_POOL_MAX sitting in the real process
    // env must NOT leak into the pool built from the (mocked) config — if
    // buildPgPoolOptions ever regresses to reading process.env directly
    // (the exact bug this test guards against), this test would observe
    // 999 instead of the mocked config values below.
    process.env.DB_POOL_MAX = '999';
    process.env.DATABASE_POOL_MAX = '999';
  });

  afterEach(() => {
    process.env.DB_POOL_MAX = originalDbPoolMax;
    process.env.DATABASE_POOL_MAX = originalDatabasePoolMax;
    vi.resetModules();
  });

  it('sizes the pool from config.database.poolMax/poolMin, not process.env.DB_POOL_MAX/DATABASE_POOL_MAX', async () => {
    const { buildPgPoolOptions } = await import('../client');
    const options = buildPgPoolOptions(FAKE_CONNECTION_STRING);

    expect(options.max).toBe(MOCKED_POOL_MAX);
    expect(options.min).toBe(MOCKED_POOL_MIN);
    expect(options.max).not.toBe(999);
    expect(options.min).not.toBe(999);
  });

  it('passes the connection string through unchanged', async () => {
    const { buildPgPoolOptions } = await import('../client');
    const options = buildPgPoolOptions(FAKE_CONNECTION_STRING);

    expect(options.connectionString).toBe(FAKE_CONNECTION_STRING);
  });
});
