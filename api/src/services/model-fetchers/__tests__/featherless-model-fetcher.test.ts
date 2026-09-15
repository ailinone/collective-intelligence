// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/logger', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // `child` itself is a plain function (NOT vi.fn()-wrapped): the fetcher's
  // constructor calls logger.child(...) once and stores the result, so this
  // factory must keep returning the same object across the whole file. A
  // vi.fn() wrapper here would get its implementation wiped by the
  // `vi.restoreAllMocks()` in afterEach (used below to reset the fetch spy),
  // which would make logger.child(...) return undefined after the first
  // test and crash every fetcher instantiated afterward.
  return { logger: { child: () => child, ...child } };
});

import { FeatherlessModelFetcher } from '@/services/model-fetchers/featherless-model-fetcher';
import { logger } from '@/utils/logger';

const mockLog = logger.child();

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
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page([{ id: 'a/m1' }], 1, 1));

    const fetcher = new FeatherlessModelFetcher('live-key');
    await fetcher.getModels();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.featherless.ai/v1/models?page=1&per_page=1000');
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBeTruthy();
    expect(headers['User-Agent']).not.toBe('node');
    expect(headers.Authorization).toBe('Bearer live-key');
  });

  it('does NOT stop on a mid-catalog page that comes back short of per_page (production regression)', async () => {
    // Regression: featherless-ai's live ~43.5k-model catalog returns
    // slightly-short-of-1000 pages even mid-crawl (confirmed against
    // production: page 2 came back with 998 of 1000, page 3 with 997) —
    // NOT just on the final page. An earlier version of this fetcher
    // treated any page with length < per_page as "the last page" and
    // stopped after page 2, capturing only ~1998 of ~43,591 models. Only a
    // genuinely EMPTY page (or total_pages being exhausted) should stop
    // pagination.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 998 }, (_, i) => ({ id: `p1/m${i}` })),
          1,
          3
        )
      )
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 997 }, (_, i) => ({ id: `p2/m${i}` })),
          2,
          3
        )
      )
      .mockResolvedValueOnce(page([{ id: 'p3/last' }], 3, 3));

    const fetcher = new FeatherlessModelFetcher('live-key');
    const models = await fetcher.getModels();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(models).toHaveLength(998 + 997 + 1);
    expect(models.at(-1)?.id).toBe('p3/last');
  });

  // Deep-pagination-ceiling regression (confirmed live 2026-09-14): a page
  // coming back empty does NOT reliably mean the catalog is exhausted for
  // this vendor — featherless-ai returns `data: []` for every page at/after
  // a deep-pagination offset ceiling while `pagination.total_pages` keeps
  // reporting the full, unchanged catalog (including at its own real last
  // page). Stopping on the first empty page used to truncate the catalog to
  // ~44% of its real size. total_pages is the authoritative stop signal now.
  describe('empty-page handling (does not trust "empty" over total_pages)', () => {
    it('does NOT stop on a mid-catalog empty page while total_pages says more data exists, and keeps accumulating models found after it', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          page(
            Array.from({ length: 1000 }, (_, i) => ({ id: `a/m${i}` })),
            1,
            3
          )
        )
        .mockResolvedValueOnce(page([], 2, 3))
        .mockResolvedValueOnce(page([{ id: 'p3/last' }], 3, 3));

      const fetcher = new FeatherlessModelFetcher('live-key');
      const models = await fetcher.getModels();

      // All 3 pages requested, including the one after the empty page.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(models).toHaveLength(1001);
      expect(models.at(-1)?.id).toBe('p3/last');
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, totalPages: 3, consecutiveEmptyPages: 1 }),
        expect.stringContaining('came back empty')
      );
    });

    it('stops correctly once page exceeds total_pages, even when the last page fetched was empty', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          page(
            Array.from({ length: 1000 }, (_, i) => ({ id: `a/m${i}` })),
            1,
            2
          )
        )
        .mockResolvedValueOnce(page([], 2, 2));

      const fetcher = new FeatherlessModelFetcher('live-key');
      const models = await fetcher.getModels();

      // page 3 > total_pages (2): the loop stops on its own without a 3rd
      // request, and without needing the consecutive-empty-pages safety net.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(models).toHaveLength(1000);
    });

    it('aborts with a clear error log after an unreasonable run of consecutive empty pages (vendor total_pages never converges)', async () => {
      // total_pages is reported as 1000 on every response and never drops,
      // simulating a vendor that never signals the real end of the catalog.
      // With a small maxConsecutiveEmptyPages override (4th ctor arg), the
      // safety net must trip well before maxPages (or the real total_pages)
      // is ever reached.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const requestedPage = Number(new URL(String(input)).searchParams.get('page'));
        if (requestedPage === 1) {
          return page([{ id: 'a/m0' }], 1, 1000);
        }
        return page([], requestedPage, 1000);
      });

      const fetcher = new FeatherlessModelFetcher('live-key', 15000, 500, 3);
      const models = await fetcher.getModels();

      // page 1 (data) + pages 2-5 (4 consecutive empty pages, exceeding the
      // override of 3) = 5 requests, then abort — nowhere near total_pages.
      expect(fetchSpy).toHaveBeenCalledTimes(5);
      expect(models).toHaveLength(1);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ consecutiveEmptyPages: 4, maxConsecutiveEmptyPages: 3 }),
        expect.stringContaining('too many consecutive empty pages')
      );
      expect(mockLog.info).not.toHaveBeenCalledWith(
        expect.anything(),
        'Featherless AI discovery completed'
      );
    });
  });

  it('stops pagination on a non-OK page response instead of throwing', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 1000 }, (_, i) => ({ id: `a/m${i}` })),
          1,
          3
        )
      )
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

  // maxPages ceiling (2026-09-08/09): this was `const MAX_PAGES = 100`, a
  // fixed module-level constant with no env override — an arbitrary
  // round-number stop, not a documented safety margin. Read-only COUNT(*)
  // against the production database confirms provider_id='featherless-ai' currently
  // holds 22,150 rows (~22% of the old 100-page/100k-model ceiling), so
  // headroom existed today but shrank as the catalog grows toward the
  // mandate's 150k-200k+ target — and there was no way to raise it without a
  // code change, nor any signal if a run ever silently hit it. Same failure
  // shape as the HF Hub fetcher's fixed 60k cap (hf-hub-model-fetcher.ts) and
  // the Bytez fetcher's fixed 100k parity cap. The default was subsequently
  // raised to 500 pages (500k models, see the "at least 150,000" test below)
  // to give the same order-of-magnitude headroom as those two fetchers.
  describe('maxPages ceiling (env-overridable + loud on hit)', () => {
    const ENV_KEY = 'FEATHERLESS_DISCOVERY_MAX_PAGES';
    const originalEnv = process.env[ENV_KEY];

    afterEach(() => {
      if (originalEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = originalEnv;
    });

    it('an explicit maxPages override (3rd constructor arg) stops pagination early', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(page([{ id: 'p1/m0' }], 1, 5))
        .mockResolvedValueOnce(page([{ id: 'p2/m0' }], 2, 5));

      const fetcher = new FeatherlessModelFetcher('live-key', 15000, 2);
      const models = await fetcher.getModels();

      // total_pages (5) exceeds the override (2): pagination stops at page 2
      // and never requests page 3+, even though the API says more exist.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(models).toHaveLength(2);
    });

    it('the ceiling is overridable via FEATHERLESS_DISCOVERY_MAX_PAGES with no constructor arg (env-overridable, no code change needed)', async () => {
      process.env[ENV_KEY] = '2';
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(page([{ id: 'p1/m0' }], 1, 5))
        .mockResolvedValueOnce(page([{ id: 'p2/m0' }], 2, 5));

      // No 3rd arg: picks up the env override via the constructor default.
      const fetcher = new FeatherlessModelFetcher('live-key');
      const models = await fetcher.getModels();

      expect(models).toHaveLength(2);
    });

    it('logs a warning (not just info) when a run actually hits the ceiling', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(page([{ id: 'p1/m0' }], 1, 5))
        .mockResolvedValueOnce(page([{ id: 'p2/m0' }], 2, 5));

      await new FeatherlessModelFetcher('live-key', 15000, 2).getModels();

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ capped: true, pagesFetched: 2 }),
        expect.stringContaining('FEATHERLESS_DISCOVERY_MAX_PAGES')
      );
      expect(mockLog.info).not.toHaveBeenCalledWith(
        expect.anything(),
        'Featherless AI discovery completed'
      );
    });

    it('logs at info (not warn) when the full catalog fits under the ceiling', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(page([{ id: 'p1/m0' }], 1, 1));

      await new FeatherlessModelFetcher('live-key', 15000, 5).getModels();

      expect(mockLog.warn).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ capped: false }),
        'Featherless AI discovery completed'
      );
    });

    // Scale-target headroom guard (2026-09-09): unlike the tests above, this
    // does NOT construct the fetcher with an explicit maxPages override, and
    // does NOT read/set FEATHERLESS_DISCOVERY_MAX_PAGES — it exercises the
    // REAL production default. Walks 151 pages (151,000 models), just past
    // the platform's 150k scale target and well past the OLD 100-page/100k
    // landmine, so this fails immediately if a future change ever lowers the
    // default back toward (or below) 150,000 models of headroom.
    it(
      'the real default (no override) does not truncate at 150,000 models (scale-target headroom)',
      async () => {
        const TOTAL_PAGES = 151;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
          const requestedPage = Number(new URL(String(input)).searchParams.get('page'));
          const models = Array.from({ length: 1000 }, (_, i) => ({
            id: `org/model-p${requestedPage}-${i}`,
          }));
          return page(models, requestedPage, TOTAL_PAGES);
        });

        const fetcher = new FeatherlessModelFetcher('live-key');
        const models = await fetcher.getModels();

        expect(models).toHaveLength(TOTAL_PAGES * 1000);
        expect(models.length).toBeGreaterThan(150000);
      },
      20000
    );
  });
});
