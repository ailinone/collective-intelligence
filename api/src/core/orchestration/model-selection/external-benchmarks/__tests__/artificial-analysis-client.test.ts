// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6 §7 — Artificial Analysis client unit tests.
 *
 * Uses an injected fetchFn so no network call leaves the test sandbox.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fetchArtificialAnalysisLlmModels,
  ARTIFICIAL_ANALYSIS_DEFAULT_ENDPOINT,
} from '@/core/orchestration/model-selection/external-benchmarks/artificial-analysis-client';

function makeResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

describe('01C.1B-J2-C-R6 — fetchArtificialAnalysisLlmModels', () => {
  it('throws when apiKey is missing', async () => {
    await expect(
      fetchArtificialAnalysisLlmModels({ apiKey: '', fetchFn: vi.fn() as never }),
    ).rejects.toThrow(/apiKey is required/i);
  });

  it('sends x-api-key header to the default endpoint', async () => {
    const fetchFn = vi.fn(async (url: string, opts: RequestInit | undefined) =>
      makeResponse({ status: 200, data: [{ id: 'm1', name: 'M1' }] }),
    );
    const result = await fetchArtificialAnalysisLlmModels({
      apiKey: 'aa-test-key-1234567890',
      fetchFn: fetchFn as never,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchFn.mock.calls[0]!;
    expect(url).toBe(ARTIFICIAL_ANALYSIS_DEFAULT_ENDPOINT);
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('aa-test-key-1234567890');
    expect(result.response.data).toHaveLength(1);
    expect(result.httpStatus).toBe(200);
  });

  it('captures rate-limit headers when present', async () => {
    const headers = {
      'x-ratelimit-limit': '1000',
      'x-ratelimit-remaining': '999',
      'x-ratelimit-reset': '60',
    };
    const fetchFn = vi.fn(async () =>
      makeResponse({ status: 200, data: [] }, { status: 200, headers }),
    );
    const result = await fetchArtificialAnalysisLlmModels({
      apiKey: 'k',
      fetchFn: fetchFn as never,
    });
    expect(result.rateLimit.limit).toBe('1000');
    expect(result.rateLimit.remaining).toBe('999');
    expect(result.rateLimit.reset).toBe('60');
  });

  it('rejects non-2xx responses and does NOT include the API key in the error', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ error: 'unauthorized' }, { status: 401 }),
    );
    const secret = 'aa-super-secret-key-xyz123456789';
    await expect(
      fetchArtificialAnalysisLlmModels({ apiKey: secret, fetchFn: fetchFn as never }),
    ).rejects.toMatchObject({ httpStatus: 401 });
    try {
      await fetchArtificialAnalysisLlmModels({ apiKey: secret, fetchFn: fetchFn as never });
    } catch (err) {
      const json = JSON.stringify(err, Object.getOwnPropertyNames(err as object));
      expect(json).not.toContain(secret);
    }
  });

  it('rejects when response body is not JSON', async () => {
    const fetchFn = vi.fn(async () => makeResponse('<html>not json</html>'));
    await expect(
      fetchArtificialAnalysisLlmModels({ apiKey: 'k', fetchFn: fetchFn as never }),
    ).rejects.toThrow(/not JSON/i);
  });

  it('rejects when data array is missing', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ status: 200, models: [] }));
    await expect(
      fetchArtificialAnalysisLlmModels({ apiKey: 'k', fetchFn: fetchFn as never }),
    ).rejects.toThrow(/missing data array/i);
  });

  it('respects custom endpoint and timeoutMs', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      makeResponse({ status: 200, data: [] }),
    );
    await fetchArtificialAnalysisLlmModels({
      apiKey: 'k',
      endpoint: 'https://example.test/api/v2/data/llms/models',
      timeoutMs: 1234,
      fetchFn: fetchFn as never,
    });
    expect((fetchFn.mock.calls[0]![0] as string)).toBe('https://example.test/api/v2/data/llms/models');
  });

  it('sanitizes API key out of network-error messages', async () => {
    const secret = 'aa-key-inline-987654321abcdef';
    const fetchFn = vi.fn(async () => {
      throw new Error(`network failure for header x-api-key=${secret}`);
    });
    try {
      await fetchArtificialAnalysisLlmModels({ apiKey: secret, fetchFn: fetchFn as never });
      throw new Error('should have thrown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(secret);
      expect(msg).toContain('[REDACTED_ARTIFICIAL_ANALYSIS_API_KEY]');
    }
  });
});
