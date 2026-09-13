// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `ci_model_selection_duration_ms` never received a sample in production:
 * its only caller omitted durationMs and its buckets stopped at 500 ms while
 * real selections take seconds. These tests pin the extended bucket range and
 * the "no durationMs, no sample" guard that keeps the counter usable on its
 * own.
 */
import { describe, expect, it } from 'vitest';
import {
  modelSelectionDuration,
  modelSelectionTotal,
  recordModelSelection,
} from '@/observability/ci-metrics';

async function bucketCounts(taskType: string): Promise<Record<string, number>> {
  const metric = await modelSelectionDuration.get();
  const out: Record<string, number> = {};
  for (const v of metric.values) {
    if (v.labels.task_type !== taskType) continue;
    if (v.metricName === 'ci_model_selection_duration_ms_bucket') {
      out[String(v.labels.le)] = v.value;
    } else if (v.metricName === 'ci_model_selection_duration_ms_count') {
      out.count = v.value;
    }
  }
  return out;
}

async function totalFor(taskType: string): Promise<number | undefined> {
  const metric = await modelSelectionTotal.get();
  return metric.values.find((v) => v.labels.task_type === taskType)?.value;
}

describe('ci_model_selection_duration_ms', () => {
  it('covers multi-second selections with buckets up to 30 s', async () => {
    recordModelSelection({
      model: 'm-dur',
      taskType: 't-dur-12s',
      selectionReason: 'heuristic',
      durationMs: 12_000,
    });

    const buckets = await bucketCounts('t-dur-12s');
    expect(buckets.count).toBe(1);
    expect(buckets['10000']).toBe(0);
    expect(buckets['30000']).toBe(1);
    expect(buckets['+Inf']).toBe(1);
    expect(Object.keys(buckets)).toEqual(
      expect.arrayContaining(['1000', '2500', '5000', '10000', '30000'])
    );
  });

  it('keeps the sub-second buckets for fast selections', async () => {
    recordModelSelection({
      model: 'm-dur',
      taskType: 't-dur-40ms',
      selectionReason: 'heuristic',
      durationMs: 40,
    });

    const buckets = await bucketCounts('t-dur-40ms');
    expect(buckets['25']).toBe(0);
    expect(buckets['50']).toBe(1);
  });

  it('records no sample without durationMs but still counts the decision', async () => {
    recordModelSelection({ model: 'm-dur', taskType: 't-dur-none', selectionReason: 'fallback' });

    expect(await bucketCounts('t-dur-none')).toEqual({});
    expect(await totalFor('t-dur-none')).toBe(1);
  });
});
