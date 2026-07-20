// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — recordCollectiveTrace helper (F2.11)
 *
 * Validates the Prometheus recorder is defensive against malformed
 * input and does not throw under any condition. The actual prom-client
 * counters are exercised at integration level by the strategies; here
 * we only assert the helper's safety contract.
 */

import { describe, it, expect } from 'vitest';
import { recordCollectiveTrace } from '../coordination-metrics';
import { CollectiveTrace } from '../collective-trace';

describe('recordCollectiveTrace (F2.11)', () => {
  it('accepts a real CollectiveTrace.describe() output without throwing', () => {
    const trace = new CollectiveTrace('run-metrics-1');
    const id = trace.startSpan('round_start', { attributes: { round: 1 } });
    trace.endSpan(id);
    trace.markComplete();
    expect(() => recordCollectiveTrace('test-strategy', trace.describe())).not.toThrow();
  });

  it('no-ops on missing input', () => {
    expect(() => recordCollectiveTrace('test-strategy', null as unknown as ReturnType<CollectiveTrace['describe']>)).not.toThrow();
  });

  it('no-ops when spanCount is non-finite', () => {
    expect(() =>
      recordCollectiveTrace('test-strategy', {
        runId: 'r',
        spanCount: Number.NaN,
        completed: true,
        statusCounts: {},
        phaseCounts: {},
      }),
    ).not.toThrow();
  });

  it('handles a trace with a mix of statuses', () => {
    const trace = new CollectiveTrace('run-metrics-mixed');
    const a = trace.startSpan('aggregate');
    const b = trace.startSpan('aggregate');
    const c = trace.startSpan('round_start');
    trace.endSpan(a, { status: 'ok' });
    trace.endSpan(b, { status: 'error', errorMessage: 'boom' });
    // c left open → markComplete will set it to 'cancelled'
    trace.markComplete();

    const stats = trace.describe();
    expect(stats.statusCounts.ok).toBe(1);
    expect(stats.statusCounts.error).toBe(1);
    expect(stats.statusCounts.cancelled).toBe(1);

    expect(() => recordCollectiveTrace('test-strategy', stats)).not.toThrow();
  });

  it('handles an aborted trace (markComplete not reached)', () => {
    const trace = new CollectiveTrace('run-aborted');
    trace.startSpan('aggregate');
    // Note: did NOT call markComplete()
    expect(() => recordCollectiveTrace('test-strategy', trace.describe())).not.toThrow();
  });

  it('handles trace with empty phase / status maps', () => {
    expect(() =>
      recordCollectiveTrace('test-strategy', {
        runId: 'r',
        spanCount: 0,
        completed: true,
        statusCounts: {},
        phaseCounts: {},
      }),
    ).not.toThrow();
  });

  it('ignores invalid count values silently', () => {
    expect(() =>
      recordCollectiveTrace('test-strategy', {
        runId: 'r',
        spanCount: 5,
        completed: true,
        statusCounts: { ok: -1, error: Number.NaN, cancelled: 'string' as unknown as number },
        phaseCounts: { aggregate: 0, round_start: -3 },
      }),
    ).not.toThrow();
  });
});
