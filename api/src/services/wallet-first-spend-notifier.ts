// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * wallet-first-spend-notifier — emits `wallet.first_spend` to billing exactly
 * once per organization: the ACTIVATION event for referral-campaign attributer
 * awards (Fase 2 of the campaign engine).
 *
 * Why this lives in ci: only the wallet knows when an org's first real debit
 * settles. The billing engine holds pending attributer redemptions keyed by
 * the invitee's tenant id (== ci organization id) and flips them to awarded
 * when this event arrives.
 *
 * Delivery contract: FIRE-AND-FORGET and at-least-once. This notifier is on
 * the post-settle path of every tiered request — it must never block, throw,
 * or retry-storm. Duplicate emissions are safe by design: billing's engine is
 * idempotent per redemption (UNIQUE constraint), so a replayed event awards
 * nothing twice. A LOST emission delays (not loses) the referrer's award —
 * the billing-side pending sweep re-drives redemptions that never activated.
 */

import { prisma, Prisma } from '@/database/client';
import { getBillingActorHeaders } from '@/services/billing-actor-token';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'wallet-first-spend-notifier' });

const NOTIFY_TIMEOUT_MS = 5_000;

export async function isOrgFirstSpend(organizationId: string): Promise<boolean> {
  // Count committed debit rows (kind='debit' — both plain debits and settled
  // holds write this kind). Called AFTER the debit committed, so this org's
  // first spend sees exactly 1.
  const rows = await prisma.$queryRaw<{ count: string }[]>(Prisma.sql`
    SELECT COUNT(*) AS count FROM credit_transaction
    WHERE organization_id = ${organizationId} AND kind = 'debit'
  `);
  return Number(rows[0]?.count ?? 0) === 1;
}

export async function emitFirstSpendEvent(
  organizationId: string,
  amountUsd: number
): Promise<void> {
  const billingUrl = (process.env.BILLING_SERVICE_URL ?? '').replace(/\/+$/, '');
  const billingSecret = process.env.BILLING_API_SECRET_KEY ?? '';
  if (!billingUrl || !billingSecret) {
    log.debug('first-spend emission skipped: billing not configured');
    return;
  }

  // Fase 4 service-token channel: the same M2M identity the other ci ->
  // billing callers mint (billing-actor-token). Minting NEVER throws -- on
  // any failure it returns {} and this emission proceeds on the static
  // secret alone (billing's dual mode), so the fire-and-forget contract
  // below stays intact. The X-Acting-Tenant-Id it adds is safe here:
  // billing's /v1/events reads tenant_id only from a top-level body field
  // (absent in this payload), so the token's tenant cross-check has
  // nothing to diverge from.
  const actorHeaders = await getBillingActorHeaders(organizationId);

  const response = await fetch(`${billingUrl}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Billing-Api-Secret-Key': billingSecret,
      ...actorHeaders,
    },
    body: JSON.stringify({
      event_type: 'wallet.first_spend',
      data: { tenant_id: organizationId, amount_usd: amountUsd },
    }),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });
  if (!response.ok) {
    // At-least-once, not exactly-once: a failed emission only DELAYS the
    // referrer's award until the next first spend... which never comes for
    // this org. Log at warning so a systematically broken endpoint surfaces;
    // the billing pending sweep is the backstop for lost events.
    log.warn(
      { organizationId, status: response.status },
      'wallet.first_spend emission rejected by billing (referrer award delayed until pending sweep)'
    );
  }
}

/**
 * Fire-and-forget entry point for the post-settle path: check whether this
 * was the org's first spend and, if so, tell billing. NEVER throws and is
 * NEVER awaited by the caller — the debit already succeeded.
 */
export function notifyFirstSpendIfApplicable(organizationId: string, amountUsd: number): void {
  void (async () => {
    try {
      if (!(await isOrgFirstSpend(organizationId))) return;
      await emitFirstSpendEvent(organizationId, amountUsd);
      log.info({ organizationId }, 'wallet.first_spend emitted to billing');
    } catch (error) {
      log.warn({ error, organizationId }, 'wallet.first_spend emission failed (non-fatal)');
    }
  })();
}
