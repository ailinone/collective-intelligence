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
import { isUniqueConstraintError } from '@/utils/prisma-error-helpers';
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

/**
 * `null` is the org-wide aggregate row's scope; `undefined`/absent on the
 * public API means "org-wide" too. Normalising to `null` here (never
 * `undefined`) matters because it is passed straight into a Prisma `where`
 * filter — `userId: undefined` would mean "don't filter on userId at all"
 * (matches every row, org-wide AND every user's), while `userId: null` means
 * "match only the org-wide row". See the `UsageQuota` doc comment in
 * schema.prisma for why this is a real DB-level distinction (partial unique
 * indexes), not just an application convention.
 */
function normalizeScope(userId: string | null | undefined): string | null {
  return userId ?? null;
}

export async function upsertQuota(organizationId: string, config: QuotaConfig): Promise<void> {
  const limits = config.limits;
  const window = resolvePeriodWindow(limits.period);
  const userId = normalizeScope(config.userId);

  const data = {
    periodEnd: window.end,
    requestLimit: limits.maxRequests ?? INT_MAX,
    tokenLimit: limits.maxTokens ? BigInt(limits.maxTokens) : null,
    costLimitUsd: limits.maxCost ? new Prisma.Decimal(limits.maxCost) : null,
    fileLimit: limits.maxFiles ?? null,
  };

  // Not a single atomic `.upsert()` anymore. `@@unique([organizationId,
  // period, periodStart])` — the compound key `.upsert()` used to target —
  // was dropped from schema.prisma: it cannot coexist with per-user rows (see
  // the `UsageQuota` doc comment) and its replacement is two PARTIAL unique
  // indexes, which Prisma's schema language has no way to declare, so there
  // is no compound-unique input left for `.upsert()`'s `where` to use. This
  // find-then-write has the same benign race `getOrCreateCurrentQuota`
  // already accepts on the hot path (see its comment below): admin quota
  // configuration is low-frequency and low-concurrency-per-key, so the
  // `isUniqueConstraintError` fallback below is a cheap belt-and-suspenders
  // rather than a load-bearing lock.
  const existing = await prisma.usageQuota.findFirst({
    where: { organizationId, userId, period: limits.period, periodStart: window.start },
  });

  if (existing) {
    await prisma.usageQuota.update({
      where: { id: existing.id },
      data: { ...data, updatedAt: new Date() },
    });
  } else {
    try {
      await prisma.usageQuota.create({
        data: { organizationId, userId, period: limits.period, periodStart: window.start, ...data },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      // Lost the create race to a concurrent call for the same scope — the
      // row exists now, so finish as an update instead of failing the
      // request over a benign collision.
      const created = await prisma.usageQuota.findFirst({
        where: { organizationId, userId, period: limits.period, periodStart: window.start },
      });
      if (!created) {
        throw error;
      }
      await prisma.usageQuota.update({
        where: { id: created.id },
        data: { ...data, updatedAt: new Date() },
      });
    }
  }

  log.info({ organizationId, userId, limits }, 'Quota configuration updated');
}

/**
 * Lists quota CONFIGURATION rows for the organization. Pinned to the
 * org-wide aggregate (`userId: null`) to preserve the exact pre-Phase-3
 * contract: every existing caller (the `/v1/enterprise/quotas` admin route)
 * expects one entry per configured org-wide period, not a mix of the
 * org-wide row and every user's individual row. Listing per-user
 * configuration is a separate, additive follow-up (a `userId` filter param
 * here, and a `userId` field on the returned `QuotaConfig`), not something
 * this phase silently changes the shape of.
 */
export async function listQuotas(organizationId: string): Promise<QuotaConfig[]> {
  const records = await prisma.usageQuota.findMany({
    where: { organizationId, userId: null },
    orderBy: { periodStart: 'desc' },
  });

  return records.map((record: (typeof records)[number]): QuotaConfig => ({
    organizationId,
    limits: {
      period: record.period as QuotaLimit['period'],
      maxRequests: record.requestLimit === INT_MAX ? undefined : record.requestLimit,
      maxTokens: record.tokenLimit ? Number(record.tokenLimit) : undefined,
      maxCost: record.costLimitUsd ? Number(record.costLimitUsd) : undefined,
      maxFiles: record.fileLimit ?? undefined,
      maxFileSize: undefined,
    },
  }));
}

export interface CheckQuotaOptions {
  /**
   * When false, a missing quota row is NOT created — the check reads, and an
   * absent row is treated as "no limits configured" (unlimited, allow). This
   * now applies independently to BOTH rows a check may read (org-wide, and —
   * when `request.userId` is set — that user's own row): neither is
   * materialised by a bare check.
   *
   * Defaults to true, preserving the behaviour `/v1/chat/completions` has
   * always had. `orchestration-gate.ts` passes false on the flat principle that
   * a CHECK must not write — not on any claim about whether its routes record
   * quota usage elsewhere (they all do). Concretely, writing here would
   * (a) materialise quota rows for orgs (or users) whose request never
   * reaches the recording path at all, changing what `listQuotas`/
   * `getQuotaUsage` report, and (b) race on the partial unique indexes that
   * replaced `@@unique([organizationId, period, periodStart])` for
   * concurrent first-requests-of-period. The row is still created on the
   * recording path by `recordQuotaUsage`, so nothing is lost for a request that
   * actually completes.
   */
  createIfMissing?: boolean;
}

/**
 * Combine an org-wide remaining-headroom reading with a per-user one: the
 * caller's true remaining headroom on any one dimension is bounded by
 * whichever of the two is tighter. `undefined` means "no limit configured
 * for this dimension" on that row, so it must not win a `Math.min` against a
 * real number — hence the explicit undefined-handling instead of a bare
 * `Math.min(a, b)`.
 */
function combineRemaining(
  org: { requests?: number; tokens?: number; cost?: number; files?: number },
  user: { requests?: number; tokens?: number; cost?: number; files?: number } | null
): { requests?: number; tokens?: number; cost?: number; files?: number } {
  if (!user) {
    return org;
  }
  const tighter = (a?: number, b?: number): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);
  return {
    requests: tighter(org.requests, user.requests),
    tokens: tighter(org.tokens, user.tokens),
    cost: tighter(org.cost, user.cost),
    files: tighter(org.files, user.files),
  };
}

function isWithinLimits(remaining: {
  requests?: number;
  tokens?: number;
  cost?: number;
  files?: number;
}): boolean {
  return (
    (remaining.requests ?? Number.POSITIVE_INFINITY) >= 0 &&
    (remaining.tokens ?? Number.POSITIVE_INFINITY) >= 0 &&
    (remaining.cost ?? Number.POSITIVE_INFINITY) >= 0 &&
    (remaining.files ?? Number.POSITIVE_INFINITY) >= 0
  );
}

export async function checkQuota(
  organizationId: string,
  request: QuotaCheckRequest,
  options: CheckQuotaOptions = {}
): Promise<QuotaCheckResult> {
  const period = request.period ?? DEFAULT_PERIOD;
  const userId = normalizeScope(request.userId);
  const loadQuota = (scopeUserId: string | null) =>
    options.createIfMissing === false
      ? getCurrentQuotaOrUnlimited(organizationId, period, scopeUserId)
      : getOrCreateCurrentQuota(organizationId, period, scopeUserId);

  const requested = {
    requests: request.operation?.requests ?? 0,
    tokens: request.operation?.tokens ?? 0,
    cost: request.operation?.cost ?? 0,
    files: request.operation?.files ?? 0,
  };

  // ── Per-user quota semantics — CONFIRMED (cross-repo quota/tier follow-up,
  // item 2a) ──────────────────────────────────────────────────────────────
  // A per-user quota is applied here as an ADDITIVE restriction on top of the
  // organization's limit: BOTH must be respected. A user is blocked once
  // EITHER their own row's limit is exceeded OR the organization aggregate's
  // limit is exceeded, whichever trips first — a per-user row is never a
  // substitute for the org check, and never lets a user bypass the org cap.
  //
  // This was shipped as a documented, unconfirmed assumption in Phase 3; it
  // is now the confirmed design, for two independent reasons:
  //
  // 1. Market pattern: `ci` is an organization's OWN internal AI gateway —
  //    one org's employees sharing one org-level plan/budget — not a public
  //    multi-org marketplace reselling metered capacity to unrelated
  //    customers (the shape "partition/allocation" quota models like OpenAI
  //    Projects or Azure OpenAI capacity carve-outs are built for). The
  //    dominant pattern for THIS shape — an internal multi-tenant LLM
  //    gateway/proxy shared by one organization's own users — is the
  //    dual-cap/additive model (both a per-user AND a per-org/team budget
  //    enforced together), the same approach LiteLLM/Portkey/Helicone-style
  //    gateways use for `user_id` + `team_id` budgets: a user's own budget
  //    is an ADDITIONAL ceiling under their team's, never a replacement for
  //    it. `ci`'s per-user row is the same relationship to its org row.
  // 2. No live conflict is even possible today: `POST /v1/enterprise/quotas`
  //    (routes/enterprise/quotas-routes.ts), the only admin-facing quota
  //    configuration endpoint, has no `userId` field in its request schema —
  //    there is no way to configure a REAL per-user limit through any
  //    exposed API yet. Every per-user row that exists is the auto-created
  //    unlimited default from `getOrCreateCurrentQuota`, so `combineRemaining`
  //    always resolves to the org limit in practice regardless of which
  //    semantics were chosen. Additive is simply the safer default to have
  //    on record for whenever a per-user configuration endpoint ships.
  const [orgQuota, userQuota] = await Promise.all([
    loadQuota(null),
    userId ? loadQuota(userId) : Promise.resolve(null),
  ]);

  const orgRemaining = calculateRemaining(orgQuota, requested);
  const userRemaining = userQuota ? calculateRemaining(userQuota, requested) : null;
  const remaining = combineRemaining(orgRemaining, userRemaining);

  const orgAllowed = isWithinLimits(orgRemaining);
  const userAllowed = userRemaining === null || isWithinLimits(userRemaining);
  const allowed = orgAllowed && userAllowed;

  let reason: string | undefined;
  if (!allowed) {
    reason =
      !orgAllowed && !userAllowed
        ? 'Quota limits exceeded'
        : !userAllowed
          ? 'User quota limits exceeded'
          : 'Organization quota limits exceeded';
  }

  return {
    allowed,
    remaining,
    resetAt: orgQuota.periodEnd.toISOString(),
    reason,
  };
}

export async function recordQuotaUsage(
  organizationId: string,
  request: QuotaCheckRequest
): Promise<void> {
  const period = request.period ?? DEFAULT_PERIOD;
  const userId = normalizeScope(request.userId);

  const increments = {
    requestCount: { increment: request.operation?.requests ?? 0 },
    tokenCount: { increment: BigInt(request.operation?.tokens ?? 0) },
    costUsd: { increment: new Prisma.Decimal(request.operation?.cost ?? 0) },
    fileCount: { increment: request.operation?.files ?? 0 },
  };

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
  //
  // Phase 3: when a userId is present this now increments TWO independent
  // rows — the org-wide aggregate (unchanged, always written) and that
  // user's own row (written additionally) — mirroring checkQuota's additive
  // read. Independent rows, independent updates, so they run concurrently
  // rather than one after another.
  const orgQuota = await getOrCreateCurrentQuota(organizationId, period, null);
  await Promise.all([
    prisma.usageQuota.update({ where: { id: orgQuota.id }, data: increments }),
    userId
      ? getOrCreateCurrentQuota(organizationId, period, userId).then((userQuota) =>
          prisma.usageQuota.update({ where: { id: userQuota.id }, data: increments })
        )
      : Promise.resolve(),
  ]);
}

/**
 * Resets usage counters for the current period. Scoped to the org-wide
 * aggregate row only (`userId: null`) — preserves the exact pre-Phase-3
 * contract of this admin action rather than silently expanding a single
 * "reset the org's quota" call into also zeroing every user's individual
 * counters. Cascading a reset to per-user rows too is a reasonable future
 * option but is a deliberate, separate decision, not a side effect of this
 * migration.
 */
export async function resetQuota(
  organizationId: string,
  period: QuotaLimit['period'] = DEFAULT_PERIOD
): Promise<void> {
  const window = resolvePeriodWindow(period);

  await prisma.usageQuota.updateMany({
    where: {
      organizationId,
      userId: null,
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

/**
 * Reads the org-wide aggregate's usage for the current period. Pinned to
 * `userId: null` — without it, `findFirst` ordered only by `periodStart`
 * could just as easily return one user's row instead of the org aggregate
 * once per-user rows exist for the same organization/period, silently
 * changing what this has always reported.
 */
export async function getQuotaUsage(
  organizationId: string,
  period: QuotaLimit['period'] = DEFAULT_PERIOD
): Promise<QuotaUsage | null> {
  const quota = await prisma.usageQuota.findFirst({
    where: {
      organizationId,
      userId: null,
      period,
    },
    orderBy: { periodStart: 'desc' },
  });

  return quota ? mapUsageRecordToDto(quota) : null;
}

/**
 * `userId: null` reads the org-wide aggregate row; a real userId reads that
 * user's own row within the same organization/period. Both are the SAME
 * table under the partial unique indexes described on `UsageQuota` in
 * schema.prisma, so this one function serves either scope.
 */
async function findCurrentQuota(
  organizationId: string,
  period: QuotaLimit['period'],
  start: Date,
  userId: string | null = null
) {
  return await prisma.usageQuota.findFirst({
    where: {
      organizationId,
      userId,
      period,
      periodStart: {
        lte: start,
      },
      periodEnd: {
        gte: start,
      },
    },
  });
}

async function getOrCreateCurrentQuota(
  organizationId: string,
  period: QuotaLimit['period'],
  userId: string | null = null
) {
  const window = resolvePeriodWindow(period);

  const existing = await findCurrentQuota(organizationId, period, window.start, userId);

  if (existing) {
    return existing;
  }

  return await prisma.usageQuota.create({
    data: {
      organizationId,
      userId,
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

/**
 * Read-only counterpart of `getOrCreateCurrentQuota`. When no row exists for the
 * current window it synthesises the SAME shape the auto-created row would have
 * had (`requestLimit: INT_MAX`, no token/cost/file cap, zero counters) without
 * writing anything, so the resulting `QuotaCheckResult` is identical to what the
 * creating path would have produced — minus the INSERT. `userId` selects the
 * scope exactly as in `findCurrentQuota`/`getOrCreateCurrentQuota`.
 */
async function getCurrentQuotaOrUnlimited(
  organizationId: string,
  period: QuotaLimit['period'],
  userId: string | null = null
) {
  const window = resolvePeriodWindow(period);

  const existing = await findCurrentQuota(organizationId, period, window.start, userId);
  if (existing) {
    return existing;
  }

  return {
    periodEnd: window.end,
    requestLimit: INT_MAX,
    tokenLimit: null as bigint | null,
    costLimitUsd: null as Prisma.Decimal | null,
    fileLimit: null as number | null,
    requestCount: 0,
    tokenCount: BigInt(0),
    costUsd: new Prisma.Decimal(0),
    fileCount: 0,
  };
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
