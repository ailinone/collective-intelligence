// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Outcome Measurement — Unit Tests
 *
 * Tests the persistence layer that links decisions to measured outcomes.
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

describe('Outcome Measurement', () => {
  describe('recordOutcome', () => {
    it('persists execution outcome to database', async () => {
      const { recordOutcome } = await import('../outcome-measurement');

      await recordOutcome({
        decisionTraceId: 'req-123',
        strategy: 'debate',
        startedAt: new Date('2026-03-31T10:00:00Z'),
        finishedAt: new Date('2026-03-31T10:00:05Z'),
        latencyMs: 5000,
        costUsd: 0.05,
        totalTokens: 2000,
        success: true,
        retries: 0,
        fallbackUsed: false,
        escalationUsed: false,
        qualityScore: 0.88,
        qualityDimensions: { correctness: 0.9, completeness: 0.85 },
        feedbackIterations: 1,
        modelsUsed: ['gpt-4o', 'claude-sonnet'],
      });

      expect(mockExecuteRaw).toHaveBeenCalledOnce();
    });

    it('handles DB errors gracefully without throwing', async () => {
      mockExecuteRaw.mockRejectedValue(new Error('Connection refused'));
      const { recordOutcome } = await import('../outcome-measurement');

      // Should not throw
      await expect(recordOutcome({
        decisionTraceId: 'req-fail',
        strategy: 'single',
        startedAt: new Date(),
        finishedAt: new Date(),
        latencyMs: 1000,
        costUsd: 0.01,
        totalTokens: 500,
        success: true,
        retries: 0,
        fallbackUsed: false,
        escalationUsed: false,
        qualityScore: 0.8,
        feedbackIterations: 1,
        modelsUsed: ['gpt-4o'],
      })).resolves.not.toThrow();
    });

    it('handles null quality score (missing data)', async () => {
      const { recordOutcome } = await import('../outcome-measurement');

      await recordOutcome({
        decisionTraceId: 'req-null-quality',
        strategy: 'single',
        startedAt: new Date(),
        finishedAt: new Date(),
        latencyMs: 2000,
        costUsd: 0.02,
        totalTokens: 800,
        success: false,
        failureReason: 'Provider timeout',
        retries: 2,
        fallbackUsed: true,
        escalationUsed: false,
        qualityScore: null, // Missing — never invented
        feedbackIterations: 1,
        modelsUsed: [],
      });

      expect(mockExecuteRaw).toHaveBeenCalledOnce();
    });
  });

  describe('getRecentOutcomes', () => {
    it('returns mapped outcomes from DB', async () => {
      mockQueryRaw.mockResolvedValue([
        {
          decision_trace_id: 'req-1',
          strategy: 'debate',
          latency_ms: 3000,
          cost_usd: 0.03,
          success: true,
          quality_score: 0.9,
          created_at: new Date(),
        },
      ]);

      const { getRecentOutcomes } = await import('../outcome-measurement');
      const outcomes = await getRecentOutcomes({
        since: new Date(Date.now() - 86_400_000),
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].strategy).toBe('debate');
      expect(outcomes[0].qualityScore).toBe(0.9);
    });

    it('returns empty array on DB error', async () => {
      mockQueryRaw.mockRejectedValue(new Error('DB error'));

      const { getRecentOutcomes } = await import('../outcome-measurement');
      const outcomes = await getRecentOutcomes({
        since: new Date(Date.now() - 86_400_000),
      });

      expect(outcomes).toHaveLength(0);
    });
  });

  describe('getAggregatedMetrics', () => {
    it('returns aggregated metrics from DB', async () => {
      mockQueryRaw.mockResolvedValue([{
        sample_size: BigInt(50),
        avg_quality: 0.82,
        avg_latency_ms: 3000,
        avg_cost_usd: 0.025,
        success_rate: 0.92,
        quality_p10: 0.65,
        quality_p90: 0.95,
        quality_stddev: 0.08,
      }]);

      const { getAggregatedMetrics } = await import('../outcome-measurement');
      const metrics = await getAggregatedMetrics({
        strategy: 'debate',
        taskType: 'code-generation',
        complexity: 'medium',
        since: new Date(Date.now() - 7 * 86_400_000),
        until: new Date(),
      });

      expect(metrics).not.toBeNull();
      expect(metrics!.sampleSize).toBe(50);
      expect(metrics!.avgQuality).toBeCloseTo(0.82, 2);
      expect(metrics!.successRate).toBeCloseTo(0.92, 2);
    });

    it('returns null when no data', async () => {
      mockQueryRaw.mockResolvedValue([{ sample_size: BigInt(0), avg_quality: null, avg_latency_ms: null, avg_cost_usd: null, success_rate: null, quality_p10: null, quality_p90: null, quality_stddev: null }]);

      const { getAggregatedMetrics } = await import('../outcome-measurement');
      const metrics = await getAggregatedMetrics({
        strategy: 'nonexistent',
        taskType: 'general',
        complexity: 'low',
        since: new Date(),
        until: new Date(),
      });

      expect(metrics).toBeNull();
    });
  });
});
