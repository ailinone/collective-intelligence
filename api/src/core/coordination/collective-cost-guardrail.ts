// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Cost Guardrail
 *
 * Pre-flight cost estimation for a coordination round.
 *
 * Why a separate module:
 *   - The existing stop-condition logic in `sensitivity-aggregator.ts`
 *     evaluates `state.totalCostUsd >= limits.maxCostUsd` AFTER a round
 *     completes. That is too late: a round of 5 expensive models can
 *     overshoot the budget by orders of magnitude before being noticed.
 *   - This module produces a conservative upper bound on the round's
 *     cost given the chosen models and the system+user prompt size, so
 *     the loop can abort BEFORE issuing the round's API calls.
 *
 * Conservativeness:
 *   - Output tokens are estimated as the requested `max_tokens` (worst
 *     case). Models rarely use the full budget but the guard must not
 *     under-estimate.
 *   - Input token count uses a 4-chars-per-token rule of thumb that is
 *     close enough across BPE tokenizers. For accuracy beyond ±10% the
 *     orchestration-engine token estimator could be plugged in here, but
 *     the guard's job is upper-bound enforcement, not precise billing.
 *
 * Deterministic and side-effect free.
 */

import type { Model, ChatRequest } from '@/types';
import type { CoordinationState } from './coordination-types';

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * Average characters per token across modern BPE tokenizers (cl100k,
 * Llama-3, Qwen, etc.). This is an upper bound: real tokenizers
 * compress slightly better in English but worse in CJK, so 4 is a safe
 * average for cost estimation without over-claiming.
 */
const CHARS_PER_TOKEN_AVG = 4;

/**
 * Tokens charged per model call regardless of message size (system
 * prompt formatting, tool definitions overhead, etc.). A small flat
 * surcharge keeps tiny prompts from being estimated at zero cost.
 */
const PER_CALL_TOKEN_OVERHEAD = 32;

/**
 * Default `max_tokens` to assume when the request omits it. Mirrors the
 * default the coordination strategy sets (`2048`) so the estimate stays
 * aligned with what is actually requested.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/**
 * Safety margin applied to the projected cost before comparing against
 * the budget. 1.10 means "abort if projected cost is within 10% of the
 * remaining budget" — leaves a small cushion for tokenizer drift and
 * provider overhead pricing.
 */
const PROJECTION_SAFETY_MARGIN = 1.1;

// ─── Types ──────────────────────────────────────────────────────────────

export interface RoundCostEstimate {
  /** Sum of estimated cost across all models for this round (USD). */
  estimatedRoundCostUsd: number;
  /** Cost already spent in previous rounds (USD). */
  alreadySpentUsd: number;
  /** Projected total at end of this round (estimated + already spent). */
  projectedTotalUsd: number;
  /** Configured ceiling. `undefined` means no cap. */
  limitUsd: number | undefined;
  /** True when projected total × safety-margin would exceed the limit. */
  exceedsLimit: boolean;
  /** Per-model breakdown for diagnostics. Stable order matches input. */
  perModel: Array<{
    modelId: string;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCostUsd: number;
  }>;
}

// ─── Token estimation ───────────────────────────────────────────────────

/**
 * Approximate the input token count for a ChatRequest. We sum the
 * stringified content length across all messages. Tool definitions are
 * intentionally ignored here because the coordination strategy does not
 * inject tools into its agent prompts.
 */
function estimateRequestInputTokens(request: ChatRequest): number {
  let totalChars = 0;
  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      totalChars += message.content.length;
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') {
            totalChars += text.length;
          }
        }
      }
    }
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN_AVG) + PER_CALL_TOKEN_OVERHEAD;
}

/**
 * Resolve the effective `max_tokens` for a given request, falling back
 * to the model's `maxOutputTokens` (when set) and finally to the
 * coordination default.
 */
function effectiveMaxOutputTokens(model: Model, request: ChatRequest): number {
  if (typeof request.max_tokens === 'number' && request.max_tokens > 0) {
    return request.max_tokens;
  }
  // Use the model's OWN declared output cap (frontier models emit far more than
  // 2048) — the old Math.min(..., 2048) under-estimated the projected cost of a
  // long frontier answer and could abort a round too early. 2048 stays only as
  // the terminal fallback when the model declares no output cap.
  if (typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0) {
    return model.maxOutputTokens;
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

// ─── Cost estimation ────────────────────────────────────────────────────

/**
 * Estimate the cost of a single model call assuming worst-case output
 * length. Returns 0 when the model is missing pricing metadata — the
 * guard is conservative on the input side; missing prices simply mean
 * the model is not budget-checked (typical for self-hosted models).
 */
function estimateModelCallCost(
  model: Model,
  request: ChatRequest,
): { input: number; output: number; cost: number } {
  const input = estimateRequestInputTokens(request);
  const output = effectiveMaxOutputTokens(model, request);

  const inputPricePer1k = Number.isFinite(model.inputCostPer1k) ? model.inputCostPer1k : 0;
  const outputPricePer1k = Number.isFinite(model.outputCostPer1k) ? model.outputCostPer1k : 0;

  const cost =
    (input / 1000) * inputPricePer1k + (output / 1000) * outputPricePer1k;

  return { input, output, cost };
}

/**
 * Build a `RoundCostEstimate` for the upcoming round. Pure function:
 * does not log, does not mutate inputs.
 */
export function estimateRoundCost(
  models: Model[],
  request: ChatRequest,
  state: CoordinationState,
): RoundCostEstimate {
  const perModel: RoundCostEstimate['perModel'] = [];
  let estimatedRoundCostUsd = 0;

  for (const model of models) {
    const { input, output, cost } = estimateModelCallCost(model, request);
    estimatedRoundCostUsd += cost;
    perModel.push({
      modelId: model.id,
      estimatedInputTokens: input,
      estimatedOutputTokens: output,
      estimatedCostUsd: cost,
    });
  }

  const alreadySpentUsd = state.totalCostUsd;
  const projectedTotalUsd = alreadySpentUsd + estimatedRoundCostUsd;
  const limitUsd = state.limits.maxCostUsd;

  const exceedsLimit =
    typeof limitUsd === 'number' &&
    projectedTotalUsd * PROJECTION_SAFETY_MARGIN > limitUsd;

  return {
    estimatedRoundCostUsd,
    alreadySpentUsd,
    projectedTotalUsd,
    limitUsd,
    exceedsLimit,
    perModel,
  };
}

/**
 * True when the round would push the run over its configured maxCostUsd
 * limit — taking the safety margin into account. When no limit is
 * configured this always returns false.
 */
export function wouldExceedCostLimit(
  models: Model[],
  request: ChatRequest,
  state: CoordinationState,
): boolean {
  return estimateRoundCost(models, request, state).exceedsLimit;
}
