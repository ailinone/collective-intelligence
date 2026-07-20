// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Statistical Analysis Engine — Unit Tests
 *
 * Pure math tests with known inputs/outputs.
 * No mocks needed — these are deterministic functions.
 */

import { describe, it, expect } from 'vitest';
import {
  computeDescriptiveStats,
  computeConfidenceInterval,
  welchTTest,
  effectSize,
  computeWinRate,
  computeRegret,
  computeStabilityIndex,
  computeCostEfficiency,
  computeParetoDominance,
  detectOutliers,
} from '../statistical-analysis';

describe('computeDescriptiveStats', () => {
  it('returns zeros for empty array', () => {
    const stats = computeDescriptiveStats([]);
    expect(stats.n).toBe(0);
    expect(stats.mean).toBe(0);
    expect(stats.stddev).toBe(0);
  });

  it('handles single value', () => {
    const stats = computeDescriptiveStats([0.75]);
    expect(stats.n).toBe(1);
    expect(stats.mean).toBe(0.75);
    expect(stats.median).toBe(0.75);
    expect(stats.variance).toBe(0);
    expect(stats.min).toBe(0.75);
    expect(stats.max).toBe(0.75);
  });

  it('computes correct stats for known dataset', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const stats = computeDescriptiveStats(values);

    expect(stats.n).toBe(8);
    expect(stats.mean).toBe(5);
    expect(stats.median).toBe(4.5);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(9);
    expect(stats.variance).toBeCloseTo(4.571, 2);
    expect(stats.stddev).toBeCloseTo(2.138, 2);
  });

  it('computes percentiles correctly', () => {
    // 0-100 linear
    const values = Array.from({ length: 101 }, (_, i) => i);
    const stats = computeDescriptiveStats(values);

    expect(stats.p10).toBeCloseTo(10, 0);
    expect(stats.p25).toBeCloseTo(25, 0);
    expect(stats.p50).toBeCloseTo(50, 0);
    expect(stats.p75).toBeCloseTo(75, 0);
    expect(stats.p90).toBeCloseTo(90, 0);
    expect(stats.iqr).toBeCloseTo(50, 0);
  });
});

describe('computeConfidenceInterval', () => {
  it('returns zeros for empty array', () => {
    const ci = computeConfidenceInterval([]);
    expect(ci.n).toBe(0);
    expect(ci.marginOfError).toBe(0);
  });

  it('computes 95% CI for known dataset', () => {
    // Large sample for z-approximation
    const values = Array.from({ length: 100 }, (_, i) => 50 + (i % 10) - 5);
    const ci = computeConfidenceInterval(values, 0.95);

    expect(ci.n).toBe(100);
    expect(ci.lower).toBeLessThan(ci.mean);
    expect(ci.upper).toBeGreaterThan(ci.mean);
    expect(ci.marginOfError).toBeGreaterThan(0);
    expect(ci.confidenceLevel).toBe(0.95);
  });

  it('wider interval for higher confidence', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ci90 = computeConfidenceInterval(values, 0.90);
    const ci99 = computeConfidenceInterval(values, 0.99);

    expect(ci99.marginOfError).toBeGreaterThan(ci90.marginOfError);
  });
});

describe('welchTTest', () => {
  it('returns non-significant for identical groups', () => {
    const group = [5, 5, 5, 5, 5];
    const result = welchTTest(group, group);

    expect(result.pValue).toBeGreaterThan(0.05);
    expect(result.significant).toBe(false);
  });

  it('returns significant for clearly different groups', () => {
    const group1 = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const group2 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = welchTTest(group1, group2);

    expect(result.tStatistic).toBeGreaterThan(0);
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.significant).toBe(true);
  });

  it('handles groups with insufficient samples', () => {
    const result = welchTTest([5], [10]);

    expect(result.pValue).toBe(1);
    expect(result.significant).toBe(false);
  });

  it('handles groups with zero variance', () => {
    const group1 = [5, 5, 5, 5, 5];
    const group2 = [10, 10, 10, 10, 10];
    const result = welchTTest(group1, group2);

    // With zero variance in both, seDiff = 0, should handle gracefully
    expect(result.tStatistic).toBeDefined();
  });

  it('handles unequal sample sizes', () => {
    const group1 = [8, 9, 10, 11, 12, 13, 14, 15];
    const group2 = [1, 2, 3, 4, 5];
    const result = welchTTest(group1, group2);

    expect(result.significant).toBe(true);
    expect(result.degreesOfFreedom).toBeGreaterThan(0);
  });
});

describe('effectSize', () => {
  it('returns negligible for identical groups', () => {
    const group = [5, 6, 7, 8, 9];
    const result = effectSize(group, group);

    expect(result.cohensD).toBeCloseTo(0, 5);
    expect(result.category).toBe('negligible');
  });

  it('returns large for clearly different groups', () => {
    const group1 = [10, 11, 12, 13, 14];
    const group2 = [1, 2, 3, 4, 5];
    const result = effectSize(group1, group2);

    expect(Math.abs(result.cohensD)).toBeGreaterThan(0.8);
    expect(result.category).toBe('large');
  });

  it('handles insufficient samples', () => {
    const result = effectSize([5], [10]);
    expect(result.category).toBe('negligible');
  });

  it('correctly categorizes medium effect', () => {
    // Construct groups with ~0.5 stddev difference
    const group1 = [5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5];
    const group2 = [4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5];
    const result = effectSize(group1, group2);

    // ~0.6 difference in means with ~1.6 stddev ≈ d=0.6 (medium)
    expect(result.category).toBe('medium');
  });
});

describe('computeWinRate', () => {
  it('computes correct win rates', () => {
    const groupA = [0.8, 0.7, 0.9, 0.6, 0.85];
    const groupB = [0.7, 0.8, 0.5, 0.6, 0.80];
    const result = computeWinRate(groupA, groupB);

    expect(result.total).toBe(5);
    expect(result.groupAWins + result.groupBWins + result.ties).toBe(5);
    expect(result.groupAWinRate + result.groupBWinRate + result.ties / result.total).toBeCloseTo(1, 5);
  });

  it('handles ties within threshold', () => {
    const groupA = [0.80, 0.81];
    const groupB = [0.79, 0.80];
    const result = computeWinRate(groupA, groupB, 0.02);

    // Both within ±0.02 → both ties
    expect(result.ties).toBe(2);
  });

  it('handles empty arrays', () => {
    const result = computeWinRate([], []);
    expect(result.total).toBe(0);
    expect(result.groupAWinRate).toBe(0);
  });
});

describe('computeRegret', () => {
  it('returns zero regret when chosen is best', () => {
    const result = computeRegret(0.9, [0.7, 0.8, 0.85]);
    expect(result.maxRegret).toBe(0);
    expect(result.avgRegret).toBe(0);
  });

  it('computes correct regret when alternative is better', () => {
    const result = computeRegret(0.6, [0.8, 0.9]);
    expect(result.maxRegret).toBeCloseTo(0.3, 5);
    expect(result.bestAlternative).toBe(0.9);
    expect(result.avgRegret).toBeCloseTo(0.25, 5); // (0.2 + 0.3) / 2
  });

  it('handles no alternatives', () => {
    const result = computeRegret(0.5, []);
    expect(result.maxRegret).toBe(0);
    expect(result.bestAlternative).toBe(0.5);
  });
});

describe('computeStabilityIndex', () => {
  it('returns 1.0 for constant values', () => {
    expect(computeStabilityIndex([0.8, 0.8, 0.8, 0.8])).toBe(1.0);
  });

  it('returns lower index for variable values', () => {
    const stable = computeStabilityIndex([0.8, 0.81, 0.79, 0.80]);
    const unstable = computeStabilityIndex([0.3, 0.9, 0.1, 0.95]);

    expect(stable).toBeGreaterThan(unstable);
  });

  it('returns 1.0 for single value', () => {
    expect(computeStabilityIndex([0.5])).toBe(1.0);
  });
});

describe('computeCostEfficiency', () => {
  it('computes quality per dollar', () => {
    expect(computeCostEfficiency(0.8, 0.04)).toBeCloseTo(20, 5);
  });

  it('handles zero cost', () => {
    expect(computeCostEfficiency(0.8, 0)).toBe(Infinity);
  });

  it('handles zero quality and cost', () => {
    expect(computeCostEfficiency(0, 0)).toBe(0);
  });
});

describe('computeParetoDominance', () => {
  it('identifies Pareto frontier correctly', () => {
    const points = [
      { label: 'A', quality: 0.9, cost: 0.10, latency: 3000, successRate: 0.95 },
      { label: 'B', quality: 0.7, cost: 0.02, latency: 1000, successRate: 0.90 },
      { label: 'C', quality: 0.5, cost: 0.15, latency: 5000, successRate: 0.80 },
    ];

    const result = computeParetoDominance(points);

    // A is best quality, B is best cost+latency, C is dominated by A (worse in all)
    expect(result.frontier.length).toBeGreaterThanOrEqual(2);
    expect(result.frontier.some(p => p.label === 'A')).toBe(true);
    expect(result.frontier.some(p => p.label === 'B')).toBe(true);
  });

  it('handles empty input', () => {
    const result = computeParetoDominance([]);
    expect(result.frontier.length).toBe(0);
    expect(result.dominated.length).toBe(0);
  });

  it('all points on frontier if none dominated', () => {
    const points = [
      { label: 'A', quality: 0.9, cost: 0.10, latency: 5000, successRate: 0.90 },
      { label: 'B', quality: 0.7, cost: 0.05, latency: 2000, successRate: 0.95 },
    ];

    const result = computeParetoDominance(points);
    // A better quality, B better cost+latency+success → neither dominates
    expect(result.frontier.length).toBe(2);
    expect(result.dominated.length).toBe(0);
  });
});

describe('detectOutliers', () => {
  it('detects outliers in a dataset', () => {
    const values = [10, 11, 12, 13, 14, 15, 100]; // 100 is an outlier
    const outliers = detectOutliers(values);

    expect(outliers.length).toBeGreaterThan(0);
    expect(outliers).toContain(6); // index of 100
  });

  it('returns empty for small arrays', () => {
    expect(detectOutliers([1, 2, 3])).toEqual([]);
  });

  it('returns empty for uniform data', () => {
    const values = [5, 5, 5, 5, 5, 5, 5, 5];
    expect(detectOutliers(values)).toEqual([]);
  });
});
