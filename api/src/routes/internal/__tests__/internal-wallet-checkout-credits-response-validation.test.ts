// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression tests for runtime validation of the billing response consumed
 * by POST /v1/internal/billing/checkout-credits (internal-wallet-routes.ts).
 *
 * Before this change, the JSON body from `POST /v1/billing/checkout/credits`
 * was cast directly (`as { url?: string; session_id?: string }`) with no
 * runtime check — a malformed or shape-shifted billing response (missing
 * `url`, `url` as a non-string, an empty object, etc.) would silently
 * propagate as `{url: undefined}` with an HTTP 200, which the portal BFF
 * would then treat as a valid checkout redirect. This suite proves billing's
 * response is now validated (zod) and a bad shape fails loudly with a 502
 * instead of forwarding malformed data, while a well-formed response (flat
 * or wrapped in billing's `{data: {...}}` envelope) still passes through
 * unchanged.
 *
 * Hermetic: no real Redis/DB/network — same mocking seams as
 * internal-wallet-checkout-credits-actor-token.test.ts (requireServiceAuth,
 * resolveOrProvisionActingUser, prepaid-wallet-gate, and the OAuth2
 * client-credentials provider are all stubbed; `fetch` is stubbed per test).
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

vi.mock('@/providers/_shared/oauth2-client-credentials', () => ({
  createOAuth2ClientCredentialsProvider: vi.fn(() => ({
    getToken: vi.fn().mockResolvedValue('mock-actor-token'),
    buildAuthHeader: vi.fn().mockResolvedValue({}),
    invalidate: vi.fn(),
  })),
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

async function postCheckout(app: FastifyInstance, amountUsd = 10) {
  return app.inject({
    method: 'POST',
    url: '/v1/internal/billing/checkout-credits',
    payload: { amountUsd },
  });
}

beforeEach(() => {
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

describe('POST /v1/internal/billing/checkout-credits — billing response shape validation', () => {
  it('accepts a flat well-formed response ({url, session_id})', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeResponse(200, { url: 'https://stripe.example/checkout/1', session_id: 'cs_123' })
      )
    );

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://stripe.example/checkout/1', sessionId: 'cs_123' });
  });

  it('accepts a response wrapped in billing\'s ApiResponse envelope ({data: {url}})', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeResponse(200, { status: 'success', data: { url: 'https://stripe.example/checkout/2' } })
      )
    );

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://stripe.example/checkout/2', sessionId: undefined });
  });

  it('accepts a well-formed response without session_id (optional field)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(200, { url: 'https://stripe.example/checkout/3' }))
    );

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://stripe.example/checkout/3', sessionId: undefined });
  });

  it('rejects with 502 billing_invalid_response when url is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(200, { status: 'success', data: {} }))
    );

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: 'billing_invalid_response',
      message: 'Billing returned an unexpected response for the checkout session.',
    });
  });

  it('rejects with 502 billing_invalid_response when url is not a string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(200, { data: { url: 12345 } }))
    );

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('billing_invalid_response');
  });

  it('rejects with 502 billing_invalid_response when url is an empty string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(200, { url: '' })));

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('billing_invalid_response');
  });

  it('rejects with 502 billing_invalid_response when the success body is a bare array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(200, [])));

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('billing_invalid_response');
  });

  it('never forwards a malformed shape to the caller as if it were a 200 success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(200, { data: { unexpected: 'shape' } }))
    );

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).not.toBe(200);
    const body = res.json();
    expect(body.url).toBeUndefined();
  });

  it('still proxies a non-2xx billing status code+body verbatim (unaffected by the new validation)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(422, { error: 'invalid_amount' }))
    );

    const app = await buildApp();
    const res = await postCheckout(app);
    await app.close();

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'invalid_amount' });
  });
});
