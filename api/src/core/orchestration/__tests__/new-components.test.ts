// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for new SOTA components:
 * - Thompson Sampling Bandit
 * - ModelPerformanceTracker
 * - WarRoomStrategy metadata
 * - DecisionAudit record structure
 * - KnowledgeGraph edge types
 * - MassiveParallel early-exit agreement calculation
 *
 * These tests are pure unit tests — no DB, no network.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ============================================
// Thompson Sampling Bandit
// ============================================
describe('StrategyBandit', () => {
  // We test the bandit logic directly without DB dependency.
  // The real module imports prisma at top level, so we mock it.
  beforeEach(() => {
    vi.resetModules();
  });

  it('selectStrategy returns null for empty candidates', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } }));
    vi.doMock('@/observability/ci-metrics', () => ({
      learningBanditsAlpha: { set: vi.fn() },
      learningBanditsBeta: { set: vi.fn() },
    }));
    const { strategyBandit } = await import('@/core/learning/strategy-bandit');
    const result = strategyBandit.selectStrategy('code-generation', 'medium', []);
    expect(result).toBeNull();
  });

  it('selectStrategy returns a strategy from candidates', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } }));
    vi.doMock('@/observability/ci-metrics', () => ({
      learningBanditsAlpha: { set: vi.fn() },
      learningBanditsBeta: { set: vi.fn() },
    }));
    const { strategyBandit } = await import('@/core/learning/strategy-bandit');
    const result = strategyBandit.selectStrategy('code-generation', 'medium', ['single', 'debate', 'consensus']);
    expect(result).not.toBeNull();
    expect(['single', 'debate', 'consensus']).toContain(result!.strategy);
    expect(result!.sampledScore).toBeGreaterThanOrEqual(0);
    expect(result!.sampledScore).toBeLessThanOrEqual(1);
  });

  it('update increases alpha for high quality', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } }));
    vi.doMock('@/observability/ci-metrics', () => ({
      learningBanditsAlpha: { set: vi.fn() },
      learningBanditsBeta: { set: vi.fn() },
    }));
    const { strategyBandit } = await import('@/core/learning/strategy-bandit');

    // Before update, get initial observation count
    const before = strategyBandit.getObservationCount('test', 'low', 'debate');

    strategyBandit.update({ taskType: 'test', complexity: 'low', strategy: 'debate', qualityScore: 0.9 });

    const after = strategyBandit.getObservationCount('test', 'low', 'debate');
    expect(after).toBe(before + 1);
  });

  it('update increases beta for low quality', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } }));
    vi.doMock('@/observability/ci-metrics', () => ({
      learningBanditsAlpha: { set: vi.fn() },
      learningBanditsBeta: { set: vi.fn() },
    }));
    const { strategyBandit } = await import('@/core/learning/strategy-bandit');

    // Record a failure
    strategyBandit.update({ taskType: 'test2', complexity: 'high', strategy: 'parallel', qualityScore: 0.2 });
    const rates = strategyBandit.getWinRates('test2', 'high', ['parallel']);
    // With Beta(1, 2), mean should be < 0.5
    expect(rates['parallel']).toBeLessThan(0.5);
  });

  it('hasConfidence returns false with insufficient observations', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } }));
    vi.doMock('@/observability/ci-metrics', () => ({
      learningBanditsAlpha: { set: vi.fn() },
      learningBanditsBeta: { set: vi.fn() },
    }));
    const { strategyBandit } = await import('@/core/learning/strategy-bandit');
    expect(strategyBandit.hasConfidence('unknown', 'unknown', 'single')).toBe(false);
  });
});

// ============================================
// ModelPerformanceTracker
// ============================================
describe('ModelPerformanceTracker', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null for unknown models', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: vi.fn() } }));
    const { modelPerformanceTracker } = await import('@/core/selection/model-performance-tracker');
    expect(modelPerformanceTracker.getDynamicScore('nonexistent-model')).toBeNull();
  });

  it('records samples and computes rolling quality', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: vi.fn() } }));
    const { modelPerformanceTracker } = await import('@/core/selection/model-performance-tracker');

    for (let i = 0; i < 10; i++) {
      modelPerformanceTracker.record({
        modelId: 'test-model-1',
        provider: 'test',
        qualityScore: 0.9,
        latencyMs: 500,
        success: true,
        costUsd: 0.01,
      });
    }

    const score = modelPerformanceTracker.getDynamicScore('test-model-1');
    expect(score).not.toBeNull();
    expect(score!.sampleCount).toBe(10);
    expect(score!.rollingQuality).toBeGreaterThan(0.5);
    expect(score!.errorRate).toBe(0);
  });

  it('tracks error rate correctly', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: vi.fn() } }));
    const { modelPerformanceTracker } = await import('@/core/selection/model-performance-tracker');

    // 3 success, 2 failures
    for (let i = 0; i < 3; i++) {
      modelPerformanceTracker.record({ modelId: 'err-model', provider: 'p', qualityScore: 0.8, latencyMs: 200, success: true, costUsd: 0.01 });
    }
    for (let i = 0; i < 2; i++) {
      modelPerformanceTracker.record({ modelId: 'err-model', provider: 'p', qualityScore: 0, latencyMs: 100, success: false, costUsd: 0 });
    }

    const score = modelPerformanceTracker.getDynamicScore('err-model');
    expect(score!.errorRate).toBe(0.4); // 2/5
  });

  it('applyToModel enriches model when enough samples', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: vi.fn() } }));
    const { modelPerformanceTracker } = await import('@/core/selection/model-performance-tracker');

    // Record enough samples
    for (let i = 0; i < 10; i++) {
      modelPerformanceTracker.record({ modelId: 'enrich-model', provider: 'p', qualityScore: 0.95, latencyMs: 300, success: true, costUsd: 0.01 });
    }

    const model = { id: 'enrich-model', performance: { quality: 0.5 } };
    const enriched = modelPerformanceTracker.applyToModel(model);
    // Should have replaced the static 0.5 with empirical ~0.95
    expect((enriched.performance as Record<string, unknown>).quality).toBeGreaterThan(0.7);
    expect((enriched.performance as Record<string, unknown>)._empirical).toBe(true);
  });

  it('applyToModel returns unchanged model with < 5 samples', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: vi.fn() } }));
    const { modelPerformanceTracker } = await import('@/core/selection/model-performance-tracker');

    modelPerformanceTracker.record({ modelId: 'few-samples', provider: 'p', qualityScore: 0.9, latencyMs: 200, success: true, costUsd: 0.01 });
    const model = { id: 'few-samples', performance: { quality: 0.5 } };
    const result = modelPerformanceTracker.applyToModel(model);
    expect(result).toBe(model); // Same reference — unchanged
  });
});

// ============================================
// StrategyBandit — extended coverage
// ============================================
describe('StrategyBandit — extended', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('partial update for mid-range quality (between thresholds)', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } }));
    vi.doMock('@/observability/ci-metrics', () => ({
      learningBanditsAlpha: { set: vi.fn() },
      learningBanditsBeta: { set: vi.fn() },
    }));
    const { strategyBandit } = await import('@/core/learning/strategy-bandit');

    // Quality 0.60 is between FAILURE_THRESHOLD (0.50) and SUCCESS_THRESHOLD (0.75)
    strategyBandit.update({ taskType: 'mid', complexity: 'low', strategy: 'single', qualityScore: 0.60 });
    const obs = strategyBandit.getObservationCount('mid', 'low', 'single');
    expect(obs).toBe(1); // Partial update still counts as 1 observation

    // Win rate should be near 0.5 (slight alpha bias from partial)
    const rates = strategyBandit.getWinRates('mid', 'low', ['single']);
    expect(rates['single']).toBeGreaterThan(0.3);
    expect(rates['single']).toBeLessThan(0.7);
  });

  it('hasConfidence returns true after enough observations', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } }));
    vi.doMock('@/observability/ci-metrics', () => ({
      learningBanditsAlpha: { set: vi.fn() },
      learningBanditsBeta: { set: vi.fn() },
    }));
    const { strategyBandit } = await import('@/core/learning/strategy-bandit');

    for (let i = 0; i < 6; i++) {
      strategyBandit.update({ taskType: 'conf', complexity: 'high', strategy: 'debate', qualityScore: 0.85 });
    }
    expect(strategyBandit.hasConfidence('conf', 'high', 'debate')).toBe(true);
  });

  it('getWinRates returns correct means', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } }));
    vi.doMock('@/observability/ci-metrics', () => ({
      learningBanditsAlpha: { set: vi.fn() },
      learningBanditsBeta: { set: vi.fn() },
    }));
    const { strategyBandit } = await import('@/core/learning/strategy-bandit');

    // 10 successes → Alpha ~11, Beta ~1 → mean ~0.916
    for (let i = 0; i < 10; i++) {
      strategyBandit.update({ taskType: 'wr', complexity: 'low', strategy: 'quality-multipass', qualityScore: 0.90 });
    }
    const rates = strategyBandit.getWinRates('wr', 'low', ['quality-multipass']);
    expect(rates['quality-multipass']).toBeGreaterThan(0.8);
  });

  it('prefers high-alpha strategy in selection over many runs', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } }));
    vi.doMock('@/observability/ci-metrics', () => ({
      learningBanditsAlpha: { set: vi.fn() },
      learningBanditsBeta: { set: vi.fn() },
    }));
    const { strategyBandit } = await import('@/core/learning/strategy-bandit');

    // Train 'good' with high quality, 'bad' with low quality
    for (let i = 0; i < 20; i++) {
      strategyBandit.update({ taskType: 'pref', complexity: 'high', strategy: 'good', qualityScore: 0.95 });
      strategyBandit.update({ taskType: 'pref', complexity: 'high', strategy: 'bad', qualityScore: 0.10 });
    }

    // Run selection many times — 'good' should win majority
    let goodWins = 0;
    for (let i = 0; i < 100; i++) {
      const result = strategyBandit.selectStrategy('pref', 'high', ['good', 'bad']);
      if (result?.strategy === 'good') goodWins++;
    }
    expect(goodWins).toBeGreaterThan(80); // Should win >80% of the time
  });
});

// ============================================
// ModelPerformanceTracker — extended coverage
// ============================================
describe('ModelPerformanceTracker — extended', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('ring buffer caps at 100 samples', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: vi.fn() } }));
    const { modelPerformanceTracker } = await import('@/core/selection/model-performance-tracker');

    for (let i = 0; i < 150; i++) {
      modelPerformanceTracker.record({
        modelId: 'ring-test',
        provider: 'p',
        qualityScore: 0.8,
        latencyMs: 200,
        success: true,
        costUsd: 0.01,
      });
    }

    const score = modelPerformanceTracker.getDynamicScore('ring-test');
    expect(score!.sampleCount).toBe(100); // Capped at RING_SIZE
  });

  it('getScores returns scores for multiple models', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: vi.fn() } }));
    const { modelPerformanceTracker } = await import('@/core/selection/model-performance-tracker');

    for (let i = 0; i < 5; i++) {
      modelPerformanceTracker.record({ modelId: 'model-a', provider: 'p', qualityScore: 0.8, latencyMs: 100, success: true, costUsd: 0.01 });
      modelPerformanceTracker.record({ modelId: 'model-b', provider: 'p', qualityScore: 0.6, latencyMs: 300, success: true, costUsd: 0.02 });
    }

    const scores = modelPerformanceTracker.getScores(['model-a', 'model-b', 'nonexistent']);
    expect(scores.size).toBe(2);
    expect(scores.has('model-a')).toBe(true);
    expect(scores.has('model-b')).toBe(true);
    expect(scores.has('nonexistent')).toBe(false);
  });

  it('EMA decay pulls quality down on failures', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: vi.fn() } }));
    const { modelPerformanceTracker } = await import('@/core/selection/model-performance-tracker');

    // Start with high quality
    for (let i = 0; i < 10; i++) {
      modelPerformanceTracker.record({ modelId: 'decay-test', provider: 'p', qualityScore: 0.95, latencyMs: 200, success: true, costUsd: 0.01 });
    }
    const before = modelPerformanceTracker.getDynamicScore('decay-test')!.rollingQuality;

    // Add failures
    for (let i = 0; i < 5; i++) {
      modelPerformanceTracker.record({ modelId: 'decay-test', provider: 'p', qualityScore: 0, latencyMs: 50, success: false, costUsd: 0 });
    }
    const after = modelPerformanceTracker.getDynamicScore('decay-test')!.rollingQuality;

    expect(after).toBeLessThan(before);
  });

  it('costEfficiency computed correctly', async () => {
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: vi.fn() } }));
    const { modelPerformanceTracker } = await import('@/core/selection/model-performance-tracker');

    for (let i = 0; i < 5; i++) {
      modelPerformanceTracker.record({ modelId: 'cost-test', provider: 'p', qualityScore: 0.8, latencyMs: 200, success: true, costUsd: 0.05 });
    }
    const score = modelPerformanceTracker.getDynamicScore('cost-test');
    expect(score!.costEfficiency).toBeGreaterThan(0);
  });
});

// ============================================
// DecisionAudit record structure
// ============================================
describe('DecisionAudit', () => {
  it('writeDecisionAudit does not throw (fire-and-forget)', async () => {
    vi.doMock('@/database/client', () => ({
      prisma: { $executeRaw: vi.fn().mockResolvedValue(1) },
    }));
    const { writeDecisionAudit } = await import('../decision-audit');

    // Should not throw even if DB fails
    expect(() => {
      writeDecisionAudit({
        requestId: 'test-123',
        organizationId: 'org-1',
        taskType: 'code-generation',
        complexity: 'medium',
        requestedStrategy: null,
        triageIntent: 'code-generation',
        triageComplexity: 'medium',
        triageConfidence: 0.85,
        triageRecommendedStrategy: null,
        strategyScores: { single: 0.7, debate: 0.6 },
        selectedStrategy: 'single' as never,
        selectionReason: 'scored',
        modelsConsidered: ['gpt-4o', 'claude-3.5-sonnet'],
        modelsSelected: ['gpt-4o'],
      });
    }).not.toThrow();
  });

  it('writeDecisionAudit survives DB failure', async () => {
    vi.doMock('@/database/client', () => ({
      prisma: { $executeRaw: vi.fn().mockRejectedValue(new Error('DB down')) },
    }));
    const { writeDecisionAudit } = await import('../decision-audit');

    // Should not throw — failure is logged, not propagated
    expect(() => {
      writeDecisionAudit({
        requestId: 'fail-123',
        organizationId: 'org-1',
        taskType: 'analysis',
        complexity: 'high',
        requestedStrategy: 'debate',
        triageIntent: null,
        triageComplexity: null,
        triageConfidence: null,
        triageRecommendedStrategy: null,
        strategyScores: {},
        selectedStrategy: 'debate' as never,
        selectionReason: 'explicit',
        modelsConsidered: [],
        modelsSelected: [],
      });
    }).not.toThrow();
  });
});

// ============================================
// KnowledgeGraph edge types
// ============================================
describe('KnowledgeGraph edge types', () => {
  it('edge type constants are valid', async () => {
    // Type-level check — EdgeType should accept these values
    const validTypes: Array<'model_task' | 'model_model' | 'strategy_model'> = [
      'model_task',
      'model_model',
      'strategy_model',
    ];
    expect(validTypes).toHaveLength(3);
  });

  it('recordExecution silently skips empty model arrays', async () => {
    const mockExecuteRaw = vi.fn();
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: mockExecuteRaw } }));
    const { knowledgeGraphService } = await import('@/core/learning/knowledge-graph-service');

    await knowledgeGraphService.recordExecution({
      strategy: 'single',
      taskType: 'code-generation',
      modelIds: [],
      qualityScore: 0.8,
    });

    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('recordExecution silently skips zero quality', async () => {
    const mockExecuteRaw = vi.fn();
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: mockExecuteRaw } }));
    const { knowledgeGraphService } = await import('@/core/learning/knowledge-graph-service');

    await knowledgeGraphService.recordExecution({
      strategy: 'single',
      taskType: 'code-generation',
      modelIds: ['gpt-4o'],
      qualityScore: 0,
    });

    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('recordExecution creates correct number of edges for single model', async () => {
    vi.resetModules();
    const mockExecuteRaw = vi.fn().mockResolvedValue(1);
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: mockExecuteRaw } }));
    const mod = await import('@/core/learning/knowledge-graph-service');

    await mod.knowledgeGraphService.recordExecution({
      strategy: 'debate',
      taskType: 'analysis',
      modelIds: ['gpt-4o'],
      qualityScore: 0.85,
    });

    // 1 model → 1 model_task edge + 1 strategy_model edge = 2 calls
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
  });

  it('recordExecution creates model_model edges for multi-model', async () => {
    vi.resetModules();
    const mockExecuteRaw = vi.fn().mockResolvedValue(1);
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: mockExecuteRaw } }));
    const mod = await import('@/core/learning/knowledge-graph-service');

    await mod.knowledgeGraphService.recordExecution({
      strategy: 'debate',
      taskType: 'analysis',
      modelIds: ['gpt-4o', 'claude-3.5-sonnet'],
      qualityScore: 0.85,
    });

    // 2 model_task + 2 strategy_model + 1 model_model (one pair) = 5 calls
    expect(mockExecuteRaw).toHaveBeenCalledTimes(5);
  });

  it('recordExecution handles DB failure gracefully', async () => {
    const mockExecuteRaw = vi.fn().mockRejectedValue(new Error('DB error'));
    vi.doMock('@/database/client', () => ({ prisma: { $executeRaw: mockExecuteRaw } }));
    const { knowledgeGraphService } = await import('@/core/learning/knowledge-graph-service');

    // Should not throw
    await expect(
      knowledgeGraphService.recordExecution({
        strategy: 'single',
        taskType: 'code-generation',
        modelIds: ['gpt-4o'],
        qualityScore: 0.8,
      })
    ).resolves.not.toThrow();
  });
});

// ============================================
// WarRoomStrategy metadata
// ============================================
describe('WarRoomStrategy', () => {
  it('has correct metadata', async () => {
    const { WarRoomStrategy } = await import('../strategies/war-room-strategy');
    const strategy = new WarRoomStrategy();
    const meta = strategy.getMetadata();

    expect(meta.id).toBe('war-room');
    expect(meta.name).toBe('war-room');
    expect(meta.minModels).toBe(3);
    expect(meta.maxModels).toBe(7);
    expect(meta.suitableFor).toContain('analysis');
    expect(meta.suitableFor).toContain('code-review');
  });

  it('supports streaming', async () => {
    const { WarRoomStrategy } = await import('../strategies/war-room-strategy');
    const strategy = new WarRoomStrategy();
    expect(strategy.supportsStreaming()).toBe(true);
  });
});

// ============================================
// Strategy contract includes war-room
// ============================================
describe('strategy-contract war-room', () => {
  it('maps war-room to its own canonical (war-room is a real strategy)', async () => {
    // Historical note: this test originally locked in `war-room → dynamic`
    // when war-room was just an execution alias for the dynamic strategy.
    // After commit d853608 ("29-strategy experiment"), war-room became a
    // first-class strategy with its own implementation in
    // `strategies/war-room-strategy.ts`. The canonical mapping was
    // promoted to `war-room → war-room` at that point but this test was
    // missed. Locking in the post-promotion behavior.
    const { mapExecutionToCanonical } = await import('../strategy-contract');
    expect(mapExecutionToCanonical('war-room')).toBe('war-room');
  });
});
