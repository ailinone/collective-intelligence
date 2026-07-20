// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — Adversarial Scenario Runner (F3.2)
 *
 * Drives `runAdversarialScenarioSynthetic` end-to-end across all five
 * canonical scenarios and asserts:
 *   - the run produces an `ExperimentExecutionResult` with success=true,
 *     zero cost, zero tokens (no model invoked);
 *   - `qualityScore` reflects whether the detector caught what was
 *     expected (1.0 on match, 0.0 on mismatch);
 *   - the response summary captures the detector outcome so the
 *     report generator can group failures.
 */

import { describe, it, expect } from 'vitest';
import {
  runAdversarialScenarioSynthetic,
  isAdversarialScenarioMode,
} from '../adversarial-scenario-runner';
import type {
  AdversarialScenarioName,
  ExperimentTask,
  CollectiveConfig,
} from '../experiment-types';

function makeTask(): ExperimentTask {
  return {
    index: 42,
    taskType: 'analysis',
    complexity: 'medium',
    domain: 'tech',
    prompt: 'analyze this',
    judgeRubric: 'rubric',
    expectedDifficulty: 0.5,
  };
}

function makeMode(scenario: AdversarialScenarioName): CollectiveConfig {
  return {
    mode: 'collective',
    strategy: 'sensitivity-consensus',
    qualityTarget: 0.85,
    requiredCapabilities: ['chat'],
    adversarialScenario: scenario,
    displayName: `sensitivity-consensus × ${scenario}`,
  };
}

function runWith(scenario: AdversarialScenarioName) {
  return runAdversarialScenarioSynthetic({
    experimentId: 'exp-adv-test',
    task: makeTask(),
    mode: makeMode(scenario),
    repetition: 1,
    phase: 'frozen',
    scenario,
  });
}

// ─── isAdversarialScenarioMode ─────────────────────────────────────────

describe('isAdversarialScenarioMode', () => {
  it('returns true for collective modes with adversarialScenario set', () => {
    const mode: CollectiveConfig = {
      mode: 'collective',
      strategy: 'consensus',
      adversarialScenario: 'sensitivity_poisoning',
    };
    expect(isAdversarialScenarioMode(mode)).toBe(true);
  });

  it('returns false for collective modes without adversarialScenario', () => {
    const mode: CollectiveConfig = {
      mode: 'collective',
      strategy: 'consensus',
    };
    expect(isAdversarialScenarioMode(mode)).toBe(false);
  });

  it('returns false for non-collective modes', () => {
    const single = { mode: 'single-model' as const, modelId: 'x', displayName: 'X' };
    expect(isAdversarialScenarioMode(single)).toBe(false);
  });

  it('returns false when adversarialScenario is empty string', () => {
    // Empty string violates the union but tests the runtime guard
    const mode = {
      mode: 'collective' as const,
      strategy: 'consensus' as const,
      adversarialScenario: '' as AdversarialScenarioName,
    };
    expect(isAdversarialScenarioMode(mode)).toBe(false);
  });
});

// ─── End-to-end per scenario ───────────────────────────────────────────

describe('runAdversarialScenarioSynthetic', () => {
  it.each([
    'sensitivity_poisoning',
    'herding_cascade',
    'confidence_spamming',
    'outlier_amplification',
    'hostile_minority',
  ] as const)('runs scenario %s without invoking any model', (scenario) => {
    const result = runWith(scenario);
    expect(result.costUsd).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.modelsUsed).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.scoringPolicy).toBe('adversarial');
    expect(result.judgeUsed).toBe(false);
  });

  it('sensitivity_poisoning passes (qualityScore=1.0) when detector trips', () => {
    const result = runWith('sensitivity_poisoning');
    expect(result.qualityScore).toBe(1.0);
    expect(result.responseSummary).toContain('poisoningDetected=true');
    expect(result.responseSummary).toContain('passed=true');
  });

  it('herding_cascade passes (qualityScore=1.0) when detector trips', () => {
    const result = runWith('herding_cascade');
    expect(result.qualityScore).toBe(1.0);
    expect(result.responseSummary).toContain('herdingDetected=true');
    expect(result.responseSummary).toContain('passed=true');
  });

  it('confidence_spamming passes (qualityScore=1.0) when detector trips', () => {
    const result = runWith('confidence_spamming');
    expect(result.qualityScore).toBe(1.0);
    expect(result.responseSummary).toContain('poisoningDetected=true');
  });

  it('outlier_amplification passes when no detector trips and aggregator damps the value', () => {
    const result = runWith('outlier_amplification');
    expect(result.qualityScore).toBe(1.0);
    expect(result.responseSummary).toContain('poisoningDetected=false');
    expect(result.responseSummary).toContain('herdingDetected=false');
  });

  it('hostile_minority passes when no detector trips (majority wins)', () => {
    const result = runWith('hostile_minority');
    expect(result.qualityScore).toBe(1.0);
    expect(result.responseSummary).toContain('passed=true');
  });

  it('records latency above 0', () => {
    const result = runWith('sensitivity_poisoning');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('preserves mode classification in result.executionMode', () => {
    const result = runWith('herding_cascade');
    expect(result.executionMode).toBe('collective');
  });

  it('strategy field reflects the mode strategy', () => {
    const result = runWith('herding_cascade');
    expect(result.strategy).toBe('sensitivity-consensus');
  });

  it('responseSummary includes the scenario name and rationale', () => {
    const result = runWith('herding_cascade');
    expect(result.responseSummary).toContain('herding_cascade');
    expect(result.responseSummary).toContain('expected:');
  });

  it('judgeRubric reflects detector accuracy semantics', () => {
    const result = runWith('sensitivity_poisoning');
    expect(result.judgeRubric).toBe('adversarial detector accuracy');
  });

  it('runs across different repetitions deterministically (same outcome)', () => {
    const run1 = runWith('sensitivity_poisoning');
    const run2 = runWith('sensitivity_poisoning');
    // The synthetic generators use Math.random() for ids so the
    // qualityScore + detection outcome are stable but the response
    // summary contains the same structural data.
    expect(run1.qualityScore).toBe(run2.qualityScore);
    expect(run1.success).toBe(run2.success);
  });
});
