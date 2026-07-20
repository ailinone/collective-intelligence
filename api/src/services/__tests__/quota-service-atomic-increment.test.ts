// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic test for recordQuotaUsage's atomic-increment fix (scale-to-100k
 * Phase 4, issue #149) — usage_quotas was a hot-row write on every billable
 * request; the previous read-modify-write (compute newCount = fetched.count
 * + N in application code, then .update()) was both a lost-update race
 * under concurrency and held the row lock longer than an atomic UPDATE
 * needs to. This verifies recordQuotaUsage now issues a Prisma
 * `{ increment: N }` update — never reading the prior count into the
 * update payload — for all four counters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findFirstMock, updateMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@/database/client', async () => {
  const actual = await vi.importActual<typeof import('@/database/client')>('@/database/client');
  return {
    ...actual,
    prisma: {
      usageQuota: {
        findFirst: findFirstMock,
        update: updateMock,
        create: vi.fn(),
      },
    },
  };
});

const { recordQuotaUsage } = await import('../quota-service');

const EXISTING_QUOTA = {
  id: 'quota-1',
  organizationId: 'org-1',
  period: 'month',
  periodStart: new Date('2026-01-01'),
  periodEnd: new Date('2026-02-01'),
  requestCount: 999, // deliberately nonzero — must NOT leak into the update payload
  tokenCount: 999n,
  requestLimit: 10_000,
  tokenLimit: null,
  costLimitUsd: null,
  fileLimit: null,
  fileCount: 0,
};

describe('recordQuotaUsage — atomic increment (issue #149)', () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    updateMock.mockReset();
    findFirstMock.mockResolvedValue(EXISTING_QUOTA);
    updateMock.mockResolvedValue(EXISTING_QUOTA);
  });

  it('issues an atomic {increment} update, not a computed absolute value', async () => {
    await recordQuotaUsage('org-1', { operation: { requests: 1, tokens: 500, cost: 0.02, files: 0 } });

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'quota-1' },
      data: {
        requestCount: { increment: 1 },
        tokenCount: { increment: 500n },
        costUsd: { increment: expect.objectContaining({ toString: expect.any(Function) }) },
        fileCount: { increment: 0 },
      },
    });
  });

  it('never reads quota.requestCount/tokenCount into the update payload (no lost-update race)', async () => {
    await recordQuotaUsage('org-1', { operation: { requests: 1 } });

    const call = updateMock.mock.calls[0]![0];
    // The update payload must be the increment amount (1), never
    // EXISTING_QUOTA.requestCount (999) + 1 computed in application code.
    expect(call.data.requestCount).toEqual({ increment: 1 });
  });

  it('defaults missing operation fields to a zero increment', async () => {
    await recordQuotaUsage('org-1', {});

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestCount: { increment: 0 },
          tokenCount: { increment: 0n },
          fileCount: { increment: 0 },
        }),
      })
    );
  });
});
