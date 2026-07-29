// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Featherless AI Model Fetcher
 *
 * featherless-ai's `/v1/models` is silently paginated: calling it with no
 * query params returns an incomplete legacy-shaped `{ data: [...] }` body
 * (no `total`/`pagination` field to signal truncation — roughly half the
 * real catalog). Passing an explicit `?page=N` switches to the real,
 * documented pagination contract:
 *
 *   GET /v1/models?page=1&per_page=1000
 *   { data: [...], total: 43591, pagination: { current_page, per_page,
 *     total_items, total_pages } }
 *
 * (`per_page` is server-capped at 1000 — confirmed via a 400 validation
 * error above that.) The shared OpenAICompatibleHubModelFetcher makes a
 * single unparameterized request and has no pagination support at all, so
 * every other provider on that bridge would need it complicated for this
 * one provider's quirk — hence a dedicated fetcher instead, following the
 * same pattern as BytezNativeModelFetcher / CloudflareWorkersAIModelFetcher
 * for providers whose discovery contract doesn't fit the generic bridge.
 *
 * Also carries the same explicit-User-Agent fix as #208/#210: featherless's
 * Cloudflare edge silently 404s Node's default `User-Agent: node`.
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';
import { inferCapabilitiesFromModelId } from './model-capability-patterns.js';

const FEATHERLESS_USER_AGENT = 'ailin-ci-discovery/1.0 (+https://ailin.one)';
const PER_PAGE = 1000;
const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
// Hard stop even if the API's own total_pages is somehow wrong/missing —
// 43,591 models / 1000 per page is ~44; 100 pages (100k models) is a
// generous ceiling that still bounds worst-case request count.
const MAX_PAGES = 100;

interface FeatherlessPricing {
  input?: number;
  output?: number;
}

interface FeatherlessModelEntry {
  id?: string;
  context_length?: number;
  model_class?: string;
  owned_by?: string;
  pricing?: FeatherlessPricing;
  [k: string]: unknown;
}

interface FeatherlessModelsPage {
  data?: FeatherlessModelEntry[];
  pagination?: {
    current_page?: number;
    per_page?: number;
    total_items?: number;
    total_pages?: number;
  };
}

export class FeatherlessModelFetcher extends BaseProviderModelFetcher {
  protected providerName = 'featherless-ai';
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly log = logger.child({ component: 'featherless-ai-fetcher' });

  constructor(
    apiKey: string,
    requestTimeoutMs = Number(process.env.FEATHERLESS_DISCOVERY_TIMEOUT_MS || '15000')
  ) {
    super();
    this.apiKey = apiKey;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getModels(): Promise<ProviderModel[]> {
    if (!this.apiKey || this.isMockKey(this.apiKey)) {
      this.log.warn(
        { keyPresent: Boolean(this.apiKey) },
        'Featherless AI discovery skipped: no/mock key'
      );
      return [];
    }

    const all: FeatherlessModelEntry[] = [];
    let totalPages = 1;
    let pagesFetched = 0;

    for (let page = 1; page <= totalPages && page <= MAX_PAGES; page++) {
      const url = `https://api.featherless.ai/v1/models?page=${page}&per_page=${PER_PAGE}`;
      let body: FeatherlessModelsPage;
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': FEATHERLESS_USER_AGENT,
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });

        if (!response.ok) {
          this.log.warn(
            { page, status: response.status },
            'Featherless AI models page non-OK, stopping pagination'
          );
          break;
        }

        body = (await response.json()) as FeatherlessModelsPage;
      } catch (error) {
        this.log.warn(
          { page, error },
          'Featherless AI models page request failed, stopping pagination'
        );
        break;
      }

      const pageModels = Array.isArray(body.data) ? body.data : [];
      pagesFetched++;
      if (pageModels.length === 0) {
        // A genuinely empty page (0 items) always means "no more data",
        // regardless of what total_pages claims — trust this over the
        // pagination metadata. A page with FEWER than per_page items is NOT
        // treated as the end: featherless-ai's catalog is large and live,
        // so even non-final pages can come back a few items short (e.g.
        // 997-999 of 1000) — confirmed by direct reproduction. total_pages
        // (re-read below, driving the loop's own bound) is what actually
        // decides when to stop.
        break;
      }
      all.push(...pageModels);

      totalPages = body.pagination?.total_pages || totalPages;
    }

    const out = all
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => this.transform(m));

    this.log.info(
      {
        pagesFetched,
        totalPages: Math.min(totalPages, MAX_PAGES),
        received: all.length,
        emitted: out.length,
      },
      'Featherless AI discovery completed'
    );
    return out;
  }

  private transform(model: FeatherlessModelEntry): ProviderModel {
    const modelId = model.id as string;
    const contextWindow = this.positiveNumberOr(model.context_length, DEFAULT_CONTEXT_WINDOW);

    let capabilities: ModelCapability[] = ['chat', 'text_generation'];
    const inferred = inferCapabilitiesFromModelId(modelId);
    if (inferred) {
      capabilities = inferred.capabilities as ModelCapability[];
    }

    // pricing.input/output are already $ per 1M tokens (confirmed against
    // pricing.prompt/completion, which are the same values expressed as
    // $ per single token — e.g. input: 0.1 === prompt: "0.0000001" * 1e6).
    const inputCostPer1M = this.positiveNumberOr(model.pricing?.input, 0);
    const outputCostPer1M = this.positiveNumberOr(model.pricing?.output, 0);

    return {
      id: modelId,
      name: modelId,
      displayName: modelId,
      contextWindow,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities,
      pricing: {
        inputCostPer1M,
        outputCostPer1M,
        currency: 'USD',
      },
      metadata: {
        provider: this.providerName,
        modelClass: model.model_class,
        ownedBy: model.owned_by,
        pricingSource: inputCostPer1M > 0 || outputCostPer1M > 0 ? 'provider' : 'unknown',
        priceConfidence: inputCostPer1M > 0 || outputCostPer1M > 0 ? 'high' : 'low',
      },
    };
  }

  private positiveNumberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private isMockKey(key: string): boolean {
    const lc = key.toLowerCase();
    return lc.includes('mock') || lc.includes('test') || lc.includes('xxx') || lc === 'changeme';
  }
}
