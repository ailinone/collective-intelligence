// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * prepaid-wallet-gate.ts — the single integration point that wires the prepaid
 * wallet (balance gate + debit) into the chat request path.
 *
 * SAFE BY DEFAULT:
 *  - Disabled unless `PREPAID_WALLET_GATE_ENABLED=true`. When off, every function
 *    is a no-op (allowed / no debit), so existing traffic is untouched.
 *  - Even when ON, it only fires for requests carrying a SERVER-SET `ailin_tier` +
 *    `ailin_tier_rate` (see `resolveTier` for why that carrier is the only safe key).
 *  - Fail-OPEN: a wallet/store error allows the request (never block on infra).
 *
 * WHICH MODEL STRINGS CARRY THAT TIER (verified against the real resolver, not
 * inferred — `resolveAilinVirtualModelAlias` + `parseStrategyTier`):
 *   BILLED — `<strategy>:<tier>` composites (`consensus:extra`), bare execution-ready
 *     strategy names (`best`→medium, `consensus`→medium, `expert-panel`→large,
 *     `fast`/`economy`/`single`/`parallel`→base), AND — because `parseStrategyTier`
 *     strips a leading `ailin-` (pricing-tiers.ts) — any `ailin-<strategy>[:<tier>]`
 *     that is NOT a configured virtual-model profile: `ailin-parallel`→`parallel:base`,
 *     `ailin-single`→`single:base`, `ailin-expert-panel`→`expert-panel:large` ($4/$20),
 *     `ailin-best:large`, `ailin-consensus:extra`, …
 *   NOT BILLED — names that ARE a configured profile (the DEFAULT_PROFILES
 *     `ailin-auto|best|fast|economy|consensus|voice|stt|realtime`, plus anything added
 *     via AILIN_AUTO_MODEL_ALIASES / AILIN_VIRTUAL_MODEL_PROFILES), a literal
 *     `model: 'auto'`, raw provider ids, and shadow-wired cells (`war-room:large`).
 * The profile lookup runs FIRST, so adding an id to those env vars silently moves it
 * from the billed set to the unbilled one. Treat that env as a pricing control.
 *
 * OPEN PRODUCT DECISION (do not enable the flag before it is settled): the unbilled
 * set above includes `ailin-consensus` (strategy consensus, fanoutFactor 5) and
 * `ailin-best` (quality-multipass, fanoutFactor 6) — the two heaviest fan-out
 * mechanisms — while the byte-identical `consensus:medium` / `best:medium` are
 * charged. There is currently NO compensating charge for them: none of the
 * DEFAULT_PROFILES declares a `billing` profile and `AILIN_VIRTUAL_MODEL_PROFILES` is
 * empty in production, so `applyBillingProfile` (billing-usage-tracker.ts) returns the
 * provider cost unchanged — and even when it does apply it only feeds usage analytics
 * and quota counters, never the prepaid wallet.
 *
 * COVERAGE (also unsettled): the only route wired to this module is
 * /v1/chat/completions (gate at chat-routes.ts, debit via `trackChatUsage`).
 * /v1/responses, /v1/chat/completions/extended-thinking and /ultra-thinking route the
 * same composite strategies but are neither gated nor debited — their `trackChatUsage`
 * call sites pass a synthetic `{ model, messages: [] }` with no per-model token
 * breakdown, so `debitChatRequest` always sees 0/0 tokens and charges nothing. That is
 * true before and after this module's rewrite; closing it is a separate change.
 *
 * OPERATORS: `PREPAID_WALLET_GATE_ENABLED` and `PRICING_TIERS_BILLING_ENABLED`
 * (pricing-tier-billing.ts) are two independent gate+debit implementations over the
 * SAME wallet firing on the same request set — enabling both double-charges every
 * tiered request. This is not left to a comment: `validateConfig()` (config/index.ts)
 * REFUSES TO BOOT when both are 'true'.
 *
 * Pre-execution: estimate the worst-case charge (prompt + declared max output at
 * the tier rate) and reject with 402 if the balance can't cover it. Post-execution:
 * debit the ACTUAL charge metered on the user's real tokens.
 */

import { nanoid } from 'nanoid';
import { PrepaidWallet, estimateMaxChargeUsd } from '@/services/prepaid-wallet';
import { PrismaBalanceStore } from '@/services/prepaid-wallet-prisma-store';
import type { TierId } from '@/services/pricing-tiers';
import { logger } from '@/utils/logger';
import type { ChatRequest } from '@/types';

const log = logger.child({ component: 'prepaid-wallet-gate' });

const GATE_ENABLED = process.env.PREPAID_WALLET_GATE_ENABLED === 'true';
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

let walletSingleton: PrepaidWallet | null = null;
function getWallet(): PrepaidWallet {
  if (!walletSingleton) {
    walletSingleton = new PrepaidWallet(new PrismaBalanceStore());
  }
  return walletSingleton;
}

/** Whether the prepaid-balance gate/debit is active (env flag, read at boot). */
export function isWalletGateEnabled(): boolean {
  return GATE_ENABLED;
}

/** The PrepaidWallet singleton — used by the internal wallet endpoints (balance/top-up). */
export function walletInstance(): PrepaidWallet {
  return getWallet();
}

/** The billable pricing cell for a request: which tier, at which quoted rate. */
interface BillableCell {
  tier: TierId;
  inputPer1MUsd: number;
  outputPer1MUsd: number;
}

/**
 * The billable cell for a request, or null when the request is not a tiered product.
 *
 * The ONLY billable shape is a `<strategy>:<tier>` composite. `normalizeChatRequest`
 * sets `ailin_tier` + `ailin_tier_rate` server-side for exactly those cells and
 * DELETES them on every other path (chat-routes.ts:522-528), so this carrier is both
 * precise and impossible for a client to inject. It is the same discriminator
 * `extractTierContext` (pricing-tier-billing.ts) already uses.
 *
 * We deliberately do NOT look at `model` or `ailin_alias`:
 *  - post-normalization `model` is the literal sentinel 'auto' for EVERY resolved
 *    alias (chat-routes.ts:492), and 'auto' is itself a key in STRATEGY_POLICY, so
 *    probing `model` bills all default platform traffic at the 'auto' cell — and
 *    bills shadow-wired cells (`war-room:large`) the platform refuses to sell,
 *    since `resolveStrategyTier` does not filter on `executionReady`;
 *  - `ailin_alias` survives untouched from the client body when no alias resolved
 *    (it is set at chat-routes.ts:547 but never deleted), so probing it would hand
 *    the client control of its own billing key.
 *
 * Configured virtual-model profiles (`ailin-auto`, `ailin-best`, …), raw provider ids,
 * a literal user `model: 'auto'` and shadow-wired cells therefore all return null here
 * — never gated, never debited, and (see the module header) not charged anywhere else
 * either. `ailin-<strategy>` names that are NOT profiles DO carry a tier and ARE billed.
 */
function resolveTier(req: ChatRequest): BillableCell | null {
  const tier = req.ailin_tier;
  const rate = req.ailin_tier_rate;
  if (!tier || !rate) return null;
  // Defence in depth for any future non-chat caller that hand-builds a request:
  // a NaN/negative rate must never produce a bogus (or negative) charge.
  if (!Number.isFinite(rate.inputPer1MUsd) || rate.inputPer1MUsd < 0) return null;
  if (!Number.isFinite(rate.outputPer1MUsd) || rate.outputPer1MUsd < 0) return null;
  return { tier, inputPer1MUsd: rate.inputPer1MUsd, outputPer1MUsd: rate.outputPer1MUsd };
}

/**
 * Worst-case token allowance for a NON-TEXT content part (image / audio / file).
 *
 * Only `part.text` used to be summed, so an image-heavy prompt estimated ~0 prompt
 * tokens and held little more than `max_tokens`. The debit then meters the provider's
 * REAL prompt tokens, and `PrepaidWallet.debit` does not floor at zero — so a wallet
 * near $0 could pass the 402 check and land an arbitrarily negative balance.
 *
 * These are deliberate over-estimates (~an OpenAI high-detail tile budget). The hold
 * is a reservation and `settle` releases the unused remainder, so over-holding costs
 * an honest caller nothing, while under-holding is an uncollectable debt.
 */
const NON_TEXT_PART_TOKENS = 1_200;
const LOW_DETAIL_IMAGE_TOKENS = 100;

/** Rough prompt-token estimate for the worst-case gate HOLD (debit uses real tokens). */
function estimatePromptTokens(req: ChatRequest): number {
  let chars = 0;
  let nonTextTokens = 0;
  const messages = (req as { messages?: Array<{ content?: unknown }> }).messages;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      const content = m?.content;
      if (typeof content === 'string') {
        chars += content.length;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          const text = (part as { text?: unknown } | null)?.text;
          if (typeof text === 'string') {
            chars += text.length;
            continue;
          }
          if (!part || typeof part !== 'object') continue;
          // Any part that is not text (image_url, input_audio, file, …) bills real
          // prompt tokens at the provider but contributes 0 characters here.
          const detail = (part as { image_url?: { detail?: unknown } }).image_url?.detail;
          nonTextTokens += detail === 'low' ? LOW_DETAIL_IMAGE_TOKENS : NON_TEXT_PART_TOKENS;
        }
      }
    }
  }
  return Math.ceil(chars / 4) + nonTextTokens;
}

export interface WalletGateResult {
  allowed: boolean;
  status?: number;
  body?: unknown;
  /**
   * Id of the PERSISTED hold reserved at the gate (present only when allowed and gated).
   * Thread it to `debitChatRequest` to settle the exact reservation; if it never
   * reaches the debit, the hold self-expires (DEFAULT_HOLD_TTL_MS) as a safety net.
   */
  holdId?: string;
}

/**
 * Pre-execution balance gate. Returns { allowed: true } (no-op) when the gate is
 * off or the request carries no tier cell. Otherwise atomically RESERVES the worst-case
 * hold (DI-02) so concurrent requests can't oversell, and returns a 402 payload if the
 * balance can't cover it.
 */
export async function gateChatRequest(
  organizationId: string,
  req: ChatRequest
): Promise<WalletGateResult> {
  if (!GATE_ENABLED) return { allowed: true };
  const tier = resolveTier(req);
  if (!tier) return { allowed: true };

  const maxOut = (req as { max_tokens?: number }).max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const hold = estimateMaxChargeUsd(
    tier.inputPer1MUsd,
    tier.outputPer1MUsd,
    estimatePromptTokens(req),
    maxOut
  );

  const holdId = `hold_${nanoid()}`;
  try {
    // Persist a reservation (not a bare read): the check-and-reserve is atomic in the
    // store, so two concurrent gates can never both take the last dollar.
    const decision = await getWallet().reserve(organizationId, holdId, hold);
    if (!decision.allowed) {
      return {
        allowed: false,
        status: 402,
        body: {
          error: {
            code: 'insufficient_funds',
            // Name the product the caller actually asked for. `req.model` is the
            // post-normalization 'auto' sentinel and would read as `for "auto"`.
            message: `Insufficient prepaid balance for "${req.ailin_alias ?? tier.tier}". Estimated hold $${hold.toFixed(4)}, available $${decision.balanceUsd.toFixed(4)}. Add credits to continue.`,
            balance_usd: decision.balanceUsd,
            required_usd: hold,
          },
        },
      };
    }
    return { allowed: true, holdId };
  } catch (error) {
    log.error(
      { error, organizationId, model: req.model, alias: req.ailin_alias, tier: tier.tier },
      'wallet gate reserve failed — allowing (fail-open)'
    );
    return { allowed: true };
  }
}

/**
 * Post-execution debit on the user's REAL tokens at the rate quoted on the request.
 * No-op when the gate is off or the request carries no tier cell.
 *
 * Idempotent (DI-01): keyed by the hold id (when the gate's `holdId` is threaded in)
 * or the request id, so a retried debit charges exactly once. When a `holdId` is
 * supplied the matching reservation is SETTLED (actual charge applied, remainder
 * released); otherwise an idempotent debit is applied and the hold self-expires.
 *
 * On failure the error is NOT swallowed (DI-08): it is logged structured AND recorded
 * in the durable failed-debit outbox for retry/observability. It never throws, so it
 * stays safe inside the usage-tracking `Promise.all`.
 */
export async function debitChatRequest(args: {
  organizationId: string;
  request: ChatRequest;
  promptTokens: number;
  completionTokens: number;
  requestId: string;
  /** The hold reserved at the gate; when present the debit settles that exact reservation. */
  holdId?: string;
}): Promise<void> {
  if (!GATE_ENABLED) return;
  const tier = resolveTier(args.request);
  if (!tier) return;

  // Bill at the rate the resolver QUOTED on this request, not at whatever the static
  // card says now — the two diverge the day a calibrated card is injected upstream.
  const charge =
    (Math.max(0, args.promptTokens) / 1_000_000) * tier.inputPer1MUsd +
    (Math.max(0, args.completionTokens) / 1_000_000) * tier.outputPer1MUsd;
  if (!(charge > 0)) {
    // Nothing to charge, but a reservation may still be outstanding — release it.
    if (args.holdId) {
      try {
        await getWallet().release(args.organizationId, args.holdId);
      } catch (error) {
        log.error(
          {
            error,
            organizationId: args.organizationId,
            requestId: args.requestId,
            holdId: args.holdId,
          },
          'wallet hold release failed'
        );
      }
    }
    return;
  }

  try {
    const newBalance = args.holdId
      ? await getWallet().settle(args.organizationId, args.holdId, charge, args.requestId)
      : await getWallet().debit(args.organizationId, charge, args.requestId, args.requestId);
    log.info(
      {
        organizationId: args.organizationId,
        model: args.request.model,
        alias: args.request.ailin_alias,
        tier: tier.tier,
        charge,
        newBalance,
        requestId: args.requestId,
        holdId: args.holdId,
      },
      'wallet debited tiered request'
    );
  } catch (error) {
    // DI-08: surface + enqueue for retry, never a silent swallow.
    log.error(
      {
        error,
        organizationId: args.organizationId,
        requestId: args.requestId,
        holdId: args.holdId,
        charge,
      },
      'wallet debit failed — recording to failed-debit outbox for retry'
    );
    try {
      await getWallet().recordFailedDebit({
        organizationId: args.organizationId,
        amountUsd: charge,
        requestId: args.requestId,
        idempotencyKey: args.holdId ?? args.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (recordError) {
      log.error(
        { error: recordError, organizationId: args.organizationId, requestId: args.requestId },
        'failed to persist failed wallet debit to outbox'
      );
    }
  }
}
