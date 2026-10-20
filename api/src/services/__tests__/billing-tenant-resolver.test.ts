// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for billing-tenant-resolver.ts.
 *
 * House pattern (billing-entitlements-client.test.ts): no real network
 * (global fetch stubbed per test), OAuth2 provider mocked at the shared
 * client-credentials seam, Prisma and Redis mocked at their module seams.
 *
 * Pins the contract clauses:
 *  - flag off => null / organizationId WITHOUT touching DB, Redis or network;
 *  - DB hit (write-through column) wins without Redis or network;
 *  - Redis positive hit wins when the column is empty;
 *  - Redis negative hit (known 404) short-circuits without a network call;
 *  - full miss => id lookup: 200 persists (write-through + positive cache)
 *    and returns the canonical tenant_id;
 *  - id 404 => negative-cached, no DB write, caller falls back;
 *  - id unreachable => null, NO negative cache (an outage is not a fact);
 *  - no userId => the network leg never runs (nothing to address id with);
 *  - the id M2M client is built with audience=ailin-id + scope=tenants:read
 *    (id REJECTS a client_credentials request without audience).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbFindUniqueMock, dbUpdateMock } = vi.hoisted(() => ({
  dbFindUniqueMock: vi.fn(),
  dbUpdateMock: vi.fn(),
}));
const { redisGetMock, redisSetexMock } = vi.hoisted(() => ({
  redisGetMock: vi.fn(),
  redisSetexMock: vi.fn(),
}));
const mockBuildAuthHeader = vi.fn();
const mockCreateProvider = vi.fn(() => ({
  getToken: vi.fn().mockResolvedValue('mock-id-token'),
  buildAuthHeader: mockBuildAuthHeader,
  invalidate: vi.fn(),
}));

vi.mock('@/database/client', () => ({
  prisma: {
    organization: {
      findUnique: (...args: unknown[]) => dbFindUniqueMock(...args),
      update: (...args: unknown[]) => dbUpdateMock(...args),
    },
  },
}));
vi.mock('@/cache/redis-client', () => ({
  getGlobalRedisClient: () => ({ get: redisGetMock, setex: redisSetexMock }),
}));
vi.mock('@/providers/_shared/oauth2-client-credentials', () => ({
  createOAuth2ClientCredentialsProvider: (...args: unknown[]) => mockCreateProvider(...args),
}));

import {
  billableTenantId,
  isBillingTenantMappingEnabled,
  resolveBillingTenantId,
  __resetBillingTenantResolverForTests,
} from '@/services/billing-tenant-resolver';

const ENV_VARS = [
  'BILLING_TENANT_MAPPING_ENABLED',
  'ID_INTERNAL_BASE_URL',
  'CI_ID_CLIENT_OIDC_CLIENT_ID',
  'CI_ID_CLIENT_OIDC_CLIENT_SECRET',
  'CI_ID_CLIENT_OIDC_TOKEN_URL',
  'CI_ID_CLIENT_ALLOWED_AUDIENCES',
  'CI_ID_CLIENT_ALLOWED_SCOPES',
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
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
  process.env.ID_INTERNAL_BASE_URL = 'http://id-api:5001';
  process.env.CI_ID_CLIENT_OIDC_CLIENT_SECRET = 'id-m2m-secret';
  __resetBillingTenantResolverForTests();

  dbFindUniqueMock.mockReset().mockResolvedValue(null);
  dbUpdateMock.mockReset().mockResolvedValue({});
  redisGetMock.mockReset().mockResolvedValue(null);
  redisSetexMock.mockReset().mockResolvedValue('OK');
  mockBuildAuthHeader.mockReset().mockResolvedValue({ Authorization: 'Bearer mock-id-token' });
  mockCreateProvider.mockClear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
  vi.unstubAllGlobals();
});

describe('isBillingTenantMappingEnabled', () => {
  it('is disabled by default', () => {
    expect(isBillingTenantMappingEnabled()).toBe(false);
  });

  it('is enabled only with the exact literal true', () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    expect(isBillingTenantMappingEnabled()).toBe(true);
    process.env.BILLING_TENANT_MAPPING_ENABLED = '1';
    expect(isBillingTenantMappingEnabled()).toBe(false);
  });
});

describe('billableTenantId', () => {
  it('flag off => organizationId unchanged, nothing touched (structural no-op)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(billableTenantId('org-1', 'user-1')).resolves.toBe('org-1');
    expect(dbFindUniqueMock).not.toHaveBeenCalled();
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DB hit (write-through column) wins — no Redis, no network', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    dbFindUniqueMock.mockResolvedValue({ billingTenantId: 'tenant-from-db' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(billableTenantId('org-1', 'user-1')).resolves.toBe('tenant-from-db');
    expect(dbFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-1' } })
    );
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Redis positive hit wins when the column is empty — no network', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    redisGetMock.mockImplementation(async (key: string) =>
      key === 'billing:tenant-mapping:org-1' ? 'tenant-from-redis' : null
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(billableTenantId('org-1', 'user-1')).resolves.toBe('tenant-from-redis');
    expect(redisGetMock).toHaveBeenCalledWith('billing:tenant-mapping:org-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Redis negative hit (known 404) short-circuits — falls back without a network call', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    redisGetMock.mockImplementation(async (key: string) =>
      key === 'billing:tenant-mapping:none:org-1' ? 'no-tenant' : null
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(billableTenantId('org-1', 'user-1')).resolves.toBe('org-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('full miss => id 200 => canonical tenant, persisted write-through + positive cache', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(200, { tenant_id: 'tenant-canonical', account_id: 'user-1' })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(billableTenantId('org-1', 'user-1')).resolves.toBe('tenant-canonical');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://id-api:5001/internal/tenants/by-account/user-1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mock-id-token');

    expect(dbUpdateMock).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { billingTenantId: 'tenant-canonical' },
    });
    expect(redisSetexMock).toHaveBeenCalledWith(
      'billing:tenant-mapping:org-1',
      expect.any(Number),
      'tenant-canonical'
    );
  });

  it('id 404 => negative-cached, nothing persisted, caller falls back to organizationId', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(404, { message: 'no tenant' })));

    await expect(billableTenantId('org-1', 'user-1')).resolves.toBe('org-1');
    expect(dbUpdateMock).not.toHaveBeenCalled();
    expect(redisSetexMock).toHaveBeenCalledWith(
      'billing:tenant-mapping:none:org-1',
      expect.any(Number),
      'no-tenant'
    );
  });

  it('id unreachable => fallback organizationId, and NO negative cache (an outage is not a fact)', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(billableTenantId('org-1', 'user-1')).resolves.toBe('org-1');
    expect(dbUpdateMock).not.toHaveBeenCalled();
    expect(redisSetexMock).not.toHaveBeenCalled();
  });

  it('no userId => the network leg never runs (nothing to address id with)', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(billableTenantId('org-1')).resolves.toBe('org-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unconfigured M2M secret => permanent fallback, provider never built', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    delete process.env.CI_ID_CLIENT_OIDC_CLIENT_SECRET;
    __resetBillingTenantResolverForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(billableTenantId('org-1', 'user-1')).resolves.toBe('org-1');
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveBillingTenantId', () => {
  it('flag off => null even when a mapping exists (the flag gates READS too)', async () => {
    dbFindUniqueMock.mockResolvedValue({ billingTenantId: 'tenant-from-db' });
    await expect(resolveBillingTenantId('org-1', 'user-1')).resolves.toBeNull();
  });

  it('tolerates the ApiResponse-wrapped shape {data:{tenant_id}}', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(200, { data: { tenant_id: 'tenant-wrapped' } }))
    );
    await expect(resolveBillingTenantId('org-1', 'user-1')).resolves.toBe('tenant-wrapped');
  });

  it('DB read failure degrades to the cache/network layers instead of throwing', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    dbFindUniqueMock.mockRejectedValue(new Error('db down'));
    redisGetMock.mockResolvedValue('tenant-from-redis');
    await expect(resolveBillingTenantId('org-1', 'user-1')).resolves.toBe('tenant-from-redis');
  });
});

describe('id M2M client configuration', () => {
  it('is built with audience=ailin-id and scope=tenants:read (id 400s without audience)', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(200, { tenant_id: 't' })));
    await resolveBillingTenantId('org-1', 'user-1');

    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
    const cfg = mockCreateProvider.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.authUrl).toBe('http://id-api:5001/oauth/token');
    expect(cfg.clientId).toBe('ailin-ci-id-client');
    expect(cfg.extraBodyParams).toEqual({ audience: 'ailin-id' });
    expect(cfg.scope).toBe('tenants:read');
  });

  it('token minting failure => null fallback, never throws', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    mockBuildAuthHeader.mockRejectedValue(new Error('id down'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(billableTenantId('org-1', 'user-1')).resolves.toBe('org-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
