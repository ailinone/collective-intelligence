// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shadow Evaluation — Unit Tests
 *
 * Tests sampling, budget control, regret calculation, and stats.
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

describe('Shadow Evaluation', () => {
  describe('shouldRunShadowEval', () => {
    it('returns false when disabled via env', async () => {
      vi.stubEnv('SHADOW_EVAL_ENABLED', 'false');
      const { shouldRunShadowEval } = await import('../shadow-evaluation');
      expect(shouldRunShadowEval()).toBe(false);
    });

    it('respects sampling rate', async () => {
      vi.stubEnv('SHADOW_EVAL_SAMPLING_RATE', '1.0'); // 100% sampling
      vi.stubEnv('SHADOW_EVAL_ENABLED', 'true');
      const { shouldRunShadowEval } = await import('../shadow-evaluation');
      // With 100% rate, should always return true (barring budget/concurrency)
      expect(shouldRunShadowEval()).toBe(true);
    });
  });

  describe('recordShadowEvaluation', () => {
    it('persists comparison to database', async () => {
      const { recordShadowEvaluation } = await import('../shadow-evaluation');

      await recordShadowEvaluation(
        {
          decisionTraceId: 'req-1',
          taskType: 'code-generation',
          complexity: 'medium',
          chosenStrategy: 'single',
          chosenQuality: 0.75,
          chosenLatencyMs: 2000,
          chosenCostUsd: 0.01,
        },
        {
          shadowStrategy: 'debate',
          shadowQuality: 0.90,
          shadowLatencyMs: 5000,
          shadowCostUsd: 0.05,
          qualityRegret: 0.15,
          winnerStrategy: 'debate',
        },
      );

      expect(mockExecuteRaw).toHaveBeenCalledOnce();
    });

    it('handles DB errors gracefully', async () => {
      mockExecuteRaw.mockRejectedValue(new Error('DB down'));
      const { recordShadowEvaluation } = await import('../shadow-evaluation');

      await expect(recordShadowEvaluation(
        {
          decisionTraceId: 'req-fail', taskType: 'general', complexity: 'low',
          chosenStrategy: 'single', chosenQuality: 0.8, chosenLatencyMs: 1000, chosenCostUsd: 0.01,
        },
        {
          shadowStrategy: 'debate', shadowQuality: 0.85, shadowLatencyMs: 3000,
          shadowCostUsd: 0.03, qualityRegret: 0.05, winnerStrategy: 'debate',
        },
      )).resolves.not.toThrow();
    });
  });

  describe('runShadowEvaluation', () => {
    it('executes shadow strategy and records comparison', async () => {
      vi.stubEnv('SHADOW_EVAL_SAMPLING_RATE', '1.0');
      vi.stubEnv('SHADOW_EVAL_ENABLED', 'true');
      const { runShadowEvaluation } = await import('../shadow-evaluation');

      const result = await runShadowEvaluation(
        {
          decisionTraceId: 'req-shadow',
          taskType: 'code-generation',
          complexity: 'medium',
          chosenStrategy: 'single',
          chosenQuality: 0.70,
          chosenLatencyMs: 2000,
          chosenCostUsd: 0.01,
        },
        'debate',
        async () => ({ quality: 0.90, latencyMs: 5000, costUsd: 0.05 }),
      );

      expect(result).not.toBeNull();
      expect(result!.shadowStrategy).toBe('debate');
      expect(result!.shadowQuality).toBe(0.90);
      expect(result!.qualityRegret).toBeCloseTo(0.20, 2);
      expect(result!.winnerStrategy).toBe('debate');
    });

    it('returns null when shadow execution fails', async () => {
      vi.stubEnv('SHADOW_EVAL_SAMPLING_RATE', '1.0');
      vi.stubEnv('SHADOW_EVAL_ENABLED', 'true');
      const { runShadowEvaluation } = await import('../shadow-evaluation');

      const result = await runShadowEvaluation(
        {
          decisionTraceId: 'req-fail', taskType: 'general', complexity: 'low',
          chosenStrategy: 'single', chosenQuality: 0.8, chosenLatencyMs: 1000, chosenCostUsd: 0.01,
        },
        'debate',
        async () => { throw new Error('Provider timeout'); },
      );

      expect(result).toBeNull();
    });
  });

  describe('getShadowEvalStats', () => {
    it('returns aggregated stats from DB', async () => {
      mockQueryRaw
        .mockResolvedValueOnce([{
          total: BigInt(100), avg_regret: 0.08,
          chosen_wins: BigInt(65), shadow_wins: BigInt(35),
        }])
        .mockResolvedValueOnce([
          { chosen_strategy: 'single', shadow_strategy: 'debate', avg_regret: 0.15, cnt: BigInt(20) },
        ]);

      const { getShadowEvalStats } = await import('../shadow-evaluation');
      const stats = await getShadowEvalStats(24);

      expect(stats.totalEvals).toBe(100);
      expect(stats.avgRegret).toBeCloseTo(0.08, 2);
      expect(stats.chosenWinRate).toBeCloseTo(0.65, 2);
      expect(stats.topRegretStrategies).toHaveLength(1);
      expect(stats.topRegretStrategies[0].avgRegret).toBeCloseTo(0.15, 2);
    });
  });

  describe('getShadowEvalConfig', () => {
    it('returns current config and budget status', async () => {
      const { getShadowEvalConfig } = await import('../shadow-evaluation');
      const config = getShadowEvalConfig();

      expect(config).toHaveProperty('enabled');
      expect(config).toHaveProperty('samplingRate');
      expect(config).toHaveProperty('maxCostPerHourUsd');
      expect(config).toHaveProperty('budgetRemaining');
      expect(config.budgetRemaining).toBeGreaterThanOrEqual(0);
    });
  });
});
