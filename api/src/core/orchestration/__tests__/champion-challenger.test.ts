// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Champion / Challenger Framework — Unit Tests
 *
 * Tests the core evaluation logic WITHOUT database dependency.
 * Mocks prisma and ci-metrics to isolate pure business logic.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BenchmarkResult, ChampionChallengerResult } from '../champion-challenger';

// Standard mocks for all tests
const mockFindMany = vi.fn();
const mockUpsert = vi.fn();

beforeEach(() => {
  vi.resetModules();
  mockFindMany.mockReset();
  mockUpsert.mockReset();

  vi.doMock('@/database/client', () => ({
    prisma: {
      strategyWeight: {
        findMany: mockFindMany,
        upsert: mockUpsert,
      },
    },
  }));
  vi.doMock('@/observability/ci-metrics', () => ({
    ciMetrics: {
      championChallengerPromotions: { inc: vi.fn() },
      championChallengerRejections: { inc: vi.fn() },
      championChallengerQualityDelta: { observe: vi.fn() },
    },
  }));
});

function makeResults(overrides: Partial<BenchmarkResult> & { count?: number } = {}): BenchmarkResult[] {
  const count = overrides.count ?? 5;
  const base: BenchmarkResult = {
    taskType: 'code-generation',
    complexity: 'medium',
    strategy: 'single',
    qualityScore: 0.85,
    success: true,
    durationMs: 1000,
    ...overrides,
  };
  return Array.from({ length: count }, () => ({ ...base }));
}

describe('evaluateChallenger', () => {
  it('promotes when challenger beats champion by >= threshold', async () => {
    // Champion has quality 0.70
    mockFindMany.mockResolvedValue([
      { taskType: 'code-generation', complexity: 'medium', strategy: 'single', avgQuality: 0.70, successRate: 0.80, weight: 1.35, sampleCount: 20 },
    ]);

    const { evaluateChallenger } = await import('../champion-challenger');
    const result = await evaluateChallenger(makeResults({ qualityScore: 0.80, count: 5 }));

    expect(result.overallVerdict).toBe('promoted');
    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0].delta).toBeCloseTo(0.10, 2);
  });

  it('returns no-change when delta is below threshold', async () => {
    mockFindMany.mockResolvedValue([
      { taskType: 'code-generation', complexity: 'medium', strategy: 'single', avgQuality: 0.80, successRate: 0.90, weight: 1.40, sampleCount: 20 },
    ]);

    const { evaluateChallenger } = await import('../champion-challenger');
    const result = await evaluateChallenger(makeResults({ qualityScore: 0.81, count: 5 }));

    expect(result.overallVerdict).toBe('no-change');
    expect(result.promoted).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });

  it('rejects when challenger degrades beyond limit', async () => {
    mockFindMany.mockResolvedValue([
      { taskType: 'code-generation', complexity: 'medium', strategy: 'single', avgQuality: 0.90, successRate: 0.95, weight: 1.45, sampleCount: 20 },
    ]);

    const { evaluateChallenger } = await import('../champion-challenger');
    // Quality drops from 0.90 to 0.80 = -0.10 which exceeds degradation limit (0.05)
    const result = await evaluateChallenger(makeResults({ qualityScore: 0.80, count: 5 }));

    expect(result.overallVerdict).toBe('rejected');
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(result.rejected[0].reason).toContain('Degradation');
  });

  it('rejects ALL strategies when any single one critically degrades', async () => {
    // Two strategies: one improving, one degrading
    mockFindMany.mockResolvedValue([
      { taskType: 'code-gen', complexity: 'high', strategy: 'single', avgQuality: 0.70, successRate: 0.80, weight: 1.35, sampleCount: 20 },
      { taskType: 'code-gen', complexity: 'high', strategy: 'debate', avgQuality: 0.90, successRate: 0.95, weight: 1.45, sampleCount: 20 },
    ]);

    const { evaluateChallenger } = await import('../champion-challenger');
    const results: BenchmarkResult[] = [
      // single improves (0.70 → 0.85 = +0.15)
      ...makeResults({ taskType: 'code-gen', complexity: 'high', strategy: 'single', qualityScore: 0.85, count: 5 }),
      // debate degrades (0.90 → 0.75 = -0.15, beyond limit)
      ...makeResults({ taskType: 'code-gen', complexity: 'high', strategy: 'debate', qualityScore: 0.75, count: 5 }),
    ];

    const result = await evaluateChallenger(results);

    expect(result.overallVerdict).toBe('rejected');
    expect(result.promoted).toHaveLength(0);
    // Both should be in rejected — debate for degradation, single blocked by cascade
    expect(result.rejected.length).toBe(2);
  });

  it('auto-promotes new entries with no champion', async () => {
    mockFindMany.mockResolvedValue([]); // No existing champions

    const { evaluateChallenger } = await import('../champion-challenger');
    const result = await evaluateChallenger(makeResults({ qualityScore: 0.85, count: 5 }));

    expect(result.overallVerdict).toBe('promoted');
    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0].championQuality).toBe(0);
  });

  it('skips challengers with insufficient samples', async () => {
    mockFindMany.mockResolvedValue([]);

    const { evaluateChallenger } = await import('../champion-challenger');
    // Only 2 samples — below minChallengerSamples (3)
    const result = await evaluateChallenger(makeResults({ qualityScore: 0.85, count: 2 }));

    expect(result.overallVerdict).toBe('no-change');
    expect(result.unchanged).toBe(1);
  });

  it('auto-promotes when champion has insufficient samples', async () => {
    mockFindMany.mockResolvedValue([
      { taskType: 'code-generation', complexity: 'medium', strategy: 'single', avgQuality: 0.90, successRate: 0.95, weight: 1.45, sampleCount: 3 }, // < 10
    ]);

    const { evaluateChallenger } = await import('../champion-challenger');
    const result = await evaluateChallenger(makeResults({ qualityScore: 0.70, count: 5 }));

    // Should auto-promote even though quality is lower — champion not established
    expect(result.overallVerdict).toBe('promoted');
  });
});

describe('promoteChallenger', () => {
  it('upserts weights for promoted strategies only', async () => {
    mockUpsert.mockResolvedValue({});

    const { promoteChallenger } = await import('../champion-challenger');

    const evaluation: ChampionChallengerResult = {
      promoted: [
        { taskType: 'code-gen', complexity: 'high', strategy: 'single', championQuality: 0.70, challengerQuality: 0.85, delta: 0.15 },
      ],
      rejected: [],
      unchanged: 0,
      overallVerdict: 'promoted',
      timestamp: new Date().toISOString(),
    };

    const results = makeResults({ taskType: 'code-gen', complexity: 'high', strategy: 'single', qualityScore: 0.85, count: 5 });

    await promoteChallenger(evaluation, results);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].where.taskType_complexity_strategy.strategy).toBe('single');
  });

  it('skips upsert when verdict is not promoted', async () => {
    const { promoteChallenger } = await import('../champion-challenger');

    const evaluation: ChampionChallengerResult = {
      promoted: [],
      rejected: [],
      unchanged: 1,
      overallVerdict: 'no-change',
      timestamp: new Date().toISOString(),
    };

    await promoteChallenger(evaluation, []);

    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
