// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Feeds the long-declared-but-never-written pool metrics
 * (`ailin_dev_db_connection_pool_size`, `ailin_dev_db_errors_total`) from a
 * `pg.Pool`. Shared by the Prisma adapter pool and the capability pool so a
 * pgbouncer canary can see queueing (`waiting`) per pool instead of guessing
 * from latency.
 */
import { dbConnectionPoolSize, dbErrors } from '@/utils/metrics';
import { extractErrorCodeFromObject } from '@/utils/type-guards';

export interface PoolMetricsSource {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface PoolMetricsOptions {
  sampleIntervalMs?: number;
  /** Defaults to off under NODE_ENV=test so suites never leak timers. */
  enableSampler?: boolean;
}

export const DEFAULT_POOL_SAMPLE_INTERVAL_MS = 15_000;

export function samplePoolSize(pool: PoolMetricsSource, poolLabel: string): void {
  dbConnectionPoolSize.set({ pool: poolLabel, state: 'total' }, pool.totalCount);
  dbConnectionPoolSize.set({ pool: poolLabel, state: 'idle' }, pool.idleCount);
  dbConnectionPoolSize.set({ pool: poolLabel, state: 'waiting' }, pool.waitingCount);
}

export function recordPoolError(error: unknown): void {
  const code = extractErrorCodeFromObject(error);
  dbErrors.inc({ error_type: code ?? 'unknown' });
}

/**
 * Registers the error counter and (outside tests) a periodic size sampler.
 * Returns the sampler handle so a pool replacement can clear it.
 */
export function attachPoolMetrics(
  pool: PoolMetricsSource,
  poolLabel: string,
  options: PoolMetricsOptions = {}
): NodeJS.Timeout | null {
  pool.on('error', recordPoolError);

  const enableSampler = options.enableSampler ?? process.env.NODE_ENV !== 'test';
  if (!enableSampler) {
    return null;
  }

  const timer = setInterval(
    () => samplePoolSize(pool, poolLabel),
    options.sampleIntervalMs ?? DEFAULT_POOL_SAMPLE_INTERVAL_MS
  );
  timer.unref();
  return timer;
}
