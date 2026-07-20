// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GO/NO-GO Decision Engine — Unit Tests
 *
 * Tests the automated decision framework with mock experiment results.
 */

import { describe, it, expect } from 'vitest';
import { generateGoNoGoReport } from '../go-no-go-engine';
import { EXPERIMENT_SUITE } from '../experiment-suite';
import type { ExperimentExecutionResult, GoNoGoThresholds } from '../experiment-types';
import { DEFAULT_THRESHOLDS } from '../experiment-types';

function mockLargeExperiment(): ExperimentExecutionResult[] {
  const results: ExperimentExecutionResult[] = [];
  const tasks = EXPERIMENT_SUITE.slice(0, 10);
  const models = ['gpt-5.4', 'claude-opus-4-6', 'gemini-3.1'];
  const collectiveStrategies = ['debate', 'consensus'];

  // Mode A: 3 models × 10 tasks × 3 reps = 90 single-model results
  for (const model of models) {
    for (const task of tasks) {
      for (let rep = 1; rep <= 3; rep++) {
        results.push({
          experimentId: 'exp-gng',
          taskIndex: task.index, repetition: rep,
          executionMode: 'single-model', strategy: 'single', model,
          taskType: task.taskType, complexity: task.complexity, domain: task.domain, prompt: task.prompt,
          qualityScore: 0.72 + Math.random() * 0.15,
          costUsd: 0.01 + Math.random() * 0.02,
          latencyMs: 800 + Math.random() * 1500,
          totalTokens: 500 + Math.floor(Math.random() * 500),
          success: true, modelsUsed: [model],
          judgeScore: 0.72 + Math.random() * 0.15, judgeRubric: task.judgeRubric,
          faithfulnessScore: null, instructionFollowingScore: null, failureMode: null,
          phase: 'frozen', responseSummary: 'Mock',
        });
      }
    }
  }

  // Mode B: 2 strategies × 10 tasks × 3 reps = 60 collective results
  for (const strategy of collectiveStrategies) {
    for (const task of tasks) {
      for (let rep = 1; rep <= 3; rep++) {
        results.push({
          experimentId: 'exp-gng',
          taskIndex: task.index, repetition: rep,
          executionMode: 'collective', strategy, model: null,
          taskType: task.taskType, complexity: task.complexity, domain: task.domain, prompt: task.prompt,
          qualityScore: 0.75 + Math.random() * 0.15,
          costUsd: 0.05 + Math.random() * 0.10,
          latencyMs: 3000 + Math.random() * 5000,
          totalTokens: 1500 + Math.floor(Math.random() * 1000),
          success: true, modelsUsed: ['a', 'b', 'c'],
          judgeScore: 0.75 + Math.random() * 0.15, judgeRubric: task.judgeRubric,
          faithfulnessScore: null, instructionFollowingScore: null, failureMode: null,
          phase: 'frozen', responseSummary: 'Mock collective',
        });
      }
    }
  }

  // Mode C: 10 tasks × 3 reps = 30 adaptive results
  for (const task of tasks) {
    for (let rep = 1; rep <= 3; rep++) {
      results.push({
        experimentId: 'exp-gng',
        taskIndex: task.index, repetition: rep,
        executionMode: 'adaptive', strategy: 'auto', model: null,
        taskType: task.taskType, complexity: task.complexity, domain: task.domain, prompt: task.prompt,
        qualityScore: 0.74 + Math.random() * 0.14,
        costUsd: 0.02 + Math.random() * 0.05,
        latencyMs: 1500 + Math.random() * 3000,
        totalTokens: 800 + Math.floor(Math.random() * 600),
        success: true, modelsUsed: ['auto'],
        judgeScore: 0.74 + Math.random() * 0.14, judgeRubric: task.judgeRubric,
        faithfulnessScore: null, instructionFollowingScore: null, failureMode: null,
        phase: 'frozen', responseSummary: 'Mock adaptive',
      });
    }
  }

  return results; // 180 total
}

describe('GO/NO-GO Engine', () => {
  it('generates a complete report with all required sections', () => {
    const results = mockLargeExperiment();
    const report = generateGoNoGoReport('exp-gng', results);

    expect(report.experimentId).toBe('exp-gng');
    expect(report.totalExecutions).toBe(results.length);

    // Phase summary
    expect(report.phaseSummary.frozen.executed).toBeGreaterThan(0);

    // Decisions exist for all profiles
    expect(report.decisions.length).toBeGreaterThan(0);
    const profiles = new Set(report.decisions.map(d => d.profile));
    expect(profiles.has('max-quality')).toBe(true);
    expect(profiles.has('low-cost')).toBe(true);
    expect(profiles.has('low-latency')).toBe(true);
    expect(profiles.has('high-robustness')).toBe(true);
    expect(profiles.has('generalist')).toBe(true);

    // Decision matrix
    expect(report.decisionMatrix.length).toBeGreaterThan(0);

    // Heatmap
    expect(report.heatmap.length).toBeGreaterThan(0);

    // Confidence map
    expect(report.confidenceMap.length).toBeGreaterThan(0);

    // Trade-off curves
    expect(report.tradeoffCurves.qualityVsCost.length).toBeGreaterThan(0);
    expect(report.tradeoffCurves.qualityVsLatency.length).toBeGreaterThan(0);

    // Final verdict
    expect(report.finalVerdict.class).toBeTruthy();
    expect(report.finalVerdict.productionDefault).toBeTruthy();

    // Mandatory questions
    expect(report.mandatoryQuestions.q1_bestTier1Baseline).toBeTruthy();
    expect(report.mandatoryQuestions.q2_collectiveBeatsTier1).toBeTruthy();
  });

  it('produces GO verdicts for approaches meeting all thresholds', () => {
    const results = mockLargeExperiment();
    const report = generateGoNoGoReport('exp-gng', results);

    // At least one approach should have GO for some profile
    const goDecisions = report.decisions.filter(d => d.verdict === 'GO');
    expect(goDecisions.length).toBeGreaterThan(0);
  });

  it('each decision has valid verdict type', () => {
    const results = mockLargeExperiment();
    const report = generateGoNoGoReport('exp-gng', results);

    for (const decision of report.decisions) {
      expect(['GO', 'CONDITIONAL-GO', 'NO-GO', 'INCONCLUSIVE']).toContain(decision.verdict);
      expect(decision.reason).toBeTruthy();
      expect(decision.metrics.sampleSize).toBeGreaterThan(0);
    }
  });

  it('returns INCONCLUSIVE for empty results', () => {
    const report = generateGoNoGoReport('exp-empty', []);
    expect(report.decisions.length).toBe(0);
    expect(report.finalVerdict.class).toContain('INCONCLUSIVE');
  });

  it('uses custom thresholds when provided', () => {
    const results = mockLargeExperiment();
    const strictThresholds: GoNoGoThresholds = {
      ...DEFAULT_THRESHOLDS,
      qualityFloor: 0.99, // Impossibly high
    };

    const report = generateGoNoGoReport('exp-strict', results, strictThresholds);

    // With quality floor at 0.99, everything should be NO-GO
    const goDecisions = report.decisions.filter(d => d.verdict === 'GO');
    expect(goDecisions.length).toBe(0);
  });

  it('heatmap covers all taskType/complexity × approach combinations', () => {
    const results = mockLargeExperiment();
    const report = generateGoNoGoReport('exp-gng', results);

    // Should have cells for multiple rows and columns
    const rows = new Set(report.heatmap.map(c => c.row));
    const columns = new Set(report.heatmap.map(c => c.column));

    expect(rows.size).toBeGreaterThan(1);
    expect(columns.size).toBeGreaterThan(1);
  });

  it('answers all 11 mandatory questions', () => {
    const results = mockLargeExperiment();
    const report = generateGoNoGoReport('exp-gng', results);

    const q = report.mandatoryQuestions;
    expect(q.q1_bestTier1Baseline).toBeTruthy();
    expect(q.q2_collectiveBeatsTier1).toBeTruthy();
    expect(q.q3_collectiveWinsWhere).toBeDefined();
    expect(q.q4_collectiveNotWorth).toBeDefined();
    expect(q.q5_adaptiveSuperior).toBeTruthy();
    expect(q.q6_collectiveJustifiesCost).toBeTruthy();
    expect(q.q7_productionDefault).toBeTruthy();
    expect(q.q8_premiumOnly).toBeDefined();
    expect(q.q9_go).toBeDefined();
    expect(q.q10_noGo).toBeDefined();
    expect(q.q11_inconclusive).toBeDefined();
  });
});
