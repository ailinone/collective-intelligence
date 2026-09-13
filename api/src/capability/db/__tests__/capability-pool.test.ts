// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test — capability pool must resolve DATABASE_URL from the SAME
 * early-captured source as Prisma, not a lazy re-read of `process.env`
 * (2026-09-07 incident, ci-api production: "getaddrinfo ENOTFOUND old-db-host" on
 * every semantic-cache/HCRA query).
 *
 * Root cause: `config/load-secrets-into-env.ts` reassigns
 * `process.env.DATABASE_URL` partway through boot (GCP Secret Manager is
 * treated as the source of truth for a list of CRITICAL_SECRETS, including
 * `database-url`, and overwrites process.env with whatever it finds there —
 * see index.ts's documented call order: config imported and Prisma's pool
 * built at synchronous top-level `import` time, THEN
 * `await loadSecretsIntoEnv()` runs later in async boot). Prisma is safe
 * because `database/client.ts` captures `config.database.url` at that early
 * import-time point. `getCapabilityPool()` is lazy — created on first real
 * use, well after boot completes — so reading `process.env.DATABASE_URL`
 * directly at that later point picked up whatever `loadSecretsIntoEnv()` had
 * already overwritten it with. In production, the GCP secret
 * `<prefix>-database-url` is stale (pre-rename hostname (old-db-host), not the
 * current `db`), so this diverged from Prisma's correct target while Prisma
 * itself kept working fine — exactly the asymmetry observed live.
 *
 * This test proves the fix by mocking `@/config` and `process.env` to
 * DIFFERENT values (mirroring the exact production divergence) and asserting
 * the pool follows `config.database.url`, never the mutated env var.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONFIG_DATABASE_URL = 'postgresql://ci_user:secret@db:5432/ci_db';
const STALE_ENV_DATABASE_URL = 'postgresql://ci_user:secret@old-db-host:5432/ci_db';

vi.mock('@/config', () => ({
  config: {
    database: {
      url: CONFIG_DATABASE_URL,
    },
  },
}));

describe('getCapabilityPool — DATABASE_URL source (2026-09-07 incident)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalUsePooler = process.env.DATABASE_USE_POOLER;
  const originalPoolerHost = process.env.DATABASE_POOLER_HOST;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.DATABASE_USE_POOLER;
    delete process.env.DATABASE_POOLER_HOST;
    // Simulate the production divergence: process.env.DATABASE_URL has
    // already been overwritten (by load-secrets-into-env.ts, from the stale
    // GCP secret) to a DIFFERENT host than config.database.url captured
    // early. If getCapabilityPool ever regresses to reading process.env
    // directly, this test will see the stale "old-db-host" host instead.
    process.env.DATABASE_URL = STALE_ENV_DATABASE_URL;
  });

  afterEach(async () => {
    const { closeCapabilityPool } = await import('../capability-pool');
    await closeCapabilityPool();
    process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalUsePooler === undefined) delete process.env.DATABASE_USE_POOLER;
    else process.env.DATABASE_USE_POOLER = originalUsePooler;
    if (originalPoolerHost === undefined) delete process.env.DATABASE_POOLER_HOST;
    else process.env.DATABASE_POOLER_HOST = originalPoolerHost;
    vi.resetModules();
  });

  it('follows the pooler (host:6432, no params) when DATABASE_USE_POOLER=true + DATABASE_POOLER_HOST are set', async () => {
    process.env.DATABASE_USE_POOLER = 'true';
    process.env.DATABASE_POOLER_HOST = 'pgbouncer';
    const { getCapabilityPool } = await import('../capability-pool');
    const pool = getCapabilityPool();

    expect(pool.options.connectionString).toBe('postgresql://ci_user:secret@pgbouncer:6432/ci_db');
    expect(pool.options.connectionString).not.toContain('old-db-host');
  });

  it('builds the pool from config.database.url, not the (possibly stale) process.env.DATABASE_URL', async () => {
    const { getCapabilityPool } = await import('../capability-pool');
    const pool = getCapabilityPool();

    expect(pool.options.connectionString).toBe(CONFIG_DATABASE_URL);
    expect(pool.options.connectionString).not.toBe(STALE_ENV_DATABASE_URL);
    expect(pool.options.connectionString).not.toContain('old-db-host');
  });

  it('is a singleton — repeated calls return the same pool instance', async () => {
    const { getCapabilityPool } = await import('../capability-pool');
    const first = getCapabilityPool();
    const second = getCapabilityPool();
    expect(first).toBe(second);
  });

  it('closeCapabilityPool tears down the singleton so a later call rebuilds it', async () => {
    const { getCapabilityPool, closeCapabilityPool } = await import('../capability-pool');
    const first = getCapabilityPool();
    await closeCapabilityPool();
    const second = getCapabilityPool();
    expect(second).not.toBe(first);
    expect(second.options.connectionString).toBe(CONFIG_DATABASE_URL);
  });
});
