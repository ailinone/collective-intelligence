// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Boot-time database gate for the api and worker processes.
 *
 * Why this exists: the Swarm healthchecks of `api` and `worker` probe
 * liveness only (`/health/live` and `/health`), so they no longer touch the
 * database. `/health/ready` ran `SELECT 1` through the shared Prisma pool,
 * whose acquisition wait (20 s) is longer than the healthcheck `timeout`
 * (10 s): an exhausted pool or a slow database for a few minutes made the
 * Swarm kill healthy tasks, and each replacement opened a fresh pool against
 * the same saturated server. With a liveness-only healthcheck, the only DB
 * guarantee left at boot is `prisma migrate deploy`, and that goes away once
 * `SKIP_DB_MIGRATIONS=true` moves migrations to the pipeline. This check
 * keeps the guarantee explicit and independent of migrations: a task that
 * cannot run `SELECT 1` against its runtime database target within a bounded
 * budget exits non-zero BEFORE it starts serving (api) or listening for its
 * healthcheck (worker), so a start-first rollout rolls back instead of
 * promoting a task that cannot reach Postgres.
 *
 * Design notes:
 * - One short-lived `pg.Client` per attempt, NOT the Prisma pool and NOT the
 *   shared database circuit breaker: the probe never holds a pool slot for
 *   the pool's 60 s idle window, and boot-time failures cannot open the
 *   breaker that `/health/ready` and request traffic depend on later.
 * - Connects to the same runtime target as the raw pg pools
 *   (`getRuntimeDatabaseUrl()`), so with `DATABASE_USE_POOLER=true` it
 *   checks the pooler path the process will actually use.
 * - Bounded exponential backoff. Defaults ride out the short "too many
 *   clients" bursts seen during rollouts (up to ~1 min) and give up well
 *   before the healthcheck's own unhealthy window (start_period 90 s +
 *   6 x 30 s).
 * - Credentials never reach logs or the thrown error: messages are reduced
 *   to their first line and any `postgres://user:password@` is redacted.
 *
 * Pure module (only `pg` and the dependency-free type guards are imported) so
 * it can be unit-tested without the Prisma client singleton or `@/config`.
 */

import pg from 'pg';
import { extractErrorCodeFromObject } from '@/utils/type-guards';

export interface StartupDbCheckOptions {
  /** Total attempts, including the first one. */
  attempts: number;
  /** Delay after the first failed attempt; doubles on every further failure. */
  initialDelayMs: number;
  /** Upper bound for a single backoff delay. */
  maxDelayMs: number;
  /** Bound for one attempt (connect + SELECT 1). */
  attemptTimeoutMs: number;
}

/**
 * Worst case with the defaults: 10 attempts x 5 s timeout plus
 * 1+2+4+8+15x5 = 90 s of backoff, about 140 s. A refused connection or a
 * "too many clients" FATAL fails immediately, so a hard outage exits after
 * roughly 90 s.
 */
export const DEFAULT_STARTUP_DB_CHECK_OPTIONS: Readonly<StartupDbCheckOptions> = Object.freeze({
  attempts: 10,
  initialDelayMs: 1_000,
  maxDelayMs: 15_000,
  attemptTimeoutMs: 5_000,
});

export const STARTUP_DB_CHECK_APPLICATION_NAME = 'ci-startup-db-check';

/**
 * SQLSTATEs that retrying cannot fix within a boot: wrong password, role not
 * allowed to log in, database missing. The check fails on the first one.
 * Everything else (refused, DNS, timeout, 53300 too_many_connections, 57P03
 * cannot_connect_now) is retried.
 */
export const NON_RETRYABLE_STARTUP_DB_ERROR_CODES: ReadonlySet<string> = new Set([
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification
  '3D000', // invalid_catalog_name (database does not exist)
]);

type Env = Record<string, string | undefined>;

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  if (!/^\d+$/.test(value.trim())) {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Operator overrides; anything missing or not a positive integer falls back
 * to the default so a typo can never disable the gate.
 */
export function resolveStartupDbCheckOptions(env: Env = process.env): StartupDbCheckOptions {
  const d = DEFAULT_STARTUP_DB_CHECK_OPTIONS;
  const initialDelayMs = positiveIntFromEnv(
    env.DATABASE_STARTUP_CHECK_INITIAL_DELAY_MS,
    d.initialDelayMs
  );
  const maxDelayMs = positiveIntFromEnv(env.DATABASE_STARTUP_CHECK_MAX_DELAY_MS, d.maxDelayMs);
  return {
    attempts: positiveIntFromEnv(env.DATABASE_STARTUP_CHECK_ATTEMPTS, d.attempts),
    initialDelayMs,
    maxDelayMs: Math.max(maxDelayMs, initialDelayMs),
    attemptTimeoutMs: positiveIntFromEnv(env.DATABASE_STARTUP_CHECK_TIMEOUT_MS, d.attemptTimeoutMs),
  };
}

/** Delay to wait after the `failedAttempt`-th failure (1-based). */
export function startupDbCheckBackoffMs(
  failedAttempt: number,
  options: Pick<StartupDbCheckOptions, 'initialDelayMs' | 'maxDelayMs'>
): number {
  const exponent = Math.max(0, failedAttempt - 1);
  // 2^30 already exceeds any sane maxDelayMs; avoid overflowing to Infinity.
  const factor = 2 ** Math.min(exponent, 30);
  return Math.min(options.initialDelayMs * factor, options.maxDelayMs);
}

const CREDENTIALS_IN_URL = /(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]*@/gi;

/** First line of the message, with any URL password replaced by `***`. */
export function sanitizeStartupDbErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split('\n', 1)[0] ?? '';
  return firstLine.replace(CREDENTIALS_IN_URL, '$1***@').slice(0, 500);
}

export class StartupDbCheckTimeoutError extends Error {
  readonly code = 'STARTUP_DB_CHECK_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`database probe did not answer within ${timeoutMs} ms`);
    this.name = 'StartupDbCheckTimeoutError';
  }
}

export class DatabaseStartupCheckError extends Error {
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly lastErrorCode: string | undefined;
  readonly lastErrorMessage: string;

  constructor(params: {
    attempts: number;
    elapsedMs: number;
    lastErrorCode: string | undefined;
    lastErrorMessage: string;
    nonRetryable: boolean;
  }) {
    const why = params.nonRetryable ? 'non-retryable error' : `${params.attempts} attempt(s)`;
    super(
      `Database unreachable at startup (SELECT 1 failed after ${why}, ${params.elapsedMs} ms): ` +
        `${params.lastErrorCode ? `[${params.lastErrorCode}] ` : ''}${params.lastErrorMessage}. ` +
        'Refusing to start so the orchestrator rolls back or restarts this task.'
    );
    this.name = 'DatabaseStartupCheckError';
    this.attempts = params.attempts;
    this.elapsedMs = params.elapsedMs;
    this.lastErrorCode = params.lastErrorCode;
    this.lastErrorMessage = params.lastErrorMessage;
  }
}

export type DatabaseProbe = () => Promise<void>;

export interface StartupDbCheckLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface StartupDbCheckResult {
  attempts: number;
  elapsedMs: number;
}

export interface RunStartupDbCheckParams {
  probe: DatabaseProbe;
  options: StartupDbCheckOptions;
  logger: StartupDbCheckLogger;
  /** Credential-free description of the target (host/port/viaPooler), logged as-is. */
  target?: Record<string, unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StartupDbCheckTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs `probe` until it succeeds or the budget is spent. Resolves with the
 * attempt count on success; throws `DatabaseStartupCheckError` otherwise.
 */
export async function runStartupDatabaseCheck(
  params: RunStartupDbCheckParams
): Promise<StartupDbCheckResult> {
  const { probe, options, logger, target = {} } = params;
  const sleep = params.sleep ?? defaultSleep;
  const now = params.now ?? Date.now;
  const attempts = Math.max(1, Math.floor(options.attempts));
  const startedAt = now();

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Promise.resolve().then() also turns a synchronous throw into a rejection.
      await withTimeout(
        Promise.resolve().then(() => probe()),
        options.attemptTimeoutMs
      );
      const elapsedMs = now() - startedAt;
      logger.info({ ...target, attempt, attempts, elapsedMs }, '✅ Database reachable at startup (SELECT 1)');
      return { attempts: attempt, elapsedMs };
    } catch (error: unknown) {
      const code = extractErrorCodeFromObject(error);
      const message = sanitizeStartupDbErrorMessage(error);
      const nonRetryable = code !== undefined && NON_RETRYABLE_STARTUP_DB_ERROR_CODES.has(code);
      const exhausted = attempt >= attempts;

      if (nonRetryable || exhausted) {
        const elapsedMs = now() - startedAt;
        logger.error(
          { ...target, attempt, attempts, elapsedMs, code, error: message, nonRetryable },
          'Database startup check failed, giving up'
        );
        throw new DatabaseStartupCheckError({
          attempts: attempt,
          elapsedMs,
          lastErrorCode: code,
          lastErrorMessage: message,
          nonRetryable,
        });
      }

      const delayMs = startupDbCheckBackoffMs(attempt, options);
      logger.warn(
        { ...target, attempt, attempts, code, error: message, retryInMs: delayMs },
        'Database not reachable at startup yet, retrying'
      );
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws on its last iteration.
  throw new Error('startup database check loop exited without a result');
}

/** Structural subset of `pg.Client` the probe needs (lets tests inject a fake). */
export interface StartupProbeClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type StartupProbeClientFactory = (config: pg.ClientConfig) => StartupProbeClient;

const defaultClientFactory: StartupProbeClientFactory = (config) => new pg.Client(config);

function closeInBackground(client: StartupProbeClient): void {
  try {
    client.end().catch(() => undefined);
  } catch {
    // A synchronous throw from end() must not change the probe's outcome.
  }
}

/**
 * `SELECT 1` over a dedicated, short-lived connection. The client-side
 * timeouts release the socket on their own; the runner's timeout bounds the
 * attempt regardless. The connection is closed in the background so a slow
 * `end()` never turns a successful probe into a failure.
 */
export function createPgSelectOneProbe(
  connectionString: string,
  timeoutMs: number,
  clientFactory: StartupProbeClientFactory = defaultClientFactory
): DatabaseProbe {
  return async () => {
    const client = clientFactory({
      connectionString,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      application_name: STARTUP_DB_CHECK_APPLICATION_NAME,
    });
    // pg emits 'error' on the client for socket errors outside a pending
    // call; without a listener Node would crash the process with it.
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.query('SELECT 1');
    } finally {
      closeInBackground(client);
    }
  };
}
