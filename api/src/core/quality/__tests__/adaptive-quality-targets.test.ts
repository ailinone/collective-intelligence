// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Adaptive Quality Targets (OI-08) — Unit Tests
 *
 * Tests the three paths: learned (from DB), heuristic, and default.
 * Mocks the database client to control which path is taken.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();

beforeEach(() => {
  vi.resetModules();
  mockFindMany.mockReset();

  vi.doMock('@/database/client', () => ({
    prisma: {
      strategyWeight: {
        findMany: mockFindMany,
      },
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
    recordAdaptiveQualityTarget: vi.fn(),
  }));
});

// Helper to create mock strategyWeight rows
function makeWeightRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    taskType: 'code-generation',
    complexity: 'medium',
    strategy: 'single',
    weight: 1.0,
    avgQuality: 0.82,
    avgCostEfficiency: 80,
    successRate: 0.9,
    sampleCount: 20,
    ...overrides,
  };
}

describe('Adaptive Quality Targets (OI-08)', () => {
  describe('getAdaptiveQualityTarget', () => {
    it('returns learned target when DB has sufficient data', async () => {
      // loadNicheProfile calls prisma.strategyWeight.findMany
      // minSamplesForLearned = 15. Total sampleCount across rows must be >= 15.
      mockFindMany.mockResolvedValue([
        makeWeightRow({ strategy: 'single', avgQuality: 0.78, successRate: 0.85, sampleCount: 30 }),
        makeWeightRow({ strategy: 'debate', avgQuality: 0.92, successRate: 0.90, sampleCount: 25 }),
      ]);

      const { getAdaptiveQualityTarget } = await import('../../quality/adaptive-quality-targets');
      const result = await getAdaptiveQualityTarget('code-generation', 'medium');

      expect(result.source).toBe('learned');
      expect(result.target).toBeGreaterThan(0);
      expect(result.target).toBeLessThanOrEqual(1);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.historicalAvg).not.toBeNull();
    });

    it('falls back to heuristic when DB returns empty', async () => {
      mockFindMany.mockResolvedValue([]);

      const { getAdaptiveQualityTarget } = await import('../../quality/adaptive-quality-targets');
      const result = await getAdaptiveQualityTarget('code-generation', 'medium');

      expect(result.source).toBe('heuristic');
      expect(result.target).toBeGreaterThan(0);
    });

    it('falls back to heuristic when total samples below threshold', async () => {
      // Return rows but total sampleCount = 4+4 = 8 < 15 (minSamplesForLearned)
      mockFindMany.mockResolvedValue([
        makeWeightRow({ sampleCount: 4 }),
        makeWeightRow({ strategy: 'debate', sampleCount: 4 }),
      ]);

      const { getAdaptiveQualityTarget } = await import('../../quality/adaptive-quality-targets');
      const result = await getAdaptiveQualityTarget('code-generation', 'medium');

      expect(result.source).toBe('heuristic');
    });

    it('falls back to heuristic on DB error', async () => {
      mockFindMany.mockRejectedValue(new Error('Connection refused'));

      const { getAdaptiveQualityTarget } = await import('../../quality/adaptive-quality-targets');
      const result = await getAdaptiveQualityTarget('code-generation', 'high');

      expect(result.source).toBe('heuristic');
      expect(result.target).toBeGreaterThan(0);
    });

    it('heuristic returns higher targets for complex tasks', async () => {
      mockFindMany.mockResolvedValue([]);

      const { getAdaptiveQualityTarget } = await import('../../quality/adaptive-quality-targets');
      const lowResult = await getAdaptiveQualityTarget('code-generation', 'low');
      const highResult = await getAdaptiveQualityTarget('code-generation', 'high');

      expect(highResult.target).toBeGreaterThanOrEqual(lowResult.target);
    });

    it('respects explicit quality target override', async () => {
      mockFindMany.mockResolvedValue([]);

      const { getAdaptiveQualityTarget } = await import('../../quality/adaptive-quality-targets');
      const result = await getAdaptiveQualityTarget('code-generation', 'medium', 0.95);

      expect(result.source).toBe('default');
      expect(result.target).toBeCloseTo(0.95, 1);
    });

    it('returns suggestedMinIterations based on difficulty', async () => {
      mockFindMany.mockResolvedValue([]);

      const { getAdaptiveQualityTarget } = await import('../../quality/adaptive-quality-targets');
      const result = await getAdaptiveQualityTarget('code-generation', 'high');

      expect(result.suggestedMinIterations).toBeDefined();
      expect(result.suggestedMinIterations).toBeGreaterThanOrEqual(1);
    });

    it('clamps target within valid range', async () => {
      mockFindMany.mockResolvedValue([
        makeWeightRow({ avgQuality: 0.99, successRate: 0.99, sampleCount: 100 }),
      ]);

      const { getAdaptiveQualityTarget } = await import('../../quality/adaptive-quality-targets');
      const result = await getAdaptiveQualityTarget('code-generation', 'medium');

      expect(result.target).toBeLessThanOrEqual(0.96);
      expect(result.target).toBeGreaterThanOrEqual(0.65);
    });
  });

  describe('refreshAllProfiles', () => {
    it('runs without error', async () => {
      mockFindMany.mockResolvedValue([]);

      const { refreshAllProfiles } = await import('../../quality/adaptive-quality-targets');
      await expect(refreshAllProfiles()).resolves.not.toThrow();
    });
  });

  describe('getCachedProfiles', () => {
    it('returns the profile cache', async () => {
      const { getCachedProfiles } = await import('../../quality/adaptive-quality-targets');
      const profiles = getCachedProfiles();
      expect(profiles).toBeDefined();
      expect(Array.isArray(profiles)).toBe(true);
    });
  });
});
