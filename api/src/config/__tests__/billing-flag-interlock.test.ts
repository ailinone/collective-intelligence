// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * billing-flag-interlock.test.ts — the prepaid-wallet double-charge boot guard.
 *
 * `PREPAID_WALLET_GATE_ENABLED` (prepaid-wallet-gate.ts) and
 * `PRICING_TIERS_BILLING_ENABLED` (pricing-tier-billing.ts) are two independent
 * gate+debit implementations over the SAME PrepaidWallet. Both discriminate on the
 * server-set `ailin_tier`/`ailin_tier_rate` carrier and both are wired into the same
 * /v1/chat/completions handler, so with both flags on every tiered request is held
 * twice and debited twice — silently, in real money.
 *
 * That interlock used to be a code comment. This pins it as a boot failure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '@/config';

const GATE = 'PREPAID_WALLET_GATE_ENABLED';
const TIER = 'PRICING_TIERS_BILLING_ENABLED';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('prepaid-wallet billing flag interlock', () => {
  it('refuses to boot when both wallet-debit flags are enabled', () => {
    vi.stubEnv(GATE, 'true');
    vi.stubEnv(TIER, 'true');
    expect(() => validateConfig()).toThrow(/mutually exclusive/i);
  });

  it.each([
    [GATE, TIER],
    [TIER, GATE],
  ])('accepts %s alone (exactly one debit path is the supported configuration)', (on, off) => {
    vi.stubEnv(on, 'true');
    vi.stubEnv(off, '');
    expect(() => validateConfig()).not.toThrow();
  });

  it('accepts the shipped default (both off)', () => {
    vi.stubEnv(GATE, '');
    vi.stubEnv(TIER, '');
    expect(() => validateConfig()).not.toThrow();
  });
});
