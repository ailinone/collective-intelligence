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
 *  - Even when ON, it only fires for `<strategy>:<tier>` pricing cells (the new
 *    collective pricing aliases). Raw model ids and legacy `ailin-*` aliases that
 *    don't resolve to a tier are NEVER gated or debited.
 *  - Fail-OPEN: a wallet/store error allows the request (never block on infra).
 *
 * Pre-execution: estimate the worst-case charge (prompt + declared max output at
 * the tier rate) and reject with 402 if the balance can't cover it. Post-execution:
 * debit the ACTUAL charge metered on the user's real tokens.
 */

import { nanoid } from 'nanoid';
import { PrepaidWallet, estimateMaxChargeUsd } from '@/services/prepaid-wallet';
import { PrismaBalanceStore } from '@/services/prepaid-wallet-prisma-store';
import {
  resolveStrategyTier,
  tierBilledCostUsd,
  type ResolvedStrategyTier,
} from '@/services/pricing-tiers';
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

/**
 * Resolve a request to a tiered pricing cell, trying `model` then `ailin_alias`.
 * Returns null for raw/legacy models (which are never gated/debited).
 */
function resolveTier(req: ChatRequest): ResolvedStrategyTier | null {
  const fromModel = resolveStrategyTier(req.model);
  if (fromModel) return fromModel;
  const alias = (req as { ailin_alias?: string }).ailin_alias;
  return alias ? resolveStrategyTier(alias) : null;
}

/** Rough char/4 prompt-token estimate for the worst-case gate HOLD (debit uses real tokens). */
function estimatePromptTokens(req: ChatRequest): number {
  let chars = 0;
  const messages = (req as { messages?: Array<{ content?: unknown }> }).messages;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      const content = m?.content;
      if (typeof content === 'string') {
        chars += content.length;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          const text = (part as { text?: unknown })?.text;
          if (typeof text === 'string') chars += text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
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
 * off or the model is not a tiered cell. Otherwise atomically RESERVES the worst-case
 * hold (DI-02) so concurrent requests can't oversell, and returns a 402 payload if the
 * balance can't cover it.
 */
export async function gateChatRequest(
  organizationId: string,
  req: ChatRequest,
): Promise<WalletGateResult> {
  if (!GATE_ENABLED) return { allowed: true };
  const tier = resolveTier(req);
  if (!tier) return { allowed: true };

  const maxOut = (req as { max_tokens?: number }).max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const hold = estimateMaxChargeUsd(
    tier.inputPer1MUsd,
    tier.outputPer1MUsd,
    estimatePromptTokens(req),
    maxOut,
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
            message: `Insufficient prepaid balance for "${req.model}". Estimated hold $${hold.toFixed(4)}, available $${decision.balanceUsd.toFixed(4)}. Add credits to continue.`,
            balance_usd: decision.balanceUsd,
            required_usd: hold,
          },
        },
      };
    }
    return { allowed: true, holdId };
  } catch (error) {
    log.error({ error, organizationId, model: req.model }, 'wallet gate reserve failed — allowing (fail-open)');
    return { allowed: true };
  }
}

/**
 * Post-execution debit on the user's REAL tokens at the tier rate. No-op when the
 * gate is off or the model is not a tiered cell.
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

  const charge = tierBilledCostUsd(tier.tier, args.promptTokens, args.completionTokens);
  if (!(charge > 0)) {
    // Nothing to charge, but a reservation may still be outstanding — release it.
    if (args.holdId) {
      try {
        await getWallet().release(args.organizationId, args.holdId);
      } catch (error) {
        log.error(
          { error, organizationId: args.organizationId, requestId: args.requestId, holdId: args.holdId },
          'wallet hold release failed',
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
        charge,
        newBalance,
        requestId: args.requestId,
        holdId: args.holdId,
      },
      'wallet debited tiered request',
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
      'wallet debit failed — recording to failed-debit outbox for retry',
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
        'failed to persist failed wallet debit to outbox',
      );
    }
  }
}
