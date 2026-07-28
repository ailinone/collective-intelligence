// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatherlessModelFetcher } from '@/services/model-fetchers/featherless-model-fetcher';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function page(models: Array<Record<string, unknown>>, currentPage: number, totalPages: number) {
  return jsonResponse({
    data: models,
    pagination: {
      current_page: currentPage,
      per_page: 1000,
      total_items: totalPages * 1000,
      total_pages: totalPages,
    },
  });
}

describe('featherless-model-fetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('paginates through every page reported by total_pages, accumulating all models', async () => {
    // Realistic shape: every page is a full 1000 except the last (mirrors
    // real featherless-ai pagination) — a short intermediate page is
    // covered separately below, where it's expected to short-circuit.
    const fullPage = (prefix: string) =>
      Array.from({ length: 1000 }, (_, i) => ({ id: `${prefix}/m${i}`, context_length: 4096 }));

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page(fullPage('p1'), 1, 3))
      .mockResolvedValueOnce(page(fullPage('p2'), 2, 3))
      .mockResolvedValueOnce(page([{ id: 'p3/last', context_length: 4096 }], 3, 3));

    const fetcher = new FeatherlessModelFetcher('live-key');
    const models = await fetcher.getModels();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(models).toHaveLength(2001);
    expect(models.at(-1)?.id).toBe('p3/last');
  });

  it('sends page and per_page=1000 query params plus an explicit non-default User-Agent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(page([{ id: 'a/m1' }], 1, 1));

    const fetcher = new FeatherlessModelFetcher('live-key');
    await fetcher.getModels();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.featherless.ai/v1/models?page=1&per_page=1000');
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBeTruthy();
    expect(headers['User-Agent']).not.toBe('node');
    expect(headers.Authorization).toBe('Bearer live-key');
  });

  it('stops early when a page returns fewer than per_page models, even if total_pages says otherwise', async () => {
    // Regression guard: trust the actual page size over a possibly-stale
    // total_pages value, so a mid-fetch catalog shrink can't cause an
    // infinite/over-long pagination loop.
    const short = Array.from({ length: 5 }, (_, i) => ({ id: `a/m${i}`, context_length: 4096 }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(page(short, 1, 5));

    const fetcher = new FeatherlessModelFetcher('live-key');
    const models = await fetcher.getModels();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(models).toHaveLength(5);
  });

  it('stops when a page comes back empty', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page(Array.from({ length: 1000 }, (_, i) => ({ id: `a/m${i}` })), 1, 3))
      .mockResolvedValueOnce(page([], 2, 3));

    const fetcher = new FeatherlessModelFetcher('live-key');
    const models = await fetcher.getModels();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(models).toHaveLength(1000);
  });

  it('stops pagination on a non-OK page response instead of throwing', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page(Array.from({ length: 1000 }, (_, i) => ({ id: `a/m${i}` })), 1, 3))
      .mockResolvedValueOnce(jsonResponse({}, 500));

    const fetcher = new FeatherlessModelFetcher('live-key');
    const models = await fetcher.getModels();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(models).toHaveLength(1000);
  });

  it('returns empty list when the key is missing or mock', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(await new FeatherlessModelFetcher('').getModels()).toEqual([]);
    expect(await new FeatherlessModelFetcher('sk-test-mock-123').getModels()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('converts pricing.input/output (already $ per 1M tokens) and infers capabilities from the model id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      page(
        [
          {
            id: 'recursal/EagleX_1-7T',
            context_length: 16384,
            model_class: 'rwkv5-7b',
            owned_by: 'Feather',
            pricing: { prompt: '0.0000001', completion: '0.0000002', input: 0.1, output: 0.2 },
          },
        ],
        1,
        1
      )
    );

    const fetcher = new FeatherlessModelFetcher('live-key');
    const models = await fetcher.getModels();

    expect(models).toHaveLength(1);
    const [model] = models;
    expect(model.id).toBe('recursal/EagleX_1-7T');
    expect(model.contextWindow).toBe(16384);
    expect(model.pricing.inputCostPer1M).toBe(0.1);
    expect(model.pricing.outputCostPer1M).toBe(0.2);
    expect(model.capabilities.length).toBeGreaterThan(0);
  });

  it('falls back to defaults for missing context_length and zero pricing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(page([{ id: 'a/no-metadata' }], 1, 1));

    const fetcher = new FeatherlessModelFetcher('live-key');
    const models = await fetcher.getModels();

    expect(models).toHaveLength(1);
    expect(models[0].contextWindow).toBe(8192);
    expect(models[0].pricing.inputCostPer1M).toBe(0);
    expect(models[0].pricing.outputCostPer1M).toBe(0);
  });

  it('drops entries with no id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      page([{ context_length: 4096 }, { id: 'a/valid' }], 1, 1)
    );

    const fetcher = new FeatherlessModelFetcher('live-key');
    const models = await fetcher.getModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('a/valid');
  });
});
