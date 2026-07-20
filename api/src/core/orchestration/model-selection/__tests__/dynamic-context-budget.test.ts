// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4C §9 — dynamic-context-budget tests.
 */
import { describe, it, expect } from 'vitest';
import {
  computeDynamicContextBudget,
  candidateSatisfiesContextBudget,
  estimateTokensForText,
  FORMULA_VERSION,
  MIN_SAFETY_MARGIN_RATIO,
  MIN_ABSOLUTE_SAFETY_MARGIN_TOKENS,
  type DynamicContextBudgetInput,
} from '@/core/orchestration/model-selection/dynamic-context-budget';

function baseInput(overrides: Partial<DynamicContextBudgetInput> = {}): DynamicContextBudgetInput {
  return {
    role: 'participant',
    userPromptTokensEstimate: 1000,
    systemPromptTokensEstimate: 500,
    roleInstructionTokensEstimate: 200,
    participantCount: 3,
    participantMaxOutputTokens: 4096,
    synthesizerMaxOutputTokens: 4096,
    judgeMaxOutputTokens: 4096,
    rubricTokensEstimate: 500,
    toolTraceTokensEstimate: 0,
    overheadTokens: 256,
    safetyMarginRatio: 0.2,
    absoluteSafetyMarginTokens: 1024,
    ...overrides,
  };
}

describe('01C.1B-J1D-R4C §9 — computeDynamicContextBudget', () => {
  it('participant budget < synthesizer budget for N=3 participants', () => {
    const p = computeDynamicContextBudget(baseInput({ role: 'participant' }));
    const s = computeDynamicContextBudget(baseInput({ role: 'synthesizer' }));
    expect(p.minContextWindow).toBeLessThan(s.minContextWindow);
  });

  it('judge budget > synthesizer budget (judge reads synth output)', () => {
    const s = computeDynamicContextBudget(baseInput({ role: 'synthesizer' }));
    const j = computeDynamicContextBudget(baseInput({ role: 'judge' }));
    expect(j.minContextWindow).toBeGreaterThan(s.minContextWindow);
  });

  it('synthesizer budget scales with participantCount', () => {
    const s3 = computeDynamicContextBudget(baseInput({ role: 'synthesizer', participantCount: 3 }));
    const s5 = computeDynamicContextBudget(baseInput({ role: 'synthesizer', participantCount: 5 }));
    expect(s5.minContextWindow).toBeGreaterThan(s3.minContextWindow);
  });

  it('synthesizer budget scales with participantMaxOutputTokens', () => {
    const small = computeDynamicContextBudget(
      baseInput({ role: 'synthesizer', participantMaxOutputTokens: 2048 }),
    );
    const big = computeDynamicContextBudget(
      baseInput({ role: 'synthesizer', participantMaxOutputTokens: 8192 }),
    );
    expect(big.minContextWindow).toBeGreaterThan(small.minContextWindow);
  });

  it('safety margin respects MIN_SAFETY_MARGIN_RATIO floor', () => {
    const b = computeDynamicContextBudget(baseInput({ safetyMarginRatio: 0.05 }));
    const ratio = b.safetyMarginTokens / b.requiredInputTokens;
    expect(ratio).toBeGreaterThanOrEqual(MIN_SAFETY_MARGIN_RATIO - 0.001);
  });

  it('safety margin respects MIN_ABSOLUTE_SAFETY_MARGIN_TOKENS floor', () => {
    const b = computeDynamicContextBudget(
      baseInput({
        userPromptTokensEstimate: 10,
        systemPromptTokensEstimate: 10,
        roleInstructionTokensEstimate: 10,
        overheadTokens: 10,
        absoluteSafetyMarginTokens: 0,
      }),
    );
    expect(b.safetyMarginTokens).toBeGreaterThanOrEqual(MIN_ABSOLUTE_SAFETY_MARGIN_TOKENS);
  });

  it('formulaVersion is the J1D-R4C constant', () => {
    const b = computeDynamicContextBudget(baseInput());
    expect(b.formulaVersion).toBe(FORMULA_VERSION);
    expect(b.formulaVersion).toBe('01C.1B-J1D-R4C-v1');
  });

  it('candidate passes when effectiveContextWindow >= minContextWindow', () => {
    const budget = computeDynamicContextBudget(baseInput({ role: 'synthesizer' }));
    const fit = candidateSatisfiesContextBudget({
      effectiveContextWindow: 200000,
      budget,
    });
    expect(fit.ok).toBe(true);
  });

  it('candidate fails when effectiveContextWindow < minContextWindow', () => {
    const budget = computeDynamicContextBudget(baseInput({ role: 'synthesizer' }));
    const fit = candidateSatisfiesContextBudget({
      effectiveContextWindow: 4096,
      budget,
    });
    expect(fit.ok).toBe(false);
    expect(fit.reason).toBe('context_window_too_small');
    expect(fit.required).toBe(budget.minContextWindow);
    expect(fit.available).toBe(4096);
  });

  it('reports max_output_tokens_too_small when required exceeds available', () => {
    const budget = computeDynamicContextBudget(baseInput({ role: 'synthesizer' }));
    const fit = candidateSatisfiesContextBudget({
      effectiveContextWindow: 200000,
      effectiveMaxOutputTokens: 1024,
      budget,
      requiredMaxOutputTokens: 4096,
    });
    expect(fit.ok).toBe(false);
    expect(fit.reason).toBe('max_output_tokens_too_small');
  });

  it('deterministic — identical inputs → identical output', () => {
    const a = computeDynamicContextBudget(baseInput({ role: 'judge' }));
    const b = computeDynamicContextBudget(baseInput({ role: 'judge' }));
    expect(a).toEqual(b);
  });

  it('replaces magic 32k/16k — synthesizer minContext changes with maxOutputTokens', () => {
    // With participantCount=3, maxOut=4096, system+user+role small,
    // synthesizer budget would be ≈ 12288 + safety. NOT 32000 hardcoded.
    const s = computeDynamicContextBudget(
      baseInput({
        role: 'synthesizer',
        userPromptTokensEstimate: 100,
        systemPromptTokensEstimate: 100,
        roleInstructionTokensEstimate: 50,
        overheadTokens: 100,
        participantCount: 3,
        participantMaxOutputTokens: 4096,
      }),
    );
    // Required: 100 + 100 + 50 + (3*4096) + 4096 + 100 = 16734
    // Safety: max(1024, ceil(16734*0.2)) = 3347
    // Min: 20081
    expect(s.minContextWindow).toBeLessThan(32000); // would have been 32k with magic constant
    expect(s.minContextWindow).toBeGreaterThan(16000);
    expect(s.minContextWindow).toBe(16734 + 3347);
  });

  it('rejects participantCount < 1 (floored to 1)', () => {
    const b = computeDynamicContextBudget(baseInput({ role: 'synthesizer', participantCount: 0 }));
    // participantCount floored to 1
    expect(b.components.participantOutputs).toBe(4096); // 1*4096
  });

  it('estimateTokensForText is conservative (rounds up)', () => {
    expect(estimateTokensForText('')).toBe(0);
    expect(estimateTokensForText('1234')).toBe(1);
    expect(estimateTokensForText('1234567')).toBe(2); // ceil(7/4) = 2
    expect(estimateTokensForText('a'.repeat(100))).toBe(25);
  });

  it('serialized budget does NOT contain secret patterns', () => {
    const b = computeDynamicContextBudget(baseInput({ role: 'judge' }));
    const s = JSON.stringify(b);
    expect(s).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(s).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });
});
