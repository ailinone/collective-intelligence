// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for billing-entitlements-client.ts.
 *
 * No real Redis (getGlobalRedisClient mocked to an in-memory fake, matching
 * the house pattern used by free-tier-quota-gate.test.ts) and no real
 * network (global fetch stubbed per test; the OAuth2 client_credentials
 * provider module is mocked so token minting never needs a second fetch
 * mock).
 *
 * Covers exactly what the Fase 5 spec asks for: successful resolution via
 * billing (mocked), fallback to null on billing being unreachable/erroring/
 * timing out, and the Redis cache being respected (a second call within the
 * TTL never re-hits billing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

const fakeRedis = {
  async get(key: string): Promise<string | null> {
    return store.get(key) ?? null;
  },
  async setex(key: string, _ttlSeconds: number, value: string): Promise<'OK'> {
    store.set(key, value);
    return 'OK';
  },
};

vi.mock('@/cache/redis-client', () => ({
  getGlobalRedisClient: () => fakeRedis,
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

import {
  getTenantEntitlements,
  __resetBillingEntitlementsClientForTests,
} from '@/services/billing-entitlements-client';

const ENV_VARS = [
  'BILLING_SERVICE_URL',
  'BILLING_API_SECRET_KEY',
  'CI_BILLING_CLIENT_OIDC_CLIENT_ID',
  'CI_BILLING_CLIENT_OIDC_CLIENT_SECRET',
  'CI_BILLING_CLIENT_OIDC_TOKEN_URL',
  'CI_BILLING_CLIENT_ALLOWED_AUDIENCES',
  'CI_BILLING_CLIENT_ALLOWED_SCOPES',
  'BILLING_ENTITLEMENTS_CACHE_TTL_SECONDS',
  'BILLING_ENTITLEMENTS_TIMEOUT_MS',
] as const;

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

beforeEach(() => {
  store.clear();
  mockBuildAuthHeader.mockReset();
  mockCreateProvider.mockClear();
  __resetBillingEntitlementsClientForTests();
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
});

const FAKE_RESOLVE_BODY = {
  status: 'success',
  data: {
    tenant_id: 'org-1',
    plan_id: 'professional',
    source: 'subscription',
    limits: {
      members: 5,
      apps: 10,
      vector_space: 10,
      knowledge_rate_limit: 100,
      documents_upload_quota: 1000,
      annotation_quota_limit: 500,
    },
  },
};

describe('getTenantEntitlements — not configured', () => {
  it('returns null without ever calling fetch when BILLING_SERVICE_URL/BILLING_API_SECRET_KEY are unset', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await getTenantEntitlements('org-1');

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getTenantEntitlements — successful resolution', () => {
  beforeEach(() => {
    process.env.BILLING_SERVICE_URL = 'https://billing.internal.example';
    process.env.BILLING_API_SECRET_KEY = 'the-static-secret';
  });

  it('resolves and maps the billing response when the static secret alone is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, FAKE_RESOLVE_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getTenantEntitlements('org-1');

    expect(result).toEqual({
      tenantId: 'org-1',
      planId: 'professional',
      source: 'subscription',
      limits: {
        members: 5,
        apps: 10,
        vector_space: 10,
        knowledge_rate_limit: 100,
        documents_upload_quota: 1000,
        annotation_quota_limit: 500,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://billing.internal.example/v1/plans/resolve?tenant_id=org-1');
    const headers = init.headers as Record<string, string>;
    expect(headers['billing-api-secret-key']).toBe('the-static-secret');
    // No M2M client secret configured -> no Authorization header attached.
    expect(headers.Authorization).toBeUndefined();
    // Never configured a token provider since no client secret was set.
    expect(mockCreateProvider).not.toHaveBeenCalled();
  });

  it('attaches the M2M Bearer token and X-Acting-Tenant-Id when the actor client is configured', async () => {
    process.env.CI_BILLING_CLIENT_OIDC_CLIENT_SECRET = 's3cr3t';
    mockBuildAuthHeader.mockResolvedValue({ Authorization: 'Bearer mock-actor-token' });

    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, FAKE_RESOLVE_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getTenantEntitlements('org-1');

    expect(result?.planId).toBe('professional');
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
    const providerArgs = mockCreateProvider.mock.calls[0][0] as Record<string, unknown>;
    expect(providerArgs.clientId).toBe('ailin-ci-billing-client');
    expect(providerArgs.clientSecret).toBe('s3cr3t');
    expect(providerArgs.extraBodyParams).toEqual({ audience: 'ailin-billing' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer mock-actor-token');
    expect(headers['X-Acting-Tenant-Id']).toBe('org-1');
  });

  it('still calls billing on the static secret alone when minting the actor token fails', async () => {
    process.env.CI_BILLING_CLIENT_OIDC_CLIENT_SECRET = 's3cr3t';
    mockBuildAuthHeader.mockRejectedValue(new Error('id unreachable'));

    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, FAKE_RESOLVE_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getTenantEntitlements('org-1');

    expect(result?.planId).toBe('professional');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('getTenantEntitlements — network-unavailability fallback (never throws)', () => {
  beforeEach(() => {
    process.env.BILLING_SERVICE_URL = 'https://billing.internal.example';
    process.env.BILLING_API_SECRET_KEY = 'the-static-secret';
  });

  it('returns null on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(500, { error: 'boom' })));

    await expect(getTenantEntitlements('org-1')).resolves.toBeNull();
  });

  it('returns null (never throws) when fetch rejects (simulated timeout/network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('simulated timeout'))
    );

    await expect(getTenantEntitlements('org-1')).resolves.toBeNull();
  });

  it('returns null when the response body has an unexpected shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(200, { status: 'success', data: { oops: true } }))
    );

    await expect(getTenantEntitlements('org-1')).resolves.toBeNull();
  });
});

describe('getTenantEntitlements — cache', () => {
  beforeEach(() => {
    process.env.BILLING_SERVICE_URL = 'https://billing.internal.example';
    process.env.BILLING_API_SECRET_KEY = 'the-static-secret';
  });

  it('does not call fetch again for a second lookup of the same tenant within the TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, FAKE_RESOLVE_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const first = await getTenantEntitlements('org-1');
    const second = await getTenantEntitlements('org-1');

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls fetch again for a different tenant (cache is keyed per-tenant)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, FAKE_RESOLVE_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await getTenantEntitlements('org-1');
    await getTenantEntitlements('org-2');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
