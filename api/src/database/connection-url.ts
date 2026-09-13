// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Runtime database target resolution (direct Postgres vs. pgbouncer).
 *
 * Pure module, deliberately free of Prisma/pg imports so it can be unit-tested
 * and reused by every pool in the process (Prisma adapter pool, capability
 * raw pool, SAB candidate-index worker pool) without dragging the Prisma
 * client singleton into the importer.
 *
 * Contract:
 * - `config.database.url` is ALWAYS the direct Postgres URL (compose builds it
 *   from `DB_HOST:-db` / `DB_PORT:-5432`). Migrations, db-backup and the CI
 *   one-off migrate keep using it untouched.
 * - `DATABASE_USE_POOLER=true` + `DATABASE_POOLER_HOST=<host>` is the ONLY
 *   opt-in for routing runtime query traffic through the pooler. The runtime
 *   URL then rewrites host/port and carries NO query parameters: pgbouncer
 *   (transaction mode) rejects unknown startup parameters such as
 *   `statement_timeout` with `FATAL: unsupported startup parameter`, and
 *   `?pgbouncer=true` has no effect with `@prisma/adapter-pg` (the driver
 *   adapter already issues unnamed statements) and is discouraged by Prisma
 *   for pgbouncer >= 1.21.
 * - With the pooler off, the direct URL is returned byte-for-byte, so an
 *   environment that never sets the flag behaves exactly as before.
 */

import { config } from '@/config';

export type DatabaseEnv = Record<string, string | undefined>;

export const DEFAULT_POOLER_PORT = '6432';

/** Query parameters node-postgres would place in the StartupMessage (or
 *  that are Prisma-engine-only) and that must never reach pgbouncer. */
const POOLER_HOSTILE_PARAMS = [
  'statement_timeout',
  'pgbouncer',
  'connection_limit',
  'pool_timeout',
  'connect_timeout',
] as const;

export function isPostgresUrl(url: string | undefined | null): url is string {
  return !!url && (url.includes('postgresql://') || url.includes('postgres://'));
}

export function isDatabaseViaPooler(env: DatabaseEnv = process.env): boolean {
  return env.DATABASE_USE_POOLER === 'true' && !!env.DATABASE_POOLER_HOST;
}

function toParsableUrl(url: string): URL {
  return new URL(url.replace('postgresql://', 'http://').replace('postgres://', 'http://'));
}

function fromParsableUrl(url: URL): string {
  return url.toString().replace('http://', 'postgresql://');
}

/**
 * Runtime URL for raw `pg.Pool`s (capability pool, SAB worker pool).
 * Direct mode: the base URL, unchanged. Pooler mode: host/port rewritten to
 * the pooler and pooler-hostile query parameters stripped.
 */
export function buildRuntimeDatabaseUrl(baseUrl: string, env: DatabaseEnv = process.env): string {
  if (!isPostgresUrl(baseUrl) || !isDatabaseViaPooler(env)) {
    return baseUrl;
  }

  const url = toParsableUrl(baseUrl);
  url.hostname = env.DATABASE_POOLER_HOST!;
  url.port = env.DATABASE_POOLER_PORT || DEFAULT_POOLER_PORT;
  for (const param of POOLER_HOSTILE_PARAMS) {
    url.searchParams.delete(param);
  }
  return fromParsableUrl(url);
}

// Captured ONCE at import time, from the same early-captured
// `config.database.url` that Prisma uses: `load-secrets-into-env.ts` later
// overwrites `process.env.DATABASE_URL` with the GCP secret (stale host
// a stale internal DB hostname, 2026-09-07 incident), so every pool must resolve its target here
// rather than re-reading `process.env` lazily.
const runtimeDatabaseUrl = buildRuntimeDatabaseUrl(config.database.url);

/** Runtime URL for raw pg.Pools, resolved once at import (see above). */
export function getRuntimeDatabaseUrl(): string {
  return runtimeDatabaseUrl;
}

export interface PrismaUrlOptions {
  /** `isDevelopment` from `@/config`; drives the direct-mode connection_limit default. */
  isDevelopment: boolean;
}

/**
 * URL handed to the Prisma adapter's `pg.Pool`.
 *
 * Direct mode keeps today's query parameters exactly (`connection_limit`,
 * `pool_timeout`, `connect_timeout`, `statement_timeout`): node-postgres
 * ignores the first three but sends `statement_timeout` in the startup
 * packet, which is the per-session 30 s backstop production relies on.
 *
 * Pooler mode carries none of them: the backstop moves to the pooler side
 * (`CONNECT_QUERY` / `ALTER ROLE ... SET statement_timeout`, see
 * docs/runbooks/pgbouncer-cutover.md); the app-level `SET LOCAL
 * statement_timeout` inside `$transaction` keeps working unchanged.
 */
export function buildPrismaDatabaseUrl(
  baseUrl: string,
  env: DatabaseEnv,
  options: PrismaUrlOptions
): string {
  if (!isPostgresUrl(baseUrl)) {
    return baseUrl;
  }

  if (isDatabaseViaPooler(env)) {
    return buildRuntimeDatabaseUrl(baseUrl, env);
  }

  const url = toParsableUrl(baseUrl);

  // DATABASE_CONNECTION_LIMIT (operator override) takes precedence in
  // every mode. Default is mode-aware: small in dev/test (5) to keep
  // local Postgres usage modest, larger in prod (30) for real load.
  // The override matters because dev orchestration runs 4+ concurrent
  // background workers (auto-learning, periodic flushers) on top of
  // request handlers, and at pool=5 they starve auth queries that
  // then return as 401 "invalid api key" (the symptom that masks
  // pool exhaustion).
  const poolConfig: Record<string, string> = {
    connection_limit:
      env.DATABASE_CONNECTION_LIMIT ||
      (options.isDevelopment || env.NODE_ENV === 'test' ? '5' : '30'),
    pool_timeout: '60',
    // Docker/Cloud environments (e.g. Cloud SQL proxy) need more than 10 s.
    connect_timeout: env.DATABASE_CONNECT_TIMEOUT || '20',
    // Per-session backstop; transactions override it with SET LOCAL.
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT || '30000',
  };

  for (const [key, value] of Object.entries(poolConfig)) {
    url.searchParams.set(key, value);
  }

  return fromParsableUrl(url);
}

export interface DatabaseTargetDescription {
  viaPooler: boolean;
  host: string | null;
  port: string | null;
}

/** Credential-free description of where runtime traffic goes, for boot logs. */
export function describeDatabaseTarget(
  runtimeUrl: string,
  env: DatabaseEnv = process.env
): DatabaseTargetDescription {
  if (!isPostgresUrl(runtimeUrl)) {
    return { viaPooler: false, host: null, port: null };
  }
  try {
    const url = toParsableUrl(runtimeUrl);
    return {
      viaPooler: isDatabaseViaPooler(env),
      host: url.hostname || null,
      port: url.port || '5432',
    };
  } catch {
    return { viaPooler: isDatabaseViaPooler(env), host: null, port: null };
  }
}

/**
 * Prisma interactive-transaction defaults.
 *
 * Direct mode: `undefined`, so Prisma keeps its own defaults (maxWait 2 s,
 * timeout 5 s) and nothing changes.
 *
 * Pooler mode: the BEGIN of an interactive transaction may wait in the
 * pooler queue for a backend. `maxWait` stays BELOW pgbouncer's
 * `QUERY_WAIT_TIMEOUT` (10 s in compose) so a saturated pool surfaces as a
 * retryable P2028 from Prisma with the client connection intact, instead of
 * the pooler killing the connection first. Covers every `$transaction`
 * call that passes no options (prepaid wallet, auth-service).
 */
export const POOLER_TRANSACTION_MAX_WAIT_MS = 8000;
export const POOLER_TRANSACTION_TIMEOUT_MS = 15000;

export function resolveTransactionOptions(
  env: DatabaseEnv = process.env
): { maxWait: number; timeout: number } | undefined {
  if (!isDatabaseViaPooler(env)) {
    return undefined;
  }
  return { maxWait: POOLER_TRANSACTION_MAX_WAIT_MS, timeout: POOLER_TRANSACTION_TIMEOUT_MS };
}

/**
 * Fail-closed guard for `prisma migrate deploy`: the Schema Engine holds a
 * session-level `pg_advisory_lock` on a single connection, which transaction
 * pooling cannot honour. If an operator followed the old compose comment and
 * pointed `DB_HOST` at the pooler while also enabling `DATABASE_USE_POOLER`,
 * the base URL itself targets the pooler; refuse instead of letting migrate
 * hang or apply with broken semantics.
 */
export function assertMigrationTargetIsDirect(baseUrl: string, env: DatabaseEnv = process.env): void {
  if (!isPostgresUrl(baseUrl) || !isDatabaseViaPooler(env)) {
    return;
  }
  const poolerHost = env.DATABASE_POOLER_HOST!;
  const poolerPort = env.DATABASE_POOLER_PORT || DEFAULT_POOLER_PORT;
  let url: URL;
  try {
    url = toParsableUrl(baseUrl);
  } catch {
    return;
  }
  const port = url.port || '5432';
  if (url.hostname === poolerHost && port === poolerPort) {
    throw new Error(
      `Refusing to run prisma migrate through the transaction pooler (${poolerHost}:${poolerPort}). ` +
        'DATABASE_URL must point at Postgres directly (DB_HOST=db); DATABASE_USE_POOLER only reroutes ' +
        'runtime query traffic.'
    );
  }
}
