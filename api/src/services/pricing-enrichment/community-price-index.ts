// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Live community price index — fallback price source for catalog rows whose
 * provider does not publish a price.
 *
 * Why this exists (2026-10-02 audit): 10,479 of 14,156 active models outside
 * the two open-weight mega-catalogs (74%) were persisted at $0/$0, and the
 * OpenAI rows that did have a price carried a keyword-tier GUESS (gpt-4o at
 * $5/$15; real $2.50/$10 — 70% of the comparable guesses were >25% off).
 * `models.list()`-style endpoints simply do not return prices, and the schema
 * only had input/output columns, so cache and batch pricing was never
 * captured anywhere.
 *
 * The source is the community-maintained LiteLLM price table (public JSON,
 * ~4.5k entries). It is fetched at runtime, cached, and consulted ONLY when
 * the provider supplied no real price (see apply-community-pricing.ts). Nothing
 * about individual models is hardcoded here: the table is data, refreshed on a
 * TTL, and the whole feature fails open (no network, bad JSON, kill switch ->
 * discovery behaves exactly as before).
 *
 * LiteLLM prices are USD per token; the catalog speaks USD per 1M tokens.
 */
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'community-price-index' });

export const DEFAULT_COMMUNITY_PRICE_INDEX_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 30 * 1024 * 1024;

/**
 * No real published API price for token-billed models is known to exceed this
 * (most expensive current output is ~$600/Mtok); anything above it is treated
 * as a unit error in the source rather than a price.
 */
export const MAX_PLAUSIBLE_PER_1M = 1000;

export type CommunityPriceMatch = 'provider-prefixed' | 'exact' | 'name-only';

export interface CommunityPrice {
  inputCostPer1M: number;
  outputCostPer1M: number;
  cacheReadCostPer1M?: number;
  cacheWriteCostPer1M?: number;
  batchInputCostPer1M?: number;
  batchOutputCostPer1M?: number;
  inputCostPer1MAbove200k?: number;
  outputCostPer1MAbove200k?: number;
}

export interface CommunityPriceLookup {
  price: CommunityPrice;
  sourceKey: string;
  match: CommunityPriceMatch;
}

/**
 * Our provider id -> the namespace prefix(es) the community table uses for
 * that provider's hosted copies of a model. Only a key-namespace mapping, not
 * a model list.
 */
const PROVIDER_KEY_PREFIXES: Record<string, string[]> = {
  'aws-bedrock': ['bedrock', 'bedrock_converse'],
  'vertex-ai': ['vertex_ai'],
  google: ['gemini', 'vertex_ai'],
  'gemini-openai': ['gemini'],
  togetherai: ['together_ai'],
  'fireworks-ai': ['fireworks_ai'],
  'cloudflare-workers-ai': ['cloudflare'],
  'github-models': ['github'],
  'digitalocean': ['digitalocean'],
  nvidia: ['nvidia_nim'],
  novita: ['novita'],
  deepinfra: ['deepinfra'],
  openrouter: ['openrouter'],
  groq: ['groq'],
  mistral: ['mistral'],
  xai: ['xai'],
  anthropic: ['anthropic'],
  openai: ['openai'],
  cohere: ['cohere'],
  perplexity: ['perplexity'],
  deepseek: ['deepseek'],
  cerebras: ['cerebras'],
  sambanova: ['sambanova'],
  hyperbolic: ['hyperbolic'],
  moonshot: ['moonshot'],
  voyage: ['voyage'],
  jina: ['jina_ai'],
  replicate: ['replicate'],
  databricks: ['databricks'],
  nscale: ['nscale'],
  friendli: ['friendliai'],
};

interface StoredEntry {
  key: string;
  price: CommunityPrice;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function perMillion(perToken: unknown): number | undefined {
  const value = finitePositive(perToken);
  if (value === undefined) return undefined;
  return Number((value * 1_000_000).toFixed(6));
}

function toCommunityPrice(raw: Record<string, unknown>): CommunityPrice | undefined {
  const input = perMillion(raw.input_cost_per_token);
  const output = perMillion(raw.output_cost_per_token);
  if (input === undefined && output === undefined) return undefined;

  const price: CommunityPrice = {
    inputCostPer1M: input ?? 0,
    outputCostPer1M: output ?? 0,
  };
  if (price.inputCostPer1M > MAX_PLAUSIBLE_PER_1M || price.outputCostPer1M > MAX_PLAUSIBLE_PER_1M) {
    return undefined;
  }

  const extras: Array<[keyof CommunityPrice, number | undefined]> = [
    ['cacheReadCostPer1M', perMillion(raw.cache_read_input_token_cost)],
    ['cacheWriteCostPer1M', perMillion(raw.cache_creation_input_token_cost)],
    ['batchInputCostPer1M', perMillion(raw.input_cost_per_token_batches)],
    ['batchOutputCostPer1M', perMillion(raw.output_cost_per_token_batches)],
    ['inputCostPer1MAbove200k', perMillion(raw.input_cost_per_token_above_200k_tokens)],
    ['outputCostPer1MAbove200k', perMillion(raw.output_cost_per_token_above_200k_tokens)],
  ];
  for (const [field, value] of extras) {
    if (value !== undefined && value <= MAX_PLAUSIBLE_PER_1M) price[field] = value;
  }
  return price;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function lastSegment(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] ?? name;
}

export class CommunityPriceIndex {
  private readonly byKey = new Map<string, StoredEntry>();
  private readonly byLastSegment = new Map<string, StoredEntry>();

  static fromJson(json: unknown): CommunityPriceIndex {
    const index = new CommunityPriceIndex();
    if (!json || typeof json !== 'object' || Array.isArray(json)) return index;

    const entries = Object.entries(json as Record<string, unknown>)
      .filter(([key, value]) => key !== 'sample_spec' && value && typeof value === 'object')
      // Canonical first-party names ("gpt-4o") before host-namespaced copies
      // ("together_ai/..."), so the name-only fallback prefers them.
      .sort(([a], [b]) => a.split('/').length - b.split('/').length);

    for (const [rawKey, value] of entries) {
      const price = toCommunityPrice(value as Record<string, unknown>);
      if (!price) continue;
      const key = normalizeName(rawKey);
      const stored: StoredEntry = { key: rawKey, price };
      if (!index.byKey.has(key)) index.byKey.set(key, stored);
      const last = lastSegment(key);
      if (!index.byLastSegment.has(last)) index.byLastSegment.set(last, stored);
    }
    return index;
  }

  get size(): number {
    return this.byKey.size;
  }

  lookup(providerId: string, modelName: string): CommunityPriceLookup | undefined {
    const name = normalizeName(modelName);
    if (!name) return undefined;

    for (const prefix of PROVIDER_KEY_PREFIXES[providerId] ?? []) {
      const hit = this.byKey.get(`${prefix}/${name}`);
      if (hit) return { price: hit.price, sourceKey: hit.key, match: 'provider-prefixed' };
    }
    const exact = this.byKey.get(name);
    if (exact) return { price: exact.price, sourceKey: exact.key, match: 'exact' };

    const last = lastSegment(name);
    const byLast = this.byKey.get(last) ?? this.byLastSegment.get(last);
    if (byLast) return { price: byLast.price, sourceKey: byLast.key, match: 'name-only' };
    return undefined;
  }
}

export interface CommunityPriceIndexOptions {
  url?: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class CommunityPriceIndexLoader {
  private index: CommunityPriceIndex | undefined;
  private loadedAt = 0;
  private inflight: Promise<CommunityPriceIndex | undefined> | undefined;

  constructor(private readonly options: CommunityPriceIndexOptions = {}) {}

  private get url(): string {
    return (
      this.options.url ?? process.env.COMMUNITY_PRICE_INDEX_URL ?? DEFAULT_COMMUNITY_PRICE_INDEX_URL
    );
  }

  private get ttlMs(): number {
    const fromEnv = Number(process.env.COMMUNITY_PRICE_INDEX_TTL_MS);
    return this.options.ttlMs ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TTL_MS);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * The current index, refreshing it when the TTL has elapsed. Never throws:
   * on any failure it keeps serving the last good index (or `undefined` if
   * there never was one), so a GitHub outage cannot affect discovery.
   */
  async get(): Promise<CommunityPriceIndex | undefined> {
    if (this.index && this.now() - this.loadedAt < this.ttlMs) return this.index;
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async refresh(): Promise<CommunityPriceIndex | undefined> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(this.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_BODY_BYTES) throw new Error(`body too large (${text.length} bytes)`);
      const index = CommunityPriceIndex.fromJson(JSON.parse(text));
      if (index.size === 0) throw new Error('index parsed to zero usable entries');
      this.index = index;
      this.loadedAt = this.now();
      log.info({ entries: index.size }, 'Community price index refreshed');
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error), haveStale: Boolean(this.index) },
        'Community price index refresh failed; discovery continues without refreshing it'
      );
    }
    return this.index;
  }
}

let sharedLoader: CommunityPriceIndexLoader | undefined;

/**
 * Process-wide index for discovery. Disabled by COMMUNITY_PRICING_ENRICHMENT_DISABLED
 * (kill switch) and, in unit tests, unless a URL is configured explicitly so no
 * test ever reaches the network by accident.
 */
export async function getCommunityPriceIndex(): Promise<CommunityPriceIndex | undefined> {
  if (process.env.COMMUNITY_PRICING_ENRICHMENT_DISABLED === 'true') return undefined;
  if (process.env.NODE_ENV === 'test' && !process.env.COMMUNITY_PRICE_INDEX_URL) return undefined;
  sharedLoader ??= new CommunityPriceIndexLoader();
  return sharedLoader.get();
}
