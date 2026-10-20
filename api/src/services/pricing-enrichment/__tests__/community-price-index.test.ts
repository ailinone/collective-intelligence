// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommunityPriceIndex,
  CommunityPriceIndexLoader,
  MAX_PLAUSIBLE_PER_1M,
  getCommunityPriceIndex,
} from '@/services/pricing-enrichment/community-price-index';

const TABLE = {
  sample_spec: { input_cost_per_token: 1 },
  'gpt-4o': {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.00000125,
    input_cost_per_token_batches: 0.00000125,
    output_cost_per_token_batches: 0.000005,
  },
  'together_ai/meta-llama/llama-3.3-70b-instruct-turbo': {
    input_cost_per_token: 0.00000088,
    output_cost_per_token: 0.00000088,
  },
  'bedrock/anthropic.claude-3-haiku-20240307-v1:0': {
    input_cost_per_token: 0.00000025,
    output_cost_per_token: 0.00000125,
  },
  'anthropic.claude-3-haiku-20240307-v1:0': {
    input_cost_per_token: 0.0000009,
    output_cost_per_token: 0.0000009,
  },
  'claude-sonnet-long': {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_creation_input_token_cost: 0.00000375,
    input_cost_per_token_above_200k_tokens: 0.000006,
    output_cost_per_token_above_200k_tokens: 0.0000225,
  },
  'image-only-model': { output_cost_per_image: 0.04 },
  'unit-error-model': { input_cost_per_token: 5, output_cost_per_token: 5 },
};

describe('CommunityPriceIndex.fromJson', () => {
  const index = CommunityPriceIndex.fromJson(TABLE);

  it('converts USD/token to USD per 1M tokens without float artefacts', () => {
    const hit = index.lookup('openai', 'gpt-4o');
    expect(hit?.price.inputCostPer1M).toBe(2.5);
    expect(hit?.price.outputCostPer1M).toBe(10);
  });

  it('carries cache, batch and long-context prices', () => {
    const gpt = index.lookup('openai', 'gpt-4o')?.price;
    expect(gpt?.cacheReadCostPer1M).toBe(1.25);
    expect(gpt?.batchInputCostPer1M).toBe(1.25);
    expect(gpt?.batchOutputCostPer1M).toBe(5);

    const sonnet = index.lookup('anthropic', 'claude-sonnet-long')?.price;
    expect(sonnet?.cacheWriteCostPer1M).toBe(3.75);
    expect(sonnet?.inputCostPer1MAbove200k).toBe(6);
    expect(sonnet?.outputCostPer1MAbove200k).toBe(22.5);
  });

  it('skips sample_spec, entries with no token price, and implausible prices', () => {
    expect(index.lookup('x', 'sample_spec')).toBeUndefined();
    expect(index.lookup('x', 'image-only-model')).toBeUndefined();
    expect(index.lookup('x', 'unit-error-model')).toBeUndefined();
    expect(MAX_PLAUSIBLE_PER_1M).toBeLessThan(5_000_000);
  });

  it('tolerates garbage input', () => {
    expect(CommunityPriceIndex.fromJson(null).size).toBe(0);
    expect(CommunityPriceIndex.fromJson([]).size).toBe(0);
    expect(CommunityPriceIndex.fromJson('nope').size).toBe(0);
  });
});

describe('CommunityPriceIndex.lookup', () => {
  const index = CommunityPriceIndex.fromJson(TABLE);

  it('prefers the provider-namespaced entry, then the exact one', () => {
    const bedrock = index.lookup('aws-bedrock', 'anthropic.claude-3-haiku-20240307-v1:0');
    expect(bedrock?.match).toBe('provider-prefixed');
    expect(bedrock?.price.inputCostPer1M).toBe(0.25);

    const generic = index.lookup('some-hub', 'anthropic.claude-3-haiku-20240307-v1:0');
    expect(generic?.match).toBe('exact');
    expect(generic?.price.inputCostPer1M).toBe(0.9);
  });

  it('falls back to the last path segment for org-namespaced hub names, tagged name-only', () => {
    const hit = index.lookup('edenai', 'openai/GPT-4o');
    expect(hit?.match).toBe('name-only');
    expect(hit?.sourceKey).toBe('gpt-4o');
    expect(hit?.price.inputCostPer1M).toBe(2.5);
  });

  it('is case-insensitive and ignores empty names', () => {
    expect(index.lookup('openai', 'GPT-4O')?.price.outputCostPer1M).toBe(10);
    expect(index.lookup('openai', '   ')).toBeUndefined();
  });

  it('returns undefined for models the table does not know', () => {
    expect(index.lookup('openai', 'totally-unknown-model')).toBeUndefined();
  });
});

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('CommunityPriceIndexLoader', () => {
  it('loads once and serves the cache until the TTL elapses, then refreshes', async () => {
    let clock = 1_000;
    const fetchImpl = vi.fn(async () => jsonResponse(TABLE));
    const loader = new CommunityPriceIndexLoader({
      url: 'https://example.test/prices.json',
      ttlMs: 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    expect((await loader.get())?.size).toBeGreaterThan(0);
    clock += 5_000;
    await loader.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 6_000;
    await loader.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(TABLE));
    const loader = new CommunityPriceIndexLoader({
      url: 'https://example.test/prices.json',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await Promise.all([loader.get(), loader.get(), loader.get()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the last good index when a refresh fails (fails open)', async () => {
    let clock = 0;
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error('network down');
      return jsonResponse(TABLE);
    });
    const loader = new CommunityPriceIndexLoader({
      url: 'https://example.test/prices.json',
      ttlMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    const first = await loader.get();
    clock += 5_000;
    fail = true;
    const second = await loader.get();
    expect(second).toBe(first);
  });

  it('returns undefined, never throws, when there is no good index and the fetch fails', async () => {
    const loader = new CommunityPriceIndexLoader({
      url: 'https://example.test/prices.json',
      fetchImpl: vi.fn(async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    });
    await expect(loader.get()).resolves.toBeUndefined();
  });

  it('rejects non-2xx responses and indexes with no usable entries', async () => {
    const http500 = new CommunityPriceIndexLoader({
      url: 'https://example.test/prices.json',
      fetchImpl: vi.fn(async () => jsonResponse({}, { ok: false, status: 500 })) as unknown as typeof fetch,
    });
    await expect(http500.get()).resolves.toBeUndefined();

    const empty = new CommunityPriceIndexLoader({
      url: 'https://example.test/prices.json',
      fetchImpl: vi.fn(async () => jsonResponse({ sample_spec: {} })) as unknown as typeof fetch,
    });
    await expect(empty.get()).resolves.toBeUndefined();
  });
});

describe('getCommunityPriceIndex gating', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it('never touches the network under NODE_ENV=test unless a URL is configured', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.COMMUNITY_PRICE_INDEX_URL;
    delete process.env.COMMUNITY_PRICING_ENRICHMENT_DISABLED;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(getCommunityPriceIndex()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honours the kill switch even when a URL is configured', async () => {
    process.env.COMMUNITY_PRICING_ENRICHMENT_DISABLED = 'true';
    process.env.COMMUNITY_PRICE_INDEX_URL = 'https://example.test/prices.json';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(getCommunityPriceIndex()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
