// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for auto-preset-billing.ts — the per-user ailin-auto
 * billing disposition (owner product decision 2026-10-02). All I/O is
 * injected (user lookup, wallet balance, entitlements), so no Prisma, Redis
 * or billing service is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const walletGetAvailableUsd = vi.fn();
const lookupUserOrganizationId = vi.fn();
const getEntitlements = vi.fn();

vi.mock('@/database/client', () => ({
  prisma: { user: { findFirst: vi.fn() } },
}));

vi.mock('@/services/billing-entitlements-client', () => ({
  getTenantEntitlements: (...args: unknown[]) => getEntitlements(...(args as [])),
}));

vi.mock('@/cache/redis-client', () => ({
  getGlobalRedisClient: () => ({}),
}));

import {
  isPerUserAutoBillingEnabled,
  resolveAutoBillingDisposition,
} from '@/services/auto-preset-billing';
import { CREDITS_CONTINUE_MODEL_CELL } from '@/services/free-tier-quota-gate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const USER_ORG = 'org_end_user';
const PRINCIPAL_ORG = 'org_chat_principal';

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveAutoBillingDisposition({
    userId: USER_ID,
    principalOrganizationId: PRINCIPAL_ORG,
    lookupUserOrganizationId: lookupUserOrganizationId as never,
    getAvailableUsd: walletGetAvailableUsd as never,
    getEntitlements: getEntitlements as never,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AILIN_AUTO_PER_USER_BILLING_ENABLED;
  lookupUserOrganizationId.mockResolvedValue(USER_ORG);
  walletGetAvailableUsd.mockResolvedValue(0);
  getEntitlements.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.AILIN_AUTO_PER_USER_BILLING_ENABLED;
});

describe('flag', () => {
  it('is off by default and on only with the explicit env value', () => {
    expect(isPerUserAutoBillingEnabled()).toBe(false);
    process.env.AILIN_AUTO_PER_USER_BILLING_ENABLED = 'true';
    expect(isPerUserAutoBillingEnabled()).toBe(true);
    process.env.AILIN_AUTO_PER_USER_BILLING_ENABLED = '1';
    expect(isPerUserAutoBillingEnabled()).toBe(false);
  });
});

describe('rate card', () => {
  it('the published price is single-sourced from free-tier-quota-gate', () => {
    // auto-preset-billing deliberately does NOT define its own rate cell:
    // the wallet-billable carrier uses the SAME published `auto:base` cell
    // as the credits-continue consent path (one price for ailin-auto).
    expect(CREDITS_CONTINUE_MODEL_CELL).toBe('auto:base');
  });
});

describe('resolveAutoBillingDisposition', () => {
  it('wallet-billable: available balance > 0 → billable_wallet at the user org', async () => {
    walletGetAvailableUsd.mockResolvedValue(0.05);
    await expect(resolve()).resolves.toEqual({
      kind: 'billable_wallet',
      organizationId: USER_ORG,
    });
    // The subscription probe runs FIRST (plan priority) and returned no
    // real subscription — only then is the wallet balance decisive.
    expect(getEntitlements).toHaveBeenCalledWith(USER_ORG);
  });

  it('OWNER DECISION 2026-10-03: active subscription has priority over wallet balance', async () => {
    walletGetAvailableUsd.mockResolvedValue(5);
    getEntitlements.mockResolvedValue({
      tenantId: USER_ORG,
      planId: 'plan_pro',
      source: 'subscription',
      limits: { api_requests_daily: 200 },
    });
    await expect(resolve()).resolves.toEqual({
      kind: 'billable_plan',
      organizationId: USER_ORG,
    });
    // The wallet is never even probed — a subscriber is never wallet-charged.
    expect(walletGetAvailableUsd).not.toHaveBeenCalled();
  });

  it('zero balance + active subscription → billable_plan (no wallet hold lockout)', async () => {
    getEntitlements.mockResolvedValue({
      tenantId: USER_ORG,
      planId: 'plan_pro',
      source: 'subscription',
      limits: { api_requests_daily: 200 },
    });
    await expect(resolve()).resolves.toEqual({
      kind: 'billable_plan',
      organizationId: USER_ORG,
    });
  });

  it('zero balance + fallback_sandbox entitlements → free (no real subscription)', async () => {
    getEntitlements.mockResolvedValue({
      tenantId: USER_ORG,
      planId: 'sandbox',
      source: 'fallback_sandbox',
      limits: {},
    });
    const d = await resolve();
    expect(d).toEqual({
      kind: 'free',
      reason: 'no_balance_no_subscription',
      organizationId: USER_ORG,
    });
  });

  it('zero balance + no entitlements → free', async () => {
    await expect(resolve()).resolves.toEqual({
      kind: 'free',
      reason: 'no_balance_no_subscription',
      organizationId: USER_ORG,
    });
  });

  it('acting user without a ci user row → free (never bill blind, never bill the principal)', async () => {
    lookupUserOrganizationId.mockResolvedValue(null);
    const d = await resolve();
    expect(d).toEqual({ kind: 'free', reason: 'acting_user_not_in_ci' });
    expect(walletGetAvailableUsd).not.toHaveBeenCalled();
  });

  it('identity-swap guard: resolution equal to the key principal org → free', async () => {
    lookupUserOrganizationId.mockResolvedValue(PRINCIPAL_ORG);
    const d = await resolve();
    expect(d).toEqual({ kind: 'free', reason: 'identity_not_swapped' });
    expect(walletGetAvailableUsd).not.toHaveBeenCalled();
  });

  it('wallet probe failure → free (fail to FREE, never bill on an unreadable balance)', async () => {
    walletGetAvailableUsd.mockRejectedValue(new Error('db down'));
    const d = await resolve();
    // The resolved org is still carried on the free disposition so the
    // credits-continue consent path can target the user's OWN wallet.
    expect(d).toEqual({
      kind: 'free',
      reason: 'billing_probe_failed',
      organizationId: USER_ORG,
    });
  });

  it('user lookup failure → free, never throws (never-throw contract)', async () => {
    lookupUserOrganizationId.mockRejectedValue(new Error('prisma connection lost'));
    await expect(resolve()).resolves.toEqual({
      kind: 'free',
      reason: 'billing_probe_failed',
    });
  });

  it('negative available balance (held funds) is not billable via wallet', async () => {
    walletGetAvailableUsd.mockResolvedValue(-0.5);
    getEntitlements.mockResolvedValue(null);
    await expect(resolve()).resolves.toEqual({
      kind: 'free',
      reason: 'no_balance_no_subscription',
      organizationId: USER_ORG,
    });
  });
});

/**
 * Source-level pins (P1-2 follow-up to the #720 audit): the pure-function
 * suite above cannot see the ROUTE wiring, and the P0-1 hole (billable users
 * executed with NO billing carrier — no gate, no debit, no ceiling) shipped
 * behind a fully green suite. Pin the load-bearing wiring at the source
 * level, same house pattern as strategy-target-policy's §8 #1.
 */
describe('chat-routes wiring (source-level pins)', () => {
  const code = readFileSync(
    fileURLToPath(new URL('../../routes/chat/chat-routes.ts', import.meta.url)),
    'utf8'
  );

  it('P0-1: the billable_wallet branch attaches the tier carrier BEFORE the free counter', () => {
    const billableAt = code.indexOf("if (disposition.kind === 'billable_wallet')");
    const counterAt = code.indexOf('await checkAndConsumeFreeTierAutoQuota(');
    expect(billableAt).toBeGreaterThan(-1);
    expect(counterAt).toBeGreaterThan(billableAt);
    const billableBlock = code.slice(billableAt, counterAt);
    // The carrier IS attached for billable users (gate/debit key on it).
    expect(billableBlock).toContain('chatRequest.ailin_tier = carrier.ailin_tier');
    expect(billableBlock).toContain('chatRequest.ailin_tier_rate = carrier.ailin_tier_rate');
    expect(billableBlock).toContain('chatRequest.ailin_wallet_org = billingOrganizationId');
    // And rate-card drift falls back to the free counter, never unbilled execution.
    expect(billableBlock).toContain("reason: 'billing_probe_failed'");
  });

  it('P0-1b: billable_plan (subscriber) never attaches the wallet carrier', () => {
    // OWNER DECISION (2026-10-03): a subscriber consumes their plan, NEVER
    // their wallet — no carrier means no 402 hold and no wallet debit.
    const planAt = code.indexOf("else if (disposition.kind === 'billable_plan')");
    expect(planAt).toBeGreaterThan(-1);
    const counterAt = code.indexOf('await checkAndConsumeFreeTierAutoQuota(');
    expect(counterAt).toBeGreaterThan(planAt);
    const planBlock = code.slice(planAt, counterAt);
    expect(planBlock).toContain('billingOrganizationId = disposition.organizationId');
    expect(planBlock).not.toContain('ailin_tier');
    expect(planBlock).not.toContain('ailin_wallet_org');
  });

  it('P0-2: normalizeChatRequest strips the client-supplied wallet-org field', () => {
    expect(code).toContain('delete normalizedRequest.ailin_wallet_org');
  });

  it('the single published price cell feeds every ailin-auto attach', () => {
    // Both attach sites (billable + credits-continue) must resolve the SAME
    // cell — one price for ailin-auto, however the user got there.
    const attaches = code.match(/resolveTierCarrier\(([A-Z_]+)\)/g) ?? [];
    expect(attaches.length).toBeGreaterThanOrEqual(2);
    for (const a of attaches) {
      expect(a).toBe('resolveTierCarrier(CREDITS_CONTINUE_MODEL_CELL)');
    }
  });
});
