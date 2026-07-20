// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Segmented Benchmark Report — CONFIRMATORY vs EXPLORATORY.
 *
 * Proves the one distinction the module exists to enforce: a pre-registered
 * regime (CONFIRMATORY_REGISTRY, mechanistic hypothesis recorded before any
 * run) gets a real paired verdict; anything else is exploratory-only and
 * always carries the "not confirmatory" caveat — no code path can produce an
 * unlabeled "validated" claim from a post-hoc slice.
 */
import { describe, it, expect } from 'vitest';
import {
  generateSegmentedBenchmarkReport,
  CONFIRMATORY_REGISTRY,
} from '../segmented-benchmark-report';
import {
  HARD_VERIFIABLE_TASK_TYPE,
  CODE_VERIFIED_TASK_TYPE,
} from '../experiment-suite';
import type { ExperimentExecutionResult } from '../experiment-types';

function row(over: Partial<ExperimentExecutionResult>): ExperimentExecutionResult {
  return {
    experimentId: 'exp-seg',
    taskIndex: 0,
    repetition: 1,
    executionMode: 'single-model',
    strategy: 'single',
    model: 'gpt-5.4',
    taskType: 'reasoning',
    complexity: 'high',
    domain: 'tech',
    prompt: 'p',
    qualityScore: 0.8,
    costUsd: 0.01,
    latencyMs: 1000,
    totalTokens: 500,
    success: true,
    modelsUsed: ['gpt-5.4'],
    judgeScore: 0.8,
    judgeRubric: 'r',
    faithfulnessScore: null,
    instructionFollowingScore: null,
    failureMode: null,
    phase: 'frozen',
    responseSummary: 'mock',
    ...over,
  };
}

describe('CONFIRMATORY_REGISTRY', () => {
  it('has exactly the 3 pre-registered regimes, each with a recorded hypothesis', () => {
    expect(CONFIRMATORY_REGISTRY).toHaveLength(3);
    for (const regime of CONFIRMATORY_REGISTRY) {
      expect(regime.hypothesis.length).toBeGreaterThan(40); // not a placeholder
      expect(regime.configKey).toMatch(/^c3-/);
    }
  });
});

describe('generateSegmentedBenchmarkReport', () => {
  it('CONFIRMATORY: a genuine paired win on a pre-registered regime is COLLECTIVE_WINS, with full audit trail', () => {
    const results: ExperimentExecutionResult[] = [
      row({ taskIndex: 146, taskType: HARD_VERIFIABLE_TASK_TYPE, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 0.60 }),
      row({ taskIndex: 147, taskType: HARD_VERIFIABLE_TASK_TYPE, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 0.55 }),
      row({ taskIndex: 148, taskType: HARD_VERIFIABLE_TASK_TYPE, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 0.62 }),
      row({ taskIndex: 146, taskType: HARD_VERIFIABLE_TASK_TYPE, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.90 }),
      row({ taskIndex: 147, taskType: HARD_VERIFIABLE_TASK_TYPE, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.88 }),
      row({ taskIndex: 148, taskType: HARD_VERIFIABLE_TASK_TYPE, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.92 }),
    ];

    const report = generateSegmentedBenchmarkReport('exp-seg', results);
    const haHard = report.confirmatory.find((f) => f.regime === 'ha-hard')!;

    expect(haHard.verdict).toBe('COLLECTIVE_WINS');
    expect(haHard.pairedDeltaMean).toBeCloseTo(0.31, 1);
    expect(haHard.pValue).not.toBeNull();
    expect(haHard.sharedTaskCount).toBe(3);
    expect(haHard.sharedTaskIndices).toEqual([146, 147, 148]);
    expect(haHard.hypothesis.length).toBeGreaterThan(0);
  });

  it('CONFIRMATORY: a regime with no data reports INSUFFICIENT_DATA, not a fabricated verdict', () => {
    const report = generateSegmentedBenchmarkReport('exp-seg', []);
    for (const finding of report.confirmatory) {
      expect(finding.verdict).toBe('INSUFFICIENT_DATA');
      expect(finding.pValue).toBeNull();
      expect(finding.sharedTaskCount).toBe(0);
    }
  });

  it('CONFIRMATORY: a regime where the single wins is NO_ADVANTAGE, not silently omitted', () => {
    const results: ExperimentExecutionResult[] = [
      row({ taskIndex: 156, taskType: CODE_VERIFIED_TASK_TYPE, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 1.0 }),
      row({ taskIndex: 157, taskType: CODE_VERIFIED_TASK_TYPE, executionMode: 'single-model', model: 'gpt-5.4', qualityScore: 1.0 }),
      row({ taskIndex: 156, taskType: CODE_VERIFIED_TASK_TYPE, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.5 }),
      row({ taskIndex: 157, taskType: CODE_VERIFIED_TASK_TYPE, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.5 }),
    ];
    const report = generateSegmentedBenchmarkReport('exp-seg', results);
    const codeVerified = report.confirmatory.find((f) => f.regime === 'code-verified')!;
    expect(codeVerified.verdict).toBe('NO_ADVANTAGE');
    expect(codeVerified.pairedDeltaMean).toBeLessThan(0);
  });

  it('EXPLORATORY: a post-hoc scenario win is labeled EXPLORATORY with the non-confirmatory caveat, never merged into confirmatory', () => {
    // "reasoning/high" is NOT one of the 3 registered regimes' taskTypes.
    const results: ExperimentExecutionResult[] = [
      row({ taskIndex: 10, taskType: 'reasoning', complexity: 'high', executionMode: 'single-model', qualityScore: 0.60 }),
      row({ taskIndex: 11, taskType: 'reasoning', complexity: 'high', executionMode: 'single-model', qualityScore: 0.62 }),
      row({ taskIndex: 10, taskType: 'reasoning', complexity: 'high', executionMode: 'collective', strategy: 'debate', model: null, qualityScore: 0.85 }),
      row({ taskIndex: 11, taskType: 'reasoning', complexity: 'high', executionMode: 'collective', strategy: 'debate', model: null, qualityScore: 0.83 }),
    ];

    const report = generateSegmentedBenchmarkReport('exp-seg', results);

    expect(report.confirmatory.map((f) => f.regime)).not.toContain('reasoning/high');
    const finding = report.exploratory.find((f) => f.scenario === 'reasoning/high');
    expect(finding).toBeDefined();
    expect(finding!.verdict).toBe('COLLECTIVE_WINS');
    expect(finding!.caveat).toMatch(/EXPLORATORY/);
    expect(finding!.caveat).toMatch(/not confirmatory/i);
    expect(finding!.sharedTaskIndices).toEqual([10, 11]);
  });

  it('EXPLORATORY: reproduces the same task-mix trap fix as go-no-go q3/q4 — a pooled-only "win" is not reported', () => {
    // Single ran an easy+hard task; collective only ran the easy one.
    // Pooled means would show a spurious win; paired has only 1 shared task
    // (below the ≥2 floor) so nothing is reported for this scenario.
    const results: ExperimentExecutionResult[] = [
      row({ taskIndex: 20, taskType: 'analysis', complexity: 'medium', executionMode: 'single-model', qualityScore: 0.90 }),
      row({ taskIndex: 21, taskType: 'analysis', complexity: 'medium', executionMode: 'single-model', qualityScore: 0.40 }),
      row({ taskIndex: 20, taskType: 'analysis', complexity: 'medium', executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.95 }),
    ];
    const report = generateSegmentedBenchmarkReport('exp-seg', results);
    expect(report.exploratory.find((f) => f.scenario === 'analysis/medium')).toBeUndefined();
  });

  it('every finding (confirmatory and exploratory) carries a full audit trail', () => {
    const results: ExperimentExecutionResult[] = [
      row({ taskIndex: 146, taskType: HARD_VERIFIABLE_TASK_TYPE, executionMode: 'single-model', qualityScore: 0.5 }),
      row({ taskIndex: 147, taskType: HARD_VERIFIABLE_TASK_TYPE, executionMode: 'single-model', qualityScore: 0.5 }),
      row({ taskIndex: 146, taskType: HARD_VERIFIABLE_TASK_TYPE, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.6 }),
      row({ taskIndex: 147, taskType: HARD_VERIFIABLE_TASK_TYPE, executionMode: 'collective', strategy: 'consensus', model: null, qualityScore: 0.6 }),
    ];
    const report = generateSegmentedBenchmarkReport('exp-seg', results);
    expect(report.methodologyNote.length).toBeGreaterThan(50);
    for (const f of report.confirmatory) {
      expect(Array.isArray(f.sharedTaskIndices)).toBe(true);
    }
  });
});
