// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic unit tests for billing-usage-report-client.ts.
 *
 * Same house pattern as billing-entitlements-client.test.ts: no real
 * network (global fetch stubbed per test), OAuth2 provider mocked so actor
 * headers never need a second fetch mock. No Redis involved (this client
 * does not cache -- reports are cumulative, replays are idempotent by key).
 *
 * Covers the contract of the caller:
 *  * disabled by default (BILLING_USAGE_REPORT_ENABLED unset -> no fetch)
 *  * success posts the right payload shape (tenant_id/idempotency_key/reports)
 *  * 409 (race lost / replay under the same key) is SUCCESS for this caller
 *  * non-2xx and network failure return false and never throw
 *  * unconfigured URL/secret is a silent no-op
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { billableTenantIdMock } = vi.hoisted(() => ({
  billableTenantIdMock: vi.fn(async (organizationId: string) => organizationId),
}));

vi.mock('@/services/billing-tenant-resolver', () => ({
  billableTenantId: (...args: unknown[]) => billableTenantIdMock(...args),
  isBillingTenantMappingEnabled: () => process.env.BILLING_TENANT_MAPPING_ENABLED === 'true',
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
  isBillingUsageReportEnabled,
  reportUsageToBilling,
} from '@/services/billing-usage-report-client';
import { __resetBillingActorTokenForTests } from '@/services/billing-actor-token';

const ENV_VARS = [
  'BILLING_SERVICE_URL',
  'BILLING_API_SECRET_KEY',
  'BILLING_USAGE_REPORT_ENABLED',
  'BILLING_TENANT_MAPPING_ENABLED',
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
  process.env.BILLING_SERVICE_URL = 'http://billing-api:8000';
  process.env.BILLING_API_SECRET_KEY = 'test-secret';
  __resetBillingActorTokenForTests();
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
  vi.unstubAllGlobals();
});

describe('isBillingUsageReportEnabled', () => {
  it('is disabled by default', () => {
    expect(isBillingUsageReportEnabled()).toBe(false);
  });

  it('is enabled only with the exact literal true', () => {
    process.env.BILLING_USAGE_REPORT_ENABLED = 'true';
    expect(isBillingUsageReportEnabled()).toBe(true);
    process.env.BILLING_USAGE_REPORT_ENABLED = '1';
    expect(isBillingUsageReportEnabled()).toBe(false);
  });
});

describe('reportUsageToBilling', () => {
  it('posts the contract payload and returns true on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(200, { status: 'success', data: { idempotent: false, results: [] } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const ok = await reportUsageToBilling('org-1', 'req-1', [
      { resourceType: 'api_requests', amount: 1 },
    ]);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://billing-api:8000/v1/usage/report');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      tenant_id: 'org-1',
      idempotency_key: 'req-1',
      reports: [{ resource_type: 'api_requests', amount: 1 }],
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['billing-api-secret-key']).toBe('test-secret');
  });

  it('treats 409 as success (batch already applied under the same key)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(409, { status: 'error', message: 'idempotency conflict' })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      reportUsageToBilling('org-1', 'req-1', [{ resourceType: 'api_requests', amount: 1 }])
    ).resolves.toBe(true);
  });

  it('returns false on non-2xx without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(422, { status: 'error', message: 'unknown' }))
    );

    await expect(
      reportUsageToBilling('org-1', 'req-1', [{ resourceType: 'gibberish', amount: 1 }])
    ).resolves.toBe(false);
  });

  it('returns false on network failure without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(
      reportUsageToBilling('org-1', 'req-1', [{ resourceType: 'api_requests', amount: 1 }])
    ).resolves.toBe(false);
  });

  it('is a silent no-op when unconfigured', async () => {
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_API_SECRET_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      reportUsageToBilling('org-1', 'req-1', [{ resourceType: 'api_requests', amount: 1 }])
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects empty batches without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(reportUsageToBilling('org-1', 'req-1', [])).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reportUsageToBilling — tenant namespace mapping (BILLING_TENANT_MAPPING_ENABLED)', () => {
  it('flag off => tenant_id stays the ci organizationId (resolver answers with the org itself)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(200, { status: 'success', data: { idempotent: false, results: [] } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const ok = await reportUsageToBilling(
      'org-1',
      'req-1',
      [{ resourceType: 'api_requests', amount: 1 }],
      'user-1'
    );

    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).tenant_id).toBe('org-1');
    expect(billableTenantIdMock).toHaveBeenCalledWith('org-1', 'user-1');
  });

  it('flag on + resolver hit => tenant_id AND X-Acting-Tenant-Id both carry the canonical tenant', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    billableTenantIdMock.mockResolvedValue('tenant-canonical');
    process.env.CI_BILLING_CLIENT_OIDC_CLIENT_SECRET = 's3cr3t';
    mockBuildAuthHeader.mockResolvedValue({ Authorization: 'Bearer mock-actor-token' });
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(200, { status: 'success', data: { idempotent: false, results: [] } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const ok = await reportUsageToBilling(
      'org-1',
      'req-1',
      [{ resourceType: 'api_requests', amount: 1 }],
      'user-1'
    );

    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).tenant_id).toBe('tenant-canonical');
    const headers = init.headers as Record<string, string>;
    // Both tenant channels move together — billing's verify_service_token
    // cross-checks this header against the body's tenant_id and rejects a
    // mismatch.
    expect(headers['X-Acting-Tenant-Id']).toBe('tenant-canonical');
  });

  it('flag on + resolver miss (id down) => falls back to organizationId, call still happens', async () => {
    process.env.BILLING_TENANT_MAPPING_ENABLED = 'true';
    billableTenantIdMock.mockImplementation(async (organizationId: string) => organizationId);
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(200, { status: 'success', data: { idempotent: false, results: [] } })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      reportUsageToBilling('org-1', 'req-1', [{ resourceType: 'api_requests', amount: 1 }], 'user-1')
    ).resolves.toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).tenant_id).toBe('org-1');
  });
});
