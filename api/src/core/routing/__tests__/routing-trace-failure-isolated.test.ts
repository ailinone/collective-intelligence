// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-trace-failure-isolated.test.ts — MVP 3
 *
 * Proves that a persistor that throws does NOT propagate the error to
 * the request path. `flush` resolves normally even when the persistor
 * rejects, and the error is recorded in
 * `routing_trace_persist_error_total`.
 */

import { describe, expect, it } from 'vitest';
import {
  RoutingTraceCollector,
  ROUTING_TRACE_METRIC_NAMES,
} from '../routing-trace-collector';
import type { RoutingTracePersistor } from '../routing-trace-collector';
import type { RoutingTraceMetrics } from '../routing-decision-trace';
import { makeValidTrace } from './fixtures/routing-trace.fixture';

class CountingMetrics implements RoutingTraceMetrics {
  public counters: Record<string, number> = {};
  public persistErrorReasons: Record<string, number> = {};
  public gauges: Record<string, number> = {};
  increment(name: string, labels?: Readonly<Record<string, string>>): void {
    this.counters[name] = (this.counters[name] ?? 0) + 1;
    if (
      name === ROUTING_TRACE_METRIC_NAMES.PERSIST_ERROR_TOTAL &&
      labels?.reason
    ) {
      this.persistErrorReasons[labels.reason] =
        (this.persistErrorReasons[labels.reason] ?? 0) + 1;
    }
  }
  gauge(name: string, value: number): void {
    this.gauges[name] = value;
  }
}

describe('routing-trace-failure-isolated — persistor errors stay contained', () => {
  it('persistor that throws synchronously does NOT propagate from flush', async () => {
    const persistor: RoutingTracePersistor = {
      persist() {
        throw new Error('synthetic sync error');
      },
    };
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({ persistor, metrics });
    collector.enqueue(makeValidTrace('t-1'));
    await expect(collector.flush()).resolves.toBeUndefined();
    expect(metrics.counters[ROUTING_TRACE_METRIC_NAMES.PERSIST_ERROR_TOTAL]).toBe(1);
  });

  it('persistor that rejects async does NOT propagate from flush', async () => {
    const persistor: RoutingTracePersistor = {
      async persist() {
        throw new Error('synthetic async error');
      },
    };
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({ persistor, metrics });
    collector.enqueue(makeValidTrace('t-1'));
    await expect(collector.flush()).resolves.toBeUndefined();
    expect(metrics.counters[ROUTING_TRACE_METRIC_NAMES.PERSIST_ERROR_TOTAL]).toBe(1);
  });

  it('classifies error by name in routing_trace_persist_error_total', async () => {
    class MyAbortError extends Error {
      override name = 'AbortError';
    }
    const persistor: RoutingTracePersistor = {
      async persist() {
        throw new MyAbortError('upstream timed out');
      },
    };
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({ persistor, metrics });
    collector.enqueue(makeValidTrace('t-1'));
    await collector.flush();
    expect(metrics.persistErrorReasons.AbortError).toBe(1);
  });

  it('after a failed flush, the collector continues accepting new enqueues', async () => {
    let shouldFail = true;
    const persistor: RoutingTracePersistor = {
      async persist() {
        if (shouldFail) throw new Error('transient');
      },
    };
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({ persistor, metrics, batchSize: 2 });

    collector.enqueue(makeValidTrace('t-1'));
    collector.enqueue(makeValidTrace('t-2'));
    await collector.flush(); // fails — recorded

    // Collector still works.
    collector.enqueue(makeValidTrace('t-3'));
    expect(collector.size()).toBe(1);

    shouldFail = false;
    await collector.flush(); // succeeds
    expect(collector.size()).toBe(0);
    expect(metrics.counters[ROUTING_TRACE_METRIC_NAMES.PERSIST_ERROR_TOTAL]).toBe(1);
  });

  it('failed persist DOES NOT re-queue the failed batch (deliberate drop)', async () => {
    const persistedBatches: number[] = [];
    let shouldFail = true;
    const persistor: RoutingTracePersistor = {
      async persist(batch) {
        if (shouldFail) throw new Error('transient');
        persistedBatches.push(batch.length);
      },
    };
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({ persistor, metrics });

    collector.enqueue(makeValidTrace('t-1'));
    collector.enqueue(makeValidTrace('t-2'));
    await collector.flush(); // throws, batch is consumed and dropped

    shouldFail = false;
    await collector.flush(); // no-op — queue empty
    expect(persistedBatches).toEqual([]); // 0 because failed batch is dropped, queue empty
    expect(collector.size()).toBe(0);
  });
});
