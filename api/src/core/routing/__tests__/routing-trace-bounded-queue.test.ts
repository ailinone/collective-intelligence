// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * routing-trace-bounded-queue.test.ts — MVP 3
 *
 * Proves that the queue respects `maxQueueSize`, evicts the OLDEST
 * trace on overflow, and increments the `routing_trace_dropped_total`
 * metric with `reason='queue_full'`.
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
  public dropReasons: Record<string, number> = {};
  public gauges: Record<string, number> = {};

  increment(name: string, labels?: Readonly<Record<string, string>>): void {
    this.counters[name] = (this.counters[name] ?? 0) + 1;
    if (name === ROUTING_TRACE_METRIC_NAMES.DROPPED_TOTAL && labels?.reason) {
      this.dropReasons[labels.reason] =
        (this.dropReasons[labels.reason] ?? 0) + 1;
    }
  }
  gauge(name: string, value: number): void {
    this.gauges[name] = value;
  }
}

const SILENT_PERSISTOR: RoutingTracePersistor = {
  async persist(): Promise<void> {
    /* drop on the floor */
  },
};

describe('routing-trace-bounded-queue — maxQueueSize is respected', () => {
  it('queue never exceeds maxQueueSize', () => {
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({
      persistor: SILENT_PERSISTOR,
      maxQueueSize: 3,
      metrics,
    });
    for (let i = 0; i < 10; i += 1) {
      collector.enqueue(makeValidTrace(`t-${i}`));
    }
    expect(collector.size()).toBe(3);
  });

  it('overflow evicts the OLDEST trace (FIFO)', () => {
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({
      persistor: SILENT_PERSISTOR,
      maxQueueSize: 3,
      metrics,
    });
    collector.enqueue(makeValidTrace('first'));
    collector.enqueue(makeValidTrace('second'));
    collector.enqueue(makeValidTrace('third'));
    collector.enqueue(makeValidTrace('fourth')); // evicts 'first'

    const snapshot = collector.snapshot();
    const ids = snapshot.map((t) => t.traceId);
    expect(ids).toEqual(['second', 'third', 'fourth']);
  });

  it('every overflow increments routing_trace_dropped_total{reason=queue_full}', () => {
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({
      persistor: SILENT_PERSISTOR,
      maxQueueSize: 2,
      metrics,
    });
    collector.enqueue(makeValidTrace('a'));
    collector.enqueue(makeValidTrace('b'));
    // no drop yet
    expect(metrics.counters[ROUTING_TRACE_METRIC_NAMES.DROPPED_TOTAL]).toBeUndefined();

    collector.enqueue(makeValidTrace('c')); // drop a
    collector.enqueue(makeValidTrace('d')); // drop b
    collector.enqueue(makeValidTrace('e')); // drop c

    expect(metrics.counters[ROUTING_TRACE_METRIC_NAMES.DROPPED_TOTAL]).toBe(3);
    expect(metrics.dropReasons.queue_full).toBe(3);
  });

  it('gauge routing_trace_queue_size reflects current size after each enqueue', () => {
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({
      persistor: SILENT_PERSISTOR,
      maxQueueSize: 5,
      metrics,
    });
    collector.enqueue(makeValidTrace('a'));
    expect(metrics.gauges[ROUTING_TRACE_METRIC_NAMES.QUEUE_SIZE]).toBe(1);
    collector.enqueue(makeValidTrace('b'));
    expect(metrics.gauges[ROUTING_TRACE_METRIC_NAMES.QUEUE_SIZE]).toBe(2);
  });

  it('options.maxQueueSize<=0 falls back to >=1 (defensive)', () => {
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({
      persistor: SILENT_PERSISTOR,
      maxQueueSize: 0,
      metrics,
    });
    // Even with max=0, we accept the first trace (clamped to 1) and drop on next.
    collector.enqueue(makeValidTrace('a'));
    expect(collector.size()).toBe(1);
    collector.enqueue(makeValidTrace('b'));
    expect(collector.size()).toBe(1);
    expect(metrics.dropReasons.queue_full).toBe(1);
  });

  it('flush respects batchSize across multiple flushes', async () => {
    const persistCalls: number[] = [];
    const persistor: RoutingTracePersistor = {
      async persist(batch) {
        persistCalls.push(batch.length);
      },
    };
    const metrics = new CountingMetrics();
    const collector = new RoutingTraceCollector({
      persistor,
      maxQueueSize: 100,
      batchSize: 4,
      metrics,
    });
    for (let i = 0; i < 10; i += 1) collector.enqueue(makeValidTrace(`t-${i}`));

    await collector.flush();
    await collector.flush();
    await collector.flush();
    await collector.flush(); // final no-op

    expect(persistCalls).toEqual([4, 4, 2]);
    expect(collector.size()).toBe(0);
  });
});
