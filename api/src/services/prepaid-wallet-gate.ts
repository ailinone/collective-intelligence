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
 * EXCEPTION to the unbilled set (owner product decision 2026-10-02, settled —
 * see auto-preset-billing.ts): `ailin-auto` for a wallet-billable acting user
 * IS billed. chat-routes.ts re-sets `ailin_tier`/`ailin_tier_rate` server-side
 * (the 'base' rate card) after normalizeChatRequest deleted them, so such
 * requests DO carry the carrier and flow through gateChatRequest/debitChatRequest
 * — against the END USER's organization (billingOrganizationId threaded by the
 * route), never the shared chat key principal's. This file is unchanged: it
 * still bills exactly the requests that carry the server-set carrier.
 *
 * REMAINING OPEN ITEM (2026-10-02): the unbilled set still includes
 * `ailin-consensus` (strategy consensus, fanoutFactor 5) and
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
import { notifyFirstSpendIfApplicable } from '@/services/wallet-first-spend-notifier';
import { reportUsageToBilling } from '@/services/billing-usage-report-client';
import { holdTtlForRequest } from '@/services/strategy-hold-ttl';
import type { TierId } from '@/services/pricing-tiers';
import { logger } from '@/utils/logger';
import { noteFailOpen } from '@/utils/metrics';
import type { ChatRequest } from '@/types';

const log = logger.child({ component: 'prepaid-wallet-gate' });

const GATE_ENABLED = process.env.PREPAID_WALLET_GATE_ENABLED === 'true';
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * What a reserve INFRA failure (wallet store unreachable, etc.) does to a PAID
 * (tiered) request. Read at request time so operators can flip it without a
 * restart during an incident.
 *
 * - 'open' (default, historical production behaviour): execute without a
 *   hold — availability over revenue protection. The post-execution debit
 *   still runs, and a debit that also fails lands in the failed-debit outbox.
 *   Downside: an outage of the wallet store opens a bounded revenue window.
 * - 'closed': reject with 503 `wallet_unavailable` — a paid request never
 *   executes without a reservation. Downside: a wallet-store outage takes
 *   tiered chat down entirely until it recovers.
 *
 * Non-tiered requests are unaffected either way (the gate returns early).
 * This is the evaluated, implemented form of the "fail-closed or bounded
 * fail-open on the reserve" recommendation — flipping the default is an
 * explicit owner availability/revenue decision, not a code change.
 */
export type ReserveFailMode = 'open' | 'closed';
function reserveFailMode(): ReserveFailMode {
  return process.env.PREPAID_WALLET_GATE_RESERVE_FAIL_MODE === 'closed' ? 'closed' : 'open';
}

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

/**
 * Mirror of wallet debits into billing's Credit ledger (2026-10-08 design):
 * THIS wallet is the source of truth for spendable balance; billing's Credit
 * ledger CONVERGES to it by ingesting `wallet_debit_usd_micros` events under
 * the chat requestId (idempotency key). Without this mirror, every credit
 * bought via Stripe showed as unspent in billing forever — purchases flow
 * billing->ci but consumption never flowed back.
 *
 * MONEY vs counters: unlike the cumulative usage counters
 * (billing-usage-report-client.ts), money must be exactly-once. billing
 * dedups on TWO layers (batch key + CreditTransaction source), so a retry
 * storm here can never double-charge the ledger.
 *
 * Fire-and-forget BY CONTRACT (never extends the request path beyond the
 * local debit): `debitChatRequest` invokes it with `void`. Owns a short
 * retry ladder; if all attempts fail, the daily reconciliation task on
 * billing (tasks/reconciliation.py) surfaces the drift — the debit itself
 * already happened here and is never rolled back.
 *
 * Separate flag from BILLING_USAGE_REPORT_ENABLED: counters can lag a cycle
 * for free; money mirroring is enabled per-deployment on its own schedule.
 */
const WALLET_MIRROR_RETRY_DELAYS_MS = [0, 1_000, 5_000, 15_000, 30_000];

/**
 * Cap on mirrors in flight in THIS process. Each mirror can live ~51 s (the
 * retry ladder), so with billing slow or down an unbounded `void` per debit
 * accumulates promises and timers in proportion to request rate. Beyond the
 * cap a mirror is SHED: the wallet debit is untouched, a metric + error log
 * records it, and billing's daily reconciliation (org-balance) surfaces the
 * gap. Read per call, like the enable flag.
 */
const WALLET_MIRROR_DEFAULT_MAX_IN_FLIGHT = 500;
let walletMirrorInFlight = 0;

function walletMirrorMaxInFlight(): number {
  const parsed = Number.parseInt(process.env.BILLING_WALLET_MIRROR_MAX_IN_FLIGHT ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : WALLET_MIRROR_DEFAULT_MAX_IN_FLIGHT;
}

/** Whether wallet debits mirror into billing's Credit ledger (env flag, read per call). */
export function isWalletConsumptionMirrorEnabled(): boolean {
  return process.env.BILLING_WALLET_CONSUMPTION_REPORT_ENABLED === 'true';
}

/** Mirrors one settled wallet debit to billing. Never throws; returns whether billing confirmed. */
export async function mirrorWalletDebitToBilling(args: {
  organizationId: string;
  requestId: string;
  chargeUsd: number;
}): Promise<boolean> {
  if (!isWalletConsumptionMirrorEnabled()) return false;
  // Integer micro-USD over the wire: no float drift through JSON (billing
  // rejects fractional micros by contract).
  const amountMicros = Math.round(args.chargeUsd * 1_000_000);
  if (!(amountMicros > 0)) return false;

  if (walletMirrorInFlight >= walletMirrorMaxInFlight()) {
    log.error(
      { organizationId: args.organizationId, requestId: args.requestId, amountMicros, inFlight: walletMirrorInFlight },
      'wallet debit mirror shed (in-flight cap reached) — billing-side reconciliation will surface the drift'
    );
    noteFailOpen('wallet_debit_mirror_shed', { organizationId: args.organizationId });
    return false;
  }

  walletMirrorInFlight += 1;
  try {
    return await sendWalletDebitMirror(args, amountMicros);
  } finally {
    walletMirrorInFlight -= 1;
  }
}

/** The bounded retry ladder for one mirror (separated so the in-flight slot is released in `finally`). */
async function sendWalletDebitMirror(
  args: { organizationId: string; requestId: string },
  amountMicros: number
): Promise<boolean> {
  for (const delayMs of WALLET_MIRROR_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const delivered = await reportUsageToBilling(args.organizationId, args.requestId, [
        { resourceType: 'wallet_debit_usd_micros', amount: amountMicros },
      ]);
      if (delivered) {
        log.info(
          { organizationId: args.organizationId, requestId: args.requestId, amountMicros },
          'wallet debit mirrored to billing credit ledger'
        );
        return true;
      }
    } catch (error) {
      // reportUsageToBilling never throws by contract; this guards the
      // contract (a mirror must never break anything, least of all itself).
      log.error(
        { error, organizationId: args.organizationId, requestId: args.requestId },
        'wallet debit mirror attempt threw unexpectedly'
      );
    }
  }

  log.error(
    { organizationId: args.organizationId, requestId: args.requestId, amountMicros },
    'wallet debit mirror exhausted retries — billing-side reconciliation will surface the drift'
  );
  noteFailOpen('wallet_debit_mirror_failed', { organizationId: args.organizationId });
  return false;
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

  const walletOrg = req.ailin_wallet_org ?? organizationId;
  const maxOut = (req as { max_tokens?: number }).max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const hold = estimateMaxChargeUsd(
    tier.inputPer1MUsd,
    tier.outputPer1MUsd,
    estimatePromptTokens(req),
    maxOut
  );

  const holdId = `hold_${nanoid()}`;
  // ENT-002 Phase 1 (D4): size the hold's TTL for the request's worst-case
  // generation horizon — composite `<family>:<tier>` targets get their
  // family's horizon (strategy-hold-ttl.ts), everything else keeps the
  // store's DEFAULT_HOLD_TTL_MS. An expiry mid-generation frees reserved
  // spend while the execution still runs; the per-family floor removes that
  // window for the shipped strategies. The `strategy-hold-ttl` import is
  // dependency-light (pricing-tiers + prepaid-wallet consts only).
  const ttlMs = holdTtlForRequest(req);
  try {
    // Persist a reservation (not a bare read): the check-and-reserve is atomic in the
    // store, so two concurrent gates can never both take the last dollar.
    const decision = await getWallet().reserve(
      walletOrg,
      holdId,
      hold,
      ttlMs !== undefined ? { ttlMs } : undefined
    );
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
    const failMode = reserveFailMode();
    log.error(
      { error, organizationId, model: req.model, alias: req.ailin_alias, tier: tier.tier, failMode },
      failMode === 'closed'
        ? 'wallet gate reserve failed — rejecting 503 (fail-closed: a paid request never executes without a reservation)'
        : 'wallet gate reserve failed — allowing (fail-open)'
    );
    noteFailOpen('prepaid_wallet_reserve', { organizationId });
    if (failMode === 'closed') {
      return {
        allowed: false,
        status: 503,
        body: {
          error: {
            code: 'wallet_unavailable',
            message: 'Prepaid wallet is temporarily unavailable. Please retry shortly.',
          },
        },
      };
    }
    return { allowed: true };
  }
}

/**
 * Release (NOT settle) the pre-execution hold when the execution will never
 * complete — the client-disconnect abort path (ci#751, 2026-10-04 product
 * decision): without a completed execution there is no usage to bill, so the
 * user is not debited and the reserved worst-case hold must be returned to the
 * balance immediately instead of staying reserved until holdTtlForRequest's
 * TTL. Provider calls already in flight when the disconnect fired are absorbed
 * by the platform. No-op when the gate is off, the request was never gated
 * (no holdId), or the release fails — a failed release still self-expires at
 * the hold TTL, exactly like the pre-fix status quo.
 */
export async function releaseChatHold(args: {
  organizationId: string;
  request: ChatRequest;
  requestId: string;
  holdId?: string;
}): Promise<void> {
  if (!GATE_ENABLED || !args.holdId) return;
  const walletOrg = args.request.ailin_wallet_org ?? args.organizationId;
  try {
    await getWallet().release(walletOrg, args.holdId);
    log.info(
      {
        organizationId: walletOrg,
        requestId: args.requestId,
        holdId: args.holdId,
      },
      'wallet hold released — execution aborted before completion (client disconnect)'
    );
  } catch (error) {
    log.error(
      {
        error,
        organizationId: walletOrg,
        requestId: args.requestId,
        holdId: args.holdId,
      },
      'wallet hold release failed after abort — hold self-expires at TTL'
    );
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

  // credits-continue override: the server-set `ailin_wallet_org` (the ACTING
  // user's org) wins over the authenticated API key's org — see the ChatRequest
  // field doc. Never set from client input.
  const walletOrg = args.request.ailin_wallet_org ?? args.organizationId;

  // Bill at the rate the resolver QUOTED on this request, not at whatever the static
  // card says now — the two diverge the day a calibrated card is injected upstream.
  const charge =
    (Math.max(0, args.promptTokens) / 1_000_000) * tier.inputPer1MUsd +
    (Math.max(0, args.completionTokens) / 1_000_000) * tier.outputPer1MUsd;
  if (!(charge > 0)) {
    // Nothing to charge, but a reservation may still be outstanding — release it.
    if (args.holdId) {
      try {
        await getWallet().release(walletOrg, args.holdId);
      } catch (error) {
        log.error(
          {
            error,
            organizationId: walletOrg,
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
      ? await getWallet().settle(walletOrg, args.holdId, charge, args.requestId)
      : await getWallet().debit(walletOrg, charge, args.requestId, args.requestId);
    log.info(
      {
        organizationId: walletOrg,
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
    // Referral-campaign activation (Fase 2): tell billing when this was the
    // org's FIRST real spend — the trigger that awards activation-gated
    // attributer bonuses. Fire-and-forget; never throws, never blocks.
    notifyFirstSpendIfApplicable(walletOrg, charge);
    // Mirror the debit into billing's Credit ledger (accounting/reports);
    // fire-and-forget with its own retry ladder — never blocks this path.
    void mirrorWalletDebitToBilling({
      organizationId: walletOrg,
      requestId: args.requestId,
      chargeUsd: charge,
    });
  } catch (error) {
    // DI-08: surface + enqueue for retry, never a silent swallow.
    log.error(
      {
        error,
        organizationId: walletOrg,
        requestId: args.requestId,
        holdId: args.holdId,
        charge,
      },
      'wallet debit failed — recording to failed-debit outbox for retry'
    );
    try {
      await getWallet().recordFailedDebit({
        organizationId: walletOrg,
        amountUsd: charge,
        requestId: args.requestId,
        idempotencyKey: args.holdId ?? args.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (recordError) {
      log.error(
        { error: recordError, organizationId: walletOrg, requestId: args.requestId },
        'failed to persist failed wallet debit to outbox'
      );
    }
  }
}
