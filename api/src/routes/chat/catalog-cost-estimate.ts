// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Catalog pricing for provider calls that never produce an
 * `OrchestrationResult`.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: RETAINED BUT DELIBERATELY UNWIRED (2026-08-03). NO CALL SITES.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * This module was written for `/v1/chat/completions/intelligent` and
 * `/v1/analyze-requirements`. #271 deleted both, so both call sites are gone. It
 * is kept — rather than deleted with them — because there is a real, separately
 * valuable use for it, and kept UNWIRED because wiring it is a billing change
 * that does not belong in this PR. Both halves of that need explaining, because
 * "unused file" is otherwise indistinguishable from "dead file".
 *
 * WHAT IT IS FOR NEXT — the real bug it fixes.
 * `chat-routes.ts:1806` records `totalCostOverride: 0` for ALL streaming cost on
 * `POST /v1/chat/completions`, the flagship route. That is a hardcoded, known-
 * false zero: the stream ran on a real model and the terminal chunk usually
 * carries `usage`, so the number IS computable. `estimateStreamCostUsd` computes
 * exactly it — and everything it needs is already in scope at that call site
 * (`candidate.model` carries the catalog rates, `lastChunk.usage` carries the
 * tokens). It is a one-line change, and that is precisely why it needs a gate
 * rather than a quiet edit.
 *
 * WHY IT IS NOT WIRED HERE — the money argument, traced end to end.
 * Making that number non-zero is NOT confined to analytics. Following it:
 *
 *   totalCostOverride
 *     -> providerCost                       (billing-usage-tracker.ts:74)
 *     -> billedCost = applyBillingProfile() (:77)
 *     -> recordQuotaUsage({ cost: billedCost })            (:129-137)
 *     -> usage_quotas.costUsd += billedCost                (quota-service.ts:143)
 *     -> checkQuota -> calculateRemaining -> remaining.cost (:308-312)
 *     -> allowed = ... && remaining.cost >= 0              (:110)
 *     -> HARD 429 on POST /v1/chat/completions, NO feature flag of its own
 *
 * So for any org with `costLimitUsd` configured, flipping this zero to a real
 * number starts burning a cost cap that streaming traffic has never touched, and
 * can begin rejecting requests that succeed today. That is a change to request
 * ACCEPTANCE on the busiest route in the API — which this PR is required to
 * leave untouched at default flags.
 *
 * Two things it is NOT, stated so the next reader does not re-derive them:
 *   - It is NOT a prepaid-wallet change. `debitChatRequest` never reads this
 *     number; it computes its charge from prompt/completion tokens at tier rates
 *     (`prepaid-wallet-gate.ts:266-268`). The wallet is unaffected either way.
 *   - It is NOT sufficient on its own. There is a SECOND hardcoded zero on the
 *     same path — `requestLogger.logRequest({ costUsd: 0 })` at
 *     `chat-routes.ts:1778` — and that is the column the governance monthly
 *     budget cap sums (`org-governance-service.ts:288-291`). Fixing only the
 *     `trackChatUsage` zero would tighten QUOTA enforcement while leaving BUDGET
 *     enforcement still reading zero: a half-fix that makes the two disagree.
 *
 * THE FOLLOW-UP, CONCRETELY. A dedicated PR that:
 *   1. fixes BOTH zeros together (`trackChatUsage` and `requestLogger`), so
 *      quota and governance budget agree on what a streamed request cost;
 *   2. puts them behind one default-off flag (`STREAM_COST_ATTRIBUTION`), so the
 *      rollout is an env flip and the rollback is not a revert;
 *   3. ships the pre-deploy query that lists every org with a non-null
 *      `costLimitUsd` and its month-to-date streaming volume, so the blast
 *      radius is measured before the flip rather than discovered after it.
 *
 * `orchestration-gate-wallet-exclusion.test.ts` pins the unwired state, so this
 * decision fails loudly if someone wires it without the above. That pin is the
 * ONLY thing holding this decision. The orphan guard
 * (`scripts/check-orphans.mjs`) is not a backstop for it: the guard's reference
 * haystack includes test files, so `catalog-cost-estimate.test.ts` satisfies it
 * on its own and it would stay green whatever happens here. See that test's
 * block comment for the full reasoning.
 *
 * WHY IT IS A SEPARATE MODULE AT ALL
 * ----------------------------------
 * It is the only piece of billing ARITHMETIC in the chat route layer, and
 * arithmetic that feeds an invoice should be unit-testable without standing up
 * Fastify, Prisma and the provider registry. This file imports types only, so it
 * has no runtime dependencies and its tests need no fixtures.
 *
 * WHY IT LIVES IN THE ROUTE LAYER AND NOT IN A SERVICE.
 * Deliberate layering: a service reports what it DID (which model, what token
 * usage), the route decides what that is WORTH. A service hands back facts and
 * this module prices them, which keeps billing policy out of the execution path.
 */

import type { ChatResponse, Model } from '@/types';

/**
 * Price ONE provider call from catalog rates.
 *
 * CONSERVATIVE BY DESIGN — it under-reports rather than guesses, because an
 * over-report becomes a real charge wherever this number reaches a counter that
 * something enforces on (see the file header for that trace):
 *
 *   - adapter reported no `usage`  -> 0 (token counts are unknown)
 *   - non-finite catalog pricing   -> that leg contributes 0
 *   - negative token counts        -> clamped to 0, never a credit
 *
 * Same formula and the same `Number.isFinite` guard as
 * `core/coordination/collective-cost-guardrail.ts`, so the two agree on what a
 * per-1k price means. This is an ESTIMATE from catalog pricing, never a provider
 * invoice — usage events record it alongside the tokens it was derived from.
 */
function priceCatalogUsage(model: Model, usage: ChatResponse['usage'] | undefined): number {
  if (!usage) {
    return 0;
  }

  const inputPricePer1k = Number.isFinite(model.inputCostPer1k) ? model.inputCostPer1k : 0;
  const outputPricePer1k = Number.isFinite(model.outputCostPer1k) ? model.outputCostPer1k : 0;

  const promptTokens = Number.isFinite(usage.prompt_tokens) ? Math.max(0, usage.prompt_tokens) : 0;
  const completionTokens = Number.isFinite(usage.completion_tokens)
    ? Math.max(0, usage.completion_tokens)
    : 0;

  const cost =
    (promptTokens / 1000) * inputPricePer1k + (completionTokens / 1000) * outputPricePer1k;

  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/**
 * Estimated USD cost of one streamed request, priced from the model catalog.
 *
 * A streaming handler that calls `adapter.chatCompletionStream` directly has no
 * `OrchestrationResult` and no provider-reported cost. Left alone,
 * `trackChatUsage` resolves
 * `options.totalCostOverride ?? options.result?.totalCost ?? 0` to an
 * unconditional ZERO — meaning streaming traffic contributes nothing at all to
 * cost accounting. A known-false zero is worse than a labelled estimate, and the
 * estimate is available: the stream ran on a candidate the handler selected, and
 * `Model` carries `inputCostPer1k` / `outputCostPer1k`.
 *
 * This is the function the flagship streaming path at `chat-routes.ts:1806`
 * should eventually use. See the file header for why that is not done here.
 *
 * Returns 0 when the executed model cannot be matched: the fallback ladder means
 * the model that ran is not necessarily the primary candidate, so pricing some
 * other candidate's rate onto this request would be a fabricated number.
 *
 * @param candidates    the selection's candidates, i.e. every model that could
 *                      have served this request
 * @param executedModel model id/name echoed back by the stream, if any
 * @param usage         terminal-chunk usage, if the adapter sent it
 */
export function estimateStreamCostUsd(
  candidates: ReadonlyArray<{ model: Model }>,
  executedModel: string | undefined,
  usage: ChatResponse['usage'] | undefined
): number {
  if (!usage || !executedModel) {
    return 0;
  }

  const model = candidates.find(
    (candidate) => candidate.model.id === executedModel || candidate.model.name === executedModel
  )?.model;
  if (!model) {
    return 0;
  }

  return priceCatalogUsage(model, usage);
}

/**
 * Estimated USD cost of a set of provider calls the caller already knows the
 * model for — currently the input-triage fan-out.
 *
 * Unlike the stream case there is no matching problem: `performInputTriage`
 * returns the very `Model` object it called, so every call it reports is
 * priceable. Calls whose adapter returned no `usage` contribute 0.
 */
export function estimateProviderCallsCostUsd(
  calls: ReadonlyArray<{ model: Model; usage?: ChatResponse['usage'] }>
): number {
  const total = calls.reduce((sum, call) => sum + priceCatalogUsage(call.model, call.usage), 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/** Prompt/completion/total token totals across a set of provider calls. */
export function sumProviderCallTokens(
  calls: ReadonlyArray<{ usage?: ChatResponse['usage'] }>
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  let promptTokens = 0;
  let completionTokens = 0;
  for (const call of calls) {
    if (!call.usage) continue;
    if (Number.isFinite(call.usage.prompt_tokens)) {
      promptTokens += Math.max(0, call.usage.prompt_tokens);
    }
    if (Number.isFinite(call.usage.completion_tokens)) {
      completionTokens += Math.max(0, call.usage.completion_tokens);
    }
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
