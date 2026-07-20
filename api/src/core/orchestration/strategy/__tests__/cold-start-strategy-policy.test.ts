// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * cold-start-strategy-policy.test.ts — SM-R2-CORRECTIVE §15
 *
 * Tests for the deterministic cold-start routing policy.
 * Verifies: all 8 canonical scenarios, rule priorities, distinct strategy count.
 */

import { describe, it, expect } from 'vitest';
import {
  selectColdStartStrategy,
  extractColdStartInput,
  COLD_START_CANONICAL_SCENARIOS,
} from '../cold-start-strategy-policy';
import type { ColdStartPolicyInput } from '../cold-start-strategy-policy';

const BASE_INPUT: ColdStartPolicyInput = { modelsAvailable: 3 };

describe('selectColdStartStrategy — rule priorities', () => {
  it('R1: very low max_cost → cost-cascade', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, maxCostUsd: 0.0001 });
    expect(result.strategy).toBe('cost-cascade');
    expect(result.reason).toBe('cost_budget_very_low');
    expect(result.isDeterministic).toBe(true);
  });

  it('R1: cost below $0.002 threshold → cost-cascade', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, maxCostUsd: 0.001999 });
    expect(result.strategy).toBe('cost-cascade');
  });

  it('R1: cost at exactly $0.002 → NOT triggered (falls to R6 default)', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, maxCostUsd: 0.002 });
    // R1 condition is < 0.002 (strict less-than)
    expect(result.strategy).toBe('single');
  });

  it('R2: high quality target ≥ 0.9 → consensus', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, qualityTarget: 0.9 });
    expect(result.strategy).toBe('consensus');
    expect(result.reason).toBe('quality_target_high');
  });

  it('R2: quality_target=0.95 → consensus', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, qualityTarget: 0.95 });
    expect(result.strategy).toBe('consensus');
  });

  it('R2: quality_target=0.89 → NOT triggered (falls to later rules)', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, qualityTarget: 0.89 });
    // Should fall to R6 default since no other rules match
    expect(result.strategy).toBe('single');
  });

  it('R3: prefer_speed=true → single', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, preferSpeed: true });
    expect(result.strategy).toBe('single');
    expect(result.reason).toBe('prefer_speed');
  });

  it('R4: analysis task type → consensus', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, taskType: 'analysis' });
    expect(result.strategy).toBe('consensus');
    expect(result.reason).toBe('complex_task_type');
  });

  it('R4: reasoning task type → consensus', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, taskType: 'reasoning' });
    expect(result.strategy).toBe('consensus');
  });

  it('R4: decision-making task type → consensus', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, taskType: 'decision-making' });
    expect(result.strategy).toBe('consensus');
  });

  it('R5: code-review task type → debate', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, taskType: 'code-review' });
    expect(result.strategy).toBe('debate');
    expect(result.reason).toBe('adversarial_task_type');
  });

  it('R5: debugging task type → debate', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, taskType: 'debugging' });
    expect(result.strategy).toBe('debate');
  });

  it('R6: default (no constraints) → single', () => {
    const result = selectColdStartStrategy(BASE_INPUT);
    expect(result.strategy).toBe('single');
    expect(result.reason).toBe('default_cold_start');
  });

  it('R6: code-generation → single (not a complex type)', () => {
    const result = selectColdStartStrategy({ ...BASE_INPUT, taskType: 'code-generation' });
    expect(result.strategy).toBe('single');
  });
});

describe('selectColdStartStrategy — priority ordering', () => {
  it('R1 (cost) beats R2 (quality) when both apply', () => {
    // Both cost very low AND quality high — cost is rule 1, should win
    const result = selectColdStartStrategy({
      ...BASE_INPUT,
      maxCostUsd: 0.0001,
      qualityTarget: 0.95,
    });
    expect(result.strategy).toBe('cost-cascade');
    expect(result.reason).toBe('cost_budget_very_low');
  });

  it('R2 (quality) beats R3 (speed) when both apply', () => {
    // Both quality high AND prefer_speed — quality is rule 2, should win
    const result = selectColdStartStrategy({
      ...BASE_INPUT,
      qualityTarget: 0.92,
      preferSpeed: true,
    });
    expect(result.strategy).toBe('consensus');
    expect(result.reason).toBe('quality_target_high');
  });

  it('R3 (speed) beats R4 (complex task) when both apply', () => {
    const result = selectColdStartStrategy({
      ...BASE_INPUT,
      preferSpeed: true,
      taskType: 'analysis',
    });
    expect(result.strategy).toBe('single');
    expect(result.reason).toBe('prefer_speed');
  });
});

describe('selectColdStartStrategy — model suitability', () => {
  it('returns suitableWithAvailableModels=true when models≥minRequired', () => {
    const r1 = selectColdStartStrategy({ ...BASE_INPUT, modelsAvailable: 3 });  // single: min=1
    expect(r1.suitableWithAvailableModels).toBe(true);

    const r2 = selectColdStartStrategy({ ...BASE_INPUT, maxCostUsd: 0.001, modelsAvailable: 2 });
    expect(r2.strategy).toBe('cost-cascade');  // min=2
    expect(r2.suitableWithAvailableModels).toBe(true);
  });

  it('returns suitableWithAvailableModels=false when models<minRequired', () => {
    // consensus needs 3, only 1 available
    const r = selectColdStartStrategy({ ...BASE_INPUT, qualityTarget: 0.95, modelsAvailable: 1 });
    expect(r.strategy).toBe('consensus');
    expect(r.suitableWithAvailableModels).toBe(false);
    expect(r.minModelsRequired).toBe(3);
  });
});

describe('COLD_START_CANONICAL_SCENARIOS — 8-scenario matrix', () => {
  it('all 8 scenarios produce expected strategies', () => {
    for (const scenario of COLD_START_CANONICAL_SCENARIOS) {
      const result = selectColdStartStrategy(scenario.input);
      expect(result.strategy).toBe(scenario.expectedStrategy);
      expect(result.reason).toBe(scenario.expectedReason);
    }
  });

  it('produces ≥3 distinct strategies across 8 scenarios', () => {
    const strategies = new Set(
      COLD_START_CANONICAL_SCENARIOS.map(s => selectColdStartStrategy(s.input).strategy)
    );
    expect(strategies.size).toBeGreaterThanOrEqual(3);
  });

  it('produces exactly the expected distinct strategies', () => {
    const strategies = new Set(
      COLD_START_CANONICAL_SCENARIOS.map(s => selectColdStartStrategy(s.input).strategy)
    );
    // Expected: single, consensus, cost-cascade
    expect(strategies.has('single')).toBe(true);
    expect(strategies.has('consensus')).toBe(true);
    expect(strategies.has('cost-cascade')).toBe(true);
  });

  it('has 8 scenarios', () => {
    expect(COLD_START_CANONICAL_SCENARIOS).toHaveLength(8);
  });
});

describe('extractColdStartInput', () => {
  it('extracts max_cost from request', () => {
    const input = extractColdStartInput(
      { messages: [], max_cost: 0.001 } as never,
      { modelsAvailable: 3 } as never,
    );
    expect(input.maxCostUsd).toBe(0.001);
  });

  it('prefers context.qualityTarget over request.quality_target', () => {
    const input = extractColdStartInput(
      { messages: [], quality_target: 0.7 } as never,
      { qualityTarget: 0.95, modelsAvailable: 3 } as never,
    );
    expect(input.qualityTarget).toBe(0.95);
  });

  it('falls back to request.quality_target when context.qualityTarget is absent', () => {
    const input = extractColdStartInput(
      { messages: [], quality_target: 0.85 } as never,
      { modelsAvailable: 3 } as never,
    );
    expect(input.qualityTarget).toBe(0.85);
  });

  it('prefers context.preferSpeed over request.prefer_speed', () => {
    const input = extractColdStartInput(
      { messages: [], prefer_speed: false } as never,
      { preferSpeed: true, modelsAvailable: 2 } as never,
    );
    expect(input.preferSpeed).toBe(true);
  });
});
