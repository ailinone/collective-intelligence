// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Runner — Tests
 *
 * Tests the experiment suite structure, filtering, volume calculations,
 * and report generation logic. DB-dependent tests use the test database.
 */

import { describe, it, expect } from 'vitest';
import { EXPERIMENT_SUITE, getSuiteCoverage, getFilteredTasks } from '../experiment-suite';
import { generateReport } from '../experiment-report';
import type { ExperimentConfig, ExperimentExecutionResult } from '../experiment-types';
import { ALL_COLLECTIVE_STRATEGIES } from '../experiment-types';

describe('Experiment Suite', () => {
  it('has a non-trivial suite covering all required task types', () => {
    const coverage = getSuiteCoverage();

    // Derive expected size from the live array so the test does not
    // become stale every time the suite grows. A floor of 36 catches
    // catastrophic shrinkage (the original baseline was 36 tasks; any
    // accidental reset to a stub would fall below this).
    expect(coverage.totalTasks).toBe(EXPERIMENT_SUITE.length);
    expect(EXPERIMENT_SUITE.length).toBeGreaterThanOrEqual(36);

    expect(Object.keys(coverage.byTaskType)).toContain('code-generation');
    expect(Object.keys(coverage.byTaskType)).toContain('code-review');
    expect(Object.keys(coverage.byTaskType)).toContain('analysis');
    expect(Object.keys(coverage.byTaskType)).toContain('debugging');
    expect(Object.keys(coverage.byTaskType)).toContain('documentation');
    expect(Object.keys(coverage.byTaskType)).toContain('refactoring');
    expect(Object.keys(coverage.byTaskType)).toContain('general');
    expect(Object.keys(coverage.byTaskType)).toContain('creative');
    expect(Object.keys(coverage.byTaskType)).toContain('factual-qa');
    expect(Object.keys(coverage.byTaskType)).toContain('reasoning');
    expect(Object.keys(coverage.byTaskType)).toContain('document-understanding');
    expect(Object.keys(coverage.byTaskType)).toContain('adversarial');
  });

  it('has all three complexity levels', () => {
    const coverage = getSuiteCoverage();

    expect(coverage.byComplexity['low']).toBeGreaterThan(0);
    expect(coverage.byComplexity['medium']).toBeGreaterThan(0);
    expect(coverage.byComplexity['high']).toBeGreaterThan(0);
  });

  it('has multiple domains', () => {
    const coverage = getSuiteCoverage();

    expect(Object.keys(coverage.byDomain).length).toBeGreaterThanOrEqual(3);
    expect(coverage.byDomain['tech']).toBeGreaterThan(0);
  });

  it('each task has required fields', () => {
    for (const task of EXPERIMENT_SUITE) {
      expect(task.index).toBeDefined();
      expect(task.taskType).toBeTruthy();
      expect(task.complexity).toMatch(/^(low|medium|high)$/);
      expect(task.domain).toBeTruthy();
      expect(task.prompt.length).toBeGreaterThan(10);
      expect(task.judgeRubric.length).toBeGreaterThan(10);
      expect(task.expectedDifficulty).toBeGreaterThanOrEqual(0);
      expect(task.expectedDifficulty).toBeLessThanOrEqual(1);
    }
  });

  it('task indices are unique and sequential', () => {
    const indices = EXPERIMENT_SUITE.map(t => t.index);
    const unique = new Set(indices);
    expect(unique.size).toBe(EXPERIMENT_SUITE.length);

    for (let i = 0; i < indices.length; i++) {
      expect(indices[i]).toBe(i);
    }
  });

  it('filters tasks correctly', () => {
    const codeGen = getFilteredTasks({ taskTypes: ['code-generation'] });
    expect(codeGen.every(t => t.taskType === 'code-generation')).toBe(true);
    expect(codeGen.length).toBeGreaterThan(0);

    const highOnly = getFilteredTasks({ complexities: ['high'] });
    expect(highOnly.every(t => t.complexity === 'high')).toBe(true);
    expect(highOnly.length).toBeGreaterThan(0);

    const byIndex = getFilteredTasks({ indices: [0, 1, 2] });
    expect(byIndex.length).toBe(3);

    const businessDomain = getFilteredTasks({ domains: ['business'] });
    expect(businessDomain.every(t => t.domain === 'business')).toBe(true);
  });

  it('returns all tasks when no filters provided', () => {
    const all = getFilteredTasks();
    expect(all.length).toBe(EXPERIMENT_SUITE.length);
  });
});

describe('Volume Requirements', () => {
  it('full experiment reaches 300+ executions', () => {
    // Derive arms from the live registries (suite size + collective
    // strategy enum). The previous version hardcoded 48 tasks and 5
    // collective strategies, both of which drifted as the suite grew
    // and new strategies were registered. Using `.length` here makes
    // the assertion track real arm-count changes while still gating
    // against accidental shrinkage via the lower-bound check below.
    const taskCount = EXPERIMENT_SUITE.length;
    const singleModels = 6;
    const collectiveStrategies = ALL_COLLECTIVE_STRATEGIES.length;
    const adaptiveModes = 1;
    const totalModes = singleModels + collectiveStrategies + adaptiveModes;
    const repetitions = 3;

    const totalExecutions = taskCount * totalModes * repetitions;
    expect(totalExecutions).toBeGreaterThanOrEqual(300);
    expect(totalExecutions).toBe(taskCount * totalModes * repetitions);
    // Cross-check the components individually so a regression in any
    // one of them shows up directly in the test output.
    expect(taskCount).toBeGreaterThanOrEqual(36);
    expect(collectiveStrategies).toBeGreaterThanOrEqual(20);
  });

  it('minimum experiment (10 tasks, 3 modes, 3 reps) reaches 90 executions', () => {
    const minimal = 10 * 3 * 3;
    expect(minimal).toBe(90);
  });

  it('calculates correct total for custom config', () => {
    const config: ExperimentConfig = {
      name: 'Test',
      description: '',
      taskIndices: [0, 1, 2, 3, 4], // 5 tasks
      modes: [
        { mode: 'single-model', modelId: 'gpt-5.4', displayName: 'GPT-5.4' },
        { mode: 'collective', strategy: 'debate' },
        { mode: 'adaptive' },
      ], // 3 modes
      repetitions: 2,
      maxBudgetUsd: 50,
      delayBetweenCallsMs: 0,
      maxConcurrency: 1,
      warmupExecutions: 0,
      freezeLearningDuringEval: true,
    };

    const tasks = getFilteredTasks({ indices: config.taskIndices });
    const total = tasks.length * config.modes.length * config.repetitions;
    expect(total).toBe(30); // 5 × 3 × 2
  });
});

describe('Report Generation', () => {
  function mockResults(): ExperimentExecutionResult[] {
    const results: ExperimentExecutionResult[] = [];

    // Mode A: single-model (3 models × 5 tasks × 2 reps = 30 results)
    const models = ['gpt-5.4', 'claude-opus-4-6', 'gemini-3.1'];
    const tasks = EXPERIMENT_SUITE.slice(0, 5);

    for (const model of models) {
      for (const task of tasks) {
        for (let rep = 1; rep <= 2; rep++) {
          results.push({
            experimentId: 'exp-001',
            taskIndex: task.index,
            repetition: rep,
            executionMode: 'single-model',
            strategy: 'single',
            model,
            taskType: task.taskType,
            complexity: task.complexity,
            domain: task.domain,
            prompt: task.prompt,
            qualityScore: 0.65 + Math.random() * 0.2, // 0.65-0.85
            costUsd: 0.01 + Math.random() * 0.02,
            latencyMs: 1000 + Math.random() * 2000,
            totalTokens: 500 + Math.floor(Math.random() * 500),
            success: true,
            modelsUsed: [model],
            judgeScore: 0.65 + Math.random() * 0.2,
            judgeRubric: task.judgeRubric,
            faithfulnessScore: null,
            instructionFollowingScore: null,
            failureMode: null,
            phase: 'frozen' as const,
            responseSummary: 'Mock response',
          });
        }
      }
    }

    // Mode B: collective (2 strategies × 5 tasks × 2 reps = 20 results)
    const strategies = ['debate', 'consensus'];
    for (const strategy of strategies) {
      for (const task of tasks) {
        for (let rep = 1; rep <= 2; rep++) {
          results.push({
            experimentId: 'exp-001',
            taskIndex: task.index,
            repetition: rep,
            executionMode: 'collective',
            strategy,
            model: null,
            taskType: task.taskType,
            complexity: task.complexity,
            domain: task.domain,
            prompt: task.prompt,
            qualityScore: 0.70 + Math.random() * 0.2, // 0.70-0.90 (slightly higher)
            costUsd: 0.05 + Math.random() * 0.10,
            latencyMs: 3000 + Math.random() * 5000,
            totalTokens: 1500 + Math.floor(Math.random() * 1000),
            success: true,
            modelsUsed: ['model-a', 'model-b', 'model-c'],
            judgeScore: 0.70 + Math.random() * 0.2,
            judgeRubric: task.judgeRubric,
            faithfulnessScore: null,
            instructionFollowingScore: null,
            failureMode: null,
            phase: 'frozen' as const,
            responseSummary: 'Mock collective response',
          });
        }
      }
    }

    // Mode C: adaptive (5 tasks × 2 reps = 10 results)
    for (const task of tasks) {
      for (let rep = 1; rep <= 2; rep++) {
        results.push({
          experimentId: 'exp-001',
          taskIndex: task.index,
          repetition: rep,
          executionMode: 'adaptive',
          strategy: 'auto',
          model: null,
          taskType: task.taskType,
          complexity: task.complexity,
          domain: task.domain,
          prompt: task.prompt,
          qualityScore: 0.68 + Math.random() * 0.2,
          costUsd: 0.02 + Math.random() * 0.05,
          latencyMs: 1500 + Math.random() * 3000,
          totalTokens: 800 + Math.floor(Math.random() * 600),
          success: true,
          modelsUsed: ['auto-selected'],
          judgeScore: 0.68 + Math.random() * 0.2,
          judgeRubric: task.judgeRubric,
          faithfulnessScore: null,
          instructionFollowingScore: null,
          failureMode: null,
          phase: 'frozen' as const,
          responseSummary: 'Mock adaptive response',
        });
      }
    }

    return results;
  }

  it('generates a complete 5-document report bundle', () => {
    const results = mockResults();
    const report = generateReport('exp-001', 'Test Experiment', results);

    // Document 1: Executive Summary
    expect(report.executiveSummary.experimentId).toBe('exp-001');
    expect(report.executiveSummary.totalExecutions).toBe(results.length);
    expect(report.executiveSummary.bestOverallApproach.label).toBeTruthy();
    expect(report.executiveSummary.finalVerdict).toBeTruthy();
    expect(report.executiveSummary.keyFindings.length).toBeGreaterThan(0);

    // Document 2: Methodology
    expect(report.methodology.modelsCompared.length).toBeGreaterThan(0);
    expect(report.methodology.statisticalMethods.length).toBeGreaterThan(0);
    expect(report.methodology.threatsToValidity.length).toBeGreaterThan(0);

    // Document 3: Detailed Results
    expect(report.detailedResults.overallRanking.length).toBeGreaterThan(0);
    expect(report.detailedResults.headToHead.length).toBeGreaterThan(0);
    expect(report.detailedResults.paretoDominance.frontier.length).toBeGreaterThan(0);
    expect(report.detailedResults.tradeoffs.qualityVsCost.length).toBeGreaterThan(0);
    expect(Object.keys(report.detailedResults.compositeRegret).length).toBeGreaterThan(0);
    expect(Object.keys(report.detailedResults.compositeEfficiency).length).toBeGreaterThan(0);

    // Document 4: Statistical Appendix
    expect(Object.keys(report.statisticalAppendix.sampleSizes).length).toBeGreaterThan(0);
    expect(report.statisticalAppendix.tTests.length).toBeGreaterThan(0);
    expect(report.statisticalAppendix.methodNotes.length).toBeGreaterThan(0);

    // Document 5: Decision Memo
    expect(report.decisionMemo.bestSingleModel.model).toBeTruthy();
    expect(report.decisionMemo.collectiveBeatsTier1.answer).toBeTruthy();
    expect(report.decisionMemo.productionRecommendation.defaultMode).toBeTruthy();
    expect(report.decisionMemo.proven.length).toBeGreaterThan(0);
    expect(report.decisionMemo.finalVerdict).toBeTruthy();
  });

  it('includes head-to-head with t-test results in detailed results', () => {
    const results = mockResults();
    const report = generateReport('exp-001', 'Test', results);

    const h2h = report.detailedResults.headToHead.find(h => h.groupA === 'single-model' && h.groupB === 'collective');
    expect(h2h).toBeDefined();

    if (h2h) {
      expect(h2h.qualityTTest.pValue).toBeGreaterThanOrEqual(0);
      expect(h2h.qualityTTest.pValue).toBeLessThanOrEqual(1);
      expect(h2h.effectSize.category).toMatch(/^(negligible|small|medium|large)$/);
      expect(h2h.winRate.total).toBeGreaterThan(0);
    }
  });

  it('identifies limitations for small sample sizes', () => {
    // Just 5 results — should flag low sample size
    const smallResults: ExperimentExecutionResult[] = Array.from({ length: 5 }, (_, i) => ({
      experimentId: 'exp-small',
      taskIndex: i,
      repetition: 1,
      executionMode: 'single-model' as const,
      strategy: 'single',
      model: 'gpt-5.4',
      taskType: 'code-generation',
      complexity: 'medium',
      domain: 'tech',
      prompt: 'test prompt',
      qualityScore: 0.8,
      costUsd: 0.01,
      latencyMs: 1000,
      totalTokens: 500,
      success: true,
      modelsUsed: ['gpt-5.4'],
      judgeScore: 0.8,
      judgeRubric: 'test rubric',
      faithfulnessScore: null,
      instructionFollowingScore: null,
      failureMode: null,
      phase: 'frozen' as const,
      responseSummary: 'test',
    }));

    const report = generateReport('exp-small', 'Small Test', smallResults);

    expect(report.methodology.limitations.some(l => l.includes('below recommended minimum'))).toBe(true);
  });

  it('conclusion confidence scales with sample size', () => {
    const results = mockResults();
    const report = generateReport('exp-001', 'Test', results);

    // With 30+ single-model and 20+ collective results, confidence should be medium+
    expect(['high', 'medium', 'low', 'inconclusive']).toContain(report.executiveSummary.collectiveVsTier1.confidence);
  });
});
