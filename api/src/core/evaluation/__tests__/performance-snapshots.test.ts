// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Performance Snapshots — Unit Tests
 *
 * Tests daily snapshot generation and competitive benchmarking queries.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockExecuteRaw = vi.fn().mockResolvedValue(0);
const mockQueryRaw = vi.fn().mockResolvedValue([]);

beforeEach(() => {
  vi.resetModules();
  mockExecuteRaw.mockReset().mockResolvedValue(0);
  mockQueryRaw.mockReset().mockResolvedValue([]);

  vi.doMock('@/database/client', () => ({
    prisma: { $executeRaw: mockExecuteRaw, $queryRaw: mockQueryRaw },
  }));
  vi.doMock('@/utils/logger', () => ({
    logger: { child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  }));
});

describe('Performance Snapshots', () => {
  describe('generateDailySnapshots', () => {
    it('generates snapshots from execution outcomes', async () => {
      mockQueryRaw.mockResolvedValueOnce([
        {
          strategy: 'debate',
          task_type: 'code-generation',
          complexity: 'medium',
          sample_size: BigInt(25),
          avg_quality: 0.88,
          avg_latency_ms: 4500,
          avg_cost_usd: 0.04,
          success_rate: 0.92,
          quality_p10: 0.72,
          quality_p90: 0.95,
          quality_stddev: 0.07,
        },
        {
          strategy: 'single',
          task_type: 'code-generation',
          complexity: 'medium',
          sample_size: BigInt(40),
          avg_quality: 0.76,
          avg_latency_ms: 2000,
          avg_cost_usd: 0.01,
          success_rate: 0.88,
          quality_p10: 0.60,
          quality_p90: 0.88,
          quality_stddev: 0.10,
        },
      ]);

      const { generateDailySnapshots } = await import('../performance-snapshots');
      const count = await generateDailySnapshots(new Date('2026-03-31'));

      expect(count).toBe(2);
      // Should have called $executeRaw twice (one per niche)
      expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
    });

    it('returns 0 when no data available', async () => {
      mockQueryRaw.mockResolvedValueOnce([]);

      const { generateDailySnapshots } = await import('../performance-snapshots');
      const count = await generateDailySnapshots();

      expect(count).toBe(0);
    });

    it('handles DB errors gracefully', async () => {
      mockQueryRaw.mockRejectedValue(new Error('DB error'));

      const { generateDailySnapshots } = await import('../performance-snapshots');
      const count = await generateDailySnapshots();

      expect(count).toBe(0);
    });
  });

  describe('getCompetitiveBenchmark', () => {
    it('returns strategies ranked by quality', async () => {
      mockQueryRaw.mockResolvedValueOnce([
        {
          strategy: 'debate', task_type: 'code-generation',
          avg_quality: 0.88, success_rate: 0.92, avg_latency_ms: 4500,
          avg_cost_usd: 0.04, total_samples: BigInt(150),
          avg_stability: 0.85, avg_confidence: 0.90,
        },
        {
          strategy: 'single', task_type: 'code-generation',
          avg_quality: 0.76, success_rate: 0.88, avg_latency_ms: 2000,
          avg_cost_usd: 0.01, total_samples: BigInt(300),
          avg_stability: 0.70, avg_confidence: 0.95,
        },
      ]);

      const { getCompetitiveBenchmark } = await import('../performance-snapshots');
      const rankings = await getCompetitiveBenchmark({ windowDays: 7 });

      expect(rankings).toHaveLength(2);
      // First result should be highest quality
      expect(rankings[0].strategy).toBe('debate');
      expect(rankings[0].avgQuality).toBeCloseTo(0.88, 2);
      expect(rankings[1].strategy).toBe('single');
    });

    it('returns empty array on error', async () => {
      mockQueryRaw.mockRejectedValue(new Error('DB error'));

      const { getCompetitiveBenchmark } = await import('../performance-snapshots');
      const rankings = await getCompetitiveBenchmark({});

      expect(rankings).toHaveLength(0);
    });
  });
});
