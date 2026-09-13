// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LOTE AZ (2026-09) — regression coverage for the canonical reasoning-effort
 * resolver: the precedence rule (explicit thinking_budget > reasoning_effort
 * enum > bare enable_reasoning default > nothing) and the documented
 * per-tier token budgets base-strategy.ts now scales by instead of one
 * hardcoded constant for every caller.
 */
import { describe, expect, it } from 'vitest';
import {
  EFFORT_THINKING_BUDGETS,
  HIGH_EFFORT_QUALITY_TARGET_FLOOR,
  isReasoningEffort,
  modelHasNativeThinking,
  resolveReasoningEffort,
} from '../reasoning-effort';

describe('isReasoningEffort', () => {
  it('accepts exactly the closed low/medium/high enum', () => {
    expect(isReasoningEffort('low')).toBe(true);
    expect(isReasoningEffort('medium')).toBe(true);
    expect(isReasoningEffort('high')).toBe(true);
  });

  it('rejects everything else, including BytePlus/Groq-only tiers and non-strings', () => {
    expect(isReasoningEffort('none')).toBe(false);
    expect(isReasoningEffort('minimal')).toBe(false);
    expect(isReasoningEffort('xhigh')).toBe(false);
    expect(isReasoningEffort('max')).toBe(false);
    expect(isReasoningEffort('default')).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
    expect(isReasoningEffort(null)).toBe(false);
    expect(isReasoningEffort(1)).toBe(false);
    expect(isReasoningEffort('')).toBe(false);
  });
});

describe('resolveReasoningEffort', () => {
  it('returns undefined/undefined when nothing on the request expresses a reasoning signal', () => {
    expect(resolveReasoningEffort({})).toEqual({ effort: undefined, thinkingBudget: undefined });
  });

  it('maps each graded effort to its documented per-tier budget', () => {
    expect(resolveReasoningEffort({ reasoning_effort: 'low' })).toEqual({
      effort: 'low',
      thinkingBudget: EFFORT_THINKING_BUDGETS.low,
    });
    expect(resolveReasoningEffort({ reasoning_effort: 'medium' })).toEqual({
      effort: 'medium',
      thinkingBudget: EFFORT_THINKING_BUDGETS.medium,
    });
    expect(resolveReasoningEffort({ reasoning_effort: 'high' })).toEqual({
      effort: 'high',
      thinkingBudget: EFFORT_THINKING_BUDGETS.high,
    });
  });

  it('budgets are strictly increasing low < medium < high, and low sits at the documented floor', () => {
    expect(EFFORT_THINKING_BUDGETS.low).toBeLessThan(EFFORT_THINKING_BUDGETS.medium);
    expect(EFFORT_THINKING_BUDGETS.medium).toBeLessThan(EFFORT_THINKING_BUDGETS.high);
    // Anthropic's documented hard minimum for budget_tokens.
    expect(EFFORT_THINKING_BUDGETS.low).toBe(1024);
  });

  it('an explicit numeric thinking_budget wins verbatim over a conflicting reasoning_effort', () => {
    const resolved = resolveReasoningEffort({ reasoning_effort: 'low', thinking_budget: 9999 });
    expect(resolved.thinkingBudget).toBe(9999);
    // The stated intent is still recorded even though the numeric budget won.
    expect(resolved.effort).toBe('low');
  });

  it('an explicit thinking_budget alone (no reasoning_effort) resolves with effort undefined', () => {
    const resolved = resolveReasoningEffort({ thinking_budget: 5000 });
    expect(resolved).toEqual({ effort: undefined, thinkingBudget: 5000 });
  });

  it('ignores a non-positive or zero thinking_budget (falls through to lower-precedence rules)', () => {
    expect(resolveReasoningEffort({ thinking_budget: 0, reasoning_effort: 'medium' })).toEqual({
      effort: 'medium',
      thinkingBudget: EFFORT_THINKING_BUDGETS.medium,
    });
    expect(resolveReasoningEffort({ thinking_budget: -5 })).toEqual({
      effort: undefined,
      thinkingBudget: undefined,
    });
  });

  it("bare ailin_constraints.enable_reasoning (no effort, no budget) defaults to 'medium'", () => {
    const resolved = resolveReasoningEffort({ ailin_constraints: { enable_reasoning: true } });
    expect(resolved).toEqual({ effort: 'medium', thinkingBudget: EFFORT_THINKING_BUDGETS.medium });
  });

  it('enable_reasoning=false contributes nothing', () => {
    expect(resolveReasoningEffort({ ailin_constraints: { enable_reasoning: false } })).toEqual({
      effort: undefined,
      thinkingBudget: undefined,
    });
  });

  it('an explicit reasoning_effort takes precedence over bare enable_reasoning', () => {
    const resolved = resolveReasoningEffort({
      reasoning_effort: 'low',
      ailin_constraints: { enable_reasoning: true },
    });
    expect(resolved).toEqual({ effort: 'low', thinkingBudget: EFFORT_THINKING_BUDGETS.low });
  });

  it('a garbage reasoning_effort value is ignored rather than corrupting the resolution', () => {
    const resolved = resolveReasoningEffort({
      reasoning_effort: 'ultra' as unknown as 'low',
      ailin_constraints: { enable_reasoning: true },
    });
    // Falls through to the enable_reasoning default since the enum value is invalid.
    expect(resolved).toEqual({ effort: 'medium', thinkingBudget: EFFORT_THINKING_BUDGETS.medium });
  });
});

describe('modelHasNativeThinking (LOTE AZ follow-up — extended-thinking real-native activation)', () => {
  it('is true for a model whose capabilities carry the thinking_mode capability — the authoritative, dynamic signal', () => {
    expect(
      modelHasNativeThinking({ id: 'some/opaque-id', name: 'Opaque Model', capabilities: ['thinking_mode'] })
    ).toBe(true);
  });

  it('is false for a model with unrelated capabilities and no name-heuristic match — NO hardcoded allowlist', () => {
    expect(
      modelHasNativeThinking({ id: 'openai/gpt-4o-mini', name: 'gpt-4o-mini', capabilities: ['chat', 'reasoning'] })
    ).toBe(false);
  });

  it('falls back to the defensive name heuristic when capabilities are absent/empty (catalog not yet tagged)', () => {
    // The heuristic checks `model.name || model.id` (name wins when truthy) —
    // a hyphenated name is what real catalog rows actually carry.
    expect(modelHasNativeThinking({ id: 'deepseek/deepseek-r1', name: 'DeepSeek-R1', capabilities: [] })).toBe(
      true
    );
    expect(modelHasNativeThinking({ id: 'qwen/qwq-32b', name: 'QwQ-32B-Preview' })).toBe(true);
    expect(modelHasNativeThinking({ id: 'some/reasoner-model', name: 'Custom Reasoner' })).toBe(true);
  });

  it('name heuristic is case-insensitive and falls back to id when name is empty', () => {
    expect(modelHasNativeThinking({ id: 'x', name: 'DEEPSEEK-R1-DISTILL' })).toBe(true);
    expect(modelHasNativeThinking({ id: 'provider/qwq-something', name: '' })).toBe(true);
  });

  it('a plain chat model with neither signal is not native', () => {
    expect(modelHasNativeThinking({ id: 'anthropic/claude-haiku', name: 'Claude Haiku' })).toBe(false);
  });
});

describe('HIGH_EFFORT_QUALITY_TARGET_FLOOR', () => {
  it('matches the exact threshold orchestration-engine.ts already treats as "wants high quality"', () => {
    // Locks the value to 0.9 — the SAME constant applyTriageRoute's
    // clientWantsHighQuality check and the alias preferQuality check use, so
    // a drift here silently decouples the reasoning_effort bias from every
    // other "quality_target >= 0.9" decision point in the engine.
    expect(HIGH_EFFORT_QUALITY_TARGET_FLOOR).toBe(0.9);
  });
});
