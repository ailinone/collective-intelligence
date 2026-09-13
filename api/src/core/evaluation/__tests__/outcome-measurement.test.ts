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
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
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
      await expect(
        recordOutcome({
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
        })
      ).resolves.not.toThrow();
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

    // ─── Regression: 2026-02-20 negative-cost incident (write boundary) ────
    // This is the ONLY write path into execution_outcomes, which
    // drift-detection.ts / learning-validation.ts / performance-snapshots.ts
    // all later aggregate with AVG(cost_usd). Guarding here stops a
    // negative/NaN/Infinite cost from ever reaching the column.
    it('never persists a negative costUsd — guard rejects it before the INSERT runs', async () => {
      const originalPolicy = process.env.CI_COST_INTEGRITY_POLICY;
      const originalNodeEnv = process.env.NODE_ENV;
      delete process.env.CI_COST_INTEGRITY_POLICY; // exercise the real default
      process.env.NODE_ENV = 'test'; // env-dependent -> strict-throw outside production

      try {
        const { recordOutcome } = await import('../outcome-measurement');

        // -58.04 is the exact per-execution signature from the incident
        // (48 x -58.04 aggregated to avgCostPerRequest: -2786 USD).
        await recordOutcome({
          decisionTraceId: 'req-negative-cost',
          strategy: 'debate',
          startedAt: new Date(),
          finishedAt: new Date(),
          latencyMs: 5000,
          costUsd: -58.04,
          totalTokens: 2000,
          success: true,
          retries: 0,
          fallbackUsed: false,
          escalationUsed: false,
          qualityScore: 0.8,
          feedbackIterations: 1,
          modelsUsed: ['gpt-4o'],
        });

        // guardCost() throws under strict-throw; recordOutcome's own
        // try/catch swallows it (fire-and-forget contract) — the INSERT
        // must never run with the corrupted value.
        expect(mockExecuteRaw).not.toHaveBeenCalled();
      } finally {
        if (originalPolicy !== undefined) {
          process.env.CI_COST_INTEGRITY_POLICY = originalPolicy;
        } else {
          delete process.env.CI_COST_INTEGRITY_POLICY;
        }
        if (originalNodeEnv !== undefined) {
          process.env.NODE_ENV = originalNodeEnv;
        } else {
          delete process.env.NODE_ENV;
        }
      }
    });

    it('coalesces a rejected cost to 0 (never negative) when the policy does not throw', async () => {
      const originalPolicy = process.env.CI_COST_INTEGRITY_POLICY;
      process.env.CI_COST_INTEGRITY_POLICY = 'warn-and-null';

      try {
        const { recordOutcome } = await import('../outcome-measurement');

        await recordOutcome({
          decisionTraceId: 'req-negative-cost-prod',
          strategy: 'debate',
          startedAt: new Date(),
          finishedAt: new Date(),
          latencyMs: 5000,
          costUsd: -2786.097718,
          totalTokens: 2000,
          success: true,
          retries: 0,
          fallbackUsed: false,
          escalationUsed: false,
          qualityScore: 0.8,
          feedbackIterations: 1,
          modelsUsed: ['gpt-4o'],
        });

        expect(mockExecuteRaw).toHaveBeenCalledOnce();
        // `cost_usd` is NOT NULL Decimal(10,6) DEFAULT 0 — the guard's `null`
        // result is coalesced to 0 for storage, never left negative.
        // $executeRaw is invoked as a template tag: calls[0] = [strings, ...values];
        // VALUES order is decisionTraceId(1), strategy(2), startedAt(3),
        // finishedAt(4), latencyMs(5), costUsd(6).
        const insertedCostUsd = mockExecuteRaw.mock.calls[0][6];
        expect(insertedCostUsd).toBe(0);
      } finally {
        if (originalPolicy !== undefined) {
          process.env.CI_COST_INTEGRITY_POLICY = originalPolicy;
        } else {
          delete process.env.CI_COST_INTEGRITY_POLICY;
        }
      }
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
      mockQueryRaw.mockResolvedValue([
        {
          sample_size: BigInt(50),
          avg_quality: 0.82,
          avg_latency_ms: 3000,
          cost_usd_samples: Array.from({ length: 50 }, () => 0.025),
          success_rate: 0.92,
          quality_p10: 0.65,
          quality_p90: 0.95,
          quality_stddev: 0.08,
        },
      ]);

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
      expect(metrics!.avgCostUsd).toBeCloseTo(0.025, 6);
    });

    it('returns null when no data', async () => {
      mockQueryRaw.mockResolvedValue([
        {
          sample_size: BigInt(0),
          avg_quality: null,
          avg_latency_ms: null,
          cost_usd_samples: null,
          success_rate: null,
          quality_p10: null,
          quality_p90: null,
          quality_stddev: null,
        },
      ]);

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

    // ─── Regression: 2026-02-20 negative-cost incident ──────────────────────
    // eval-baseline-metrics.json reported `avgCostPerRequest: -2786 USD` for
    // the debate strategy — the SQL AVG(cost_usd) blindly averaged corrupted
    // negative rows. getAggregatedMetrics now fetches the raw per-row samples
    // and runs them through filterValidCosts() before averaging, so the same
    // input can no longer reproduce that corrupted output.
    it('does not reproduce the -2786 avgCostPerRequest incident when corrupted rows are present', async () => {
      // 48 debate executions at -58.04 USD each == -2786.xx aggregated, the
      // exact shape observed in the incident.
      mockQueryRaw.mockResolvedValue([
        {
          sample_size: BigInt(48),
          avg_quality: 0.7,
          avg_latency_ms: 4000,
          cost_usd_samples: Array.from({ length: 48 }, () => -58.04),
          success_rate: 1.0,
          quality_p10: 0.6,
          quality_p90: 0.8,
          quality_stddev: 0.05,
        },
      ]);

      const { getAggregatedMetrics } = await import('../outcome-measurement');
      const metrics = await getAggregatedMetrics({
        strategy: 'debate',
        taskType: 'code-generation',
        complexity: 'medium',
        since: new Date(Date.now() - 7 * 86_400_000),
        until: new Date(),
      });

      expect(metrics).not.toBeNull();
      // Critical: NOT -2786-ish, NOT -58.04 — every sample was invalid, so
      // the aggregate falls back to 0 rather than propagating corruption.
      expect(metrics!.avgCostUsd).toBe(0);
      expect(metrics!.avgCostUsd).not.toBeLessThan(0);
    });

    it('averages only the valid samples when corrupted rows are mixed with clean ones', async () => {
      mockQueryRaw.mockResolvedValue([
        {
          sample_size: BigInt(4),
          avg_quality: 0.75,
          avg_latency_ms: 2500,
          // 2 clean executions at 0.05 + 2 corrupted negative rows. A naive
          // SQL AVG(cost_usd) would report (0.05 + 0.05 - 58.04 - 58.04) / 4
          // = -28.995, still negative. Filtered, it must average only the
          // clean pair.
          cost_usd_samples: [0.05, 0.05, -58.04, -58.04],
          success_rate: 1.0,
          quality_p10: 0.6,
          quality_p90: 0.9,
          quality_stddev: 0.05,
        },
      ]);

      const { getAggregatedMetrics } = await import('../outcome-measurement');
      const metrics = await getAggregatedMetrics({
        strategy: 'debate',
        taskType: 'code-generation',
        complexity: 'medium',
        since: new Date(Date.now() - 7 * 86_400_000),
        until: new Date(),
      });

      expect(metrics).not.toBeNull();
      expect(metrics!.avgCostUsd).toBeCloseTo(0.05, 6);
    });
  });
});
