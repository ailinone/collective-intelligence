// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Boot-time database gate (SAB plan Phase 1b): bounded SELECT 1 retries that
 * replace the database coupling the Swarm healthcheck used to carry. Pure
 * unit tests: the probe, the clock and the sleep are injected, and the pg
 * client is a fake, so nothing here opens a socket.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createPgSelectOneProbe,
  DatabaseStartupCheckError,
  DEFAULT_STARTUP_DB_CHECK_OPTIONS,
  resolveStartupDbCheckOptions,
  runStartupDatabaseCheck,
  sanitizeStartupDbErrorMessage,
  STARTUP_DB_CHECK_APPLICATION_NAME,
  startupDbCheckBackoffMs,
  StartupDbCheckTimeoutError,
  type StartupDbCheckLogger,
  type StartupDbCheckOptions,
  type StartupProbeClient,
} from '../startup-db-check';

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies StartupDbCheckLogger;
}

const FAST: StartupDbCheckOptions = {
  attempts: 4,
  initialDelayMs: 1000,
  maxDelayMs: 3000,
  attemptTimeoutMs: 1000,
};

describe('resolveStartupDbCheckOptions', () => {
  it('uses the defaults when nothing is set', () => {
    expect(resolveStartupDbCheckOptions({})).toEqual({ ...DEFAULT_STARTUP_DB_CHECK_OPTIONS });
  });

  it('defaults give up well before the healthcheck unhealthy window (90 s + 6 x 30 s)', () => {
    const d = DEFAULT_STARTUP_DB_CHECK_OPTIONS;
    let worstCaseMs = d.attempts * d.attemptTimeoutMs;
    for (let failed = 1; failed < d.attempts; failed++) {
      worstCaseMs += startupDbCheckBackoffMs(failed, d);
    }
    expect(worstCaseMs).toBeLessThan(270_000);
    // ...and still cover the ~1 min "too many clients" bursts seen in rollouts.
    let backoffOnlyMs = 0;
    for (let failed = 1; failed < d.attempts; failed++) {
      backoffOnlyMs += startupDbCheckBackoffMs(failed, d);
    }
    expect(backoffOnlyMs).toBeGreaterThanOrEqual(60_000);
  });

  it('reads the operator overrides', () => {
    expect(
      resolveStartupDbCheckOptions({
        DATABASE_STARTUP_CHECK_ATTEMPTS: '3',
        DATABASE_STARTUP_CHECK_INITIAL_DELAY_MS: '250',
        DATABASE_STARTUP_CHECK_MAX_DELAY_MS: '4000',
        DATABASE_STARTUP_CHECK_TIMEOUT_MS: '2000',
      })
    ).toEqual({ attempts: 3, initialDelayMs: 250, maxDelayMs: 4000, attemptTimeoutMs: 2000 });
  });

  it.each(['0', '-1', 'abc', '1.5', '', '  ', '10ms'])(
    'falls back to the default for an invalid value (%j), so a typo never disables the gate',
    (value) => {
      const options = resolveStartupDbCheckOptions({
        DATABASE_STARTUP_CHECK_ATTEMPTS: value,
        DATABASE_STARTUP_CHECK_TIMEOUT_MS: value,
      });
      expect(options.attempts).toBe(DEFAULT_STARTUP_DB_CHECK_OPTIONS.attempts);
      expect(options.attemptTimeoutMs).toBe(DEFAULT_STARTUP_DB_CHECK_OPTIONS.attemptTimeoutMs);
    }
  );

  it('never lets the max delay drop below the initial delay', () => {
    const options = resolveStartupDbCheckOptions({
      DATABASE_STARTUP_CHECK_INITIAL_DELAY_MS: '5000',
      DATABASE_STARTUP_CHECK_MAX_DELAY_MS: '100',
    });
    expect(options.maxDelayMs).toBe(5000);
  });
});

describe('startupDbCheckBackoffMs', () => {
  it('doubles from the initial delay and caps at the max delay', () => {
    const opts = { initialDelayMs: 1000, maxDelayMs: 15000 };
    expect([1, 2, 3, 4, 5, 6].map((n) => startupDbCheckBackoffMs(n, opts))).toEqual([
      1000, 2000, 4000, 8000, 15000, 15000,
    ]);
  });

  it('stays finite for absurd attempt numbers', () => {
    expect(startupDbCheckBackoffMs(10_000, { initialDelayMs: 1000, maxDelayMs: 15000 })).toBe(15000);
  });
});

describe('sanitizeStartupDbErrorMessage', () => {
  it('redacts the password of a postgres URL', () => {
    const message = sanitizeStartupDbErrorMessage(
      new Error('cannot parse postgresql://app_user:s3cr3t-pass@db:5432/app_db?x=1')
    );
    expect(message).not.toContain('s3cr3t-pass');
    expect(message).toContain('postgresql://app_user:***@db:5432/app_db');
  });

  it('keeps only the first line and accepts non-Error values', () => {
    expect(sanitizeStartupDbErrorMessage(new Error('first\nsecond'))).toBe('first');
    expect(sanitizeStartupDbErrorMessage('plain')).toBe('plain');
  });
});

describe('runStartupDatabaseCheck', () => {
  it('returns on the first successful SELECT 1 without sleeping', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const logger = makeLogger();
    const probe = vi.fn(async () => undefined);

    const result = await runStartupDatabaseCheck({
      probe,
      options: FAST,
      logger,
      sleep,
      target: { host: 'db', port: '5432', viaPooler: false },
    });

    expect(result.attempts).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'db', port: '5432', viaPooler: false, attempt: 1 }),
      expect.stringContaining('Database reachable at startup')
    );
  });

  it('retries transient failures (too many clients, refused) with exponential backoff', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const logger = makeLogger();
    const probe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(pgError('53300', 'sorry, too many clients already'))
      .mockRejectedValueOnce(pgError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:5432'))
      .mockResolvedValueOnce(undefined);

    const result = await runStartupDatabaseCheck({ probe, options: FAST, logger, sleep });

    expect(result.attempts).toBe(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ attempt: 1, code: '53300', retryInMs: 1000 }),
      expect.any(String)
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('throws DatabaseStartupCheckError after the last attempt so the bootstrap exits non-zero', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const logger = makeLogger();
    const probe = vi.fn(async () => {
      throw pgError('53300', 'sorry, too many clients already');
    });

    const failure = await runStartupDatabaseCheck({ probe, options: FAST, logger, sleep }).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(DatabaseStartupCheckError);
    const error = failure as DatabaseStartupCheckError;
    expect(error.attempts).toBe(FAST.attempts);
    expect(error.lastErrorCode).toBe('53300');
    expect(error.message).toContain('too many clients');
    expect(probe).toHaveBeenCalledTimes(FAST.attempts);
    // Backoff capped at maxDelayMs (3000): 1000, 2000, 3000.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 3000]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['28P01', 'password authentication failed for user "app_user"'],
    ['28000', 'no pg_hba.conf entry for host'],
    ['3D000', 'database "app_db" does not exist'],
  ])('fails on the first non-retryable error (%s) without retrying', async (code, message) => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const probe = vi.fn(async () => {
      throw pgError(code, message);
    });

    await expect(
      runStartupDatabaseCheck({ probe, options: FAST, logger: makeLogger(), sleep })
    ).rejects.toMatchObject({ name: 'DatabaseStartupCheckError', attempts: 1, lastErrorCode: code });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('bounds a hung probe with the per-attempt timeout', async () => {
    const probe = vi.fn(() => new Promise<void>(() => {}));

    const failure = await runStartupDatabaseCheck({
      probe,
      options: { attempts: 2, initialDelayMs: 1, maxDelayMs: 1, attemptTimeoutMs: 20 },
      logger: makeLogger(),
      sleep: async () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DatabaseStartupCheckError);
    expect((failure as DatabaseStartupCheckError).lastErrorCode).toBe(
      new StartupDbCheckTimeoutError(20).code
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('treats a synchronous throw from the probe as a failed attempt', async () => {
    const probe = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error('sync boom');
      })
      .mockResolvedValueOnce(undefined);

    const result = await runStartupDatabaseCheck({
      probe,
      options: FAST,
      logger: makeLogger(),
      sleep: async () => undefined,
    });

    expect(result.attempts).toBe(2);
  });

  it('never logs or throws the database password', async () => {
    const logger = makeLogger();
    const probe = vi.fn(async () => {
      throw new Error('bad url postgres://app_user:hunter2@db:5432/app_db');
    });

    const failure = await runStartupDatabaseCheck({
      probe,
      options: { ...FAST, attempts: 2 },
      logger,
      sleep: async () => undefined,
    }).catch((error: unknown) => error);

    const everything = JSON.stringify([
      logger.warn.mock.calls,
      logger.error.mock.calls,
      (failure as Error).message,
      failure,
    ]);
    expect(everything).not.toContain('hunter2');
  });

  it('reports elapsed time from the injected clock', async () => {
    let t = 1_000;
    const probe = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        t += 700;
        throw pgError('53300', 'too many clients');
      })
      .mockImplementationOnce(async () => {
        t += 300;
      });

    const result = await runStartupDatabaseCheck({
      probe,
      options: FAST,
      logger: makeLogger(),
      sleep: async () => undefined,
      now: () => t,
    });

    expect(result).toEqual({ attempts: 2, elapsedMs: 1000 });
  });
});

describe('createPgSelectOneProbe', () => {
  function fakeClient(overrides: Partial<StartupProbeClient> = {}) {
    const client = {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })),
      end: vi.fn(async () => undefined),
      on: vi.fn(),
      ...overrides,
    };
    return client;
  }

  it('opens a dedicated client with bounded timeouts and runs SELECT 1', async () => {
    const client = fakeClient();
    const factory = vi.fn(() => client);

    await createPgSelectOneProbe('postgresql://u:p@db:5432/app_db', 4000, factory)();

    expect(factory).toHaveBeenCalledWith({
      connectionString: 'postgresql://u:p@db:5432/app_db',
      connectionTimeoutMillis: 4000,
      query_timeout: 4000,
      application_name: STARTUP_DB_CHECK_APPLICATION_NAME,
    });
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SELECT 1');
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('propagates a connect failure, skips the query and still closes the client', async () => {
    const client = fakeClient({
      connect: vi.fn(async () => {
        throw pgError('53300', 'sorry, too many clients already');
      }),
    });

    await expect(createPgSelectOneProbe('postgresql://db/app_db', 1000, () => client)()).rejects.toMatchObject({
      code: '53300',
    });
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('does not turn a successful SELECT 1 into a failure when closing fails', async () => {
    const rejecting = fakeClient({ end: vi.fn(async () => Promise.reject(new Error('end failed'))) });
    await expect(createPgSelectOneProbe('postgresql://db/app_db', 1000, () => rejecting)()).resolves.toBeUndefined();

    const throwing = fakeClient({
      end: vi.fn(() => {
        throw new Error('sync end failure');
      }),
    });
    await expect(createPgSelectOneProbe('postgresql://db/app_db', 1000, () => throwing)()).resolves.toBeUndefined();
  });

  it('does not wait for end() to settle before resolving', async () => {
    const client = fakeClient({ end: vi.fn(() => new Promise<void>(() => {})) });
    await expect(createPgSelectOneProbe('postgresql://db/app_db', 1000, () => client)()).resolves.toBeUndefined();
  });

  it('keeps the error listener harmless (pg emits socket errors on idle clients)', async () => {
    const on = vi.fn();
    const client = fakeClient({ on });
    await createPgSelectOneProbe('postgresql://db/app_db', 1000, () => client)();
    const listener = on.mock.calls[0][1] as (err: Error) => void;
    expect(() => listener(new Error('Connection terminated unexpectedly'))).not.toThrow();
  });
});
