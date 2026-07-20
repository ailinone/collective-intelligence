// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pricing-tier-billing.ts — the live glue between a resolved `<strategy>:<tier>`
 * request, the prepaid wallet, and the request path.
 *
 * Everything here is **feature-flagged** (`PRICING_TIERS_BILLING_ENABLED`, default
 * OFF) and **defensive**: the gate fails OPEN and the debit fails SILENT on any
 * infra error (e.g. the wallet migration not yet applied), so enabling-by-mistake
 * or a transient DB blip can never block live traffic. The operator flips the flag
 * on only after the migration is applied and balances are funded.
 *
 * Path interactions handled by the CALL SITES (see chat-routes.ts):
 *   - gate runs before execution (covers streaming + non-streaming);
 *   - debit runs INSIDE the idempotency handler, so idempotent REPLAYS don't
 *     re-bill, and the queue 202 path returns before it.
 */

import { logger } from '@/utils/logger';
import { PrepaidWallet, estimateMaxChargeUsd, type SpendGateOptions } from './prepaid-wallet';
import { PrismaBalanceStore } from './prepaid-wallet-prisma-store';
import type { TierId, TierRate } from './pricing-tiers';

let walletSingleton: PrepaidWallet | null = null;
function wallet(): PrepaidWallet {
  if (!walletSingleton) walletSingleton = new PrepaidWallet(new PrismaBalanceStore());
  return walletSingleton;
}

/** Test/override seam. */
export function __setWalletForTesting(w: PrepaidWallet | null): void {
  walletSingleton = w;
}

export function isTierBillingEnabled(): boolean {
  return process.env.PRICING_TIERS_BILLING_ENABLED === 'true';
}

export interface TierContext {
  tier: TierId;
  rate: TierRate;
}

/** Pull the tier context off a resolved alias (null unless it was a composite cell). */
export function extractTierContext(
  resolved: { tier?: TierId; tierRate?: TierRate } | null | undefined,
): TierContext | null {
  if (!resolved?.tier || !resolved.tierRate) return null;
  return { tier: resolved.tier, rate: resolved.tierRate };
}

/** Rough prompt-token estimate (chars/4) for the worst-case hold — exact tokens aren't known pre-exec. */
export function estimatePromptTokens(messages: ReadonlyArray<{ content?: unknown }> | undefined): number {
  let chars = 0;
  for (const m of messages ?? []) {
    const c = m?.content;
    if (typeof c === 'string') {
      chars += c.length;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        const t = (part as { text?: unknown } | null)?.text;
        if (typeof t === 'string') chars += t.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

export type GateOutcome =
  | { ok: true }
  | { ok: false; balanceUsd: number; requiredUsd: number };

/**
 * Worst-case spend gate. Returns `ok` (proceed) when billing is disabled, when the
 * request is not tiered, or on any infra error (FAIL-OPEN). Returns `!ok` only when
 * the wallet is reachable AND the balance genuinely can't cover the hold.
 */
export async function gateTierRequest(
  organizationId: string,
  ctx: TierContext,
  promptTokens: number,
  maxCompletionTokens: number,
  opts?: SpendGateOptions,
): Promise<GateOutcome> {
  if (!isTierBillingEnabled()) return { ok: true };
  try {
    const hold = estimateMaxChargeUsd(
      ctx.rate.inputPer1MUsd,
      ctx.rate.outputPer1MUsd,
      promptTokens,
      maxCompletionTokens,
    );
    const decision = await wallet().checkGate(organizationId, hold, opts);
    if (decision.allowed) return { ok: true };
    return { ok: false, balanceUsd: decision.balanceUsd, requiredUsd: hold };
  } catch (err) {
    logger.warn({ err, organizationId, tier: ctx.tier }, 'tier spend gate failed open');
    return { ok: true };
  }
}

/** Charge the user's actual tokens at the tier rate. No-op when disabled; fails silent on error. */
export async function debitTierRequest(
  organizationId: string,
  ctx: TierContext,
  promptTokens: number,
  completionTokens: number,
  requestId?: string,
): Promise<void> {
  if (!isTierBillingEnabled()) return;
  try {
    const charge =
      (Math.max(0, promptTokens) / 1_000_000) * ctx.rate.inputPer1MUsd +
      (Math.max(0, completionTokens) / 1_000_000) * ctx.rate.outputPer1MUsd;
    if (charge <= 0) return;
    await wallet().debit(organizationId, charge, requestId);
  } catch (err) {
    logger.warn({ err, organizationId, tier: ctx.tier, requestId }, 'tier debit failed (revenue not captured)');
  }
}
