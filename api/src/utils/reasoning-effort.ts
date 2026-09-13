// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Canonical reasoning-effort resolution (LOTE AZ, 2026-09).
 *
 * This is THE single source of truth for turning a `ChatRequest`'s three
 * independent, overlapping "how much should the model think" signals —
 * the new public `reasoning_effort` enum, the pre-existing numeric
 * `thinking_budget`, and the pre-existing boolean
 * `ailin_constraints.enable_reasoning` — into one resolved, unambiguous
 * answer. Every consumer (base-strategy's native-thinking budget, the
 * judge/synthesis threading in consensus-strategy.ts, and — in later PRs —
 * the OpenAI/xAI, Anthropic and Google per-provider native mappings) MUST
 * go through `resolveReasoningEffort()` rather than reading these fields ad
 * hoc, so the reconciliation rule only ever lives in one place.
 *
 * Reconciliation rule (highest to lowest precedence):
 *   1. An explicit numeric `thinking_budget` always wins VERBATIM. It is the
 *      more specific, pre-existing knob (already consumed directly by
 *      BytePlus and the generic OpenAI-compatible hub adapter) — nothing
 *      here may silently override a caller's exact token count.
 *   2. Otherwise, an explicit `reasoning_effort` maps to a documented
 *      per-tier token budget (see `EFFORT_THINKING_BUDGETS`).
 *   3. Otherwise, `ailin_constraints.enable_reasoning === true` (the
 *      existing collective-strategy opt-in, which carries no notion of
 *      "how much") defaults to `'medium'` — this is what replaces the old
 *      base-strategy.ts hardcoded `2000` fallback.
 *   4. Otherwise both are `undefined` — no reasoning signal at all.
 *
 * Budget rationale (`EFFORT_THINKING_BUDGETS`):
 *   - `low`    1,024 tokens — Anthropic's extended-thinking docs state 1,024
 *              as the hard minimum `budget_tokens` the API accepts; a `low`
 *              request should sit right at that floor rather than pay for
 *              reasoning it explicitly asked to minimize.
 *   - `medium` 4,096 tokens — 2x the previous repo-wide hardcoded constant
 *              (`request.thinking_budget || 2000` in base-strategy.ts). Kept
 *              close to the historical default so existing callers that hit
 *              this path via `enable_reasoning` alone (no explicit effort)
 *              see a moderate, not disruptive, increase.
 *   - `high`   16,384 tokens — matches Anthropic's own documented starting
 *              point for complex extended-thinking tasks ("start around
 *              16k tokens, scale up to 32k for very hard problems") and is
 *              comfortably inside DeepSeek-R1 / QwQ's practical native
 *              thinking-length envelope for hard multi-step tasks.
 */
import type { AilinRuntimeConstraints, ChatRequest, Model, ReasoningEffort } from '@/types';

export type { ReasoningEffort } from '@/types';

/** Per-tier native-thinking token budgets. See module doc for rationale. */
export const EFFORT_THINKING_BUDGETS: Readonly<Record<ReasoningEffort, number>> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

/**
 * `quality_target` floor applied when `reasoning_effort: 'high'` is set and
 * the caller (or a resolved alias) did not already request a quality target.
 * Reuses the EXACT threshold orchestration-engine.ts already treats as "the
 * client wants high quality" (see `applyTriageRoute`'s
 * `clientWantsHighQuality = request.quality_target >= 0.9` and the
 * `preferQuality = aliasProfile?.quality_target >= 0.9` alias check) rather
 * than inventing a new one — piggybacking on a hook that is already wired
 * into real selection/routing decisions.
 */
export const HIGH_EFFORT_QUALITY_TARGET_FLOOR = 0.9;

const REASONING_EFFORT_VALUES = new Set<ReasoningEffort>(['low', 'medium', 'high']);

/** Type guard for the closed `ReasoningEffort` enum. Exported so callers
 *  (route validation, other resolvers) can defensively narrow a value that
 *  arrived as untyped JSON without duplicating the literal set. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_VALUES.has(value as ReasoningEffort);
}

export interface ResolvedReasoningEffort {
  /** The caller's graded intent, when known. `undefined` when nothing on the
   *  request expressed an effort level (not even `enable_reasoning`). */
  readonly effort: ReasoningEffort | undefined;
  /** The concrete native-thinking token budget to use, when reasoning is
   *  requested at all. `undefined` exactly when `effort` is `undefined`
   *  AND no explicit `thinking_budget` was set. */
  readonly thinkingBudget: number | undefined;
}

/** Minimal shape this resolver needs — narrower than the full `ChatRequest`
 *  so callers that only have a fragment (e.g. a reconstructed judge/synthesis
 *  request) can still call it without fabricating unrelated fields. */
export type ReasoningEffortSource = Pick<ChatRequest, 'reasoning_effort' | 'thinking_budget'> & {
  ailin_constraints?: Pick<AilinRuntimeConstraints, 'enable_reasoning'>;
};

/**
 * Resolve the single, unambiguous reasoning-effort signal for a request.
 * Pure function — see module doc for the precedence rule and budget
 * rationale. Safe to call on ANY object shaped like (a subset of)
 * `ChatRequest`, including ones assembled for a judge or synthesis sub-call.
 */
export function resolveReasoningEffort(request: ReasoningEffortSource): ResolvedReasoningEffort {
  const effort = isReasoningEffort(request.reasoning_effort) ? request.reasoning_effort : undefined;

  // Rule 1 — explicit numeric budget wins verbatim, regardless of `effort`.
  if (typeof request.thinking_budget === 'number' && request.thinking_budget > 0) {
    return { effort, thinkingBudget: request.thinking_budget };
  }

  // Rule 2 — explicit graded effort maps to its documented budget.
  if (effort) {
    return { effort, thinkingBudget: EFFORT_THINKING_BUDGETS[effort] };
  }

  // Rule 3 — bare `enable_reasoning` (no effort, no explicit budget) defaults
  // to 'medium'. This is the ONLY behavior change for existing callers that
  // never touch `reasoning_effort`/`thinking_budget`: they previously got a
  // hardcoded 2000 wherever base-strategy.ts's native-thinking path ran, and
  // now get the documented 4096 'medium' tier instead.
  if (request.ailin_constraints?.enable_reasoning === true) {
    return { effort: 'medium', thinkingBudget: EFFORT_THINKING_BUDGETS.medium };
  }

  // Rule 4 — no signal at all.
  return { effort: undefined, thinkingBudget: undefined };
}

/**
 * Does this model have REAL native extended-thinking support (DeepSeek-R1,
 * QwQ, and — once the parallel per-provider PRs land — Claude/Gemini/o-series
 * models flagged with the `thinking_mode` capability)?
 *
 * Extracted (LOTE AZ follow-up, 2026-09) from `BaseStrategy.hasNativeThinking`
 * so the extended-thinking/ultra-thinking routes (`extended-thinking-routes.ts`,
 * which build their own `ChatRequest`s directly rather than going through a
 * `BaseStrategy` subclass) can make the exact same native-vs-prompt-injection
 * decision as the orchestration engine's strategies, instead of maintaining a
 * second, drift-prone copy of this heuristic. `BaseStrategy.hasNativeThinking`
 * now delegates here — this is the single source of truth for both callers.
 *
 * NO HARDCODED MODEL LIST: the capability check is the authoritative signal
 * (populated dynamically by discovery/capability-inference, never a pinned
 * id); the name regex is only a defensive heuristic for rows the catalog
 * hasn't tagged yet.
 */
export function modelHasNativeThinking(
  model: Pick<Model, 'name' | 'id'> & { capabilities?: readonly string[] }
): boolean {
  if (Array.isArray(model.capabilities) && model.capabilities.includes('thinking_mode')) {
    return true;
  }
  const name = (model.name || model.id || '').toLowerCase();
  return /deepseek-r1|qwq|thinking|reasoner/.test(name);
}
