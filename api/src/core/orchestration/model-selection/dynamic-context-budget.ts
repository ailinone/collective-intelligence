// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4C §9 — Dynamic context budget.
 *
 * Derives the minimum required contextWindow per consensus role from
 * the plan inputs, INSTEAD of relying on magic constants
 * (`contextWindowMin: 32000/16000/8000` in `model-role-policy.ts`).
 *
 * Why this matters (per spec §3.3 + user's observation):
 *   - `participantCount=5` or `maxOutputTokens=8192` silently break a
 *     32k constant; with the formula they raise the requirement.
 *   - Judge actually NEEDS more context than synthesizer (it reads the
 *     synth output), but the constants inverted this (judge=16k <
 *     synth=32k). The formula corrects this naturally.
 *
 * Pure: no I/O. The formula is the contract.
 *
 * Formula (per role):
 *   participant.minContext =
 *     userPromptTokens + systemPromptTokens + roleInstructionTokens
 *     + overheadTokens + safetyMargin
 *
 *   synthesizer.minContext =
 *     userPromptTokens + systemPromptTokens + roleInstructionTokens
 *     + participantCount * participantMaxOutputTokens
 *     + overheadTokens + safetyMargin
 *
 *   judge.minContext =
 *     userPromptTokens + systemPromptTokens + roleInstructionTokens
 *     + participantCount * participantMaxOutputTokens
 *     + synthesizerMaxOutputTokens
 *     + rubricTokens + toolTraceTokens
 *     + overheadTokens + safetyMargin
 *
 *   fallback_single.minContext = participant.minContext
 *
 * Safety margin = max(absoluteSafetyMarginTokens, ceil(requiredInputTokens * safetyMarginRatio))
 * (min ratio 0.20, min absolute 1024 — enforced in `computeDynamicContextBudget`)
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type ConsensusRole =
  | 'participant'
  | 'synthesizer'
  | 'judge'
  | 'fallback'
  | 'fallback_single';

export interface DynamicContextBudgetInput {
  readonly role: ConsensusRole;
  readonly userPromptTokensEstimate: number;
  readonly systemPromptTokensEstimate: number;
  readonly roleInstructionTokensEstimate: number;
  readonly participantCount: number;
  readonly participantMaxOutputTokens: number;
  readonly synthesizerMaxOutputTokens: number;
  readonly judgeMaxOutputTokens: number;
  readonly rubricTokensEstimate: number;
  readonly toolTraceTokensEstimate: number;
  readonly overheadTokens: number;
  readonly safetyMarginRatio: number;
  readonly absoluteSafetyMarginTokens: number;
}

export interface DynamicContextBudgetComponents {
  readonly userPrompt: number;
  readonly systemPrompt: number;
  readonly roleInstruction: number;
  readonly participantOutputs: number;
  readonly synthesizerOutput: number;
  readonly judgeOutput: number;
  readonly rubric: number;
  readonly toolTrace: number;
  readonly overhead: number;
}

export interface DynamicContextBudget {
  readonly role: ConsensusRole;
  readonly formulaVersion: '01C.1B-J1D-R4C-v1';
  readonly requiredInputTokens: number;
  readonly safetyMarginTokens: number;
  readonly minContextWindow: number;
  readonly components: DynamicContextBudgetComponents;
}

// ─── Constants ────────────────────────────────────────────────────────────

export const FORMULA_VERSION = '01C.1B-J1D-R4C-v1' as const;
export const MIN_SAFETY_MARGIN_RATIO = 0.2;
export const MIN_ABSOLUTE_SAFETY_MARGIN_TOKENS = 1024;

// ─── Helpers ──────────────────────────────────────────────────────────────

function nonNeg(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Cheap token estimator. Heuristic: average of 4 chars per token (English
 * GPT-style). Used by callers when they don't have a real tokenizer.
 * Conservative — always rounds UP.
 */
export function estimateTokensForText(input: string): number {
  if (!input) return 0;
  return Math.max(1, Math.ceil(input.length / 4));
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Compute the dynamic context budget for one role.
 *
 * Returns the required input tokens, computed safety margin, and the
 * minimum effective contextWindow a candidate must support to be
 * eligible for this role.
 *
 * Determinism: identical inputs → identical output. No I/O.
 */
export function computeDynamicContextBudget(
  input: DynamicContextBudgetInput,
): DynamicContextBudget {
  // Enforce safety floors
  const safetyMarginRatio = Math.max(MIN_SAFETY_MARGIN_RATIO, input.safetyMarginRatio);
  const absoluteSafetyMarginTokens = Math.max(
    MIN_ABSOLUTE_SAFETY_MARGIN_TOKENS,
    nonNeg(input.absoluteSafetyMarginTokens),
  );

  // Normalize inputs
  const participantCount = Math.max(1, nonNeg(input.participantCount));
  const participantMaxOutputTokens = nonNeg(input.participantMaxOutputTokens);
  const synthesizerMaxOutputTokens = nonNeg(input.synthesizerMaxOutputTokens);
  const judgeMaxOutputTokens = nonNeg(input.judgeMaxOutputTokens);
  const userPrompt = nonNeg(input.userPromptTokensEstimate);
  const systemPrompt = nonNeg(input.systemPromptTokensEstimate);
  const roleInstruction = nonNeg(input.roleInstructionTokensEstimate);
  const rubric = nonNeg(input.rubricTokensEstimate);
  const toolTrace = nonNeg(input.toolTraceTokensEstimate);
  const overhead = nonNeg(input.overheadTokens);

  // Compute per-role components
  let components: DynamicContextBudgetComponents;

  switch (input.role) {
    case 'synthesizer': {
      const participantOutputs = participantCount * participantMaxOutputTokens;
      components = {
        userPrompt,
        systemPrompt,
        roleInstruction,
        participantOutputs,
        synthesizerOutput: synthesizerMaxOutputTokens,
        judgeOutput: 0,
        rubric: 0,
        toolTrace,
        overhead,
      };
      break;
    }
    case 'judge': {
      const participantOutputs = participantCount * participantMaxOutputTokens;
      components = {
        userPrompt,
        systemPrompt,
        roleInstruction,
        participantOutputs,
        synthesizerOutput: synthesizerMaxOutputTokens,
        judgeOutput: judgeMaxOutputTokens,
        rubric,
        toolTrace,
        overhead,
      };
      break;
    }
    case 'participant':
    case 'fallback':
    case 'fallback_single':
    default: {
      components = {
        userPrompt,
        systemPrompt,
        roleInstruction,
        participantOutputs: 0,
        synthesizerOutput: 0,
        judgeOutput: 0,
        rubric: 0,
        toolTrace: 0,
        overhead,
      };
      break;
    }
  }

  const requiredInputTokens =
    components.userPrompt +
    components.systemPrompt +
    components.roleInstruction +
    components.participantOutputs +
    components.synthesizerOutput +
    components.judgeOutput +
    components.rubric +
    components.toolTrace +
    components.overhead;

  const safetyMarginTokens = Math.max(
    absoluteSafetyMarginTokens,
    Math.ceil(requiredInputTokens * safetyMarginRatio),
  );

  const minContextWindow = requiredInputTokens + safetyMarginTokens;

  return {
    role: input.role,
    formulaVersion: FORMULA_VERSION,
    requiredInputTokens,
    safetyMarginTokens,
    minContextWindow,
    components,
  };
}

// ─── Candidate eligibility ────────────────────────────────────────────────

export interface CandidateContextFit {
  readonly ok: boolean;
  readonly reason?: 'context_window_too_small' | 'max_output_tokens_too_small';
  readonly required?: number;
  readonly available?: number;
}

export function candidateSatisfiesContextBudget(input: {
  readonly effectiveContextWindow: number;
  readonly effectiveMaxOutputTokens?: number;
  readonly budget: DynamicContextBudget;
  readonly requiredMaxOutputTokens?: number;
}): CandidateContextFit {
  const ctx = Number(input.effectiveContextWindow ?? 0);
  if (!Number.isFinite(ctx) || ctx <= 0) {
    return {
      ok: false,
      reason: 'context_window_too_small',
      required: input.budget.minContextWindow,
      available: ctx,
    };
  }
  if (ctx < input.budget.minContextWindow) {
    return {
      ok: false,
      reason: 'context_window_too_small',
      required: input.budget.minContextWindow,
      available: ctx,
    };
  }
  if (typeof input.requiredMaxOutputTokens === 'number' && input.requiredMaxOutputTokens > 0) {
    const maxOut = Number(input.effectiveMaxOutputTokens ?? 0);
    if (!Number.isFinite(maxOut) || maxOut < input.requiredMaxOutputTokens) {
      return {
        ok: false,
        reason: 'max_output_tokens_too_small',
        required: input.requiredMaxOutputTokens,
        available: maxOut,
      };
    }
  }
  return { ok: true };
}
