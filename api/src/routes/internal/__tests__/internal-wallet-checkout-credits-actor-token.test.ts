// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for the Fase 4 signed-service-token migration of
 * POST /v1/internal/billing/checkout-credits (internal-wallet-routes.ts).
 *
 * Before this change, this was the one real ci -> billing caller that never
 * migrated off the static `Billing-Api-Secret-Key` alone — see
 * billing-entitlements-client.ts's OWN outbound call (GET /v1/plans/resolve),
 * which already attached the signed token. This test proves the checkout-
 * credits proxy now does the same, via the SAME shared helper
 * (services/billing-actor-token.ts) — so both real callers mint and cache one
 * token, not two independent copies of the same OAuth2 client_credentials
 * wiring.
 *
 * Hermetic: no real Redis/DB/network. `requireServiceAuth` and
 * `resolveOrProvisionActingUser` are stubbed (same seam
 * src/tests/security/billing-route-authz.test.ts uses for this exact route
 * module); the OAuth2 client-credentials provider is mocked at the same
 * boundary billing-entitlements-client.test.ts uses, so the REAL
 * getBillingActorHeaders logic runs end-to-end against a fake provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('@/api/middleware/internal-service-auth-middleware', () => ({
  requireServiceAuth: () => async () => {},
}));

const fakeUser = { organizationId: 'org-1', email: 'acting-user@example.com' };
const resolveOrProvisionActingUserMock = vi.fn(async () => fakeUser);
vi.mock('@/services/internal-acting-user', () => ({
  resolveOrProvisionActingUser: (...args: unknown[]) => resolveOrProvisionActingUserMock(...args),
}));

vi.mock('@/services/prepaid-wallet-gate', () => ({
  walletInstance: vi.fn(),
  isWalletGateEnabled: vi.fn(),
}));

const mockBuildAuthHeader = vi.fn();
const mockCreateProvider = vi.fn(() => ({
  getToken: vi.fn().mockResolvedValue('mock-actor-token'),
  buildAuthHeader: mockBuildAuthHeader,
  invalidate: vi.fn(),
}));
vi.mock('@/providers/_shared/oauth2-client-credentials', () => ({
  createOAuth2ClientCredentialsProvider: (...args: unknown[]) => mockCreateProvider(...args),
}));

import { internalWalletRoutes } from '@/routes/internal/internal-wallet-routes';
import { __resetBillingActorTokenForTests } from '@/services/billing-actor-token';

const ENV_VARS = [
  'BILLING_SERVICE_URL',
  'BILLING_API_SECRET_KEY',
  'CI_BILLING_CLIENT_OIDC_CLIENT_ID',
  'CI_BILLING_CLIENT_OIDC_CLIENT_SECRET',
  'CI_BILLING_CLIENT_OIDC_TOKEN_URL',
  'CI_BILLING_CLIENT_ALLOWED_AUDIENCES',
  'CI_BILLING_CLIENT_ALLOWED_SCOPES',
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
  mockBuildAuthHeader.mockReset();
  mockCreateProvider.mockClear();
  resolveOrProvisionActingUserMock.mockClear();
  __resetBillingActorTokenForTests();
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
  process.env.BILLING_SERVICE_URL = 'https://billing.internal.example';
  process.env.BILLING_API_SECRET_KEY = 'the-static-secret';
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
});

const BILLING_CHECKOUT_OK = { status: 'success', data: { url: 'https://stripe.example/checkout/1' } };

describe('POST /v1/internal/billing/checkout-credits — outbound billing auth', () => {
  it('sends only the static secret + x-tenant-id when no M2M client secret is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, BILLING_CHECKOUT_OK));
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/billing/checkout-credits',
      payload: { amountUsd: 10 },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://billing.internal.example/v1/billing/checkout/credits');
    const headers = init.headers as Record<string, string>;
    expect(headers['billing-api-secret-key']).toBe('the-static-secret');
    expect(headers['x-tenant-id']).toBe('org-1');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Acting-Tenant-Id']).toBeUndefined();
    expect(mockCreateProvider).not.toHaveBeenCalled();
  });

  it('additionally attaches the signed actor token + X-Acting-Tenant-Id when the M2M client is configured', async () => {
    process.env.CI_BILLING_CLIENT_OIDC_CLIENT_SECRET = 's3cr3t';
    mockBuildAuthHeader.mockResolvedValue({ Authorization: 'Bearer mock-actor-token' });

    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, BILLING_CHECKOUT_OK));
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/billing/checkout-credits',
      payload: { amountUsd: 10 },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // Both channels present at once — dual mode, never one replacing the other.
    expect(headers['billing-api-secret-key']).toBe('the-static-secret');
    expect(headers['x-tenant-id']).toBe('org-1');
    expect(headers.Authorization).toBe('Bearer mock-actor-token');
    expect(headers['X-Acting-Tenant-Id']).toBe('org-1');
  });

  it('still completes the call on the static secret alone when minting the actor token fails', async () => {
    process.env.CI_BILLING_CLIENT_OIDC_CLIENT_SECRET = 's3cr3t';
    mockBuildAuthHeader.mockRejectedValue(new Error('id unreachable'));

    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, BILLING_CHECKOUT_OK));
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/billing/checkout-credits',
      payload: { amountUsd: 10 },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['billing-api-secret-key']).toBe('the-static-secret');
    expect(headers.Authorization).toBeUndefined();
  });

  it('shares the same cached token provider as billing-entitlements-client for the same process', async () => {
    process.env.CI_BILLING_CLIENT_OIDC_CLIENT_SECRET = 's3cr3t';
    mockBuildAuthHeader.mockResolvedValue({ Authorization: 'Bearer mock-actor-token' });

    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, BILLING_CHECKOUT_OK));
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/v1/internal/billing/checkout-credits',
      payload: { amountUsd: 10 },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/internal/billing/checkout-credits',
      payload: { amountUsd: 5 },
    });
    await app.close();

    // One provider built (cached), even across two calls into this route.
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
  });
});
