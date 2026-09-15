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
 *
 * Deep-pagination ceiling (confirmed live 2026-09-14): beyond an offset of
 * roughly 21,957 rows, every page comes back with `data: []` while
 * `pagination.total_items`/`total_pages` keep reporting the full, unchanged
 * catalog size — reproducible across per_page values (100/500/1000) at the
 * same offset, and stable across immediate retries and all the way through
 * the vendor's own reported last page. This is very likely the vendor's
 * search/index backend hitting its own max pagination-depth window (common
 * for Elasticsearch/OpenSearch-style deep pagination) while its COUNT query
 * (used for total_items/total_pages) is unaffected. Because that ceiling
 * could shift between runs (index resize, backend fix, etc.), the loop below
 * does NOT treat "empty page" as "catalog exhausted" — it trusts the
 * vendor's own total_pages instead, logging empty-but-in-range pages as a
 * warning rather than stopping on them. See the getModels()/maxConsecutiveEmptyPages
 * comments below for the full reasoning and the separate safety net for a
 * vendor whose total_pages itself never converges.
 */

import { BaseProviderModelFetcher, type ProviderModel } from './provider-model-fetcher';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';
import { inferCapabilitiesFromModelId } from './model-capability-patterns.js';

const FEATHERLESS_USER_AGENT = 'ailin-ci-discovery/1.0 (+https://ailin.one)';
const PER_PAGE = 1000;
const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

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
  private readonly maxPages: number;
  private readonly maxConsecutiveEmptyPages: number;
  private readonly log = logger.child({ component: 'featherless-ai-fetcher' });

  constructor(
    apiKey: string,
    requestTimeoutMs = Number(process.env.FEATHERLESS_DISCOVERY_TIMEOUT_MS || '15000'),
    // Hard stop even if the API's own total_pages is somehow wrong/missing.
    // Confirmed live against production (read-only COUNT(*) against the database,
    // 2026-09-08): provider_id='featherless-ai' currently holds 22,150 rows.
    // The ceiling used to default to 100 pages (100k models) — an arbitrary
    // round-number stop with no documented safety margin (unlike, say, a
    // number derived from an observed catalog size + buffer), and already
    // BELOW the 150k-200k platform-wide scale target this file's own
    // discovery output feeds into. Same failure shape as the HF Hub fetcher's
    // fixed 60k cap and the Bytez fetcher's fixed 100k cap: a fixed ceiling
    // silently truncates the tail once the real catalog outgrows it, and
    // pagination-based discovery here would keep re-walking the same first N
    // pages forever, never reaching whatever sits past the cutoff. Raised to
    // 500 pages (500k models) — the same safety-valve order of magnitude
    // already used for HF_HUB_DISCOVERY_MAX_MODELS/BYTEZ_DISCOVERY_MAX_MODELS
    // — at zero runtime cost: the loop below still exits as soon as the API's
    // own `total_pages` is exhausted, so a real ~22k-row catalog still stops
    // after ~23 requests. Still env-overridable so raising it further never
    // requires a code change, and a warn-level log below makes it loud if a
    // run ever actually reaches it.
    maxPages = Number(process.env.FEATHERLESS_DISCOVERY_MAX_PAGES || '500'),
    // Safety valve for a vendor that reports `total_pages` but then never
    // stops returning empty pages (see the empty-page handling below) — caps
    // how many *consecutive* empty pages we tolerate before giving up early,
    // independent of maxPages. Confirmed live 2026-09-14 (per_page=1000):
    // featherless-ai's `/v1/models` has a deep-pagination ceiling around
    // offset ~21,957 — every page at or beyond that offset comes back with
    // `data: []` while `pagination.total_items`/`total_pages` keep reporting
    // the full, unchanged catalog size (49,587 items / 50 pages). That is a
    // genuine, reproducible run of ~28 consecutive empty pages (23 through
    // the real last page, 50) that must NOT be treated as "vendor is broken,
    // abort" — total_pages is the authoritative stop signal, so the loop
    // below walks all the way to page > total_pages regardless of how many
    // empty pages it sees along the way. This threshold exists only to catch
    // a *different* failure: total_pages itself being wrong/stuck (e.g. a
    // vendor regression that reports a wildly inflated total_pages forever)
    // — set comfortably above the ~28-page anomaly actually observed so it
    // never fires for that, but still short of the 500-page maxPages ceiling
    // so a truly broken vendor fails loud instead of silently burning 500
    // requests every single discovery run.
    maxConsecutiveEmptyPages = Number(
      process.env.FEATHERLESS_DISCOVERY_MAX_CONSECUTIVE_EMPTY_PAGES || '50'
    )
  ) {
    super();
    this.apiKey = apiKey;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxPages = maxPages;
    this.maxConsecutiveEmptyPages = maxConsecutiveEmptyPages;
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
    let consecutiveEmptyPages = 0;
    let abortedOnConsecutiveEmptyPages = false;

    for (let page = 1; page <= totalPages && page <= this.maxPages; page++) {
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

      // Re-read total_pages on every response (not just non-empty ones):
      // it is the vendor's own, authoritative "is there more data" signal,
      // and it can only be trusted if we keep refreshing it every page.
      const nextTotalPages = body.pagination?.total_pages;

      if (pageModels.length === 0) {
        // An empty page does NOT reliably mean "no more data" for this
        // vendor. Confirmed live 2026-09-14: featherless-ai's `/v1/models`
        // has a deep-pagination ceiling around offset ~21,957 — every page
        // at/after that offset comes back with `data: []` while
        // `pagination.total_items`/`total_pages` keep reporting the full,
        // unchanged catalog (49,587 items / 50 pages, including at the real
        // last page, 50). Stopping on the first empty page here used to
        // truncate the catalog to ~44% of its real size (~22k of ~49.5k
        // models). total_pages is what actually decides when to stop, so an
        // empty page inside that range is logged as an anomaly and treated
        // as transient — the loop keeps walking toward total_pages instead
        // of giving up.
        consecutiveEmptyPages++;
        totalPages = nextTotalPages || totalPages;

        if (consecutiveEmptyPages > this.maxConsecutiveEmptyPages) {
          // Distinct failure mode from the one above: this catches a vendor
          // whose total_pages itself never converges (stuck/inflated), which
          // would otherwise silently burn up to maxPages requests, all
          // empty, on every single discovery run.
          this.log.error(
            { page, totalPages, consecutiveEmptyPages, maxConsecutiveEmptyPages: this.maxConsecutiveEmptyPages },
            'Featherless AI discovery aborted: too many consecutive empty pages while ' +
              'total_pages still claims more data exists — vendor pagination looks broken'
          );
          abortedOnConsecutiveEmptyPages = true;
          break;
        }

        this.log.warn(
          { page, totalPages, consecutiveEmptyPages },
          'Featherless AI models page came back empty but total_pages says more data ' +
            'should exist; treating as a transient vendor anomaly and continuing pagination'
        );
        continue;
      }

      consecutiveEmptyPages = 0;
      all.push(...pageModels);
      totalPages = nextTotalPages || totalPages;
    }

    const out = all
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => this.transform(m));

    // capped: the API's own total_pages (re-read from the last successful
    // response) reports more pages than we were willing to walk — the tail
    // beyond maxPages was never fetched at all, not just left untransformed.
    const capped = totalPages > this.maxPages;
    const summary = {
      pagesFetched,
      totalPages: Math.min(totalPages, this.maxPages),
      received: all.length,
      emitted: out.length,
      capped,
      abortedOnConsecutiveEmptyPages,
    };
    // Landmine guard (mirrors the HF Hub fetcher fix, 2026-09-08): `capped:
    // true` means featherless-ai's real catalog now exceeds this discovery's
    // page ceiling and everything past it is silently unreachable by this
    // run (and every future run, since pagination always restarts at page
    // 1). Loud warn instead of routine info so a future truncation is
    // visible rather than repeating the exact bug shape the HF Hub fetcher's
    // 60k cap and the Bytez fetcher's 100k cap were fixed for.
    if (capped) {
      this.log.warn(
        summary,
        'Featherless AI discovery hit maxPages — the catalog now exceeds the safety ceiling ' +
          'and pages beyond it were never fetched; raise FEATHERLESS_DISCOVERY_MAX_PAGES'
      );
    } else {
      this.log.info(summary, 'Featherless AI discovery completed');
    }
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
