// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ailin_dev_db_connection_pool_size / ailin_dev_db_errors_total were declared
 * in utils/metrics.ts but never written. pool-metrics.ts feeds them from a
 * pg.Pool; this pins the label shape a pooler canary dashboard depends on.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachPoolMetrics, samplePoolSize } from '../pool-metrics';
import { dbConnectionPoolSize, dbErrors } from '@/utils/metrics';

class FakePool extends EventEmitter {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
}

async function gaugeValue(pool: string, state: string): Promise<number | undefined> {
  const snapshot = await dbConnectionPoolSize.get();
  return snapshot.values.find((v) => v.labels.pool === pool && v.labels.state === state)?.value;
}

async function counterValue(errorType: string): Promise<number> {
  const snapshot = await dbErrors.get();
  return snapshot.values.find((v) => v.labels.error_type === errorType)?.value ?? 0;
}

describe('pool-metrics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('samplePoolSize writes total/idle/waiting under the given pool label', async () => {
    const pool = new FakePool();
    pool.totalCount = 7;
    pool.idleCount = 3;
    pool.waitingCount = 2;

    samplePoolSize(pool, 'sample-test');

    expect(await gaugeValue('sample-test', 'total')).toBe(7);
    expect(await gaugeValue('sample-test', 'idle')).toBe(3);
    expect(await gaugeValue('sample-test', 'waiting')).toBe(2);
  });

  it("pool 'error' increments ailin_dev_db_errors_total{error_type=<pg code>} (57P01 = admin shutdown)", async () => {
    const pool = new FakePool();
    const before = await counterValue('57P01');
    const timer = attachPoolMetrics(pool, 'err-test');
    expect(timer).toBeNull(); // NODE_ENV=test: no sampler timer

    pool.emit('error', Object.assign(new Error('terminating connection'), { code: '57P01' }));
    pool.emit('error', new Error('no code'));

    expect(await counterValue('57P01')).toBe(before + 1);
    expect(await counterValue('unknown')).toBeGreaterThanOrEqual(1);
  });

  it('sampler (when enabled) writes the gauge every interval and is unref-ed', async () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.totalCount = 5;
    pool.idleCount = 1;
    pool.waitingCount = 4;

    const timer = attachPoolMetrics(pool, 'sampler-test', { enableSampler: true, sampleIntervalMs: 1000 });
    expect(timer).not.toBeNull();
    try {
      expect(await gaugeValue('sampler-test', 'waiting')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await gaugeValue('sampler-test', 'total')).toBe(5);
      expect(await gaugeValue('sampler-test', 'idle')).toBe(1);
      expect(await gaugeValue('sampler-test', 'waiting')).toBe(4);
    } finally {
      clearInterval(timer!);
    }
  });
});
