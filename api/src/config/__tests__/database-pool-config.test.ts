// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * database-pool-config.test.ts — the DATABASE_POOL_MAX / DB_POOL_MAX footgun.
 *
 * Until this fix, `config/index.ts` defined `config.database.poolMin` /
 * `poolMax` from `DATABASE_POOL_MIN` / `DATABASE_POOL_MAX`, but NOTHING in
 * the codebase ever read those two config fields. The real Postgres pool
 * size (`database/client.ts`'s `createPgPool()` → `pg.Pool({ max })`) was
 * controlled by a completely different, undocumented env var read directly
 * from `process.env`: `DB_POOL_MAX`. An operator tuning the discoverable,
 * conventionally-named `DATABASE_POOL_MAX` had zero effect, silently, with
 * no error or warning.
 *
 * `resolveDatabasePoolMax()` / `resolveDatabasePoolMin()` are now the single
 * source of truth: `config.database.poolMax` / `poolMin` are built from
 * them, and `database/client.ts` reads ONLY `config.database.poolMax` /
 * `poolMin` (see `database/__tests__/database-client-pool.test.ts` for the
 * proof that the actual pg.Pool traces back to these values). This file
 * pins the resolution/precedence/deprecation-warning contract itself:
 *
 *   1. DATABASE_POOL_MAX (canonical) wins whenever it is set.
 *   2. DB_POOL_MAX (deprecated, undocumented) is honored ONLY as a fallback
 *      when DATABASE_POOL_MAX is unset, so any environment already setting
 *      it keeps working identically — with a deprecation warning.
 *   3. The default, when neither is set, is mode-aware (20 dev/test, 100
 *      otherwise) to exactly match the pool size database/client.ts has
 *      always actually used in each environment (production currently sets
 *      neither, so it silently relies on this same 100 default today).
 *   4. poolMin has never had a live env var under ANY name (no DB_POOL_MIN
 *      ever existed), so its default is 0 — pg-pool's own default, and
 *      today's real behavior — not the previously-dead config's stale
 *      default of 10, so wiring it up does not silently change anyone's
 *      pool behavior.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDatabasePoolMax, resolveDatabasePoolMin } from '@/config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('validateConfig — database pool sizing boundaries (now enforceable, since these values are live)', () => {
  // These values are captured once into the frozen `config` object at
  // module-import time, so exercising validateConfig()'s boundary checks
  // for different values requires a fresh module instance per case (the
  // statically-imported resolveDatabasePoolMax/Min above are unaffected by
  // this — they keep referencing the original module instance).
  afterEach(() => {
    vi.resetModules();
  });

  it('rejects DATABASE_POOL_MAX < 1', async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_POOL_MAX', '0');
    const { validateConfig } = await import('@/config');
    expect(() => validateConfig()).toThrow(/DATABASE_POOL_MAX must be at least 1/);
  });

  it('rejects DATABASE_POOL_MIN < 0', async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_POOL_MIN', '-5');
    const { validateConfig } = await import('@/config');
    expect(() => validateConfig()).toThrow(/DATABASE_POOL_MIN must be zero or positive/);
  });

  it('rejects DATABASE_POOL_MIN > DATABASE_POOL_MAX', async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_POOL_MAX', '10');
    vi.stubEnv('DATABASE_POOL_MIN', '20');
    const { validateConfig } = await import('@/config');
    expect(() => validateConfig()).toThrow(/DATABASE_POOL_MIN cannot exceed DATABASE_POOL_MAX/);
  });

  it('accepts sane pool sizing', async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_POOL_MAX', '50');
    vi.stubEnv('DATABASE_POOL_MIN', '5');
    const { validateConfig } = await import('@/config');
    expect(() => validateConfig()).not.toThrow();
  });
});

describe('resolveDatabasePoolMax — DATABASE_POOL_MAX / DB_POOL_MAX precedence', () => {
  it('uses DATABASE_POOL_MAX (the canonical, documented name) when set', () => {
    vi.stubEnv('DATABASE_POOL_MAX', '77');
    vi.stubEnv('DB_POOL_MAX', '');
    expect(resolveDatabasePoolMax()).toBe(77);
  });

  it('falls back to the deprecated DB_POOL_MAX when DATABASE_POOL_MAX is unset', () => {
    vi.stubEnv('DATABASE_POOL_MAX', '');
    vi.stubEnv('DB_POOL_MAX', '42');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(resolveDatabasePoolMax()).toBe(42);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/DB_POOL_MAX is a deprecated/i));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('DATABASE_POOL_MAX takes precedence over DB_POOL_MAX when both are set, with no deprecation warning', () => {
    vi.stubEnv('DATABASE_POOL_MAX', '77');
    vi.stubEnv('DB_POOL_MAX', '42');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(resolveDatabasePoolMax()).toBe(77);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/DB_POOL_MAX/i));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('defaults to 100 in production when neither env var is set (matches current real production behavior)', () => {
    vi.stubEnv('DATABASE_POOL_MAX', '');
    vi.stubEnv('DB_POOL_MAX', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(resolveDatabasePoolMax()).toBe(100);
  });

  it('defaults to 20 in development/test when neither env var is set (matches current real dev/test behavior)', () => {
    vi.stubEnv('DATABASE_POOL_MAX', '');
    vi.stubEnv('DB_POOL_MAX', '');
    vi.stubEnv('NODE_ENV', 'test');
    expect(resolveDatabasePoolMax()).toBe(20);

    vi.stubEnv('NODE_ENV', 'development');
    expect(resolveDatabasePoolMax()).toBe(20);
  });
});

describe('resolveDatabasePoolMin — no env var has ever been live under any name', () => {
  it('defaults to 0 (pg-pool default, matching real behavior today) when unset', () => {
    vi.stubEnv('DATABASE_POOL_MIN', '');
    expect(resolveDatabasePoolMin()).toBe(0);
  });

  it('honors DATABASE_POOL_MIN when explicitly set (opt-in warm-pool behavior)', () => {
    vi.stubEnv('DATABASE_POOL_MIN', '15');
    expect(resolveDatabasePoolMin()).toBe(15);
  });
});

// Sanity: make sure this suite is actually exercising the exported
// resolvers (not e.g. silently importing stale compiled output).
describe('sanity', () => {
  it('the resolver functions are actually exported from @/config', () => {
    expect(typeof resolveDatabasePoolMax).toBe('function');
    expect(typeof resolveDatabasePoolMin).toBe('function');
  });
});
