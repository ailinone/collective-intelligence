// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * plan-quota-gate.ts — the PLAN's daily request ceiling, enforced at admission.
 *
 * This is the enforcement half of "quota vem do PLANO" (audit 2026-09-29:
 * declared plan limits had a resolver and, since Caminho A, a consumption
 * counter — but nothing ever DENIED on them). The limit comes from
 * `/v1/plans/resolve` (`api_requests_daily`, billing PR "api_requests_daily —
 * plan-borne DAILY limit") through the cached, fail-open
 * billing-entitlements-client; the WINDOW is a per-(org, UTC-day) Redis
 * counter owned by THIS service — deliberately NOT the cumulative
 * `api_requests` Usage counter the ci reports to billing, which has no reset
 * semantics and would brick an org forever if enforced as-is.
 *
 * Safety posture (mirrors free-tier-quota-gate / anonymous-quota-gate):
 *  - `PLAN_QUOTA_ENFORCEMENT_ENABLED` unset/false (the shipped default) makes
 *    every entry point a structural no-op — the wire lands dark and is lit
 *    by a deploy-time flag after canary, like PREPAID_WALLET_GATE was.
 *  - No organizationId => nothing org-scoped to count; allow.
 *  - No entitlements (billing unreachable / not configured) => allow
 *    (fail-open) — plan QUOTA degrades to unlimited, never to hard-down.
 *  - Limit missing, null, zero or negative => allow: `api_requests_daily`
 *    absent from a plan means "no ceiling declared", and get_resource_limit
 *    is fail-closed to 0 in billing only for genuinely unknown resources —
 *    a 0 here is treated as "not configured", not "nothing allowed",
 *    because a mis-seeded plan feature must not lock every tenant out.
 *  - Redis errors => allow + structured log (fail-open; same house style as
 *    the other gates — a quota cache outage must not take the API down).
 *  - Over the limit => 429 `plan_quota_exceeded` with reset_at (next UTC
 *    midnight) and an upgrade hint — unless PLAN_QUOTA_ENFORCEMENT_MODE is
 *    "shadow", in which case the would-deny is logged
 *    (`plan_quota.shadow_denial`) and the request is served. No model
 *    swapping, no silent paid fallback — same trust pattern as the
 *    free-tier gate's 429.
 *
 * Consume ordering: callers must invoke this AFTER every other admission
 * gate has allowed the request (last check before execution), so requests
 * rejected elsewhere (governance, wallet, org quota) do not burn plan
 * allowance.
 */
import { getGlobalRedisClient } from '@/cache/redis-client';
import { getTenantEntitlements } from '@/services/billing-entitlements-client';
import { billableTenantId } from '@/services/billing-tenant-resolver';
import { logger } from '@/utils/logger';
import { noteFailOpen } from '@/utils/metrics';

const log = logger.child({ component: 'plan-quota-gate' });

const REDIS_KEY_PREFIX = 'plan_quota:api_requests_daily:';
const LIMIT_RESOURCE_TYPE = 'api_requests_daily';

export interface PlanDailyQuotaResult {
  /** false when the gate is dark (flag off / nothing to enforce). */
  enforced: boolean;
  allowed: boolean;
  limit?: number;
  remaining?: number;
  resetAt?: string;
}

export interface PlanQuotaDenialBody {
  error: { code: string; message: string; reset_at: string; limit: number };
}

export function isPlanQuotaEnforcementEnabled(): boolean {
  return process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED === 'true';
}

/**
 * `enforce` (default): an exhausted org gets the 429. `shadow`: the counter
 * still consumes (real-usage observation) and an exhausted org is LOGGED as a
 * would-deny but always allowed — the enforcement-readiness signal, same
 * rollout idiom as TARGET_POLICY_MODE / the orchestration gate's shadow mode.
 * Any unknown value behaves as `enforce`.
 */
function isPlanQuotaShadowMode(): boolean {
  return (process.env.PLAN_QUOTA_ENFORCEMENT_MODE ?? '').trim().toLowerCase() === 'shadow';
}

function utcDateStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function nextUtcMidnight(now: Date): Date {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

/**
 * Check + atomically consume one unit of the org's DAILY plan allowance.
 * Call only at the last admission step (see "Consume ordering" above).
 *
 * `userId` (optional) feeds the tenant-namespace resolution: with
 * BILLING_TENANT_MAPPING_ENABLED on, the entitlements lookup addresses
 * billing with the id-canonical tenant (where the plan actually lives)
 * instead of ci's own org UUID. Flag off / unresolved => `organizationId`,
 * byte-identical to the pre-resolver behavior. The Redis CONSUMER counter
 * below deliberately stays keyed on `organizationId`: it is ci's local
 * per-org admission state, not a billing-side key, and re-keying it at flag
 * flip would silently reset every org's counted day.
 */
export async function checkAndConsumePlanDailyQuota(
  organizationId: string | undefined,
  userId?: string
): Promise<PlanDailyQuotaResult> {
  if (!isPlanQuotaEnforcementEnabled() || !organizationId) {
    return { enforced: false, allowed: true };
  }

  let limit: number | null | undefined;
  try {
    const billingTenantId = await billableTenantId(organizationId, userId);
    const entitlements = await getTenantEntitlements(billingTenantId);
    limit = entitlements?.limits?.[LIMIT_RESOURCE_TYPE];
  } catch (error) {
    // getTenantEntitlements is fail-open by contract; this belt is for a
    // future refactor that lets an exception escape.
    log.warn(
      { error, organizationId },
      'plan quota entitlements lookup threw — allowing (fail-open)'
    );
    noteFailOpen('plan_quota_entitlements_throw', { organizationId });
    return { enforced: false, allowed: true };
  }

  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    // No ceiling declared for this plan (absent, null, or mis-seeded 0):
    // treat as unlimited — never lock every tenant on a seed mistake.
    log.debug(
      { organizationId, limit },
      'plan quota: no api_requests_daily limit declared — allowing'
    );
    return { enforced: false, allowed: true };
  }

  const now = new Date();
  const resetDate = nextUtcMidnight(now);
  const resetAt = resetDate.toISOString();
  const key = `${REDIS_KEY_PREFIX}${organizationId}:${utcDateStamp(now)}`;
  const ttlSeconds = Math.max(
    60,
    Math.ceil((resetDate.getTime() - now.getTime()) / 1000)
  );

  try {
    const redis = getGlobalRedisClient();
    const count = await redis.incr(key);
    // Self-healing TTL on every call, same rationale as the other gates.
    await redis.expire(key, ttlSeconds);

    if (count > limit) {
      if (isPlanQuotaShadowMode()) {
        // Structured would-deny line — the enforcement-readiness metric. The
        // request is still served; the counter keeps consuming so the shadow
        // window observes the REAL over-limit population.
        log.warn(
          { organizationId, count, limit, key, resetAt, mode: 'shadow' },
          'plan_quota.shadow_denial: org over the plan daily limit (observe-only, NOT enforced)'
        );
        return { enforced: false, allowed: true, limit, remaining: 0, resetAt };
      }
      log.info(
        { organizationId, count, limit, key },
        'plan daily request quota exceeded'
      );
      return { enforced: true, allowed: false, limit, remaining: 0, resetAt };
    }
    return {
      enforced: true,
      allowed: true,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
    };
  } catch (error) {
    log.warn(
      { error, organizationId },
      'plan quota counter failed — allowing (fail-open, never blocks on a cache outage)'
    );
    noteFailOpen('plan_quota_counter', { organizationId });
    return { enforced: false, allowed: true };
  }
}

/** The 429 body shape for an exhausted plan daily quota. */
export function planQuotaExceededBody(
  resetAt: string,
  limit: number
): PlanQuotaDenialBody {
  return {
    error: {
      code: 'plan_quota_exceeded',
      message: `This organization reached its plan's daily limit of ${limit} requests. The counter resets at ${resetAt}. Upgrade the plan to continue.`,
      reset_at: resetAt,
      limit,
    },
  };
}
