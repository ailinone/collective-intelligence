// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * auto-preset-billing.ts — per-user billing for the `ailin-auto` preset.
 *
 * OWNER PRODUCT DECISION (2026-10-02): Ailin¹ Auto is NOT a free product.
 * The 5/day free allowance (free-tier-quota-gate.ts) exists ONLY for
 * (a) anonymous users (anonymous-quota-gate.ts) and (b) registered users
 * with NEITHER wallet balance NOR an active subscription. A registered user
 * with balance or subscription who sends `ailin-auto` through chat's
 * dedicated free-tier key consumes saldo/créditos like any paid preset:
 *
 *  - ACTIVE SUBSCRIPTION FIRST (owner decision 2026-10-03): a subscriber
 *    consumes their plan — the plan's api_requests_daily ceiling
 *    (plan-quota-gate.ts) governs volume — NEVER their wallet, even when the
 *    wallet also holds balance. A 402 hold would lock a paying subscriber
 *    out of the default preset.
 *  - no subscription + wallet balance available > 0 → the request is billed
 *    at the published `auto:base` cell (CREDITS_CONTINUE_MODEL_CELL,
 *    free-tier-quota-gate.ts — ONE published price for ailin-auto, shared
 *    with the credits-continue consent path) via the SAME server-set
 *    `ailin_tier` + `ailin_tier_rate` carrier normalizeChatRequest sets for
 *    `<strategy>:<tier>` cells (the only discriminator
 *    prepaid-wallet-gate.ts's resolveTier accepts, and impossible for a
 *    client to inject). The existing gates engage unchanged:
 *    gateChatRequest's pre-execution 402 hold and debitChatRequest's
 *    post-execution debit on REAL tokens.
 *  - neither (or billing identity unresolvable) → the existing free 5/day
 *    counter applies, byte-for-byte unchanged.
 *
 * BILLING IDENTITY, NOT AUTHORIZATION: the wallet gates/debits and the plan
 * quota run against the END USER's organization (their `users.organizationId`
 * row in ci, reached via the actor-verified X-Acting-User identity that
 * attachForwardedActorIdentity swaps onto request.userId). Quota counters,
 * governance, per-org feature flags and analytics keep the API-key principal
 * organizationId — this module deliberately does not touch attribution.
 *
 * RESOLVE, THEN PROVISION (NEVER BILL BLIND): a first-seen chat user may
 * have no ci DB row yet. When chat's build_ci_actor_headers forwards
 * email/tenant hints (attached only inside the actor-token-verified branch
 * of attachForwardedActorIdentity), resolveOrProvisionChatActingUser
 * OrganizationId just-in-time provisions the row via the EXACT
 * ensureProvisionedOnBehalf path the internal on-behalf surface uses (same
 * invariants `User.id == id-sub` / `organizationId == id-tenant_id`, same
 * autoProvisionUsers flag). Without hints — or provisioning failure — the
 * disposition is `free` (with a log line), never a charge against the shared
 * key principal org — that would spend the platform's own wallet. The same
 * `free` fallback covers any wallet/entitlements probe error: fail to FREE,
 * never bill someone whose balance could not be read.
 *
 * IDENTITY-SWAP GUARD: when the forwarded actor token is missing/invalid,
 * request.userId stays the key principal's service-account id and a DB
 * lookup would resolve to the principal org itself. A resolution that lands
 * on `principalOrganizationId` is therefore treated as "no per-user
 * identity" → free, rather than evaluating the PLATFORM org's wallet.
 *
 * Flag: AILIN_AUTO_PER_USER_BILLING_ENABLED (default off, safe-by-default
 * like every other billing flag; docker-compose.production.yml sets it true).
 * Flag-off leaves the free 5/day path as the ONLY behavior for the
 * free-tier key, exactly as before this module existed.
 */

import { prisma } from '@/database/client';
import { getTenantEntitlements } from '@/services/billing-entitlements-client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'auto-preset-billing' });

export function isPerUserAutoBillingEnabled(): boolean {
  return process.env.AILIN_AUTO_PER_USER_BILLING_ENABLED === 'true';
}

export type AutoBillingDisposition =
  | { kind: 'billable_wallet'; organizationId: string }
  | { kind: 'billable_plan'; organizationId: string }
  | {
      kind: 'free';
      reason: FreeReason;
      /**
       * The end user's resolved organization, when the identity resolution
       * got that far (probe failure / no-balance-no-subscription). NOT set
       * when the identity itself was the problem (no ci row, swap guard) —
       * there is nothing addressable to bill. Lets callers route the
       * credits-continue consent path (#717) at the user's OWN wallet
       * instead of the shared key principal's.
       */
      organizationId?: string;
    };

export type FreeReason =
  | 'per_user_identity_absent'
  | 'acting_user_not_in_ci'
  | 'identity_not_swapped'
  | 'billing_probe_failed'
  | 'no_balance_no_subscription';

export interface AutoBillingDispositionInput {
  userId: string;
  principalOrganizationId: string;
  /** Injectable for tests; defaults to the ci Prisma user table (resolve-only). */
  lookupUserOrganizationId?: (userId: string) => Promise<string | null>;
  /** Injectable for tests; defaults to the PrepaidWallet singleton. */
  getAvailableUsd?: (organizationId: string) => Promise<number>;
  /** Injectable for tests; defaults to getTenantEntitlements (never throws). */
  getEntitlements?: typeof getTenantEntitlements;
}

/**
 * Decide how an in-free-tier-scope `ailin-auto` request pays. Never throws —
 * every failure mode resolves to `{ kind: 'free' }` (see module header).
 */
export async function resolveAutoBillingDisposition(
  input: AutoBillingDispositionInput
): Promise<AutoBillingDisposition> {
  const lookup = input.lookupUserOrganizationId ?? lookupActingUserOrganizationId;
  const getBalance = input.getAvailableUsd ?? defaultGetAvailableUsd;
  const getEntitlements = input.getEntitlements ?? getTenantEntitlements;

  let organizationId: string | null;
  try {
    organizationId = await lookup(input.userId);
  } catch (error) {
    log.error(
      { error, userId: input.userId },
      'ailin-auto per-user billing: acting-user lookup failed — falling back to the free daily quota (never bill blind, never throw)'
    );
    return { kind: 'free', reason: 'billing_probe_failed' };
  }
  if (!organizationId) {
    log.info(
      { userId: input.userId },
      'ailin-auto per-user billing: acting user has no ci user row and no usable provisioning hints — falling back to the free daily quota'
    );
    return { kind: 'free', reason: 'acting_user_not_in_ci' };
  }
  // Identity-swap guard (module header): a resolution equal to the key
  // principal org means request.userId was never swapped to a real end user.
  if (organizationId === input.principalOrganizationId) {
    return { kind: 'free', reason: 'identity_not_swapped' };
  }

  // OWNER DECISION (2026-10-03): subscription ALWAYS has priority over the
  // wallet — an active subscriber consumes their plan even when their wallet
  // also has balance. getTenantEntitlements is fail-open by contract (null on
  // any failure) and Redis-cached; a transient billing outage degrades a
  // no-balance subscriber to the free quota rather than blocking them (a
  // subscriber WITH balance whose entitlements lookup fails falls through to
  // a legitimate wallet debit on money they own — never a lockout).
  const entitlements = await getEntitlements(organizationId);
  if (entitlements?.source === 'subscription') {
    return { kind: 'billable_plan', organizationId };
  }

  let balanceUsd: number;
  try {
    balanceUsd = await getBalance(organizationId);
  } catch (error) {
    log.error(
      { error, organizationId, userId: input.userId },
      'ailin-auto per-user billing: wallet balance probe failed — falling back to the free daily quota (never bill on an unreadable balance)'
    );
    return { kind: 'free', reason: 'billing_probe_failed', organizationId };
  }
  if (balanceUsd > 0) {
    return { kind: 'billable_wallet', organizationId };
  }
  return { kind: 'free', reason: 'no_balance_no_subscription', organizationId };
}

/**
 * Resolve-only: the acting user's own organization (their ci `users` row),
 * or null when the user has no row here yet. Resolve-only by design — never
 * provisions, never fabricates an org (see module header). Non-ACTIVE users
 * resolve to null (same policy #721 applies to credits-continue): a
 * suspended/deactivated user's wallet is never charged.
 */
export async function lookupActingUserOrganizationId(userId: string): Promise<string | null> {
  const row = await prisma.user.findFirst({
    where: { id: userId, status: 'active' },
    select: { organizationId: true },
  });
  return row?.organizationId ?? null;
}

/**
 * Hints chat's backend asserts for the acting user (see auth-middleware's
 * attachForwardedActorIdentity — populated ONLY inside the actor-token
 * verified branch, so a client that cannot mint chat's M2M token can never
 * forge them).
 */
export interface ChatActingUserHints {
  email?: string;
  tenant?: string;
}

/**
 * Lookup-first, then JIT-provision exactly once for a first-seen chat user.
 *
 * WHY: the chat path (unlike /v1/internal/*) historically never ran
 * principal synchronization, so an invited user whose first-ever product
 * touch is the chat UI had NO ci `users` row — `User.id == id-sub` broke,
 * credits-continue consent fail-closed (free_quota_exceeded with no way to
 * pay), and wallet billing could never engage. Chat now forwards
 * email/tenant hints alongside X-Acting-User; when BOTH are present and
 * federation auto-provisioning is enabled, provision via the same
 * ensureProvisionedOnBehalf the internal surface uses (identical invariants
 * and role policy — no client-asserted roles, baseline only).
 *
 * Fail-closed like every resolver here: provisioning errors, missing hints,
 * or a disabled flag all return null — the caller treats the user as
 * unprovisioned (free tier / consent reject), NEVER bills the principal.
 */
export async function resolveOrProvisionChatActingUserOrganizationId(
  userId: string,
  hints: ChatActingUserHints
): Promise<string | null> {
  const existing = await lookupActingUserOrganizationId(userId);
  if (existing) return existing;

  if (!hints.email || !hints.tenant) return null;

  const { config } = await import('@/config');
  if (!config.security.federation.autoProvisionUsers) return null;

  try {
    const { getAuthService } = await import('@/services/auth-service');
    await getAuthService().ensureProvisionedOnBehalf({
      userId,
      organizationId: hints.tenant,
      email: hints.email,
    });
    log.info(
      { userId, organizationId: hints.tenant },
      'provisioned chat acting user on first touch (ensureProvisionedOnBehalf)'
    );
  } catch (error) {
    log.warn(
      { error, userId, organizationId: hints.tenant },
      'chat acting-user JIT provisioning failed — treating as unprovisioned (resolve-only)'
    );
    return null;
  }

  return lookupActingUserOrganizationId(userId);
}

async function defaultGetAvailableUsd(organizationId: string): Promise<number> {
  const { walletInstance } = await import('@/services/prepaid-wallet-gate');
  return walletInstance().getAvailableUsd(organizationId);
}
