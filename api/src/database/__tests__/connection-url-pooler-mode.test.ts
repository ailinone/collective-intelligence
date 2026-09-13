// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the two contracts of database/connection-url.ts:
 * 1. Direct mode (the only mode production runs today) produces the SAME
 *    Prisma URL string the old inline buildDatabaseUrl produced, byte for
 *    byte, so this refactor cannot change production behaviour.
 * 2. Pooler mode (DATABASE_USE_POOLER=true + DATABASE_POOLER_HOST) rewrites
 *    host/port and carries NO query parameters: pgbouncer rejects
 *    `statement_timeout` as a startup parameter (node-postgres puts it in
 *    the StartupMessage) and `?pgbouncer=true` is inert with the pg driver
 *    adapter.
 */
import { describe, expect, it, vi } from 'vitest';

const { BASE_URL } = vi.hoisted(() => ({ BASE_URL: 'postgresql://ci_user:s3cr3t@db:5432/ci_db' }));

vi.mock('@/config', () => ({
  config: { database: { url: BASE_URL } },
}));

import {
  assertMigrationTargetIsDirect,
  buildPrismaDatabaseUrl,
  buildRuntimeDatabaseUrl,
  describeDatabaseTarget,
  getRuntimeDatabaseUrl,
  isDatabaseViaPooler,
} from '../connection-url';

const POOLER_ENV = { DATABASE_USE_POOLER: 'true', DATABASE_POOLER_HOST: 'pgbouncer' };

describe('buildPrismaDatabaseUrl — direct mode is byte-identical to the previous inline builder', () => {
  it('appends connection_limit/pool_timeout/connect_timeout/statement_timeout with production defaults', () => {
    const url = buildPrismaDatabaseUrl(BASE_URL, {}, { isDevelopment: false });
    expect(url).toBe(
      'postgresql://ci_user:s3cr3t@db:5432/ci_db?connection_limit=30&pool_timeout=60&connect_timeout=20&statement_timeout=30000'
    );
  });

  it('uses connection_limit=5 in development and in NODE_ENV=test', () => {
    expect(buildPrismaDatabaseUrl(BASE_URL, {}, { isDevelopment: true })).toContain('connection_limit=5&');
    expect(buildPrismaDatabaseUrl(BASE_URL, { NODE_ENV: 'test' }, { isDevelopment: false })).toContain(
      'connection_limit=5&'
    );
  });

  it('honours DATABASE_STATEMENT_TIMEOUT, DATABASE_CONNECTION_LIMIT and DATABASE_CONNECT_TIMEOUT overrides', () => {
    const url = buildPrismaDatabaseUrl(
      BASE_URL,
      {
        DATABASE_STATEMENT_TIMEOUT: '45000',
        DATABASE_CONNECTION_LIMIT: '12',
        DATABASE_CONNECT_TIMEOUT: '7',
      },
      { isDevelopment: false }
    );
    expect(url).toBe(
      'postgresql://ci_user:s3cr3t@db:5432/ci_db?connection_limit=12&pool_timeout=60&connect_timeout=7&statement_timeout=45000'
    );
  });

  it('treats DATABASE_USE_POOLER=true WITHOUT DATABASE_POOLER_HOST as direct mode', () => {
    const url = buildPrismaDatabaseUrl(BASE_URL, { DATABASE_USE_POOLER: 'true' }, { isDevelopment: false });
    expect(url).toContain('@db:5432/');
    expect(url).toContain('statement_timeout=30000');
  });

  it('passes a non-postgres URL through untouched', () => {
    expect(buildPrismaDatabaseUrl('mysql://x', POOLER_ENV, { isDevelopment: false })).toBe('mysql://x');
    expect(buildPrismaDatabaseUrl('', POOLER_ENV, { isDevelopment: false })).toBe('');
  });
});

describe('buildPrismaDatabaseUrl — pooler mode', () => {
  it('rewrites host to DATABASE_POOLER_HOST and port to 6432 by default, with no query parameters at all', () => {
    const url = buildPrismaDatabaseUrl(BASE_URL, POOLER_ENV, { isDevelopment: false });
    expect(url).toBe('postgresql://ci_user:s3cr3t@pgbouncer:6432/ci_db');
    for (const forbidden of ['statement_timeout', 'pgbouncer=', 'connection_limit', 'pool_timeout', 'connect_timeout']) {
      expect(url).not.toContain(forbidden);
    }
  });

  it('honours DATABASE_POOLER_PORT', () => {
    const url = buildPrismaDatabaseUrl(
      BASE_URL,
      { ...POOLER_ENV, DATABASE_POOLER_PORT: '7000' },
      { isDevelopment: false }
    );
    expect(url).toBe('postgresql://ci_user:s3cr3t@pgbouncer:7000/ci_db');
  });

  it('strips pooler-hostile parameters an operator may have left in the base URL (DB_URL_PARAMS)', () => {
    const url = buildPrismaDatabaseUrl(
      `${BASE_URL}?pgbouncer=true&statement_timeout=30000&application_name=ci`,
      POOLER_ENV,
      { isDevelopment: false }
    );
    expect(url).toBe('postgresql://ci_user:s3cr3t@pgbouncer:6432/ci_db?application_name=ci');
  });

  it('preserves credentials', () => {
    const url = buildPrismaDatabaseUrl('postgresql://u:p%40ss@db:5432/ci_db', POOLER_ENV, {
      isDevelopment: false,
    });
    expect(url).toBe('postgresql://u:p%40ss@pgbouncer:6432/ci_db');
  });
});

describe('buildRuntimeDatabaseUrl (raw pg pools) and getRuntimeDatabaseUrl', () => {
  it('returns the base URL unchanged with the pooler off (capability pool keeps today\'s raw URL)', () => {
    expect(buildRuntimeDatabaseUrl(BASE_URL, {})).toBe(BASE_URL);
    expect(buildRuntimeDatabaseUrl(BASE_URL, { DATABASE_USE_POOLER: 'false', DATABASE_POOLER_HOST: 'x' })).toBe(
      BASE_URL
    );
  });

  it('reroutes to the pooler without parameters when the pooler is on', () => {
    expect(buildRuntimeDatabaseUrl(BASE_URL, POOLER_ENV)).toBe('postgresql://ci_user:s3cr3t@pgbouncer:6432/ci_db');
  });

  it('getRuntimeDatabaseUrl resolves config.database.url (pooler off in this suite)', () => {
    expect(getRuntimeDatabaseUrl()).toBe(BASE_URL);
  });
});

describe('isDatabaseViaPooler / describeDatabaseTarget', () => {
  it('requires both flag and host', () => {
    expect(isDatabaseViaPooler({})).toBe(false);
    expect(isDatabaseViaPooler({ DATABASE_USE_POOLER: 'true' })).toBe(false);
    expect(isDatabaseViaPooler({ DATABASE_POOLER_HOST: 'pgbouncer' })).toBe(false);
    expect(isDatabaseViaPooler(POOLER_ENV)).toBe(true);
  });

  it('describes the target without credentials', () => {
    const direct = describeDatabaseTarget(BASE_URL, {});
    expect(direct).toEqual({ viaPooler: false, host: 'db', port: '5432' });
    const pooled = describeDatabaseTarget(buildRuntimeDatabaseUrl(BASE_URL, POOLER_ENV), POOLER_ENV);
    expect(pooled).toEqual({ viaPooler: true, host: 'pgbouncer', port: '6432' });
    expect(JSON.stringify(pooled)).not.toContain('s3cr3t');
  });
});

describe('assertMigrationTargetIsDirect', () => {
  it('is a no-op with the pooler off or when the base URL is direct', () => {
    expect(() => assertMigrationTargetIsDirect(BASE_URL, {})).not.toThrow();
    expect(() => assertMigrationTargetIsDirect(BASE_URL, POOLER_ENV)).not.toThrow();
  });

  it('throws when the base URL already points at the pooler host:port', () => {
    expect(() =>
      assertMigrationTargetIsDirect('postgresql://ci_user:s3cr3t@pgbouncer:6432/ci_db', POOLER_ENV)
    ).toThrow(/transaction pooler/);
  });
});
