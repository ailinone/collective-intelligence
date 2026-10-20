// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * plan-quota-gate — decision tests for the plan's daily request ceiling.
 *
 * The gate's CONTRACT (each test pins one clause of the module header):
 *  - flag off => structural no-op (the wire lands dark; nothing may consume
 *    or deny anything until PLAN_QUOTA_ENFORCEMENT_ENABLED is deployed on);
 *  - no org => allow (nothing org-scoped to count);
 *  - entitlements unavailable (fail-open client) or no api_requests_daily
 *    limit declared => allow — a mis-seeded plan feature must never lock
 *    every tenant out;
 *  - over the limit => deny with reset_at = next UTC midnight;
 *  - Redis failure => allow (a quota cache outage must not take the API
 *    down), same house style as the other admission gates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { incrMock, expireMock } = vi.hoisted(() => ({
  incrMock: vi.fn(),
  expireMock: vi.fn(),
}));
const { entitlementsMock } = vi.hoisted(() => ({
  entitlementsMock: vi.fn(),
}));
const { billableTenantIdMock } = vi.hoisted(() => ({
  billableTenantIdMock: vi.fn(),
}));

vi.mock('@/cache/redis-client', () => ({
  getGlobalRedisClient: () => ({ incr: incrMock, expire: expireMock }),
}));
vi.mock('@/services/billing-entitlements-client', () => ({
  getTenantEntitlements: entitlementsMock,
}));
vi.mock('@/services/billing-tenant-resolver', () => ({
  billableTenantId: (...args: unknown[]) => billableTenantIdMock(...args),
  isBillingTenantMappingEnabled: () => process.env.BILLING_TENANT_MAPPING_ENABLED === 'true',
}));

const { checkAndConsumePlanDailyQuota, planQuotaExceededBody } = await import(
  '../plan-quota-gate'
);

describe('plan-quota-gate decision tests', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED;
    delete process.env.PLAN_QUOTA_ENFORCEMENT_MODE;
    incrMock.mockReset();
    expireMock.mockReset().mockResolvedValue(1);
    entitlementsMock.mockReset();
    delete process.env.BILLING_TENANT_MAPPING_ENABLED;
    billableTenantIdMock.mockReset().mockImplementation(async (organizationId: string) => organizationId);
  });
  afterEach(() => {
    delete process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED;
    delete process.env.PLAN_QUOTA_ENFORCEMENT_MODE;
  });

  it('flag off is a structural no-op — nothing is consumed or denied', async () => {
    const r = await checkAndConsumePlanDailyQuota('org-1');
    expect(r).toEqual({ enforced: false, allowed: true });
    expect(incrMock).not.toHaveBeenCalled();
    expect(entitlementsMock).not.toHaveBeenCalled();
  });

  it('no organizationId => allow without touching anything', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    const r = await checkAndConsumePlanDailyQuota(undefined);
    expect(r).toEqual({ enforced: false, allowed: true });
    expect(entitlementsMock).not.toHaveBeenCalled();
  });

  it('no entitlements (billing unreachable, fail-open client) => allow', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    entitlementsMock.mockResolvedValue(null);
    const r = await checkAndConsumePlanDailyQuota('org-1');
    expect(r.allowed).toBe(true);
    expect(incrMock).not.toHaveBeenCalled();
  });

  it('no api_requests_daily limit declared (absent/null/0) => allow, never lock-out', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    for (const limits of [{}, { api_requests_daily: null }, { api_requests_daily: 0 }]) {
      entitlementsMock.mockResolvedValueOnce({ tenantId: 't', planId: 'p', source: 'subscription', limits });
      const r = await checkAndConsumePlanDailyQuota('org-1');
      expect(r.allowed).toBe(true, `limits=${JSON.stringify(limits)}`);
      expect(incrMock).not.toHaveBeenCalled();
    }
  });

  it('within the limit => allowed with remaining, and TTL is (re)set', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    entitlementsMock.mockResolvedValue({
      tenantId: 't', planId: 'sandbox', source: 'fallback_sandbox',
      limits: { api_requests_daily: 60 },
    });
    incrMock.mockResolvedValue(7);
    const r = await checkAndConsumePlanDailyQuota('org-1');
    expect(r).toMatchObject({ enforced: true, allowed: true, limit: 60, remaining: 53 });
    expect(incrMock).toHaveBeenCalledWith(
      expect.stringMatching(/^plan_quota:api_requests_daily:org-1:\d{4}-\d{2}-\d{2}$/)
    );
    expect(expireMock).toHaveBeenCalled();
  });

  it('over the limit => denied with reset_at at next UTC midnight', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    entitlementsMock.mockResolvedValue({
      tenantId: 't', planId: 'sandbox', source: 'fallback_sandbox',
      limits: { api_requests_daily: 60 },
    });
    incrMock.mockResolvedValue(61);
    const r = await checkAndConsumePlanDailyQuota('org-1');
    expect(r).toMatchObject({ enforced: true, allowed: false, limit: 60, remaining: 0 });
    expect(r.resetAt).toMatch(/T00:00:00\.000Z$/);
  });

  it('Redis failure => allow (fail-open, cache outage never downs the API)', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    entitlementsMock.mockResolvedValue({
      tenantId: 't', planId: 'sandbox', source: 'fallback_sandbox',
      limits: { api_requests_daily: 60 },
    });
    incrMock.mockRejectedValue(new Error('redis down'));
    const r = await checkAndConsumePlanDailyQuota('org-1');
    expect(r).toEqual({ enforced: false, allowed: true });
  });

  it('entitlements lookup throwing => allow (belt for a future fail-open regression)', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    entitlementsMock.mockRejectedValue(new Error('client regression'));
    const r = await checkAndConsumePlanDailyQuota('org-1');
    expect(r).toEqual({ enforced: false, allowed: true });
  });

  it('the 429 body names the limit and the reset instant', () => {
    const body = planQuotaExceededBody('2026-10-02T00:00:00.000Z', 60);
    expect(body.error.code).toBe('plan_quota_exceeded');
    expect(body.error.limit).toBe(60);
    expect(body.error.reset_at).toBe('2026-10-02T00:00:00.000Z');
    expect(body.error.message).toContain('60');
  });

  it('BILLING_TENANT_MAPPING_ENABLED on + resolver hit => entitlements asked for the canonical tenant, counter stays on the org', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    billableTenantIdMock.mockResolvedValue('tenant-canonical');
    entitlementsMock.mockResolvedValue({
      tenantId: 'tenant-canonical', planId: 'sandbox', source: 'subscription',
      limits: { api_requests_daily: 60 },
    });
    incrMock.mockResolvedValue(7);
    const r = await checkAndConsumePlanDailyQuota('org-1', 'user-1');

    expect(entitlementsMock).toHaveBeenCalledWith('tenant-canonical');
    expect(r).toMatchObject({ enforced: true, allowed: true, limit: 60, remaining: 53 });
    // The consumer counter is ci's LOCAL per-org admission state: it must NOT
    // move to the billing tenant namespace at flag flip (that would reset
    // every org's counted day).
    expect(incrMock).toHaveBeenCalledWith(
      expect.stringMatching(/^plan_quota:api_requests_daily:org-1:/)
    );
  });

  it('BILLING_TENANT_MAPPING_ENABLED on + resolver miss => entitlements fall back to the organizationId', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    billableTenantIdMock.mockImplementation(async (organizationId: string) => organizationId);
    entitlementsMock.mockResolvedValue({
      tenantId: 'org-1', planId: 'sandbox', source: 'fallback_sandbox',
      limits: { api_requests_daily: 60 },
    });
    incrMock.mockResolvedValue(1);
    await checkAndConsumePlanDailyQuota('org-1', 'user-1');
    expect(entitlementsMock).toHaveBeenCalledWith('org-1');
  });

  it('shadow mode over the limit => ALLOWED (would-deny observed), counter still consumes', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    process.env.PLAN_QUOTA_ENFORCEMENT_MODE = 'shadow';
    entitlementsMock.mockResolvedValue({
      tenantId: 't', planId: 'sandbox', source: 'subscription',
      limits: { api_requests_daily: 60 },
    });
    incrMock.mockResolvedValue(61);
    const r = await checkAndConsumePlanDailyQuota('org-1');
    // enforced:false so the call sites (they deny only on enforced && !allowed)
    // serve the request untouched.
    expect(r).toMatchObject({ enforced: false, allowed: true, limit: 60, remaining: 0 });
    expect(r.resetAt).toMatch(/T00:00:00\.000Z$/);
    // The shadow window must observe the REAL over-limit population: the
    // counter keeps consuming.
    expect(incrMock).toHaveBeenCalledTimes(1);
    expect(expireMock).toHaveBeenCalled();
  });

  it('shadow mode within the limit => normal allowed result', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    process.env.PLAN_QUOTA_ENFORCEMENT_MODE = 'shadow';
    entitlementsMock.mockResolvedValue({
      tenantId: 't', planId: 'sandbox', source: 'subscription',
      limits: { api_requests_daily: 60 },
    });
    incrMock.mockResolvedValue(7);
    const r = await checkAndConsumePlanDailyQuota('org-1');
    expect(r).toMatchObject({ enforced: true, allowed: true, limit: 60, remaining: 53 });
  });

  it('unknown mode value behaves as enforce (over the limit denies)', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_ENABLED = 'true';
    process.env.PLAN_QUOTA_ENFORCEMENT_MODE = 'observe';
    entitlementsMock.mockResolvedValue({
      tenantId: 't', planId: 'sandbox', source: 'subscription',
      limits: { api_requests_daily: 60 },
    });
    incrMock.mockResolvedValue(61);
    const r = await checkAndConsumePlanDailyQuota('org-1');
    expect(r).toMatchObject({ enforced: true, allowed: false, limit: 60 });
  });

  it('shadow mode with flag off stays a structural no-op', async () => {
    process.env.PLAN_QUOTA_ENFORCEMENT_MODE = 'shadow';
    const r = await checkAndConsumePlanDailyQuota('org-1');
    expect(r).toEqual({ enforced: false, allowed: true });
    expect(incrMock).not.toHaveBeenCalled();
    expect(entitlementsMock).not.toHaveBeenCalled();
  });
});
