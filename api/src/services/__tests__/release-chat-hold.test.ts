// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#751 — releaseChatHold: the abort half of the wallet hold lifecycle.
 *
 * The collective streaming path takes a pre-execution hold (gateChatRequest).
 * Before this change, an aborted execution (client disconnected mid-run) left
 * that hold reserved until holdTtlForRequest's TTL — the user's balance was
 * frozen for minutes after they gave up on the request. The 2026-10-04
 * product decision: on abort, do NOT debit, RELEASE the hold immediately.
 *
 * releaseChatHold must therefore call PrepaidWallet.release (never settle —
 * settle would charge) and never throw (a failed release still self-expires
 * at the hold TTL, mirroring the pre-fix safety net).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatRequest } from '@/types';

process.env.PREPAID_WALLET_GATE_ENABLED = 'true';

const releaseMock = vi.fn();

vi.mock('@/services/prepaid-wallet', () => ({
  PrepaidWallet: class {
    release = releaseMock;
    reserve = vi.fn();
    settle = vi.fn();
    debit = vi.fn();
  },
  estimateMaxChargeUsd: vi.fn(() => 1.2345),
}));
vi.mock('@/services/prepaid-wallet-prisma-store', () => ({
  PrismaBalanceStore: class {},
}));
vi.mock('@/services/wallet-first-spend-notifier', () => ({
  notifyFirstSpendIfApplicable: vi.fn(),
}));
vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

const { releaseChatHold } = await import('@/services/prepaid-wallet-gate');

const req = {
  model: 'consensus:medium',
  messages: [{ role: 'user', content: 'hi' }],
  ailin_tier: 'medium',
  ailin_tier_rate: { inputPer1MUsd: 1, outputPer1MUsd: 2 },
} as unknown as ChatRequest;

describe('releaseChatHold (ci#751 abort path)', () => {
  beforeEach(() => {
    releaseMock.mockReset();
    releaseMock.mockResolvedValue(undefined);
  });

  it('RELEASES the hold against the wallet org (never settle/debit)', async () => {
    await releaseChatHold({
      organizationId: 'org-shared-principal',
      request: req,
      requestId: 'req-1',
      holdId: 'hold_abc',
    });

    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith('org-shared-principal', 'hold_abc');
  });

  it('prefers ailin_wallet_org (the acting end user) over the key principal org', async () => {
    await releaseChatHold({
      organizationId: 'org-shared-principal',
      request: { ...req, ailin_wallet_org: 'org-end-user' } as ChatRequest,
      requestId: 'req-2',
      holdId: 'hold_xyz',
    });

    expect(releaseMock).toHaveBeenCalledWith('org-end-user', 'hold_xyz');
  });

  it('is a no-op when the request was never gated (no holdId)', async () => {
    await releaseChatHold({
      organizationId: 'org-1',
      request: req,
      requestId: 'req-3',
      holdId: undefined,
    });

    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('never throws on a wallet release failure (hold self-expires at TTL instead)', async () => {
    releaseMock.mockRejectedValue(new Error('store down'));

    await expect(
      releaseChatHold({
        organizationId: 'org-1',
        request: req,
        requestId: 'req-4',
        holdId: 'hold_err',
      })
    ).resolves.toBeUndefined();

    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
