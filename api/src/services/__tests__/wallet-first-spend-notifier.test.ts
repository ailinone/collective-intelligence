// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for wallet-first-spend-notifier — the referral-campaign activation
 * emission (wallet.first_spend → billing).
 *
 * Hermetic: prisma raw queries and fetch are stubbed. The contract pinned:
 *   - fires ONLY when the org's committed debit count is exactly 1
 *   - never throws and never blocks (fire-and-forget wrapper swallows)
 *   - payload: {event_type: 'wallet.first_spend', data: {tenant_id, amount_usd}}
 *   - unconfigured billing = silent skip; failed POST = warning, no throw
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const queryRawMock = vi.fn();
vi.mock('@/database/client', () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRawMock(...args) },
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
}));

// Same hermetic pattern as billing-entitlements-client.test.ts: the actor
// token minting is mocked so no second network hop is needed. Default
// resolves {} (the real module's no-M2M-secret behavior), keeping every
// pre-existing assertion about the static-secret-only headers valid.
const mockGetBillingActorHeaders = vi.fn();
vi.mock('@/services/billing-actor-token', () => ({
  getBillingActorHeaders: (...args: unknown[]) => mockGetBillingActorHeaders(...args),
}));

import {
  emitFirstSpendEvent,
  isOrgFirstSpend,
  notifyFirstSpendIfApplicable,
} from '@/services/wallet-first-spend-notifier';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  process.env.BILLING_SERVICE_URL = 'http://billing.test';
  process.env.BILLING_API_SECRET_KEY = 'secret';
  queryRawMock.mockReset();
  fetchMock.mockReset();
  mockGetBillingActorHeaders.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BILLING_SERVICE_URL;
  delete process.env.BILLING_API_SECRET_KEY;
});

describe('wallet-first-spend-notifier', () => {
  it('detects first spend when the committed debit count is exactly 1', async () => {
    queryRawMock.mockResolvedValueOnce([{ count: '1' }]);
    expect(await isOrgFirstSpend('org-1')).toBe(true);

    queryRawMock.mockResolvedValueOnce([{ count: '3' }]);
    expect(await isOrgFirstSpend('org-1')).toBe(false);

    queryRawMock.mockResolvedValueOnce([]); // defensive: no row
    expect(await isOrgFirstSpend('org-1')).toBe(false);
  });

  it('posts the activation event to billing /v1/events', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await emitFirstSpendEvent('org-1', 0.42);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://billing.test/v1/events');
    expect(init.headers['Billing-Api-Secret-Key']).toBe('secret');
    expect(JSON.parse(init.body)).toEqual({
      event_type: 'wallet.first_spend',
      data: { tenant_id: 'org-1', amount_usd: 0.42 },
    });
  });

  it('attaches the M2M Bearer token and X-Acting-Tenant-Id alongside the static secret', async () => {
    mockGetBillingActorHeaders.mockResolvedValueOnce({
      Authorization: 'Bearer mock-actor-token',
      'X-Acting-Tenant-Id': 'org-1',
    });
    fetchMock.mockResolvedValueOnce({ ok: true });

    await emitFirstSpendEvent('org-1', 0.42);

    expect(mockGetBillingActorHeaders).toHaveBeenCalledWith('org-1');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Billing-Api-Secret-Key']).toBe('secret');
    expect(init.headers.Authorization).toBe('Bearer mock-actor-token');
    expect(init.headers['X-Acting-Tenant-Id']).toBe('org-1');
  });

  it('still emits on the static secret alone when actor-token minting fails', async () => {
    mockGetBillingActorHeaders.mockResolvedValueOnce({});
    fetchMock.mockResolvedValueOnce({ ok: true });

    await emitFirstSpendEvent('org-1', 1);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Billing-Api-Secret-Key']).toBe('secret');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('a rejected emission warns but never throws', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(emitFirstSpendEvent('org-1', 1)).resolves.toBeUndefined();
  });

  it('unconfigured billing skips silently', async () => {
    delete process.env.BILLING_API_SECRET_KEY;
    await expect(emitFirstSpendEvent('org-1', 1)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the fire-and-forget entry point swallows pipeline errors', async () => {
    queryRawMock.mockRejectedValueOnce(new Error('db blip'));
    expect(() => notifyFirstSpendIfApplicable('org-1', 1)).not.toThrow();
    // let the internal async complete without unhandled rejection
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('emits only on first spend (count==1)', async () => {
    queryRawMock.mockResolvedValueOnce([{ count: '1' }]);
    fetchMock.mockResolvedValueOnce({ ok: true });
    notifyFirstSpendIfApplicable('org-1', 0.5);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    queryRawMock.mockResolvedValueOnce([{ count: '2' }]);
    notifyFirstSpendIfApplicable('org-1', 0.5);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
