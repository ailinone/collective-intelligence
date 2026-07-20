// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the Phase 2c shadow-ensemble Prometheus metrics.
 *
 * Validates the four metric series and their label schemas:
 *   - coord_ensemble_shadow_calls_total{strategy, decisionType, kind}
 *   - coord_ensemble_shadow_role_match_total{strategy, decisionType, match}
 *   - coord_ensemble_shadow_latency_seconds (histogram)
 *   - coord_ensemble_shadow_confidence (histogram)
 *
 * Plus the recording rules: which snapshots produce which series
 * (e.g. confidence is success-only, latency skips disabled).
 */

import promClient from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordShadowMetrics } from '../ensemble-shadow-metrics';
import type { ShadowEnsembleSnapshot } from '../ensemble-coordinator-shadow';

async function readCounterValue(
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  // register.getMetricsAsJSON awaits async-collector metrics (Summary)
  // and returns a uniform sync shape for Counter/Histogram. Easier than
  // casting through prom-client's promise-returning Metric.get().
  const all = await promClient.register.getMetricsAsJSON();
  const found = all.find((m) => m.name === name);
  if (!found) return 0;
  const values = (found as { values?: Array<{ labels: Record<string, string>; value: number }> })
    .values ?? [];
  const match = values.find(
    (v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

async function readHistogramSampleCount(
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const all = await promClient.register.getMetricsAsJSON();
  const found = all.find((m) => m.name === name);
  if (!found) return 0;
  const values =
    (found as {
      values?: Array<{
        metricName?: string;
        labels: Record<string, string>;
        value: number;
      }>;
    }).values ?? [];
  const countSeries = values.filter(
    (v) =>
      v.metricName === `${name}_count` &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return countSeries.reduce((acc, v) => acc + v.value, 0);
}

const SUCCESS_SNAPSHOT: ShadowEnsembleSnapshot = {
  kind: 'success',
  role: 'moderator',
  scheduler: 'mock-cascade-24-tiered',
  reason: 'task-type-match',
  confidence: 0.92,
  aggregationMethod: 'weighted_bayesian_majority',
  totalVotes: 4,
  tiersActivated: [1],
  shortCircuited: true,
  divergence: {
    sameRole: true,
    sameReason: false,
    bothAgreeOnSchedulerFamily: false,
    shadowConfidence: 0.92,
  },
  latencyMs: 42,
};

const TIMEOUT_SNAPSHOT: ShadowEnsembleSnapshot = {
  kind: 'timeout',
  divergence: null,
  latencyMs: 5000,
};

const ERROR_SNAPSHOT: ShadowEnsembleSnapshot = {
  kind: 'error',
  divergence: null,
  latencyMs: 12,
  errorMessage: 'connection refused',
};

const DISABLED_SNAPSHOT: ShadowEnsembleSnapshot = {
  kind: 'disabled',
  divergence: null,
  latencyMs: 0,
};

beforeEach(() => {
  // Each test starts from a clean registry so counters don't leak.
  promClient.register.resetMetrics();
});

afterEach(() => {
  promClient.register.resetMetrics();
});

describe('recordShadowMetrics', () => {
  it('increments calls_total with kind=success on success snapshot', async () => {
    recordShadowMetrics('debate', 'moderator-selection', SUCCESS_SNAPSHOT);

    expect(
        await readCounterValue('coord_ensemble_shadow_calls_total', {
        strategy: 'debate',
        decisionType: 'moderator-selection',
        kind: 'success',
      }),
    ).toBe(1);
  });

  it('increments calls_total with kind=timeout on timeout snapshot', async () => {
    recordShadowMetrics('debate', 'moderator-selection', TIMEOUT_SNAPSHOT);

    expect(
        await readCounterValue('coord_ensemble_shadow_calls_total', {
        strategy: 'debate',
        decisionType: 'moderator-selection',
        kind: 'timeout',
      }),
    ).toBe(1);
  });

  it('increments calls_total with kind=error on error snapshot', async () => {
    recordShadowMetrics('debate', 'moderator-selection', ERROR_SNAPSHOT);

    expect(
        await readCounterValue('coord_ensemble_shadow_calls_total', {
        strategy: 'debate',
        decisionType: 'moderator-selection',
        kind: 'error',
      }),
    ).toBe(1);
  });

  it('increments calls_total with kind=disabled on disabled snapshot', async () => {
    recordShadowMetrics('debate', 'moderator-selection', DISABLED_SNAPSHOT);

    expect(
        await readCounterValue('coord_ensemble_shadow_calls_total', {
        strategy: 'debate',
        decisionType: 'moderator-selection',
        kind: 'disabled',
      }),
    ).toBe(1);
  });

  it('records latency histogram for success/timeout/error', async () => {
    recordShadowMetrics('debate', 'moderator-selection', SUCCESS_SNAPSHOT);
    recordShadowMetrics('debate', 'moderator-selection', TIMEOUT_SNAPSHOT);
    recordShadowMetrics('debate', 'moderator-selection', ERROR_SNAPSHOT);

    const count = await readHistogramSampleCount('coord_ensemble_shadow_latency_seconds', {
      strategy: 'debate',
      decisionType: 'moderator-selection',
    });
    expect(count).toBe(3);
  });

  it('does NOT record latency histogram for disabled snapshot', async () => {
    recordShadowMetrics('debate', 'moderator-selection', DISABLED_SNAPSHOT);

    const count = await readHistogramSampleCount('coord_ensemble_shadow_latency_seconds', {
      strategy: 'debate',
      decisionType: 'moderator-selection',
    });
    expect(count).toBe(0);
  });

  it('records confidence histogram only on success snapshots', async () => {
    recordShadowMetrics('debate', 'moderator-selection', SUCCESS_SNAPSHOT);
    recordShadowMetrics('debate', 'moderator-selection', TIMEOUT_SNAPSHOT);
    recordShadowMetrics('debate', 'moderator-selection', ERROR_SNAPSHOT);
    recordShadowMetrics('debate', 'moderator-selection', DISABLED_SNAPSHOT);

    const count = await readHistogramSampleCount('coord_ensemble_shadow_confidence', {
      strategy: 'debate',
      decisionType: 'moderator-selection',
    });
    expect(count).toBe(1); // only the success snapshot
  });

  it('increments role_match_total with match=true when shadow matches heuristic', async () => {
    recordShadowMetrics('debate', 'moderator-selection', SUCCESS_SNAPSHOT);

    expect(
        await readCounterValue('coord_ensemble_shadow_role_match_total', {
        strategy: 'debate',
        decisionType: 'moderator-selection',
        match: 'true',
      }),
    ).toBe(1);
  });

  it('increments role_match_total with match=false when shadow disagrees', async () => {
    const disagreeing: ShadowEnsembleSnapshot = {
      ...SUCCESS_SNAPSHOT,
      divergence: { ...SUCCESS_SNAPSHOT.divergence!, sameRole: false },
    };
    recordShadowMetrics('debate', 'moderator-selection', disagreeing);

    expect(
        await readCounterValue('coord_ensemble_shadow_role_match_total', {
        strategy: 'debate',
        decisionType: 'moderator-selection',
        match: 'false',
      }),
    ).toBe(1);
  });

  it('does NOT increment role_match_total when divergence is null', async () => {
    const successWithoutDivergence: ShadowEnsembleSnapshot = {
      ...SUCCESS_SNAPSHOT,
      divergence: null,
    };
    recordShadowMetrics('debate', 'moderator-selection', successWithoutDivergence);

    expect(
        await readCounterValue('coord_ensemble_shadow_role_match_total', {
        strategy: 'debate',
        decisionType: 'moderator-selection',
        match: 'true',
      }),
    ).toBe(0);
    expect(
        await readCounterValue('coord_ensemble_shadow_role_match_total', {
        strategy: 'debate',
        decisionType: 'moderator-selection',
        match: 'false',
      }),
    ).toBe(0);
  });

  it('separates labels per (strategy, decisionType) pair', async () => {
    recordShadowMetrics('debate', 'moderator-selection', SUCCESS_SNAPSHOT);
    recordShadowMetrics('expert-panel', 'panel-composition', SUCCESS_SNAPSHOT);

    expect(
        await readCounterValue('coord_ensemble_shadow_calls_total', {
        strategy: 'debate',
        decisionType: 'moderator-selection',
        kind: 'success',
      }),
    ).toBe(1);
    expect(
        await readCounterValue('coord_ensemble_shadow_calls_total', {
        strategy: 'expert-panel',
        decisionType: 'panel-composition',
        kind: 'success',
      }),
    ).toBe(1);
  });
});
