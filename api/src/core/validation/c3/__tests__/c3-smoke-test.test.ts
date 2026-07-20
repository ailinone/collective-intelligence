// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * C3 Validation Infrastructure — Smoke Tests
 *
 * Verifies that all C3 modules instantiate, produce correct types,
 * and basic operations work as expected. These are NOT integration tests
 * against live providers — they test the infrastructure itself.
 */

import { describe, it, expect } from 'vitest';
import {
  createAblationFlags,
  isAblated,
  NO_ABLATION,
  generateAblationMatrix,
  ALL_ABLATION_COMPONENTS,
} from '../ablation-config';
import {
  isValidForLearning,
  checkRewardHackingDivergence,
} from '../scoring-policy';
import type { PolicyAwareScore } from '../scoring-policy';
import { IndependenceTestService } from '../independence-test';
import {
  HIDDEN_INFORMATION_SUITE,
  calculateIRR,
} from '../hidden-information-suite';
import {
  HERDING_SCENARIOS,
  checkBiasFollowing,
} from '../herding-test';
import { RewardHackingDetector } from '../reward-hacking-detector';
import { ROIEstimator } from '../roi-estimator';
import { HumanCalibrationService } from '../human-calibration';
import { computeLearningTrend } from '../learning-snapshots';

// ─── Ablation Config ────────────────────────────────────────────────────────

describe('AblationConfig', () => {
  it('creates flags with disabled components', () => {
    const flags = createAblationFlags(['memory', 'bandit']);
    expect(flags.isAblation).toBe(true);
    expect(flags.disabled.has('memory')).toBe(true);
    expect(flags.disabled.has('bandit')).toBe(true);
    expect(flags.disabled.has('critique')).toBe(false);
    expect(flags.conditionLabel).toBe('-memory-bandit');
  });

  it('NO_ABLATION has nothing disabled', () => {
    expect(NO_ABLATION.isAblation).toBe(false);
    expect(NO_ABLATION.disabled.size).toBe(0);
    expect(NO_ABLATION.conditionLabel).toBe('full');
  });

  it('isAblated checks correctly', () => {
    const flags = createAblationFlags(['memory']);
    expect(isAblated(flags, 'memory')).toBe(true);
    expect(isAblated(flags, 'bandit')).toBe(false);
    expect(isAblated(undefined, 'memory')).toBe(false);
  });

  it('generateAblationMatrix produces correct number of conditions', () => {
    const matrix = generateAblationMatrix('debate');
    // 1 control + N components
    expect(matrix.length).toBe(ALL_ABLATION_COMPONENTS.length + 1);
    expect(matrix[0].disableComponents).toHaveLength(0);
    expect(matrix[0].displayName).toBe('debate (full)');
    expect(matrix[1].disableComponents).toHaveLength(1);
  });
});

// ─── Scoring Policy ─────────────────────────────────────────────────────────

describe('ScoringPolicy', () => {
  it('rejects observability scores for learning', () => {
    const score: PolicyAwareScore = {
      overall: 0.8,
      dimensions: { correctness: 0.8, completeness: 0.8, clarity: 0.8, efficiency: 0.7, relevance: 0.8 },
      confidence: 0.9,
      reasoning: [],
      method: 'heuristic',
      policy: 'observability',
    };
    expect(isValidForLearning(score)).toBe(false);
  });

  it('rejects scores where judge failed', () => {
    const score: PolicyAwareScore = {
      overall: 0.8,
      dimensions: { correctness: 0.8, completeness: 0.8, clarity: 0.8, efficiency: 0.7, relevance: 0.8 },
      confidence: 0.5,
      reasoning: [],
      method: 'heuristic',
      policy: 'learning',
      judgeFailed: true,
    };
    expect(isValidForLearning(score)).toBe(false);
  });

  it('accepts valid learning scores', () => {
    const score: PolicyAwareScore = {
      overall: 0.75,
      dimensions: { correctness: 0.8, completeness: 0.7, clarity: 0.8, efficiency: 0.7, relevance: 0.7 },
      confidence: 0.8,
      reasoning: [],
      method: 'llm-judge',
      policy: 'learning',
    };
    expect(isValidForLearning(score)).toBe(true);
  });

  it('detects reward hacking divergence', () => {
    const score: PolicyAwareScore = {
      overall: 0.8,
      dimensions: { correctness: 0.8, completeness: 0.8, clarity: 0.8, efficiency: 0.7, relevance: 0.8 },
      confidence: 0.8,
      reasoning: [],
      method: 'llm-judge',
      policy: 'learning',
      heuristicScore: 0.9,
      judgeScore: 0.55,
    };
    const result = checkRewardHackingDivergence(score);
    expect(result.divergent).toBe(true);
    expect(result.delta).toBeCloseTo(0.35);
  });
});

// ─── Budget Governor ────────────────────────────────────────────────────────

// ─── Independence Test ──────────────────────────────────────────────────────

describe('IndependenceTestService', () => {
  it('measures Jaccard diversity without embeddings', async () => {
    const service = new IndependenceTestService();
    const result = await service.measureDiversity(
      [
        { modelId: 'gpt-4o', provider: 'openai', content: 'The answer is 42 because of math', role: 'opening', round: 1 },
        { modelId: 'claude', provider: 'anthropic', content: 'The answer is 42 because of science', role: 'opening', round: 1 },
        { modelId: 'gemini', provider: 'google', content: 'Something completely different about cats and dogs', role: 'opening', round: 1 },
      ],
      'debate',
      'reasoning',
      'medium'
    );
    expect(result).not.toBeNull();
    expect(result!.modelCount).toBe(3);
    expect(result!.pairwiseSimilarities).toHaveLength(3); // 3 pairs from 3 outputs
    // Jaccard should show some similarity between first two, less with third
    const sim12 = result!.pairwiseSimilarities.find(
      p => (p.modelA === 'gpt-4o' && p.modelB === 'claude') || (p.modelA === 'claude' && p.modelB === 'gpt-4o')
    );
    expect(sim12!.jaccardSimilarity).toBeGreaterThan(0.2);
  });
});

// ─── Hidden Information Suite ───────────────────────────────────────────────

describe('HiddenInformationSuite', () => {
  it('has 25 tasks', () => {
    expect(HIDDEN_INFORMATION_SUITE).toHaveLength(25);
  });

  it('has all four task types', () => {
    const types = new Set(HIDDEN_INFORMATION_SUITE.map(t => t.type));
    expect(types.has('multi-source')).toBe(true);
    expect(types.has('puzzle-assembly')).toBe(true);
    expect(types.has('expert-synthesis')).toBe(true);
    expect(types.has('contradiction')).toBe(true);
  });

  it('calculates IRR correctly', () => {
    const result = calculateIRR(
      'TechCorp revenue was $2.3B with 15% growth driven by cloud services which grew 40%. Hardware declined by 8%. DataInc is growing faster.',
      ['TechCorp revenue $2.3B with 15% growth', 'Cloud services grew 40%', 'Hardware declined 8%', 'DataInc growing faster']
    );
    expect(result.irr).toBeGreaterThanOrEqual(0.5);
    expect(result.recovered.length).toBeGreaterThan(0);
  });

  it('returns zero IRR for irrelevant response', () => {
    const result = calculateIRR(
      'Cats are wonderful pets that love to play with yarn.',
      ['TechCorp revenue $2.3B', 'Cloud services grew 40%', 'Hardware declined']
    );
    expect(result.irr).toBe(0);
    expect(result.missed.length).toBe(3);
  });
});

// ─── Herding Test ───────────────────────────────────────────────────────────

describe('HerdingTest', () => {
  it('has 10 scenarios', () => {
    expect(HERDING_SCENARIOS).toHaveLength(10);
  });

  it('detects bias following correctly', () => {
    const scenario = HERDING_SCENARIOS[0]; // binary search O(n) bias
    // Response that follows the bias
    const biasedResult = checkBiasFollowing(
      'Binary search has O(n) complexity because it checks each element.',
      scenario
    );
    expect(biasedResult.followedBias).toBe(true);
    expect(biasedResult.incorrectElementsFound).toBeGreaterThan(0);

    // Response that corrects the bias
    const correctResult = checkBiasFollowing(
      'Binary search has O(log n) complexity. It divides the search space in half at each step, making it logarithmic.',
      scenario
    );
    expect(correctResult.followedBias).toBe(false);
    expect(correctResult.correctElementsFound).toBeGreaterThan(0);
  });
});

// ─── Reward Hacking Detector ────────────────────────────────────────────────

describe('RewardHackingDetector', () => {
  it('returns no alarm with insufficient data', () => {
    const detector = new RewardHackingDetector();
    const report = detector.getReport();
    expect(report.correlationAlarm).toBe(false);
    expect(report.sampleCount).toBe(0);
  });

  it('detects low correlation alarm', () => {
    const detector = new RewardHackingDetector({ correlationAlarmThreshold: 0.5 });
    // Add pairs where heuristic and judge disagree
    for (let i = 0; i < 50; i++) {
      detector.record({
        heuristicScore: 0.8 + Math.random() * 0.1, // Always high
        judgeScore: 0.3 + Math.random() * 0.4,       // Variable
        tokenCount: 1000,
        headingsCount: 3,
        codeBlocksCount: 2,
        contentLength: 2000,
      });
    }
    const report = detector.getReport();
    expect(report.sampleCount).toBe(50);
    // Correlation should be low because heuristic is stable but judge varies
    expect(report.meanDivergence).toBeGreaterThan(0.1);
  });
});

// ─── ROI Estimator ──────────────────────────────────────────────────────────

describe('ROIEstimator', () => {
  it('computes domain ROI', () => {
    const estimator = new ROIEstimator();

    // Add data points
    for (let i = 0; i < 20; i++) {
      estimator.addDataPoint({
        domain: 'coding', taskType: 'code-generation', complexity: 'high',
        mode: 'ci', qualityScore: 0.75 + Math.random() * 0.1, costUsd: 0.05, latencyMs: 5000,
      });
      estimator.addDataPoint({
        domain: 'coding', taskType: 'code-generation', complexity: 'high',
        mode: 'single', qualityScore: 0.70 + Math.random() * 0.1, costUsd: 0.01, latencyMs: 2000,
      });
    }

    const report = estimator.generateReport();
    expect(report.domains).toHaveLength(1);
    expect(report.domains[0].domain).toBe('coding');
    expect(report.domains[0].costRatio).toBeGreaterThan(1);
  });

  it('recommends single for domains where CI is worse', () => {
    const estimator = new ROIEstimator();

    for (let i = 0; i < 20; i++) {
      estimator.addDataPoint({
        domain: 'documentation', taskType: 'documentation', complexity: 'medium',
        mode: 'ci', qualityScore: 0.50 + Math.random() * 0.05, costUsd: 0.04, latencyMs: 8000,
      });
      estimator.addDataPoint({
        domain: 'documentation', taskType: 'documentation', complexity: 'medium',
        mode: 'single', qualityScore: 0.65 + Math.random() * 0.05, costUsd: 0.01, latencyMs: 2000,
      });
    }

    const report = estimator.generateReport();
    expect(report.domains[0].recommendation).toBe('single');
    expect(report.routingPolicy['documentation']).toBe('single');
  });
});

// ─── Human Calibration ──────────────────────────────────────────────────────

describe('HumanCalibrationService', () => {
  it('tracks samples needing annotation', () => {
    const service = new HumanCalibrationService();
    service.addSample({
      id: 's1', prompt: 'test', response: 'answer', taskType: 'coding',
      complexity: 'medium', heuristicScore: 0.8, judgeScore: 0.7,
      heuristicDimensions: { correctness: 0.8 }, judgeDimensions: { correctness: 0.7 },
    });

    const needing = service.getSamplesNeedingAnnotation();
    expect(needing).toHaveLength(1);
  });

  it('requires at least 20 fully annotated samples for report', () => {
    const service = new HumanCalibrationService();
    const report = service.generateReport();
    expect(report).toBeNull();
  });
});

// ─── Learning Snapshots ─────────────────────────────────────────────────────

describe('LearningTrend', () => {
  it('computes improving trend', () => {
    const snapshots = Array.from({ length: 20 }, (_, i) => ({
      metricType: 'bandit_params' as const,
      niche: 'coding|high|debate',
      executionCount: i * 50,
      value: { meanWinRate: 0.5 + i * 0.02 },
      timestamp: new Date(),
    }));

    const trend = computeLearningTrend(snapshots, 'meanWinRate');
    expect(trend.improving).toBe(true);
    expect(trend.slope).toBeGreaterThan(0);
    expect(trend.rSquared).toBeGreaterThan(0.5);
  });

  it('detects flat trend', () => {
    const snapshots = Array.from({ length: 20 }, (_, i) => ({
      metricType: 'bandit_params' as const,
      niche: 'coding|high|debate',
      executionCount: i * 50,
      value: { meanWinRate: 0.7 + (Math.random() - 0.5) * 0.01 },
      timestamp: new Date(),
    }));

    const trend = computeLearningTrend(snapshots, 'meanWinRate');
    expect(Math.abs(trend.slope)).toBeLessThan(0.001);
  });
});
