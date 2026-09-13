// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * runMigrations() contract for the pooler cutover:
 * - SKIP_DB_MIGRATIONS is the canonical skip flag (what index.ts checks);
 *   SKIP_MIGRATIONS still works as a deprecated alias with a warning.
 * - The migrate CLI ALWAYS receives the base (direct) URL, never the pooler
 *   URL: prisma migrate's Schema Engine needs a session-level advisory lock.
 * - Fail-closed: if DATABASE_USE_POOLER is on and the base URL already
 *   targets the pooler host:port, refuse instead of hanging.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DIRECT_URL = 'postgresql://ci_user:s3cr3t@db:5432/ci_db';
const POOLER_URL = 'postgresql://ci_user:s3cr3t@pgbouncer:6432/ci_db';

const h = vi.hoisted(() => ({ exec: vi.fn() }));

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return { ...original, exec: h.exec };
});

function mockConfig(url: string): void {
  vi.doMock('@/config', () => ({
    config: { database: { url, poolMax: 5, poolMin: 0 } },
    isDevelopment: false,
  }));
}

const ENV_KEYS = ['SKIP_DB_MIGRATIONS', 'SKIP_MIGRATIONS', 'DATABASE_USE_POOLER', 'DATABASE_POOLER_HOST'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  h.exec.mockReset();
  h.exec.mockImplementation((_cmd: unknown, _opts: unknown, cb: (e: null, out: string, err: string) => void) => {
    cb(null, 'No pending migrations to apply.', '');
  });
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.doUnmock('@/config');
  vi.resetModules();
});

async function loadClient() {
  return import('../client');
}

function execEnvDatabaseUrl(): string | undefined {
  const call = h.exec.mock.calls[0];
  const options = call?.[1] as { env?: Record<string, string> } | undefined;
  return options?.env?.DATABASE_URL;
}

describe('runMigrations — skip flags', () => {
  it('SKIP_DB_MIGRATIONS=true returns without exec', async () => {
    process.env.SKIP_DB_MIGRATIONS = 'true';
    mockConfig(DIRECT_URL);
    const { runMigrations } = await loadClient();
    await runMigrations();
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('SKIP_MIGRATIONS=true (deprecated alias) returns without exec and warns', async () => {
    process.env.SKIP_MIGRATIONS = 'true';
    mockConfig(DIRECT_URL);
    const { logger } = await import('@/utils/logger');
    const warn = vi.spyOn(logger, 'warn');
    const { runMigrations } = await loadClient();
    await runMigrations();
    expect(h.exec).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('SKIP_MIGRATIONS is a deprecated alias'))).toBe(
      true
    );
  });
});

describe('runMigrations — target is always the direct URL', () => {
  it('pooler off: exec receives env.DATABASE_URL === config.database.url', async () => {
    mockConfig(DIRECT_URL);
    const { runMigrations } = await loadClient();
    await runMigrations();
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(execEnvDatabaseUrl()).toBe(DIRECT_URL);
  });

  it('pooler on with a direct base URL: exec STILL receives the direct URL, never the pooler URL', async () => {
    process.env.DATABASE_USE_POOLER = 'true';
    process.env.DATABASE_POOLER_HOST = 'pgbouncer';
    mockConfig(DIRECT_URL);
    const { runMigrations } = await loadClient();
    await runMigrations();
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(execEnvDatabaseUrl()).toBe(DIRECT_URL);
    expect(execEnvDatabaseUrl()).not.toContain('pgbouncer');
  });

  it('pooler on with the base URL already pointing at the pooler: throws a clear error, no exec', async () => {
    process.env.DATABASE_USE_POOLER = 'true';
    process.env.DATABASE_POOLER_HOST = 'pgbouncer';
    mockConfig(POOLER_URL);
    const { runMigrations } = await loadClient();
    await expect(runMigrations()).rejects.toThrow(/transaction pooler/);
    expect(h.exec).not.toHaveBeenCalled();
  });
});
