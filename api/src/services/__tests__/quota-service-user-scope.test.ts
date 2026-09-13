// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * User-scoped quota (Phase 3 of the cross-repo quota-scoping hardening
 * program, PR #582): `UsageQuota` gained a nullable `userId` column so a row
 * can represent either the org-wide aggregate (`userId IS NULL`, unchanged
 * meaning) or one user's own allocation within that org/period.
 *
 * `checkQuota`/`recordQuotaUsage` already received `userId` on every real
 * call site (`chat-routes.ts`, `orchestration-gate.ts`,
 * `billing-usage-tracker.ts`, `orchestration-engine.ts`) — it was silently
 * discarded before this phase. This suite is the behavioural spec for what
 * honouring it means.
 *
 * SEMANTICS UNDER TEST — ADDITIVE, documented assumption pending product
 * confirmation (see the comment at the decision point in quota-service.ts
 * and the PR description): a per-user quota is an ADDITIONAL ceiling on top
 * of the organization's, not a substitute for it. Both must be respected —
 * a request is blocked the moment EITHER the user's own row or the org's
 * aggregate row would be exceeded.
 *
 * The mock below is a small in-memory relational stand-in for
 * `prisma.usageQuota` (find/create/update over an array of rows, matching
 * `where` clauses including exact-null equality and the `{lte,gte}` range
 * shape `findCurrentQuota` uses) rather than the single-fixed-row style of
 * `quota-service-atomic-increment.test.ts` — these scenarios need several
 * coexisting rows (one org-wide, several per-user) interacting realistically,
 * which a single canned return value cannot represent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { rows, findFirstMock, createMock, updateMock, resetRows } = vi.hoisted(() => {
  interface Row {
    id: string;
    organizationId: string;
    userId: string | null;
    period: string;
    periodStart: Date;
    periodEnd: Date;
    requestLimit: number;
    tokenLimit: bigint | null;
    // Never set to non-null in this suite (no test configures maxCost), so
    // the real calculateRemaining()'s Decimal-arithmetic branch is never
    // exercised here and this can stay untyped.
    costLimitUsd: unknown;
    fileLimit: number | null;
    requestCount: number;
    tokenCount: bigint;
    // Stored as a plain number in this mock (see applyIncrement below) even
    // though the real column is a Prisma.Decimal — quota-service.ts's real
    // code passes a `new Prisma.Decimal(...)` increment, which this mock
    // unwraps to a number via `.toNumber()` rather than depending on the
    // real Decimal class (which `vi.hoisted` runs before this file's own
    // imports are evaluated, so it is not safely reachable in here).
    costUsd: number;
    fileCount: number;
    createdAt: Date;
    updatedAt: Date;
  }

  const rows: Row[] = [];
  let nextId = 1;

  function matchesCondition(value: unknown, condition: unknown): boolean {
    if (
      condition !== null &&
      typeof condition === 'object' &&
      !(condition instanceof Date) &&
      ('lte' in (condition as Record<string, unknown>) ||
        'gte' in (condition as Record<string, unknown>))
    ) {
      const range = condition as { lte?: Date; gte?: Date };
      if (range.lte !== undefined && !((value as Date) <= range.lte)) return false;
      if (range.gte !== undefined && !((value as Date) >= range.gte)) return false;
      return true;
    }
    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }
    return value === condition;
  }

  function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, condition]) =>
      matchesCondition((row as unknown as Record<string, unknown>)[key], condition)
    );
  }

  /** Unwraps a real `Prisma.Decimal` (or a plain number) to a JS number. */
  function toPlainNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { toNumber?: unknown }).toNumber === 'function'
    ) {
      return (value as { toNumber: () => number }).toNumber();
    }
    return Number(value);
  }

  function applyIncrement(current: unknown, incrementSpec: unknown): unknown {
    if (
      incrementSpec !== null &&
      typeof incrementSpec === 'object' &&
      'increment' in (incrementSpec as Record<string, unknown>)
    ) {
      const delta = (incrementSpec as { increment: unknown }).increment;
      if (typeof current === 'bigint') {
        return current + (delta as bigint);
      }
      // costUsd: quota-service.ts increments it with a real `Prisma.Decimal`
      // (`{ increment: new Prisma.Decimal(cost) }`) — unwrap to a number so
      // this mock's plain-number storage stays consistent.
      return toPlainNumber(current) + toPlainNumber(delta);
    }
    return incrementSpec;
  }

  const findFirstMock = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    return rows.find((row) => matchesWhere(row, where)) ?? null;
  });

  const createMock = vi.fn(async ({ data }: { data: Partial<Row> }) => {
    const row: Row = {
      id: `row-${nextId++}`,
      requestCount: 0,
      tokenCount: 0n,
      costUsd: 0,
      fileCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: null,
      ...data,
    } as Row;
    rows.push(row);
    return row;
  });

  const updateMock = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) {
        throw new Error(`quota row not found: ${where.id}`);
      }
      for (const [key, value] of Object.entries(data)) {
        (row as unknown as Record<string, unknown>)[key] = applyIncrement(
          (row as unknown as Record<string, unknown>)[key],
          value
        );
      }
      return row;
    }
  );

  function resetRows() {
    rows.length = 0;
    nextId = 1;
  }

  return { rows, findFirstMock, createMock, updateMock, resetRows };
});

vi.mock('@/database/client', async () => {
  const actual = await vi.importActual<typeof import('@/database/client')>('@/database/client');
  return {
    ...actual,
    prisma: {
      usageQuota: {
        findFirst: findFirstMock,
        create: createMock,
        update: updateMock,
      },
    },
  };
});

const { checkQuota, recordQuotaUsage, upsertQuota } = await import('../quota-service');

const ORG = 'org-1';
const USER_A = 'user-a';
const USER_B = 'user-b';
const USER_C = 'user-c';

async function seedOrgQuota(maxRequests: number, requestCount = 0): Promise<void> {
  await upsertQuota(ORG, { limits: { period: 'month', maxRequests } });
  if (requestCount > 0) {
    await recordQuotaUsage(ORG, { operation: { requests: requestCount } });
  }
}

async function seedUserQuota(userId: string, maxRequests: number, requestCount = 0): Promise<void> {
  await upsertQuota(ORG, { userId, limits: { period: 'month', maxRequests } });
  if (requestCount > 0) {
    await recordQuotaUsage(ORG, { userId, operation: { requests: requestCount } });
  }
}

beforeEach(() => {
  resetRows();
  findFirstMock.mockClear();
  createMock.mockClear();
  updateMock.mockClear();
});

describe('quota-service — per-user scope (Phase 3, additive semantics)', () => {
  it('blocks when two users are each within their own limit but the org aggregate is not', async () => {
    await seedOrgQuota(10);
    await seedUserQuota(USER_A, 8);
    await seedUserQuota(USER_B, 8);

    // Both users have used 5 of their own 8 already; combined that is the
    // org's entire 10-request budget.
    await recordQuotaUsage(ORG, { userId: USER_A, operation: { requests: 5 } });
    await recordQuotaUsage(ORG, { userId: USER_B, operation: { requests: 5 } });

    // User B alone is nowhere near their own 8-request cap (5 + 1 = 6 <= 8),
    // but the org aggregate is already at 10/10.
    const result = await checkQuota(ORG, { userId: USER_B, operation: { requests: 1 } });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Organization quota limits exceeded');
    // The combined `remaining.requests` reflects the tighter (org) ceiling.
    expect(result.remaining?.requests).toBe(-1);
  });

  it('blocks when a single user exceeds their own limit even though the org is nowhere near its limit', async () => {
    await seedOrgQuota(1000);
    // recordQuotaUsage(userId: USER_C) also bumps the org aggregate to 5 —
    // still nowhere near its 1000 limit.
    await seedUserQuota(USER_C, 5, 5); // already at their own cap

    const result = await checkQuota(ORG, { userId: USER_C, operation: { requests: 1 } });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('User quota limits exceeded');
    expect(result.remaining?.requests).toBe(-1);
  });

  it('allows when both the user and the organization are within limits', async () => {
    await seedOrgQuota(100, 10);
    await seedUserQuota(USER_A, 20, 3);

    const result = await checkQuota(ORG, { userId: USER_A, operation: { requests: 1 } });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    // User's own limit (20-3-1=16) is the tighter of the two ceilings here;
    // the org row has plenty of separate headroom either way.
    expect(result.remaining?.requests).toBe(16);
  });

  it('legacy call with no userId behaves exactly as the pre-Phase-3 org-only check', async () => {
    await seedOrgQuota(10, 9);

    const result = await checkQuota(ORG, { operation: { requests: 1 } });

    expect(result.allowed).toBe(true);
    expect(result.remaining?.requests).toBe(0);
    expect(result.reason).toBeUndefined();

    // No per-user row should ever have been read or created for this call.
    for (const call of findFirstMock.mock.calls) {
      expect(call[0].where.userId).toBeNull();
    }
    expect(rows.every((row) => row.userId === null)).toBe(true);
  });

  it('recordQuotaUsage increments both the org row and the user row when userId is present', async () => {
    await seedOrgQuota(100);
    await seedUserQuota(USER_A, 50);

    await recordQuotaUsage(ORG, {
      userId: USER_A,
      operation: { requests: 2, tokens: 40, cost: 0.5 },
    });

    const orgRow = rows.find((r) => r.userId === null)!;
    const userRow = rows.find((r) => r.userId === USER_A)!;

    expect(orgRow.requestCount).toBe(2);
    expect(userRow.requestCount).toBe(2);
    expect(orgRow.tokenCount).toBe(40n);
    expect(userRow.tokenCount).toBe(40n);
    expect(orgRow.costUsd).toBeCloseTo(0.5);
    expect(userRow.costUsd).toBeCloseTo(0.5);
  });

  it('recordQuotaUsage without userId only ever touches the org-wide row (legacy behaviour)', async () => {
    await seedOrgQuota(100);

    await recordQuotaUsage(ORG, { operation: { requests: 3 } });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBeNull();
    expect(rows[0]!.requestCount).toBe(3);
  });

  it('upsertQuota lets an org-wide row and multiple per-user rows coexist for the same period', async () => {
    await seedOrgQuota(10);
    await seedUserQuota(USER_A, 3);
    await seedUserQuota(USER_B, 4);

    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.userId === null)?.requestLimit).toBe(10);
    expect(rows.find((r) => r.userId === USER_A)?.requestLimit).toBe(3);
    expect(rows.find((r) => r.userId === USER_B)?.requestLimit).toBe(4);
  });

  it('upsertQuota updates the existing per-user row in place instead of creating a duplicate', async () => {
    await seedUserQuota(USER_A, 3);
    await upsertQuota(ORG, { userId: USER_A, limits: { period: 'month', maxRequests: 9 } });

    const userRows = rows.filter((r) => r.userId === USER_A);
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.requestLimit).toBe(9);
  });
});
