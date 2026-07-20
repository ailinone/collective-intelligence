// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

type LogMock = {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
};

type ReplyHarness = {
  reply: FastifyReply;
  statusCode: number | null;
  payload: unknown;
  codeMock: ReturnType<typeof vi.fn>;
  sendMock: ReturnType<typeof vi.fn>;
};

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'GATEWAY_MIDDLEWARE_ENABLED',
  'QUOTA_SERVICE_URL',
  'QUOTA_SERVICE_URLS',
  'QUOTA_SERVICE_TIMEOUT',
  'GATEWAY_QUOTA_SKIP_ROUTES',
];

const originalEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of MANAGED_ENV_KEYS) {
    originalEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const previousValue = originalEnv[key];
    if (previousValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }

  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createRequest(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}): FastifyRequest {
  const log: LogMock = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };

  return {
    url: options.url,
    method: options.method ?? 'POST',
    headers: options.headers ?? {},
    query: options.query ?? {},
    log,
  } as unknown as FastifyRequest;
}

function createReply(): ReplyHarness {
  let statusCode: number | null = null;
  let payload: unknown;

  const reply = {} as FastifyReply;
  const codeMock = vi.fn((status: number) => {
    statusCode = status;
    return reply;
  });
  const sendMock = vi.fn((body: unknown) => {
    payload = body;
    return reply;
  });

  (reply as unknown as { code: typeof codeMock }).code = codeMock;
  (reply as unknown as { send: typeof sendMock }).send = sendMock;

  return {
    reply,
    get statusCode() {
      return statusCode;
    },
    get payload() {
      return payload;
    },
    codeMock,
    sendMock,
  };
}

async function loadGatewayMiddleware() {
  vi.resetModules();
  return await import('@/middleware/gateway_middleware');
}

describe('Gateway middleware', () => {
  it('skips external quota validation for enterprise quota management routes', async () => {
    process.env.NODE_ENV = 'production';
    process.env.GATEWAY_MIDDLEWARE_ENABLED = 'true';

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { quotaValidationHook } = await loadGatewayMiddleware();
    const request = createRequest({
      url: '/v1/enterprise/quotas/current?period=month',
      method: 'GET',
      headers: { authorization: 'Bearer test-token' },
    });
    const harness = createReply();

    await quotaValidationHook(request, harness.reply);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.codeMock).not.toHaveBeenCalled();
    expect(harness.sendMock).not.toHaveBeenCalled();
  });

  it('sends method in quota payload and retries fallback URLs when first candidate fails', async () => {
    process.env.NODE_ENV = 'production';
    process.env.GATEWAY_MIDDLEWARE_ENABLED = 'true';
    process.env.QUOTA_SERVICE_URL = 'http://invalid-host:5004';
    process.env.QUOTA_SERVICE_URLS = 'http://invalid-host:5004,http://quota-service:5004';
    process.env.QUOTA_SERVICE_TIMEOUT = '5000';

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND invalid-host'))
      .mockResolvedValueOnce({
        status: 200,
        json: vi.fn().mockResolvedValue({ allowed: true }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { quotaValidationHook } = await loadGatewayMiddleware();
    const request = createRequest({
      url: '/v1/chat/completions',
      method: 'POST',
      headers: { authorization: 'Bearer eval-token' },
    });
    const harness = createReply();

    await quotaValidationHook(request, harness.reply);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://invalid-host:5004/check');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://quota-service:5004/check');

    const secondCallInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const payload = JSON.parse(String(secondCallInit.body));
    expect(payload).toMatchObject({
      api_key: 'eval-token',
      route: '/v1/chat/completions',
      method: 'POST',
    });

    expect(harness.codeMock).not.toHaveBeenCalled();
    expect(harness.sendMock).not.toHaveBeenCalled();
  });

  // ─── Regression: /v1/hcra/health quota-skip allowlist (ADR-022) ────────────
  //
  // The runtime falsification that motivated these tests:
  //   GET /v1/hcra/health WITHOUT auth headers → 200 (correct: quota middleware
  //     short-circuits because there's no api_key/user_id to validate).
  //   GET /v1/hcra/health WITH junk Authorization/x-api-key → 503
  //     `quota_validation_error` (incorrect: the middleware tried to validate
  //     the junk credential against the upstream quota service).
  //
  // The fix is path-name-gating, not credential-presence-gating:
  // /v1/hcra/health belongs in DEFAULT_QUOTA_SKIP_ROUTES alongside the other
  // operational endpoints. These tests prove the bypass is positional (any
  // header content), and that the bypass does NOT leak to HCRA *product*
  // routes (which must continue to be quota-validated normally).

  it('skips external quota validation for /v1/hcra/health (no credentials)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.GATEWAY_MIDDLEWARE_ENABLED = 'true';

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { quotaValidationHook } = await loadGatewayMiddleware();
    const request = createRequest({
      url: '/v1/hcra/health',
      method: 'GET',
    });
    const harness = createReply();

    await quotaValidationHook(request, harness.reply);

    // Path-based skip: middleware never reaches upstream quota service.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.codeMock).not.toHaveBeenCalled();
    expect(harness.sendMock).not.toHaveBeenCalled();
  });

  it('skips quota validation for /v1/hcra/health EVEN WITH junk credentials (the gap)', async () => {
    // This is the falsifier — the original bug: the middleware short-circuited
    // when no creds were present, but tried to validate when junk creds were.
    // After the fix, the path-based skip wins regardless of header content.
    process.env.NODE_ENV = 'production';
    process.env.GATEWAY_MIDDLEWARE_ENABLED = 'true';

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { quotaValidationHook } = await loadGatewayMiddleware();
    const request = createRequest({
      url: '/v1/hcra/health',
      method: 'GET',
      headers: {
        authorization: 'Bearer junk-token-that-would-fail-validation',
        'x-api-key': 'ak_definitely_not_a_real_key',
      },
    });
    const harness = createReply();

    await quotaValidationHook(request, harness.reply);

    // The whole point: the bypass is positional, NOT credential-presence-gated.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.codeMock).not.toHaveBeenCalled();
    expect(harness.sendMock).not.toHaveBeenCalled();
  });

  it('does NOT bypass quota for HCRA *product* routes — gap fix must not leak', async () => {
    // Verify the bypass is scoped exclusively to /v1/hcra/health.
    // Product routes like /v1/hcra/capabilities must continue through normal
    // quota validation. Tests both the route-prefix-leak and the negative
    // assertion that the upstream quota service IS consulted.
    process.env.NODE_ENV = 'production';
    process.env.GATEWAY_MIDDLEWARE_ENABLED = 'true';
    process.env.QUOTA_SERVICE_URL = 'http://quota-service:5004';
    process.env.QUOTA_SERVICE_TIMEOUT = '5000';

    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: vi.fn().mockResolvedValue({ allowed: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { quotaValidationHook } = await loadGatewayMiddleware();
    const request = createRequest({
      url: '/v1/hcra/capabilities',
      method: 'GET',
      headers: { authorization: 'Bearer real-token' },
    });
    const harness = createReply();

    await quotaValidationHook(request, harness.reply);

    // Positive: upstream quota WAS called for the product route.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://quota-service:5004/check');
    // And the request was allowed through (quota.allowed=true mocked).
    expect(harness.codeMock).not.toHaveBeenCalled();
    expect(harness.sendMock).not.toHaveBeenCalled();
  });

  it('treats small timeout values as seconds to avoid accidental 5ms aborts', async () => {
    process.env.NODE_ENV = 'production';
    process.env.GATEWAY_MIDDLEWARE_ENABLED = 'true';
    process.env.QUOTA_SERVICE_URL = 'http://quota-service:5004';
    process.env.QUOTA_SERVICE_TIMEOUT = '5';

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const signal = init?.signal as AbortSignal | undefined;
      if (signal?.aborted) {
        const error = new Error('aborted');
        (error as Error & { name: string }).name = 'AbortError';
        throw error;
      }
      return {
        status: 200,
        json: vi.fn().mockResolvedValue({ allowed: true }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { quotaValidationHook } = await loadGatewayMiddleware();
    const request = createRequest({
      url: '/v1/chat/completions',
      method: 'POST',
      headers: { authorization: 'Bearer eval-token' },
    });
    const harness = createReply();

    await quotaValidationHook(request, harness.reply);

    expect(harness.statusCode).toBeNull();
    expect(harness.payload).toBeUndefined();
  });
});

