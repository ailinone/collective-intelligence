// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Learning Validation — Unit Tests
 *
 * Tests that the system can prove it's actually learning.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockExecuteRaw = vi.fn().mockResolvedValue(0);
const mockQueryRaw = vi.fn().mockResolvedValue([]);

beforeEach(() => {
  vi.resetModules();
  mockExecuteRaw.mockReset().mockResolvedValue(0);
  mockQueryRaw.mockReset().mockResolvedValue([]);

  vi.doMock('@/database/client', () => ({
    prisma: {
      $executeRaw: mockExecuteRaw,
      $queryRaw: mockQueryRaw,
    },
  }));
  vi.doMock('@/utils/logger', () => ({
    logger: {
      child: () => ({
        info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
      }),
    },
  }));
});

describe('Learning Validation', () => {
  describe('validateLearning', () => {
    it('returns "improving" when quality increases with no regressions', async () => {
      // Baseline window: avg quality 0.75
      mockQueryRaw
        .mockResolvedValueOnce([{
          sample_size: BigInt(50),
          avg_quality: 0.75,
          avg_latency_ms: 3000,
          avg_cost_usd: 0.03,
          success_rate: 0.85,
          quality_stddev: 0.08,
        }])
        // Comparison window: avg quality 0.85 (significant improvement)
        .mockResolvedValueOnce([{
          sample_size: BigInt(30),
          avg_quality: 0.85,
          avg_latency_ms: 2800,
          avg_cost_usd: 0.028,
          success_rate: 0.90,
          quality_stddev: 0.06,
        }]);

      const { validateLearning } = await import('../learning-validation');
      const result = await validateLearning({
        scopeType: 'strategy',
        scopeKey: 'debate',
        baselineStart: new Date(Date.now() - 14 * 86_400_000),
        baselineEnd: new Date(Date.now() - 7 * 86_400_000),
        comparisonStart: new Date(Date.now() - 7 * 86_400_000),
        comparisonEnd: new Date(),
      });

      expect(result.verdict).toBe('improving');
      expect(result.validated).toBe(true);
      expect(result.improvementDelta.quality).toBeCloseTo(0.10, 2);
      expect(result.regressions).toHaveLength(0);
      expect(result.learningVelocity).toBeGreaterThan(0);
    });

    it('returns "degrading" when quality decreases', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{
          sample_size: BigInt(50),
          avg_quality: 0.85,
          avg_latency_ms: 2000,
          avg_cost_usd: 0.02,
          success_rate: 0.95,
          quality_stddev: 0.05,
        }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(30),
          avg_quality: 0.65, // -0.20 degradation
          avg_latency_ms: 4000,
          avg_cost_usd: 0.04,
          success_rate: 0.70,
          quality_stddev: 0.15,
        }]);

      const { validateLearning } = await import('../learning-validation');
      const result = await validateLearning({
        scopeType: 'strategy',
        scopeKey: 'single',
        baselineStart: new Date(Date.now() - 14 * 86_400_000),
        baselineEnd: new Date(Date.now() - 7 * 86_400_000),
        comparisonStart: new Date(Date.now() - 7 * 86_400_000),
        comparisonEnd: new Date(),
      });

      expect(result.verdict).toBe('degrading');
      expect(result.validated).toBe(false);
      expect(result.regressions.length).toBeGreaterThan(0);
    });

    it('returns "stable" when no significant change', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{
          sample_size: BigInt(50),
          avg_quality: 0.82,
          avg_latency_ms: 2500,
          avg_cost_usd: 0.025,
          success_rate: 0.90,
          quality_stddev: 0.07,
        }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(30),
          avg_quality: 0.83, // Within significance threshold
          avg_latency_ms: 2400,
          avg_cost_usd: 0.024,
          success_rate: 0.91,
          quality_stddev: 0.06,
        }]);

      const { validateLearning } = await import('../learning-validation');
      const result = await validateLearning({
        scopeType: 'strategy',
        scopeKey: 'debate',
        baselineStart: new Date(Date.now() - 14 * 86_400_000),
        baselineEnd: new Date(Date.now() - 7 * 86_400_000),
        comparisonStart: new Date(Date.now() - 7 * 86_400_000),
        comparisonEnd: new Date(),
      });

      expect(result.verdict).toBe('stable');
    });

    it('returns "inconclusive" with insufficient data', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{
          sample_size: BigInt(3), // Below minSamplesPerWindow
          avg_quality: 0.80,
          avg_latency_ms: 2000,
          avg_cost_usd: 0.02,
          success_rate: 0.90,
          quality_stddev: 0.10,
        }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(2),
          avg_quality: 0.90,
          avg_latency_ms: 1500,
          avg_cost_usd: 0.015,
          success_rate: 0.95,
          quality_stddev: 0.05,
        }]);

      const { validateLearning } = await import('../learning-validation');
      const result = await validateLearning({
        scopeType: 'strategy',
        scopeKey: 'consensus',
        baselineStart: new Date(Date.now() - 14 * 86_400_000),
        baselineEnd: new Date(Date.now() - 7 * 86_400_000),
        comparisonStart: new Date(Date.now() - 7 * 86_400_000),
        comparisonEnd: new Date(),
      });

      expect(result.verdict).toBe('inconclusive');
      expect(result.validated).toBe(false);
    });

    it('detects regressions in latency even when quality improves', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{
          sample_size: BigInt(50),
          avg_quality: 0.78,
          avg_latency_ms: 2000,
          avg_cost_usd: 0.02,
          success_rate: 0.90,
          quality_stddev: 0.07,
        }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(30),
          avg_quality: 0.88, // Quality improved
          avg_latency_ms: 8000, // But latency 4x worse
          avg_cost_usd: 0.02,
          success_rate: 0.92,
          quality_stddev: 0.05,
        }]);

      const { validateLearning } = await import('../learning-validation');
      const result = await validateLearning({
        scopeType: 'strategy',
        scopeKey: 'debate',
        baselineStart: new Date(Date.now() - 14 * 86_400_000),
        baselineEnd: new Date(Date.now() - 7 * 86_400_000),
        comparisonStart: new Date(Date.now() - 7 * 86_400_000),
        comparisonEnd: new Date(),
      });

      // Quality improved but latency regressed significantly
      expect(result.improvementDelta.quality).toBeGreaterThan(0);
      expect(result.regressions.length).toBeGreaterThan(0);
      const latencyRegression = result.regressions.find(r => r.metric === 'latency');
      expect(latencyRegression).toBeDefined();
    });

    it('persists the report to database', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{
          sample_size: BigInt(50), avg_quality: 0.80, avg_latency_ms: 2000,
          avg_cost_usd: 0.02, success_rate: 0.90, quality_stddev: 0.07,
        }])
        .mockResolvedValueOnce([{
          sample_size: BigInt(30), avg_quality: 0.85, avg_latency_ms: 1800,
          avg_cost_usd: 0.018, success_rate: 0.93, quality_stddev: 0.05,
        }]);

      const { validateLearning } = await import('../learning-validation');
      await validateLearning({
        scopeType: 'strategy',
        scopeKey: 'debate',
        baselineStart: new Date(Date.now() - 14 * 86_400_000),
        baselineEnd: new Date(Date.now() - 7 * 86_400_000),
        comparisonStart: new Date(Date.now() - 7 * 86_400_000),
        comparisonEnd: new Date(),
      });

      // Should have called $executeRaw to persist the report
      expect(mockExecuteRaw).toHaveBeenCalled();
    });
  });
});
