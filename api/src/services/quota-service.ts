// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { Prisma, prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import type {
  QuotaCheckRequest,
  QuotaCheckResult,
  QuotaConfig,
  QuotaLimit,
  QuotaUsage,
} from '@/types';

const log = logger.child({ component: 'quota-service' });

const DEFAULT_PERIOD: QuotaLimit['period'] = 'month';
const INT_MAX = 2_147_483_647;

export async function upsertQuota(organizationId: string, config: QuotaConfig): Promise<void> {
  const limits = config.limits;
  const window = resolvePeriodWindow(limits.period);

  await prisma.usageQuota.upsert({
    where: {
      organizationId_period_periodStart: {
        organizationId,
        period: limits.period,
        periodStart: window.start,
      },
    },
    create: {
      organizationId,
      period: limits.period,
      periodStart: window.start,
      periodEnd: window.end,
      requestLimit: limits.maxRequests ?? INT_MAX,
      tokenLimit: limits.maxTokens ? BigInt(limits.maxTokens) : null,
      costLimitUsd: limits.maxCost ? new Prisma.Decimal(limits.maxCost) : null,
      fileLimit: limits.maxFiles ?? null,
    },
    update: {
      periodEnd: window.end,
      requestLimit: limits.maxRequests ?? INT_MAX,
      tokenLimit: limits.maxTokens ? BigInt(limits.maxTokens) : null,
      costLimitUsd: limits.maxCost ? new Prisma.Decimal(limits.maxCost) : null,
      fileLimit: limits.maxFiles ?? null,
      updatedAt: new Date(),
    },
  });

  log.info({ organizationId, limits }, 'Quota configuration updated');
}

export async function listQuotas(organizationId: string): Promise<QuotaConfig[]> {
  const records = await prisma.usageQuota.findMany({
    where: { organizationId },
    orderBy: { periodStart: 'desc' },
  });

  return records.map(
    (record: (typeof records)[number]): QuotaConfig => ({
      organizationId,
      limits: {
        period: record.period as QuotaLimit['period'],
        maxRequests: record.requestLimit === INT_MAX ? undefined : record.requestLimit,
        maxTokens: record.tokenLimit ? Number(record.tokenLimit) : undefined,
        maxCost: record.costLimitUsd ? Number(record.costLimitUsd) : undefined,
        maxFiles: record.fileLimit ?? undefined,
        maxFileSize: undefined,
      },
    })
  );
}

export async function checkQuota(
  organizationId: string,
  request: QuotaCheckRequest
): Promise<QuotaCheckResult> {
  const period = request.period ?? DEFAULT_PERIOD;
  const quota = await getOrCreateCurrentQuota(organizationId, period);

  const requested = {
    requests: request.operation?.requests ?? 0,
    tokens: request.operation?.tokens ?? 0,
    cost: request.operation?.cost ?? 0,
    files: request.operation?.files ?? 0,
  };

  const remaining = calculateRemaining(quota, requested);

  const allowed =
    (remaining.requests ?? Number.POSITIVE_INFINITY) >= 0 &&
    (remaining.tokens ?? Number.POSITIVE_INFINITY) >= 0 &&
    (remaining.cost ?? Number.POSITIVE_INFINITY) >= 0 &&
    (remaining.files ?? Number.POSITIVE_INFINITY) >= 0;

  return {
    allowed,
    remaining,
    resetAt: quota.periodEnd.toISOString(),
    reason: allowed ? undefined : 'Quota limits exceeded',
  };
}

export async function recordQuotaUsage(
  organizationId: string,
  request: QuotaCheckRequest
): Promise<void> {
  const period = request.period ?? DEFAULT_PERIOD;
  const quota = await getOrCreateCurrentQuota(organizationId, period);

  // Scale-to-100k Phase 4 (issue #149): this row is written on every
  // billable request for the organization — the exact hot-row write
  // usage_quotas was flagged for in the capacity assessment. The previous
  // read-modify-write (quota.requestCount + N, computed in application code
  // from the value fetched a moment earlier) is both a lost-update race
  // under concurrent requests for the same org AND holds the row lock
  // longer than necessary. Prisma's atomic `increment`/`decrement` compiles
  // to a single `SET col = col + $1` in the UPDATE itself — no stale
  // application-side value involved, safe under concurrency, same number of
  // round-trips.
  await prisma.usageQuota.update({
    where: { id: quota.id },
    data: {
      requestCount: { increment: request.operation?.requests ?? 0 },
      tokenCount: { increment: BigInt(request.operation?.tokens ?? 0) },
      costUsd: { increment: new Prisma.Decimal(request.operation?.cost ?? 0) },
      fileCount: { increment: request.operation?.files ?? 0 },
    },
  });
}

export async function resetQuota(
  organizationId: string,
  period: QuotaLimit['period'] = DEFAULT_PERIOD
): Promise<void> {
  const window = resolvePeriodWindow(period);

  await prisma.usageQuota.updateMany({
    where: {
      organizationId,
      period,
    },
    data: {
      periodStart: window.start,
      periodEnd: window.end,
      requestCount: 0,
      tokenCount: BigInt(0),
      costUsd: new Prisma.Decimal(0),
      fileCount: 0,
    },
  });
}

export async function getQuotaUsage(
  organizationId: string,
  period: QuotaLimit['period'] = DEFAULT_PERIOD
): Promise<QuotaUsage | null> {
  const quota = await prisma.usageQuota.findFirst({
    where: {
      organizationId,
      period,
    },
    orderBy: { periodStart: 'desc' },
  });

  return quota ? mapUsageRecordToDto(quota) : null;
}

async function getOrCreateCurrentQuota(organizationId: string, period: QuotaLimit['period']) {
  const window = resolvePeriodWindow(period);

  const existing = await prisma.usageQuota.findFirst({
    where: {
      organizationId,
      period,
      periodStart: {
        lte: window.start,
      },
      periodEnd: {
        gte: window.start,
      },
    },
  });

  if (existing) {
    return existing;
  }

  return await prisma.usageQuota.create({
    data: {
      organizationId,
      period,
      periodStart: window.start,
      periodEnd: window.end,
      requestLimit: INT_MAX,
      tokenLimit: null,
      costLimitUsd: null,
      fileLimit: null,
    },
  });
}

function mapUsageRecordToDto(record: {
  period: string;
  periodStart: Date;
  periodEnd: Date;
  requestLimit: number;
  tokenLimit: bigint | null;
  costLimitUsd: Prisma.Decimal | null;
  fileLimit: number | null;
  requestCount: number;
  tokenCount: bigint;
  costUsd: Prisma.Decimal;
  fileCount: number;
}): QuotaUsage {
  return {
    requests: record.requestCount,
    tokens: Number(record.tokenCount),
    cost: Number(record.costUsd),
    files: record.fileCount,
    periodStart: record.periodStart.getTime(),
    periodEnd: record.periodEnd.getTime(),
  };
}

function calculateRemaining(
  quota: {
    requestLimit: number;
    tokenLimit: bigint | null;
    costLimitUsd: Prisma.Decimal | null;
    fileLimit: number | null;
    requestCount: number;
    tokenCount: bigint;
    costUsd: Prisma.Decimal;
    fileCount: number;
  },
  requested: { requests: number; tokens: number; cost: number; files: number }
): {
  requests?: number;
  tokens?: number;
  cost?: number;
  files?: number;
} {
  const remaining: {
    requests?: number;
    tokens?: number;
    cost?: number;
    files?: number;
  } = {};

  if (quota.requestLimit) {
    remaining.requests = quota.requestLimit - quota.requestCount - requested.requests;
  }

  if (quota.tokenLimit !== null) {
    remaining.tokens = Number(quota.tokenLimit - quota.tokenCount - BigInt(requested.tokens));
  }

  if (quota.costLimitUsd !== null) {
    remaining.cost = Number(
      quota.costLimitUsd.sub(quota.costUsd).sub(new Prisma.Decimal(requested.cost))
    );
  }

  if (quota.fileLimit !== null) {
    remaining.files = quota.fileLimit - quota.fileCount - requested.files;
  }

  return remaining;
}

function resolvePeriodWindow(period: QuotaLimit['period']) {
  const now = new Date();

  switch (period) {
    case 'minute': {
      const start = new Date(now);
      start.setSeconds(0, 0);
      const end = new Date(start);
      end.setMinutes(start.getMinutes() + 1);
      return { start, end };
    }
    case 'hour': {
      const start = new Date(now);
      start.setMinutes(0, 0, 0);
      const end = new Date(start);
      end.setHours(start.getHours() + 1);
      return { start, end };
    }
    case 'day': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const end = new Date(start);
      end.setUTCDate(start.getUTCDate() + 1);
      return { start, end };
    }
    case 'month': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return { start, end };
    }
    default:
      return resolvePeriodWindow('month');
  }
}
