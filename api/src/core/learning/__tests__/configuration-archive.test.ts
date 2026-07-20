// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Configuration Archive (OI-06) — Unit Tests
 *
 * Tests the quality-diversity archive without database dependency.
 * Validates: tryInsert with fitness comparison, dimension exclusion,
 * ingestBenchmarkResults aggregation, ingestProductionResult EMA,
 * getAlternatives, getRecommendation, decay, and snapshot.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock DB and logger before importing the module
vi.mock('@/database/client', () => ({
  prisma: {
    strategyWeight: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Use dynamic import to get a fresh module per describe block
async function createArchive() {
  // Reset module registry to get a fresh singleton
  vi.resetModules();
  vi.mock('@/database/client', () => ({
    prisma: {
      strategyWeight: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  }));
  vi.mock('@/utils/logger', () => ({
    logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
      child: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    },
  }));

  const mod = await import('../configuration-archive');
  return mod.configurationArchive;
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    strategy: 'single',
    avgQuality: 0.85,
    avgCost: 0.01,
    avgLatency: 2000,
    successRate: 0.9,
    sampleCount: 10,
    avgTokens: 500,
    promotionSource: 'benchmark' as const,
    ...overrides,
  };
}

describe('ConfigurationArchive', () => {
  describe('tryInsert', () => {
    it('rejects configs with insufficient samples', async () => {
      const archive = await createArchive();
      const result = archive.tryInsert('code-generation', 'medium', makeConfig({ sampleCount: 2 }));
      expect(result.inserted).toBe(false);
      expect(result.cellsUpdated).toHaveLength(0);
    });

    it('inserts config when no elite exists', async () => {
      const archive = await createArchive();
      const result = archive.tryInsert('code-generation', 'medium', makeConfig());
      expect(result.inserted).toBe(true);
      expect(result.cellsUpdated.length).toBeGreaterThan(0);
    });

    it('inserts across multiple dimensions simultaneously', async () => {
      const archive = await createArchive();
      const result = archive.tryInsert('code-generation', 'medium', makeConfig());
      // A single config can be elite in multiple dimensions
      expect(result.cellsUpdated.length).toBeGreaterThanOrEqual(1);
      // Should be present in quality, cost-efficient, speed, balanced, reliability, quality-per-token
      expect(result.cellsUpdated).toContain('quality');
      expect(result.cellsUpdated).toContain('balanced');
    });

    it('replaces elite when new config has higher fitness', async () => {
      const archive = await createArchive();
      archive.tryInsert('code-generation', 'medium', makeConfig({ strategy: 'single', avgQuality: 0.7 }));
      const result = archive.tryInsert('code-generation', 'medium', makeConfig({ strategy: 'debate', avgQuality: 0.95 }));
      expect(result.inserted).toBe(true);

      // The quality elite should now be 'debate'
      const elite = archive.getElite('code-generation', 'medium', 'quality');
      expect(elite).not.toBeNull();
      expect(elite!.strategy).toBe('debate');
    });

    it('rejects config when existing elite has higher fitness', async () => {
      const archive = await createArchive();
      archive.tryInsert('code-generation', 'medium', makeConfig({ strategy: 'debate', avgQuality: 0.95 }));
      const result = archive.tryInsert('code-generation', 'medium', makeConfig({ strategy: 'single', avgQuality: 0.5 }));
      // May still insert in some dimensions (e.g., cost-efficient if cost is better)
      // but quality dimension should remain 'debate'
      const elite = archive.getElite('code-generation', 'medium', 'quality');
      expect(elite!.strategy).toBe('debate');
    });

    it('respects excludeDimensions option', async () => {
      const archive = await createArchive();
      const result = archive.tryInsert(
        'code-generation', 'medium',
        makeConfig(),
        { excludeDimensions: ['speed', 'quality-per-token'] },
      );
      expect(result.cellsUpdated).not.toContain('speed');
      expect(result.cellsUpdated).not.toContain('quality-per-token');
      // But other dimensions should be populated
      expect(result.cellsUpdated).toContain('quality');

      // Verify speed and quality-per-token cells are truly empty
      expect(archive.getElite('code-generation', 'medium', 'speed')).toBeNull();
      expect(archive.getElite('code-generation', 'medium', 'quality-per-token')).toBeNull();
    });
  });

  describe('getAlternatives', () => {
    it('returns all dimension elites for a niche', async () => {
      const archive = await createArchive();
      archive.tryInsert('code-generation', 'medium', makeConfig());
      const alternatives = archive.getAlternatives('code-generation', 'medium');
      expect(alternatives.length).toBeGreaterThan(0);
      // Each alternative should have a dimension and elite
      for (const alt of alternatives) {
        expect(alt.dimension).toBeDefined();
        expect(alt.elite.strategy).toBe('single');
      }
    });

    it('returns empty array for unpopulated niche', async () => {
      const archive = await createArchive();
      const alternatives = archive.getAlternatives('nonexistent', 'high');
      expect(alternatives).toHaveLength(0);
    });
  });

  describe('getRecommendation', () => {
    it('maps triage preferences to archive dimensions', async () => {
      const archive = await createArchive();
      archive.tryInsert('code-generation', 'medium', makeConfig());

      const speedRec = archive.getRecommendation('code-generation', 'medium', 'speed');
      expect(speedRec).not.toBeNull();
      expect(speedRec!.dimension).toBe('speed');

      const qualityRec = archive.getRecommendation('code-generation', 'medium', 'quality');
      expect(qualityRec).not.toBeNull();
      expect(qualityRec!.dimension).toBe('quality');
    });

    it('returns null for empty niche', async () => {
      const archive = await createArchive();
      expect(archive.getRecommendation('empty', 'high', 'quality')).toBeNull();
    });
  });

  describe('ingestBenchmarkResults', () => {
    it('ingests multiple results and returns insertion counts', async () => {
      const archive = await createArchive();
      const result = archive.ingestBenchmarkResults([
        { taskType: 'code-generation', complexity: 'medium', strategy: 'single', avgQuality: 0.8, avgCost: 0.01, avgLatency: 1500, successRate: 0.9, sampleCount: 10 },
        { taskType: 'code-generation', complexity: 'high', strategy: 'debate', avgQuality: 0.9, avgCost: 0.05, avgLatency: 5000, successRate: 0.85, sampleCount: 8 },
      ]);
      expect(result.totalInserted).toBeGreaterThanOrEqual(1);
      expect(result.cellsUpdated).toBeGreaterThan(0);
    });

    it('excludes quality-per-token when avgTokens not provided', async () => {
      const archive = await createArchive();
      archive.ingestBenchmarkResults([
        { taskType: 'analysis', complexity: 'low', strategy: 'single', avgQuality: 0.8, avgCost: 0.01, avgLatency: 1000, successRate: 0.95, sampleCount: 10 },
      ]);
      // quality-per-token should be null since no token data
      expect(archive.getElite('analysis', 'low', 'quality-per-token')).toBeNull();
      // But quality should be populated
      expect(archive.getElite('analysis', 'low', 'quality')).not.toBeNull();
    });
  });

  describe('ingestProductionResult', () => {
    it('creates a new entry for unknown strategy (rejected by MIN_SAMPLES)', async () => {
      const archive = await createArchive();
      archive.ingestProductionResult({
        taskType: 'code-generation',
        complexity: 'medium',
        strategy: 'new-strategy',
        qualityScore: 0.9,
        costUsd: 0.02,
        latencyMs: 1500,
        success: true,
        totalTokens: 300,
      });
      // With sampleCount: 1, it should be rejected by MIN_SAMPLES
      expect(archive.getElite('code-generation', 'medium', 'quality')).toBeNull();
    });

    it('updates existing elite via EMA', async () => {
      const archive = await createArchive();
      // First: create an elite with sampleCount >= MIN_SAMPLES
      archive.tryInsert('code-generation', 'medium', makeConfig({ strategy: 'single', avgQuality: 0.80 }));
      const before = archive.getElite('code-generation', 'medium', 'quality');
      expect(before).not.toBeNull();
      const qualityBefore = before!.avgQuality;

      // Update via production result (EMA with alpha=0.1)
      archive.ingestProductionResult({
        taskType: 'code-generation',
        complexity: 'medium',
        strategy: 'single',
        qualityScore: 1.0,
        costUsd: 0.01,
        latencyMs: 1000,
        success: true,
        totalTokens: 400,
      });

      const after = archive.getElite('code-generation', 'medium', 'quality');
      expect(after).not.toBeNull();
      // EMA: new = old * 0.9 + 1.0 * 0.1 → should be slightly higher
      expect(after!.avgQuality).toBeGreaterThan(qualityBefore);
      expect(after!.sampleCount).toBe(before!.sampleCount + 1);
    });
  });

  describe('getSnapshot', () => {
    it('returns correct structure', async () => {
      const archive = await createArchive();
      archive.tryInsert('code-generation', 'medium', makeConfig());
      const snapshot = archive.getSnapshot();

      expect(snapshot.cellCount).toBeGreaterThan(0);
      expect(snapshot.totalElites).toBe(snapshot.cellCount);
      expect(snapshot.coverageByDimension).toBeDefined();
      expect(snapshot.coverageByTaskType).toBeDefined();
      expect(snapshot.topElites.length).toBeGreaterThan(0);
      // topElites should have combined cell + elite properties
      expect(snapshot.topElites[0]).toHaveProperty('taskType');
      expect(snapshot.topElites[0]).toHaveProperty('strategy');
      expect(snapshot.topElites[0]).toHaveProperty('fitness');
    });
  });

  describe('getStats', () => {
    it('returns aggregated metrics', async () => {
      const archive = await createArchive();
      archive.tryInsert('code-generation', 'medium', makeConfig());
      const stats = archive.getStats();

      expect(stats.cellCount).toBeGreaterThan(0);
      expect(stats.uniqueStrategies).toBe(1);
      expect(stats.avgFitness).toBeGreaterThan(0);
      expect(stats.dimensionCoverage).toBeDefined();
    });
  });
});
