// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-trace-async.test.ts — MVP 3
 *
 * Proves that `RoutingTraceCollector.enqueue` is SYNCHRONOUS and does
 * NOT await the persistor. The hot path can call enqueue without a
 * `try/catch` and without `await`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutingTraceCollector } from '../routing-trace-collector';
import type { RoutingTracePersistor } from '../routing-trace-collector';
import type { RoutingDecisionTrace } from '../routing-decision-trace';
import { makeValidTrace } from './fixtures/routing-trace.fixture';

function makePersistor(): RoutingTracePersistor & { calls: number; lastBatch: ReadonlyArray<RoutingDecisionTrace> | null } {
  let calls = 0;
  let lastBatch: ReadonlyArray<RoutingDecisionTrace> | null = null;
  return {
    calls,
    lastBatch,
    async persist(batch) {
      this.calls += 1;
      this.lastBatch = batch;
    },
  } as never;
}

describe('routing-trace-async — enqueue is synchronous and non-blocking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enqueue returns synchronously (does NOT return a Promise)', () => {
    const persistor = makePersistor();
    const collector = new RoutingTraceCollector({ persistor });
    const ret = collector.enqueue(makeValidTrace('t-1'));
    expect(ret).toBeUndefined();
  });

  it('enqueue does NOT await the persistor', async () => {
    const persistor = makePersistor();
    const persistSpy = vi.spyOn(persistor, 'persist');
    const collector = new RoutingTraceCollector({ persistor });
    collector.enqueue(makeValidTrace('t-1'));
    collector.enqueue(makeValidTrace('t-2'));
    // Persistor not called until flush.
    expect(persistSpy).not.toHaveBeenCalled();
    // Queue still holds both traces.
    expect(collector.size()).toBe(2);
  });

  it('persist runs only on manual flush', async () => {
    const persistor = makePersistor();
    const persistSpy = vi.spyOn(persistor, 'persist');
    const collector = new RoutingTraceCollector({ persistor });
    collector.enqueue(makeValidTrace('t-1'));
    collector.enqueue(makeValidTrace('t-2'));
    expect(persistSpy).not.toHaveBeenCalled();
    await collector.flush();
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy.mock.calls[0][0].length).toBe(2);
    expect(collector.size()).toBe(0);
  });

  it('enqueue with a slow persistor returns immediately', async () => {
    let resolveSlow: () => void = () => {};
    const slowPromise = new Promise<void>((res) => {
      resolveSlow = res;
    });
    const persistor: RoutingTracePersistor = {
      persist: () => slowPromise,
    };
    const collector = new RoutingTraceCollector({ persistor });

    const t0 = performance.now();
    for (let i = 0; i < 100; i += 1) {
      collector.enqueue(makeValidTrace(`t-${i}`));
    }
    const t1 = performance.now();
    // 100 enqueues should easily fit under 50 ms even on a slow CI box.
    expect(t1 - t0).toBeLessThan(50);
    expect(collector.size()).toBe(100);

    // Resolve the slow persistor to keep teardown clean.
    resolveSlow();
    await slowPromise.catch(() => undefined);
  });

  it('flush with empty queue is a no-op (does not call persistor)', async () => {
    const persistor = makePersistor();
    const persistSpy = vi.spyOn(persistor, 'persist');
    const collector = new RoutingTraceCollector({ persistor });
    await collector.flush();
    expect(persistSpy).not.toHaveBeenCalled();
  });
});
