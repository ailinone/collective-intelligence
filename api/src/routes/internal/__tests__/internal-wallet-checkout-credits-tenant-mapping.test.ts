// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Call-site test: POST /v1/internal/billing/checkout-credits under
 * BILLING_TENANT_MAPPING_ENABLED (billing-tenant-resolver.ts).
 *
 * Pins the flag contract at the route level:
 *  - flag off (the shipped default) => x-tenant-id AND X-Acting-Tenant-Id
 *    stay the acting user's organizationId — byte-identical to the
 *    pre-resolver behavior (internal-wallet-checkout-credits-actor-token.test.ts
 *    pins the same headers on the auth axis);
 *  - flag on + resolved => BOTH tenant channels carry the id-canonical tenant
 *    (billing's verify_service_token cross-checks the header against
 *    x-tenant-id; they must move together or the call is rejected);
 *  - flag on + unresolved (id down) => falls back to organizationId and the
 *    checkout still completes — the resolver may never become a new way for
 *    this call to fail.
 *
 * Hermetic: no real Redis/DB/network (same seams as the actor-token test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('@/api/middleware/internal-service-auth-middleware', () => ({
  requireServiceAuth: () => async () => {},
}));

const fakeUser = { id: 'user-1', organizationId: 'org-1', email: 'acting-user@example.com' };
const resolveOrProvisionActingUserMock = vi.fn(async () => fakeUser);
vi.mock('@/services/internal-acting-user', () => ({
  resolveOrProvisionActingUser: (...args: unknown[]) => resolveOrProvisionActingUserMock(...args),
}));

vi.mock('@/services/prepaid-wallet-gate', () => ({
  walletInstance: vi.fn(),
  isWalletGateEnabled: vi.fn(),
}));

const { billableTenantIdMock } = vi.hoisted(() => ({
  billableTenantIdMock: vi.fn(),
}));

vi.mock('@/services/billing-tenant-resolver', () => ({
  billableTenantId: (...args: unknown[]) => billableTenantIdMock(...args),
  isBillingTenantMappingEnabled: () => process.env.BILLING_TENANT_MAPPING_ENABLED === 'true',
}));

const mockBuildAuthHeader = vi.fn();
vi.mock('@/providers/_shared/oauth2-client-credentials', () => ({
  createOAuth2ClientCredentialsProvider: () => ({
    getToken: vi.fn().mockResolvedValue('mock-actor-token'),
    buildAuthHeader: mockBuildAuthHeader,
    invalidate: vi.fn(),
  }),
}));

import { internalWalletRoutes } from '@/routes/internal/internal-wallet-routes';
import { __resetBillingActorTokenForTests } from '@/services/billing-actor-token';

const ENV_VARS = [
  'BILLING_SERVICE_URL',
  'BILLING_API_SECRET_KEY',
  'BILLING_TENANT_MAPPING_ENABLED',
  'CI_BILLING_CLIENT_OIDC_CLIENT_SECRET',
] as const;

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await internalWalletRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
  process.env.BILLING_SERVICE_URL = 'https://billing.internal.example';
  process.env.BILLING_API_SECRET_KEY = 'the-static-secret';
  billableTenantIdMock.mockReset().mockImplementation(async (organizationId: string) => organizationId);
  mockBuildAuthHeader.mockReset();
  __resetBillingActorTokenForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
});

async function postCheckout(app: FastifyInstance): Promise<{ statusCode: number; headers: Record<string, string> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/internal/billing/checkout-credits',
    payload: { amountUsd: 10 },
  });
  return { statusCode: res.statusCode, headers: res.headers as unknown as Record<string, string> };
}

// Small indirection so the fetch stub is reachable in assertions.
let fetchMock: ReturnType<typeof vi.fn>;
const stubFetch = (impl: Parameters<typeof vi.fn>[0]) => {
  fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

function extractFetchHeaders(): Record<string, string> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return init.headers as Record<string, string>;
}

const BILLING_CHECKOUT_OK = { status: 'success', data: { url: 'https://stripe.example/checkout/1' } };

describe('POST /v1/internal/billing/checkout-credits — tenant namespace mapping', () => {
  it('flag off => both tenant channels stay the organizationId (structural no-op)', async () => {
    const fetchMock = stubFetch(() => fakeResponse(200, BILLING_CHECKOUT_OK));

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = extractFetchHeaders();
    expect(headers['x-tenant-id']).toBe('org-1');
    expect(billableTenantIdMock).toHaveBeenCalledWith('org-1', 'user-1');
  });

  it('flag on + resolved => x-tenant-id and X-Acting-Tenant-Id BOTH carry the canonical tenant', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    process.env.CI_BILLING_CLIENT_OIDC_CLIENT_SECRET = 's3cr3t';
    billableTenantIdMock.mockResolvedValue('tenant-canonical');
    mockBuildAuthHeader.mockResolvedValue({ Authorization: 'Bearer mock-actor-token' });
    const fetchMock = stubFetch(() => fakeResponse(200, BILLING_CHECKOUT_OK));

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(200);
    const headers = extractFetchHeaders();
    expect(headers['x-tenant-id']).toBe('tenant-canonical');
    expect(headers['X-Acting-Tenant-Id']).toBe('tenant-canonical');
    expect(headers.Authorization).toBe('Bearer mock-actor-token');
  });

  it('flag on + resolver miss (id down) => falls back to organizationId, checkout still completes', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    billableTenantIdMock.mockImplementation(async (organizationId: string) => organizationId);
    const fetchMock = stubFetch(() => fakeResponse(200, BILLING_CHECKOUT_OK));

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(200);
    const headers = extractFetchHeaders();
    expect(headers['x-tenant-id']).toBe('org-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
