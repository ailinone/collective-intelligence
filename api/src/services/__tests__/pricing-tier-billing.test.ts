// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it } from 'vitest';
import {
  __setWalletForTesting,
  debitTierRequest,
  estimatePromptTokens,
  extractTierContext,
  gateTierRequest,
  isTierBillingEnabled,
  type TierContext,
} from '@/services/pricing-tier-billing';
import { InMemoryBalanceStore, PrepaidWallet, type BalanceStore } from '@/services/prepaid-wallet';

const FLAG = 'PRICING_TIERS_BILLING_ENABLED';
const LARGE: TierContext = { tier: 'large', rate: { inputPer1MUsd: 4, outputPer1MUsd: 20 } };

afterEach(() => {
  delete process.env[FLAG];
  __setWalletForTesting(null);
});

describe('pricing-tier-billing', () => {
  it('the flag defaults OFF', () => {
    expect(isTierBillingEnabled()).toBe(false);
  });

  it('extractTierContext needs both tier and rate', () => {
    expect(extractTierContext(null)).toBeNull();
    expect(extractTierContext({ tier: 'large' })).toBeNull();
    expect(extractTierContext({ tier: 'large', tierRate: { inputPer1MUsd: 4, outputPer1MUsd: 20 } })).toEqual(LARGE);
  });

  it('estimatePromptTokens counts string and array content (chars/4)', () => {
    expect(estimatePromptTokens([{ content: 'abcd' }])).toBe(1);
    expect(estimatePromptTokens([{ content: [{ text: 'abcdefgh' }] }])).toBe(2);
    expect(estimatePromptTokens(undefined)).toBe(0);
  });

  it('gate and debit are no-ops when the flag is OFF', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 0 }));
    __setWalletForTesting(wallet);
    expect(await gateTierRequest('org', LARGE, 1_000_000, 1_000_000)).toEqual({ ok: true }); // not blocked.
    await debitTierRequest('org', LARGE, 1_000_000, 1_000_000, 'r');
    expect(await wallet.getBalanceUsd('org')).toBe(0); // not charged.
  });

  it('gate rejects when enabled and the balance is short', async () => {
    process.env[FLAG] = 'true';
    __setWalletForTesting(new PrepaidWallet(new InMemoryBalanceStore({ org: 0 })));
    const r = await gateTierRequest('org', LARGE, 100_000, 100_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.requiredUsd).toBeGreaterThan(0);
  });

  it('gate allows and debit charges the user tokens at the tier rate', async () => {
    process.env[FLAG] = 'true';
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 10 }));
    __setWalletForTesting(wallet);
    expect((await gateTierRequest('org', LARGE, 100_000, 100_000)).ok).toBe(true);
    await debitTierRequest('org', LARGE, 100_000, 100_000, 'req'); // $0.4 + $2.0 = $2.4
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(7.6, 6);
  });

  it('gate FAILS OPEN on a wallet/infra error (never blocks traffic)', async () => {
    process.env[FLAG] = 'true';
    const broken: BalanceStore = {
      getBalanceUsd: async () => {
        throw new Error('relation "organization_balance" does not exist');
      },
      adjustBalanceUsd: async () => 0,
    };
    __setWalletForTesting(new PrepaidWallet(broken));
    expect(await gateTierRequest('org', LARGE, 1_000_000, 1_000_000)).toEqual({ ok: true });
  });
});
