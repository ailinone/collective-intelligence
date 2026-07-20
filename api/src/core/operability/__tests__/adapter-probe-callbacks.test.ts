// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Adapter probe callbacks — factory + balance/listModels probes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildProbeCallbacks, buildProbeCallbacksMap, inferProbeErrorClass } from '../adapter-probe-callbacks';

describe('buildProbeCallbacks', () => {
  it('returns probeCredit for providers with known balance endpoints', () => {
    const cb = buildProbeCallbacks({ providerId: 'aihubmix', integrationClass: 'oai-compat-pure', baseUrl: 'https://aihubmix.com' });
    expect(cb.probeCredit).toBeDefined();
  });

  it('does NOT return probeCredit for unknown providers', () => {
    const cb = buildProbeCallbacks({ providerId: 'mystery', integrationClass: 'oai-compat-pure', baseUrl: 'https://example.com' });
    expect(cb.probeCredit).toBeUndefined();
  });

  it('returns listModels for oai-compat-pure with baseUrl', () => {
    const cb = buildProbeCallbacks({ providerId: 'foo', integrationClass: 'oai-compat-pure', baseUrl: 'https://api.example.com' });
    expect(cb.listModels).toBeDefined();
  });

  it('does NOT return listModels for native-anthropic (no /v1/models)', () => {
    const cb = buildProbeCallbacks({ providerId: 'anthropic', integrationClass: 'native-anthropic', baseUrl: 'https://api.anthropic.com' });
    expect(cb.listModels).toBeUndefined();
  });

  it('does NOT return listModels when baseUrl is missing', () => {
    const cb = buildProbeCallbacks({ providerId: 'foo', integrationClass: 'oai-compat-pure' });
    expect(cb.listModels).toBeUndefined();
  });

  it('never provides probeCredential (env-only is sufficient)', () => {
    const cb = buildProbeCallbacks({ providerId: 'aihubmix', integrationClass: 'oai-compat-pure', baseUrl: 'https://aihubmix.com' });
    expect(cb.probeCredential).toBeUndefined();
  });
});

describe('buildProbeCallbacksMap', () => {
  it('builds a keyed map for multiple providers', () => {
    const map = buildProbeCallbacksMap([
      { providerId: 'aihubmix', integrationClass: 'oai-compat-pure', baseUrl: 'https://aihubmix.com' },
      { providerId: 'anthropic', integrationClass: 'native-anthropic' },
    ]);
    expect(Object.keys(map)).toEqual(['aihubmix', 'anthropic']);
    expect(map.aihubmix.probeCredit).toBeDefined();
    expect(map.anthropic.probeCredit).toBeUndefined();
  });
});

describe('probeCredit (mocked fetch)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('returns has_credits when balance > 0', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ balance: 25.50 }),
    } as unknown as Response);

    const cb = buildProbeCallbacks({ providerId: 'aihubmix', integrationClass: 'oai-compat-pure', baseUrl: 'https://aihubmix.com' });
    const result = await cb.probeCredit!({ providerId: 'aihubmix', apiKey: 'sk-test', timeoutMs: 1000 });
    expect(result.status).toBe('has_credits');
    expect(result.balanceUsd).toBe(25.5);
  });

  it('returns exhausted when balance is zero', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ balance: 0 }),
    } as unknown as Response);

    const cb = buildProbeCallbacks({ providerId: 'cometapi', integrationClass: 'oai-compat-pure', baseUrl: 'https://api.cometapi.com' });
    const result = await cb.probeCredit!({ providerId: 'cometapi', apiKey: 'sk-test', timeoutMs: 1000 });
    expect(result.status).toBe('exhausted');
    expect(result.balanceUsd).toBe(0);
  });

  it('parses quota - used_quota shape (aihubmix-style)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ quota: 1000, used_quota: 950 }),
    } as unknown as Response);

    const cb = buildProbeCallbacks({ providerId: 'aihubmix', integrationClass: 'oai-compat-pure', baseUrl: 'https://aihubmix.com' });
    const result = await cb.probeCredit!({ providerId: 'aihubmix', apiKey: 'sk-test', timeoutMs: 1000 });
    expect(result.status).toBe('has_credits');
    expect(result.balanceUsd).toBe(50);
  });

  it('returns unknown on auth error (handled separately)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as unknown as Response);

    const cb = buildProbeCallbacks({ providerId: 'aihubmix', integrationClass: 'oai-compat-pure', baseUrl: 'https://aihubmix.com' });
    const result = await cb.probeCredit!({ providerId: 'aihubmix', apiKey: 'sk-bad', timeoutMs: 1000 });
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('auth_status_401');
  });

  it('returns unknown on probe error (network/parse)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const cb = buildProbeCallbacks({ providerId: 'aihubmix', integrationClass: 'oai-compat-pure', baseUrl: 'https://aihubmix.com' });
    const result = await cb.probeCredit!({ providerId: 'aihubmix', apiKey: 'sk-test', timeoutMs: 1000 });
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('probe_error');
  });
});

describe('listModels (mocked fetch)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses OAI-compat models response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        object: 'list',
        data: [
          { id: 'gpt-4', owned_by: 'openai', context_length: 8192 },
          { id: 'gpt-4o', owned_by: 'openai', context_window: 128000 },
        ],
      }),
    } as unknown as Response);

    const cb = buildProbeCallbacks({ providerId: 'openai', integrationClass: 'native-openai', baseUrl: 'https://api.openai.com' });
    const models = await cb.listModels!({ providerId: 'openai', apiKey: 'sk-test', timeoutMs: 1000 });
    expect(models).toHaveLength(2);
    expect(models[0].modelId).toBe('gpt-4');
    expect(models[0].contextWindow).toBe(8192);
    expect(models[1].contextWindow).toBe(128000);
  });

  it('throws on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    } as unknown as Response);

    const cb = buildProbeCallbacks({ providerId: 'openai', integrationClass: 'native-openai', baseUrl: 'https://api.openai.com' });
    await expect(cb.listModels!({ providerId: 'openai', apiKey: 'sk-bad', timeoutMs: 1000 })).rejects.toThrow(/HTTP 401/);
  });

  it('throws on missing data array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }), // wrong shape
    } as unknown as Response);

    const cb = buildProbeCallbacks({ providerId: 'openai', integrationClass: 'native-openai', baseUrl: 'https://api.openai.com' });
    await expect(cb.listModels!({ providerId: 'openai', apiKey: 'sk', timeoutMs: 1000 })).rejects.toThrow(/no_data_array/);
  });

  it('uses custom modelListPath when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: 'foo' }] }),
    } as unknown as Response);
    globalThis.fetch = fetchMock;

    const cb = buildProbeCallbacks({
      providerId: 'custom',
      integrationClass: 'oai-compat-pure',
      baseUrl: 'https://api.custom.io',
      modelListPath: '/api/models',
    });
    await cb.listModels!({ providerId: 'custom', apiKey: 'sk', timeoutMs: 1000 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.custom.io/api/models',
      expect.any(Object),
    );
  });
});

describe('inferProbeErrorClass', () => {
  it('maps 401 to auth_failed', () => {
    expect(inferProbeErrorClass(new Error('HTTP 401 Unauthorized'))).toBe('auth_failed');
  });
  it('maps 402 to insufficient_credit', () => {
    expect(inferProbeErrorClass(new Error('HTTP 402'))).toBe('insufficient_credit');
  });
  it('maps timeout to provider_timeout', () => {
    expect(inferProbeErrorClass(new Error('ETIMEDOUT'))).toBe('provider_timeout');
  });
  it('maps unknown to unknown_error', () => {
    expect(inferProbeErrorClass(new Error('something weird'))).toBe('unknown_error');
  });
});
