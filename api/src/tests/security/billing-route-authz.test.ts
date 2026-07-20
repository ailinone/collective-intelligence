// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SEC-01 route-coverage test — authorization guards on billing / wallet routes.
 *
 * The RBAC middleware (`requirePermission`) exists and is enforced by default,
 * but that only matters if it is actually WIRED onto the privileged mutating
 * routes. This test inspects Fastify's route table (via the `onRoute` hook) for
 * the two owned route modules and asserts, structurally, that:
 *
 *   1. NO mutating (POST/PUT/PATCH/DELETE) route under the enterprise-billing or
 *      internal wallet/billing prefixes is left ungated — a future added-but-
 *      ungated mutating route makes this test (and therefore CI) fail.
 *   2. Every mutating ENTERPRISE billing route carries `requirePermission(
 *      'billing:update')` (JWT-principal RBAC).
 *   3. Sensitive billing READS carry `requirePermission('billing:read')`.
 *   4. Mutating INTERNAL (machine-to-machine) wallet/billing routes are
 *      authorized by the service-token scope / shared-secret guards — NOT by the
 *      JWT-principal `requirePermission` middleware, which would 401 every
 *      legitimate M2M caller (they carry no user principal).
 *
 * Hermetic: the authorization middlewares are mocked with tagged sentinels so we
 * can identify the guards in the route table without a DB (vitest.security).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// --- Seams ------------------------------------------------------------------
// Tag the RBAC guard so it is detectable in the route table without running the
// real (DB-backed) middleware. The permission string is preserved on the fn.
vi.mock('@/middleware/require-permission-middleware', () => ({
  requirePermission: (permission: string) =>
    Object.assign(async () => {}, { __rbacPermission: permission }),
  requireAnyPermission: (permissions: string[]) =>
    Object.assign(async () => {}, { __rbacPermission: permissions.join('|') }),
}));

// Tag the internal service-token guard likewise (its own deny-by-default authz).
vi.mock('@/api/middleware/internal-service-auth-middleware', () => ({
  requireServiceAuth: (scope: string) =>
    Object.assign(async () => {}, { __serviceGuard: scope }),
}));

// Lightweight stubs so importing the real route modules stays hermetic (no DB).
vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: async () => {},
}));
vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext: () => async () => {},
  getTenantContext: () => ({}),
}));
vi.mock('@/services/security-audit-service', () => ({
  recordSecurityEvent: vi.fn(),
}));
vi.mock('@/services/billing-service', () => ({
  createInvoice: vi.fn(),
  createSubscription: vi.fn(),
  getBillingConfig: vi.fn(),
  getInvoice: vi.fn(),
  listInvoices: vi.fn(),
  listSubscriptions: vi.fn(),
  markInvoicePaid: vi.fn(),
  upsertBillingConfig: vi.fn(),
  cancelSubscription: vi.fn(),
  listAvailableBillingPlans: vi.fn(),
  listPaymentMethodsForOrganization: vi.fn(),
  createSetupIntentForOrganization: vi.fn(),
  attachPaymentMethodToOrganization: vi.fn(),
  detachPaymentMethodFromOrganization: vi.fn(),
}));
vi.mock('@/services/internal-acting-user', () => ({
  resolveOrProvisionActingUser: vi.fn(),
}));
vi.mock('@/services/prepaid-wallet-gate', () => ({
  walletInstance: vi.fn(),
  isWalletGateEnabled: vi.fn(),
}));

import { registerEnterpriseBillingRoutes } from '@/routes/enterprise/billing-routes';
import { internalWalletRoutes } from '@/routes/internal/internal-wallet-routes';

type PreHandler = ((...args: unknown[]) => unknown) & {
  __rbacPermission?: string;
  __serviceGuard?: string;
  name?: string;
};

interface CapturedRoute {
  method: string;
  url: string;
  preHandlers: PreHandler[];
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BILLING_PREFIX = '/v1/enterprise/billing';
const INTERNAL_PREFIXES = ['/v1/internal/wallet', '/v1/internal/billing'];

const isBilling = (url: string): boolean => url.startsWith(BILLING_PREFIX);
const isInternal = (url: string): boolean => INTERNAL_PREFIXES.some((p) => url.startsWith(p));

const rbacPermissions = (route: CapturedRoute): string[] =>
  route.preHandlers
    .map((h) => h.__rbacPermission)
    .filter((p): p is string => typeof p === 'string');

const hasRbacGuard = (route: CapturedRoute): boolean => rbacPermissions(route).length > 0;

const hasServiceGuard = (route: CapturedRoute): boolean =>
  route.preHandlers.some(
    (h) => typeof h.__serviceGuard === 'string' || h.name === 'requireTopupSecret',
  );

const hasAnyGuard = (route: CapturedRoute): boolean => hasRbacGuard(route) || hasServiceGuard(route);

const routes: CapturedRoute[] = [];

beforeAll(async () => {
  const app: FastifyInstance = Fastify({ logger: false });

  app.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    const raw = routeOptions.preHandler;
    const preHandlers = (Array.isArray(raw) ? raw : raw ? [raw] : []) as unknown as PreHandler[];
    for (const method of methods) {
      routes.push({ method: String(method), url: routeOptions.url, preHandlers });
    }
  });

  // Registered directly (not via app.register) — the onRoute hook fires
  // synchronously as each route is added, so no app.ready() is required.
  await registerEnterpriseBillingRoutes(app);
  await internalWalletRoutes(app);
  await app.close();
});

describe('SEC-01 billing/wallet route authorization coverage', () => {
  it('discovers the billing and internal wallet route tables', () => {
    expect(routes.filter((r) => isBilling(r.url)).length).toBeGreaterThanOrEqual(14);
    expect(routes.filter((r) => isInternal(r.url)).length).toBeGreaterThanOrEqual(3);
  });

  it('leaves NO mutating billing/wallet route ungated (CI guard for future routes)', () => {
    const ungated = routes
      .filter((r) => MUTATING.has(r.method) && (isBilling(r.url) || isInternal(r.url)))
      .filter((r) => !hasAnyGuard(r))
      .map((r) => `${r.method} ${r.url}`);

    expect(ungated, `ungated mutating routes: ${ungated.join(', ') || '(none)'}`).toEqual([]);
  });

  it('gates every mutating enterprise billing route with billing:update', () => {
    const billingMutations = routes.filter((r) => MUTATING.has(r.method) && isBilling(r.url));

    expect(billingMutations.length).toBeGreaterThanOrEqual(8);
    for (const route of billingMutations) {
      expect(hasRbacGuard(route), `${route.method} ${route.url} missing requirePermission`).toBe(
        true,
      );
      expect(
        rbacPermissions(route),
        `${route.method} ${route.url} should require billing:update`,
      ).toContain('billing:update');
    }
  });

  it('gates sensitive billing reads with billing:read', () => {
    const sensitiveReads = [
      'GET /v1/enterprise/billing/config',
      'GET /v1/enterprise/billing/payment-methods',
      'GET /v1/enterprise/billing/invoices',
      'GET /v1/enterprise/billing/invoices/:invoiceId',
      'GET /v1/enterprise/billing/subscriptions',
    ];

    for (const key of sensitiveReads) {
      const [method, url] = key.split(' ');
      const route = routes.find((r) => r.method === method && r.url === url);
      expect(route, `route not found: ${key}`).toBeDefined();
      expect(rbacPermissions(route as CapturedRoute)).toContain('billing:read');
    }
  });

  it('authorizes mutating internal (M2M) wallet/billing routes via service guards, not RBAC', () => {
    const internalMutations = routes.filter((r) => MUTATING.has(r.method) && isInternal(r.url));

    expect(internalMutations.length).toBeGreaterThanOrEqual(2);
    for (const route of internalMutations) {
      expect(
        hasServiceGuard(route),
        `${route.method} ${route.url} missing service-token/secret guard`,
      ).toBe(true);
      // These routes carry no JWT principal, so the JWT-based requirePermission
      // must NOT be applied (it would 401 the legitimate M2M caller).
      expect(
        hasRbacGuard(route),
        `${route.method} ${route.url} must not use JWT requirePermission`,
      ).toBe(false);
    }
  });
});
