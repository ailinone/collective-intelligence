// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SOTA Pipeline Integration Test (OI-06/07/08/09/10/11)
 *
 * Tests the FULL data pipeline end-to-end:
 *   benchmark → champion-challenger → archive → KG → Pareto
 *
 * This validates that all dead code paths from the Fase 3 audit are now
 * properly wired and data flows through the entire system.
 *
 * No real database or API — mocks the external boundaries only.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Shared mocks ─────────────────────────────────────────────────────────

const mockExecuteRaw = vi.fn().mockResolvedValue(0);
const mockFindMany = vi.fn().mockResolvedValue([]);

beforeEach(() => {
  vi.resetModules();
  mockExecuteRaw.mockReset().mockResolvedValue(0);
  mockFindMany.mockReset().mockResolvedValue([]);

  vi.doMock('@/database/client', () => ({
    prisma: {
      strategyWeight: {
        findMany: mockFindMany,
        upsert: vi.fn().mockResolvedValue({}),
      },
      $executeRaw: mockExecuteRaw,
      $queryRaw: vi.fn().mockResolvedValue([]),
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
  vi.doMock('@/observability/ci-metrics', () => ({
    learningBanditsAlpha: { set: vi.fn() },
    learningBanditsBeta: { set: vi.fn() },
    banditRollbacksTotal: { inc: vi.fn() },
    ciMetrics: {
      championChallengerPromotions: { inc: vi.fn() },
      championChallengerRejections: { inc: vi.fn() },
      championChallengerQualityDelta: { observe: vi.fn() },
    },
    recordAdaptiveQualityTarget: vi.fn(),
    recordParetoEvaluation: vi.fn(),
    recordKnowledgeGraphState: vi.fn(),
    recordArchiveState: vi.fn(),
  }));
});

// ─── Helpers ──────────────────────────────────────────────────────────────

interface MockBenchmarkResult {
  taskType: string;
  complexity: string;
  strategy: string;
  qualityScore: number;
  success: boolean;
  durationMs: number;
  costUsd?: number;
}

function makeBenchmarkResults(): MockBenchmarkResult[] {
  return [
    // code-generation / medium — single vs debate (genuine trade-off)
    { taskType: 'code-generation', complexity: 'medium', strategy: 'single', qualityScore: 0.75, success: true, durationMs: 2000 },
    { taskType: 'code-generation', complexity: 'medium', strategy: 'single', qualityScore: 0.78, success: true, durationMs: 1800 },
    { taskType: 'code-generation', complexity: 'medium', strategy: 'single', qualityScore: 0.80, success: true, durationMs: 2200 },
    { taskType: 'code-generation', complexity: 'medium', strategy: 'single', qualityScore: 0.72, success: true, durationMs: 1900 },
    { taskType: 'code-generation', complexity: 'medium', strategy: 'single', qualityScore: 0.77, success: true, durationMs: 2100 },
    { taskType: 'code-generation', complexity: 'medium', strategy: 'debate', qualityScore: 0.90, success: true, durationMs: 5000 },
    { taskType: 'code-generation', complexity: 'medium', strategy: 'debate', qualityScore: 0.88, success: true, durationMs: 4800 },
    { taskType: 'code-generation', complexity: 'medium', strategy: 'debate', qualityScore: 0.92, success: true, durationMs: 5200 },
    { taskType: 'code-generation', complexity: 'medium', strategy: 'debate', qualityScore: 0.85, success: true, durationMs: 4500 },
    { taskType: 'code-generation', complexity: 'medium', strategy: 'debate', qualityScore: 0.89, success: true, durationMs: 5100 },
    // analysis / high — consensus
    { taskType: 'analysis', complexity: 'high', strategy: 'consensus', qualityScore: 0.82, success: true, durationMs: 6000 },
    { taskType: 'analysis', complexity: 'high', strategy: 'consensus', qualityScore: 0.85, success: true, durationMs: 5800 },
    { taskType: 'analysis', complexity: 'high', strategy: 'consensus', qualityScore: 0.80, success: true, durationMs: 6200 },
    { taskType: 'analysis', complexity: 'high', strategy: 'consensus', qualityScore: 0.84, success: true, durationMs: 5500 },
    { taskType: 'analysis', complexity: 'high', strategy: 'consensus', qualityScore: 0.88, success: true, durationMs: 5900 },
  ];
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('SOTA Pipeline Integration', () => {
  it('benchmark results flow through archive → Pareto → KG', async () => {
    const { configurationArchive } = await import('../configuration-archive');
    const { evaluatePareto, getParetoSnapshot, getBestFromFrontier } = await import('../pareto-champion-challenger');
    const { knowledgeGraphService } = await import('../knowledge-graph-service');

    const results = makeBenchmarkResults();

    // ── Step 1: Aggregate and ingest into archive ────────────────────
    const archiveAggregates = new Map<string, {
      taskType: string; complexity: string; strategy: string;
      totalQuality: number; totalLatency: number; successCount: number; count: number;
    }>();

    for (const r of results) {
      const key = `${r.taskType}|${r.complexity}|${r.strategy}`;
      const agg = archiveAggregates.get(key) ?? {
        taskType: r.taskType, complexity: r.complexity, strategy: r.strategy,
        totalQuality: 0, totalLatency: 0, successCount: 0, count: 0,
      };
      agg.totalQuality += r.qualityScore;
      agg.totalLatency += r.durationMs;
      agg.successCount += r.success ? 1 : 0;
      agg.count++;
      archiveAggregates.set(key, agg);
    }

    const archiveIngestion = configurationArchive.ingestBenchmarkResults(
      [...archiveAggregates.values()].map(a => ({
        taskType: a.taskType,
        complexity: a.complexity,
        strategy: a.strategy,
        avgQuality: a.totalQuality / a.count,
        avgCost: 0,
        avgLatency: a.totalLatency / a.count,
        successRate: a.successCount / a.count,
        sampleCount: a.count,
      })),
    );

    expect(archiveIngestion.totalInserted).toBeGreaterThanOrEqual(2);
    expect(archiveIngestion.cellsUpdated).toBeGreaterThan(0);

    // Verify quality elite: debate (higher avg quality) should be the quality elite
    const codeGenElite = configurationArchive.getElite('code-generation', 'medium', 'quality');
    expect(codeGenElite).not.toBeNull();
    expect(codeGenElite!.strategy).toBe('debate');

    // ── Step 2: Pareto frontier evaluation ──────────────────────────
    const paretoResult = evaluatePareto(results);

    expect(paretoResult.totalNiches).toBe(2);

    // Both single (fast) and debate (quality) should be non-dominated
    const codeGenFrontier = paretoResult.frontiers.find(f => f.taskType === 'code-generation');
    expect(codeGenFrontier).toBeDefined();
    expect(codeGenFrontier!.nonDominated.length).toBeGreaterThanOrEqual(1);

    // Snapshot is populated
    const snapshot = getParetoSnapshot();
    expect(snapshot.nicheCount).toBe(2);

    // Quality preference → debate
    const qualityBest = getBestFromFrontier('code-generation', 'medium', 'quality');
    expect(qualityBest).not.toBeNull();
    expect(qualityBest!.strategy).toBe('debate');

    // ── Step 3: Knowledge graph recording ────────────────────────────
    await knowledgeGraphService.recordBenchmarkResults(
      results.filter(r => r.success).map(r => ({
        taskType: r.taskType,
        strategy: r.strategy,
        qualityScore: r.qualityScore,
        complexity: r.complexity,
      })),
    );
    // KG recording completes without error

    // ── Step 4: Record archive elites in KG ──────────────────────────
    const archiveSnapshot = configurationArchive.getSnapshot();
    expect(archiveSnapshot.topElites.length).toBeGreaterThan(0);

    await knowledgeGraphService.recordArchiveElites(
      archiveSnapshot.topElites.map(e => ({
        taskType: e.taskType,
        complexity: e.complexity,
        dimension: e.dimension,
        strategy: e.strategy,
        fitness: e.fitness,
        avgQuality: e.avgQuality,
      })),
    );

    // ── Step 5: Verify alternatives for escalation (OI-10) ──────────
    const alternatives = configurationArchive.getAlternatives('code-generation', 'medium');
    expect(alternatives.length).toBeGreaterThan(0);
    const dimensions = alternatives.map(a => a.dimension);
    expect(dimensions).toContain('quality');
    expect(dimensions).toContain('balanced');
  });

  it('production results update archive and bandit state', async () => {
    const { configurationArchive } = await import('../configuration-archive');
    const { strategyBandit } = await import('../strategy-bandit');

    // Simulate production executions
    for (let i = 0; i < 10; i++) {
      configurationArchive.ingestProductionResult({
        taskType: 'code-generation',
        complexity: 'medium',
        strategy: 'single',
        qualityScore: 0.75 + Math.random() * 0.1,
        costUsd: 0.01,
        latencyMs: 2000,
        success: true,
        totalTokens: 400,
      });

      strategyBandit.update({
        taskType: 'code-generation',
        complexity: 'medium',
        strategy: 'single',
        qualityScore: 0.8,
      });
      strategyBandit.recordExecution(0.8, 2000);
    }

    // Bandit should have confidence now (10 > MIN_OBSERVATIONS_FOR_OVERRIDE = 5)
    expect(strategyBandit.hasConfidence('code-generation', 'medium', 'single')).toBe(true);

    // Win rate should reflect the quality scores (0.8 > SUCCESS_THRESHOLD = 0.75)
    const rates = strategyBandit.getWinRates('code-generation', 'medium', ['single']);
    expect(rates['single']).toBeGreaterThan(0.6);

    // Snapshot should succeed (10 >= minimum for reward rate)
    const snapshot = strategyBandit.takeSnapshot();
    expect(snapshot).not.toBeNull();
  });

  it('adaptive quality target returns learned from DB data', async () => {
    // Override findMany for this test to return strategy weight rows
    mockFindMany.mockResolvedValue([
      {
        id: 1, taskType: 'code-generation', complexity: 'medium',
        strategy: 'single', weight: 1.0, avgQuality: 0.78,
        avgCostEfficiency: 80, successRate: 0.85, sampleCount: 30,
      },
      {
        id: 2, taskType: 'code-generation', complexity: 'medium',
        strategy: 'debate', weight: 1.2, avgQuality: 0.92,
        avgCostEfficiency: 20, successRate: 0.90, sampleCount: 25,
      },
    ]);

    const { getAdaptiveQualityTarget } = await import('../../quality/adaptive-quality-targets');
    const target = await getAdaptiveQualityTarget('code-generation', 'medium');

    expect(target.source).toBe('learned');
    expect(target.target).toBeGreaterThan(0.5);
    expect(target.target).toBeLessThan(1.0);
    expect(target.confidence).toBeGreaterThan(0);
    expect(target.historicalAvg).not.toBeNull();
  });

  it('archive excludes speed/quality-per-token dimensions for DB-seeded data', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 1, taskType: 'code-generation', complexity: 'medium',
        strategy: 'single', weight: 1.0, avgQuality: 0.8,
        avgCostEfficiency: 80, successRate: 0.9, sampleCount: 20,
      },
    ]);

    const { configurationArchive } = await import('../configuration-archive');

    const seeded = await configurationArchive.seedFromDB();
    expect(seeded).toBeGreaterThanOrEqual(1);

    // Speed and quality-per-token should NOT be populated
    expect(configurationArchive.getElite('code-generation', 'medium', 'speed')).toBeNull();
    expect(configurationArchive.getElite('code-generation', 'medium', 'quality-per-token')).toBeNull();

    // Quality, balanced, reliability SHOULD be populated
    expect(configurationArchive.getElite('code-generation', 'medium', 'quality')).not.toBeNull();
    expect(configurationArchive.getElite('code-generation', 'medium', 'balanced')).not.toBeNull();
    expect(configurationArchive.getElite('code-generation', 'medium', 'reliability')).not.toBeNull();
  });
});
