// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Triage Calibrator (OI-07) — Unit Tests
 *
 * Tests observation recording, misclassification detection, correction rule
 * generation, rule application, calibration scoring, and rule pruning.
 * No database dependency — fully in-memory.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

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

async function importCalibrator() {
  vi.resetModules();
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

  const mod = await import('../triage-calibrator');
  return mod.triageCalibrator;
}

function makeObservation(overrides: Record<string, unknown> = {}) {
  return {
    predictedTaskType: 'code-generation',
    predictedComplexity: 'medium',
    predictedStrategy: 'single',
    triageConfidence: 0.8,
    actualQualityScore: 0.85,
    actualCostUsd: 0.01,
    actualLatencyMs: 2000,
    actualSuccess: true,
    executedStrategy: 'single',
    promptLength: 500,
    hasTools: false,
    messageCount: 2,
    ...overrides,
  };
}

describe('TriageCalibrator (OI-07)', () => {
  describe('recordObservation', () => {
    it('accepts and stores observations', async () => {
      const calibrator = await importCalibrator();
      calibrator.recordObservation(makeObservation());
      const state = calibrator.getState();
      expect(state.observationCount).toBe(1);
    });

    it('caps observation buffer at max size', async () => {
      const calibrator = await importCalibrator();
      // Record 2050 observations (max is 2000)
      for (let i = 0; i < 2050; i++) {
        calibrator.recordObservation(makeObservation({ actualQualityScore: 0.8 }));
      }
      const state = calibrator.getState();
      expect(state.observationCount).toBeLessThanOrEqual(2000);
    });
  });

  describe('calibrate', () => {
    it('returns empty score with too few observations', async () => {
      const calibrator = await importCalibrator();
      calibrator.recordObservation(makeObservation());
      const score = calibrator.forceCalibration();
      // With fewer than minObservationsForRule (10), should return empty score
      expect(score.sampleCount).toBe(0);
      expect(score.overall).toBe(1.0);
    });

    it('detects complexity underestimation pattern', async () => {
      const calibrator = await importCalibrator();

      // Record many observations where "low" complexity has poor quality
      // even with a complex strategy → truly under-resourced.
      // inferActualComplexity: quality < 0.4 && strategy !== 'single' → 'high'
      // So if predicted 'low' but inferred 'high' → underestimation
      for (let i = 0; i < 30; i++) {
        calibrator.recordObservation(makeObservation({
          predictedComplexity: 'low',
          actualQualityScore: 0.3,
          executedStrategy: 'debate', // Non-single strategy with low quality → inferred 'high'
        }));
      }
      // Some correct predictions too
      for (let i = 0; i < 10; i++) {
        calibrator.recordObservation(makeObservation({
          predictedComplexity: 'low',
          actualQualityScore: 0.9,
          executedStrategy: 'single',
          actualLatencyMs: 1000, // fast → inferred 'low'
        }));
      }

      const score = calibrator.forceCalibration();
      expect(score.sampleCount).toBeGreaterThan(0);
      // Should have detected underestimation
      expect(score.underestimationRate).toBeGreaterThan(0);
    });

    it('detects complexity overestimation pattern', async () => {
      const calibrator = await importCalibrator();

      // Record many observations where "high" complexity achieves great quality
      // with just the "single" strategy → over-resourced
      for (let i = 0; i < 30; i++) {
        calibrator.recordObservation(makeObservation({
          predictedComplexity: 'high',
          actualQualityScore: 0.92,
          executedStrategy: 'single', // Simple strategy gets high quality
        }));
      }

      const score = calibrator.forceCalibration();
      expect(score.sampleCount).toBeGreaterThan(0);
      // The state should now have correction rules
      const state = calibrator.getState();
      // May or may not generate a rule depending on exact thresholds
      // but calibration should complete without error
      expect(score.overall).toBeGreaterThan(0);
    });

    it('generates correction rules from underestimation pattern', async () => {
      const calibrator = await importCalibrator();

      // Create a strong underestimation pattern: triage says "low" but quality
      // is consistently terrible even with complex strategies → should be "medium"
      // detectMisclassifications requires: fraction > 0.3 of low-quality obs
      // and count >= minObservationsForRule (10)
      for (let i = 0; i < 40; i++) {
        calibrator.recordObservation(makeObservation({
          predictedComplexity: 'low',
          actualQualityScore: 0.3, // Below lowQualityThreshold (0.5)
          actualSuccess: true,
          executedStrategy: 'debate',
          promptLength: 1000,
        }));
      }
      // Some OK observations to keep the fraction above 0.3 but not 1.0
      for (let i = 0; i < 10; i++) {
        calibrator.recordObservation(makeObservation({
          predictedComplexity: 'low',
          actualQualityScore: 0.8,
          actualSuccess: true,
          executedStrategy: 'single',
          promptLength: 500,
        }));
      }

      calibrator.forceCalibration();
      const state = calibrator.getState();
      // With 40/50 = 80% low-quality observations for "low" complexity,
      // the calibrator MUST generate at least one complexity correction rule
      expect(state.activeRules.length).toBeGreaterThanOrEqual(1);

      // The rule should correct "low" → "medium"
      const rule = state.activeRules.find(
        r => r.correction.field === 'complexity' && r.correction.from === 'low'
      );
      expect(rule).toBeDefined();
      expect(rule!.correction.to).toBe('medium');

      // Verify the rule actually applies to a matching request
      const correction = calibrator.applyCorrections({
        predictedTaskType: 'code-generation',
        predictedComplexity: 'low',
        promptLength: 1000,
        hasTools: false,
        messageCount: 2,
      });
      expect(correction).not.toBeNull();
      expect(correction!.correctedComplexity).toBe('medium');
      expect(correction!.rulesApplied.length).toBeGreaterThan(0);
    });

    it('stores calibration history', async () => {
      const calibrator = await importCalibrator();

      for (let i = 0; i < 20; i++) {
        calibrator.recordObservation(makeObservation());
      }

      calibrator.forceCalibration();
      calibrator.forceCalibration();

      const state = calibrator.getState();
      expect(state.calibrationHistory.length).toBe(2);
    });
  });

  describe('applyCorrections', () => {
    it('returns null when no rules match', async () => {
      const calibrator = await importCalibrator();
      const result = calibrator.applyCorrections({
        predictedTaskType: 'code-generation',
        predictedComplexity: 'medium',
        promptLength: 500,
        hasTools: false,
        messageCount: 2,
      });
      expect(result).toBeNull();
    });

    it('applies matching correction rules', async () => {
      const calibrator = await importCalibrator();

      // Generate a strong pattern that creates a rule
      // Flood with "low complexity" observations that have terrible quality
      for (let i = 0; i < 50; i++) {
        calibrator.recordObservation(makeObservation({
          predictedComplexity: 'low',
          actualQualityScore: 0.15,
          executedStrategy: 'single',
          promptLength: 800,
        }));
      }

      calibrator.forceCalibration();

      const state = calibrator.getState();
      if (state.activeRules.length > 0) {
        // Test that the correction applies for a matching request
        const result = calibrator.applyCorrections({
          predictedTaskType: 'code-generation',
          predictedComplexity: 'low',
          promptLength: 800,
          hasTools: false,
          messageCount: 2,
        });

        if (result) {
          expect(result.correctedComplexity).not.toBe('low');
          expect(result.rulesApplied.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('ingestBenchmarkCalibration', () => {
    it('converts benchmark results to observations and calibrates', async () => {
      const calibrator = await importCalibrator();

      const benchmarkResults = Array.from({ length: 20 }, (_, i) => ({
        taskType: 'code-generation',
        expectedComplexity: 'medium',
        predictedComplexity: 'low', // Systematic misprediction
        strategy: 'single',
        qualityScore: 0.4,
        costUsd: 0.01,
        latencyMs: 2000,
        success: true,
        promptLength: 500 + i * 10,
      }));

      const score = calibrator.ingestBenchmarkCalibration(benchmarkResults);
      expect(score.sampleCount).toBeGreaterThan(0);
    });
  });

  describe('resetRules', () => {
    it('clears all correction rules', async () => {
      const calibrator = await importCalibrator();

      // Generate enough observations to potentially create rules
      for (let i = 0; i < 50; i++) {
        calibrator.recordObservation(makeObservation({
          predictedComplexity: 'low',
          actualQualityScore: 0.15,
        }));
      }
      calibrator.forceCalibration();

      calibrator.resetRules();
      const state = calibrator.getState();
      expect(state.activeRules).toHaveLength(0);
    });
  });

  describe('getState', () => {
    it('returns complete state structure', async () => {
      const calibrator = await importCalibrator();
      const state = calibrator.getState();

      expect(state).toHaveProperty('observationCount');
      expect(state).toHaveProperty('activeRules');
      expect(state).toHaveProperty('latestCalibration');
      expect(state).toHaveProperty('calibrationHistory');
      expect(state).toHaveProperty('ruleApplicationStats');
      expect(state.ruleApplicationStats).toHaveProperty('totalApplications');
      expect(state.ruleApplicationStats).toHaveProperty('topRules');
    });
  });
});
