// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `trackChatUsage` accounting modes.
 *
 * WHY THIS EXISTS
 * ---------------
 * Adding metering to a route that never had it is not a locally-contained
 * change, and the PR body claiming "metering is unconditional, it rejects
 * nothing" is true locally and false system-wide. `trackChatUsage` fans out to
 * three places, and two of them are read by enforcement code elsewhere:
 *
 *   - `recordQuotaUsage` increments `usage_quotas.requestCount/tokenCount/
 *     costUsd`, which is exactly what `checkQuota` compares — and
 *     `POST /v1/chat/completions` returns a hard 429 on that with no feature
 *     flag of its own. Metering a previously-uncounted route therefore makes an
 *     UNTOUCHED route start rejecting sooner for any org with a configured
 *     quota.
 *   - `debitChatRequest` is a prepaid-wallet debit. On a route with no wallet
 *     RESERVE (no `gateChatRequest`, so no `holdId`) it takes the unreserved
 *     branch. Inert only while `PREPAID_WALLET_GATE_ENABLED` is false; the
 *     `ailin-*` -> `'auto'` alias landmine makes it live the moment that flips.
 *
 * `analytics-only` gives the visibility the revenue hole actually needed —
 * attributed `chat.completion` events with real cost and tokens — while touching
 * neither. These tests are the mechanical guarantee of that, and the second
 * barrier behind the route-level one (a route can add wallet exposure that
 * `orchestration-gate-wallet-exclusion.test.ts` cannot see, because that file
 * only reads `orchestration-gate.ts`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { debitChatRequestMock, recordUsageEventsMock, recordQuotaUsageMock } = vi.hoisted(() => ({
  debitChatRequestMock: vi.fn(),
  recordUsageEventsMock: vi.fn(),
  recordQuotaUsageMock: vi.fn(),
}));

vi.mock('@/services/prepaid-wallet-gate', () => ({ debitChatRequest: debitChatRequestMock }));
vi.mock('@/services/usage-analytics-service', () => ({ recordUsageEvents: recordUsageEventsMock }));
vi.mock('@/services/quota-service', () => ({ recordQuotaUsage: recordQuotaUsageMock }));

const { trackChatUsage } = await import('../billing-usage-tracker');

function options(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    requestId: 'req-1',
    request: { model: 'gpt-4o', messages: [] },
    cacheHit: false,
    strategyOverride: 'intelligent',
    totalCostOverride: 1.25,
    totalTokensOverride: 900,
    ...overrides,
  } as Parameters<typeof trackChatUsage>[0];
}

describe('trackChatUsage accounting modes', () => {
  beforeEach(() => {
    debitChatRequestMock.mockReset().mockResolvedValue(undefined);
    recordUsageEventsMock.mockReset().mockResolvedValue(undefined);
    recordQuotaUsageMock.mockReset().mockResolvedValue(undefined);
  });

  it('defaults to full — every pre-existing call site is unchanged', async () => {
    await trackChatUsage(options());

    expect(debitChatRequestMock).toHaveBeenCalledTimes(1);
    expect(recordUsageEventsMock).toHaveBeenCalledTimes(1);
    expect(recordQuotaUsageMock).toHaveBeenCalledTimes(1);
  });

  it('full behaves identically when asked for explicitly', async () => {
    await trackChatUsage(options({ accounting: 'full' }));

    expect(debitChatRequestMock).toHaveBeenCalledTimes(1);
    expect(recordQuotaUsageMock).toHaveBeenCalledTimes(1);
  });

  it('analytics-only moves NO quota counter', async () => {
    await trackChatUsage(options({ accounting: 'analytics-only' }));

    expect(recordQuotaUsageMock).not.toHaveBeenCalled();
  });

  it('analytics-only performs NO wallet debit', async () => {
    await trackChatUsage(options({ accounting: 'analytics-only' }));

    expect(debitChatRequestMock).not.toHaveBeenCalled();
  });

  it('analytics-only still records an attributed usage event with real cost', async () => {
    // The point of the mode: the traffic becomes visible and billable-in-analytics
    // even though no enforced counter moves. Recording nothing would leave the
    // revenue hole exactly as open as before.
    await trackChatUsage(options({ accounting: 'analytics-only' }));

    expect(recordUsageEventsMock).toHaveBeenCalledTimes(1);
    const payload = recordUsageEventsMock.mock.calls[0]![0];
    expect(payload.organizationId).toBe('org-1');
    const event = payload.events[0];
    expect(event.eventType).toBe('chat.completion');
    expect(event.userId).toBe('user-1');
    expect(event.metadata.total_cost_usd).toBe(1.25);
    expect(event.metadata.total_tokens).toBe(900);
    // Marked, so a dashboard can tell an analytics-only row from a fully
    // accounted one rather than silently under-reporting quota consumption.
    expect(event.metadata.accounting).toBe('analytics-only');
  });

  it('marks fully-accounted rows too, so the two are distinguishable', async () => {
    await trackChatUsage(options());

    expect(recordUsageEventsMock.mock.calls[0]![0].events[0].metadata.accounting).toBe('full');
  });

  it('still cannot fail the request in either mode', async () => {
    recordUsageEventsMock.mockRejectedValue(new Error('analytics down'));

    await expect(trackChatUsage(options({ accounting: 'analytics-only' }))).resolves.toBeUndefined();
    await expect(trackChatUsage(options())).resolves.toBeUndefined();
  });
});
