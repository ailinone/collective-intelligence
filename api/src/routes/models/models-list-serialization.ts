// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Serialization + pagination core for GET /v1/models (and /v1/models/list).
 *
 * Why a separate module: the route handler in models-routes.ts statically pulls
 * in the entire provider-registry + database client + config chain. This module
 * deliberately depends ONLY on:
 *   - `@/types`                          (type-only at runtime)
 *   - `@/providers/provider-operability` (TYPE-ONLY — `import type`, erased)
 *   - `@/services/model-capability-inference`
 *   - `@/providers/catalog/consolidation-matrix`
 * all of which are dependency-light, so the row-shaping + pagination logic can
 * be unit-tested without a database, Docker, or live config. Keeping it pure
 * also guarantees the bounded (paginated) and streamed code paths emit
 * byte-identical rows, because both call the single `buildModelDto`.
 *
 * Background: serializing the full ~64k-row runnable catalog into one ~53MB
 * JSON string overran V8's old-space heap and crash-looped the container
 * (2026-06-10, exit 139). The endpoint now defaults to a bounded page and only
 * streams the full set on explicit `?all=true`, so peak memory stays O(page)
 * or O(1 row) instead of O(catalog).
 */

import type { Model, ModelCapability } from '@/types';
import type { ModelOperability } from '@/providers/provider-operability';
import type { AilinVirtualModelProfile } from '@/services/ailin-virtual-model-service';
import {
  extractModelModalities,
  inferEndpointCompatibility,
  inferSupportedEndpoints,
  type ModelOperationEndpoint,
} from '@/services/model-capability-inference';
import { getDiscoveryComplianceClass } from '@/providers/catalog/consolidation-matrix';

/** Default rows per page when `?limit=` is omitted. */
export const DEFAULT_PAGE_SIZE = 100;
/** Hard ceiling on `?limit=` so a single page can never re-create the OOM. */
export const MAX_PAGE_SIZE = 1000;

/** A catalog model paired with its resolved runtime operability. */
export type RankedEntry = { model: Model; operability: ModelOperability };

// ── Ailin first-party virtual aliases (ailin-auto, ailin-best, …) ────────────
// These are the platform's flagship presets: request-time orchestration aliases
// (defined in ailin-virtual-model-service.ts, resolved server-side in
// normalizeChatRequest), so they have NO DB catalog row and would otherwise be
// invisible to model selectors. To expose them on /v1/models with the exact
// serializer contract, we synthesize RankedEntry inputs and run them through
// the SAME buildModelDto used for catalog rows — shape parity is structural,
// not hand-maintained.

/** discoverySource stamped on alias rows so clients can tell them from DB catalog rows. */
export const AILIN_VIRTUAL_DISCOVERY_SOURCE = 'ailin-virtual';
/** Synthetic provider id for the first-party alias surface.
 *
 * Deliberately NOT plain 'ailin' — that id is already a real discovered hub
 * provider in the compliance matrix, and alias rows must not masquerade as
 * that provider's discovered inventory. */
export const AILIN_ALIAS_PROVIDER_ID = 'ailin-virtual';

/** Capability contributions per canonical endpoint token. */
const ALIAS_ENDPOINT_CAPABILITIES: Record<string, ModelCapability[]> = {
  chat_completions: ['chat', 'streaming', 'function_calling'],
  responses: ['chat', 'streaming', 'function_calling'],
  completions: ['chat', 'streaming'],
  audio_speech: ['text_to_speech'],
  audio_transcriptions: ['speech_to_text'],
  realtime: ['realtime'],
  embeddings: ['embedding'],
  images: ['image_generation'],
  videos: ['video_generation'],
};

/** Input/output modality contributions per canonical endpoint token. */
const ALIAS_ENDPOINT_MODALITIES: Record<string, { input: string[]; output: string[] }> = {
  chat_completions: { input: ['text'], output: ['text'] },
  responses: { input: ['text'], output: ['text'] },
  completions: { input: ['text'], output: ['text'] },
  audio_speech: { input: ['text'], output: ['audio'] },
  audio_transcriptions: { input: ['audio'], output: ['text'] },
  realtime: { input: ['audio'], output: ['audio'] },
  embeddings: { input: ['text'], output: ['text'] },
  images: { input: ['text'], output: ['image'] },
  videos: { input: ['text'], output: ['video'] },
};

/**
 * Project an Ailin virtual model profile into a RankedEntry that
 * `buildModelDto` serializes exactly like a catalog row. Unknown endpoint
 * tokens (e.g. custom env profiles) are ignored for capability/modality
 * derivation but still pass through `metadata.supportedEndpoints`, which the
 * endpoint-inference layer treats as explicit.
 */
export function buildAilinAliasEntry(profile: AilinVirtualModelProfile): RankedEntry {
  const capabilities = new Set<ModelCapability>();
  const inputModalities = new Set<string>();
  const outputModalities = new Set<string>();
  for (const endpoint of profile.endpoints) {
    for (const capability of ALIAS_ENDPOINT_CAPABILITIES[endpoint] ?? []) {
      capabilities.add(capability);
    }
    const modalities = ALIAS_ENDPOINT_MODALITIES[endpoint];
    if (modalities) {
      for (const item of modalities.input) inputModalities.add(item);
      for (const item of modalities.output) outputModalities.add(item);
    }
  }

  const model: Model = {
    id: profile.id,
    providerId: AILIN_ALIAS_PROVIDER_ID,
    provider: AILIN_ALIAS_PROVIDER_ID,
    // `name` is the string clients send as `model` — the bare alias id.
    name: profile.id,
    displayName: profile.displayName,
    // 0 = "not fixed": the concrete context/output envelope is decided per
    // request by the alias's orchestration strategy, not by the alias row.
    // Same for pricing — an alias's `maxCost` is a per-REQUEST budget, not
    // per-1M-token pricing, so it is NOT representable in the DTO's pricing
    // object; zeros here mean "dynamic", NOT "free" (the underlying model is
    // billed normally at request time).
    contextWindow: 0,
    maxOutputTokens: 0,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    capabilities: Array.from(capabilities),
    performance: { latencyMs: 0, throughput: 0, quality: 0, reliability: 0 },
    status: 'active',
    metadata: {
      supportedEndpoints: [...profile.endpoints],
      input_modalities: [...inputModalities],
      output_modalities: [...outputModalities],
      discoverySource: AILIN_VIRTUAL_DISCOVERY_SOURCE,
      description: profile.description,
      ...(profile.strategy ? { strategy: profile.strategy } : {}),
    },
  };

  const operability: ModelOperability = {
    // Aliases are always selectable: they resolve server-side at request time
    // (normalizeChatRequest), so they can never be "down" the way a provider
    // catalog row can.
    runnable: true,
    originProvider: AILIN_ALIAS_PROVIDER_ID,
    executionProvider: AILIN_ALIAS_PROVIDER_ID,
    // The concrete execution provider is chosen per request by the strategy.
    resolvedProvider: null,
    fallbackChain: [],
    nonOperationalReasons: [],
    warnings: [],
  };

  return { model, operability };
}

/** Normalize a model's loosely-typed `metadata` blob into a plain object. */
export function getModelMetadata(model: Model): Record<string, unknown> | undefined {
  if (model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata)) {
    return model.metadata as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Project a catalog model + its resolved operability into the public
 * `/v1/models` row shape. Extracted so the bounded (paginated) and streamed
 * code paths emit byte-identical rows — and so the streaming path can serialize
 * ONE row at a time without ever materializing the whole ~64k-row array.
 */
export function buildModelDto({ model, operability }: RankedEntry): Record<string, unknown> {
  const metadata = getModelMetadata(model);
  const originProvider =
    typeof metadata?.originalProvider === 'string' && metadata.originalProvider.length > 0
      ? metadata.originalProvider
      : model.provider;
  const executionProvider =
    typeof metadata?.executionProvider === 'string' && metadata.executionProvider.length > 0
      ? metadata.executionProvider
      : model.provider;
  const modalities = extractModelModalities(metadata);
  const modalityList = Array.from(new Set([...modalities.input, ...modalities.output]));
  const endpointCompatibility = inferEndpointCompatibility(model.capabilities, metadata);
  const endpoints = inferSupportedEndpoints(model.capabilities, metadata);

  // SOTA dynamic-discovery (2026-04-27) — provenance trio:
  // - discoverySource: which fetcher/source materialized this row (set by the
  //   discovery service at write time; e.g. 'openai-native', 'aihubmix-hub',
  //   'vertex-ai-deployment', 'static-catalog'). `null` when not stamped.
  // - discoveryTimestamp: ISO-8601 of the last successful sync of this row
  //   (sourced from Prisma `lastSyncedAt`, threaded into metadata by
  //   model-catalog-service.ts).
  // - inventoryClass: orthogonal compliance bucket (9-bucket taxonomy in
  //   consolidation-matrix.ts; Phase 6 Fix 7 split out
  //   `pinnedFallback-by-design` from `non-compliant-hardcoded-inventory`).
  //   Tells callers HOW the inventory got here, independent of operational state.
  const discoverySource =
    typeof metadata?.discoverySource === 'string' && metadata.discoverySource.length > 0
      ? metadata.discoverySource
      : null;
  const discoveryTimestamp =
    typeof metadata?.lastSyncedAt === 'string' && metadata.lastSyncedAt.length > 0
      ? metadata.lastSyncedAt
      : null;
  const inventoryClass = getDiscoveryComplianceClass(model.provider) ?? 'unclassified';

  return {
    id: model.id,
    name: model.name,
    displayName: model.displayName,
    provider: model.provider,
    originProvider: operability.originProvider || originProvider,
    executionProvider: operability.executionProvider || executionProvider,
    resolvedProvider: operability.resolvedProvider,
    runnable: operability.runnable,
    fallbackChain: operability.fallbackChain,
    operability: operability.runnable ? 'operational' : 'non_operational',
    nonOperationalReasons: operability.nonOperationalReasons,
    // Phase 6 root-cause fix (2026-04-30): informational diagnostic trace
    // (e.g. "provider_not_registered:X" attempts that came before a successful
    // resolution, "origin_provider_unknown" when the model metadata is
    // incomplete). Distinct from `nonOperationalReasons`, which holds ONLY
    // blocking causes. See ModelOperability JSDoc.
    warnings: operability.warnings,
    discoverySource,
    discoveryTimestamp,
    inventoryClass,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities,
    modalities: modalityList,
    endpoints,
    endpointCompatibility,
    pricing: {
      inputCostPer1M: model.inputCostPer1k * 1000,
      outputCostPer1M: model.outputCostPer1k * 1000,
      currency: 'USD',
    },
    performance: model.performance,
    status: model.status,
  };
}

/**
 * Whether a ranked entry supports the given endpoint, used by the `?endpoint=`
 * filter WITHOUT building the full row DTO (so the filter stays cheap on 64k
 * rows — it only computes the lightweight endpoints string array).
 */
export function entrySupportsEndpoint(
  entry: RankedEntry,
  endpoint: ModelOperationEndpoint
): boolean {
  const endpoints = inferSupportedEndpoints(
    entry.model.capabilities,
    getModelMetadata(entry.model)
  );
  return endpoints.includes(endpoint);
}

/**
 * Server-side search/filter params for GET /v1/models. All optional and
 * case-insensitive; when NONE is present the handlers behave exactly as before
 * (full backward compatibility — see filterRankedEntries returning the input
 * reference untouched).
 */
export type ModelsListFilters = {
  search?: string;
  provider?: string;
  capability?: string;
  modality?: string;
};

/** Whether any of the search/filter params carries a non-blank value. */
export function hasModelsListFilters(filters: ModelsListFilters): boolean {
  return Boolean(
    (typeof filters.search === 'string' && filters.search.trim().length > 0) ||
      (typeof filters.provider === 'string' && filters.provider.trim().length > 0) ||
      (typeof filters.capability === 'string' && filters.capability.trim().length > 0) ||
      (typeof filters.modality === 'string' && filters.modality.trim().length > 0)
  );
}

/** Resolve the effective origin provider for an entry (mirrors buildModelDto). */
function entryOriginProvider(entry: RankedEntry): string {
  const metadata = getModelMetadata(entry.model);
  const fromMeta =
    typeof metadata?.originalProvider === 'string' && metadata.originalProvider.length > 0
      ? metadata.originalProvider
      : null;
  return entry.operability.originProvider || fromMeta || entry.model.provider;
}

// ── Search haystack cache ────────────────────────────────────────────────
// Lowercasing id+name+displayName for ~105k entries allocates ~315k strings
// PER REQUEST, and that GC churn — not the matching itself — dominates latency.
// The ranked base list is a stable array reference between catalog/signals
// refreshes (rankedComputationCache), so we key a parallel array of lowered
// haystacks on that reference (WeakMap → freed with the list). First search
// on a fresh list pays normalization once; every subsequent search is a pure
// `includes` pass (single-digit ms per token over 105k rows).
const searchHaystackCache = new WeakMap<object, string[]>();

function getSearchHaystacks(entries: readonly RankedEntry[]): string[] {
  const cached = searchHaystackCache.get(entries as object);
  if (cached) return cached;
  const haystacks = entries.map((entry) => {
    const { model } = entry;
    const name = typeof model.name === 'string' ? model.name : '';
    const displayName = typeof model.displayName === 'string' ? model.displayName : '';
    // '\n' separator so a token can never match ACROSS field boundaries.
    return `${model.id}\n${name}\n${displayName}`.toLowerCase();
  });
  searchHaystackCache.set(entries as object, haystacks);
  return haystacks;
}

/**
 * Apply the server-side search/filter params over an already-ranked entry list.
 *
 * Deliberately regex-free (plain lowercase + `String.includes` per token) so a
 * full pass over the ~105k-entry catalog stays well under 50ms. Semantics:
 * - `search`: whitespace-separated tokens combined with AND; a token matches
 *   when it appears as a substring of `id`, `name` or `displayName` (substring
 *   subsumes the id-prefix case). Case-insensitive.
 * - `provider`: exact (case-insensitive) match on `provider` OR originProvider.
 * - `capability`: membership in the entry's `capabilities` array.
 * - `modality`: membership in the entry's input+output modalities.
 *
 * When no filter is active the SAME array reference is returned so the caller
 * can keep feeding the rankedComputationCache-backed list into pagination.
 */
export function filterRankedEntries(
  entries: readonly RankedEntry[],
  filters: ModelsListFilters
): RankedEntry[] {
  const searchTokens =
    typeof filters.search === 'string'
      ? filters.search.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0)
      : [];
  const provider =
    typeof filters.provider === 'string' && filters.provider.trim().length > 0
      ? filters.provider.trim().toLowerCase()
      : null;
  const capability =
    typeof filters.capability === 'string' && filters.capability.trim().length > 0
      ? filters.capability.trim().toLowerCase()
      : null;
  const modality =
    typeof filters.modality === 'string' && filters.modality.trim().length > 0
      ? filters.modality.trim().toLowerCase()
      : null;

  if (searchTokens.length === 0 && !provider && !capability && !modality) {
    return entries as RankedEntry[];
  }

  const haystacks = searchTokens.length > 0 ? getSearchHaystacks(entries) : null;

  return entries.filter((entry, index) => {
    const { model } = entry;

    if (haystacks) {
      const haystack = haystacks[index];
      for (const token of searchTokens) {
        if (!haystack.includes(token)) {
          return false;
        }
      }
    }

    if (
      provider &&
      model.provider.toLowerCase() !== provider &&
      entryOriginProvider(entry).toLowerCase() !== provider
    ) {
      return false;
    }

    if (capability && !model.capabilities.some((item) => item.toLowerCase() === capability)) {
      return false;
    }

    if (modality) {
      const modalities = extractModelModalities(getModelMetadata(model));
      const matches =
        modalities.input.some((item) => item.toLowerCase() === modality) ||
        modalities.output.some((item) => item.toLowerCase() === modality);
      if (!matches) return false;
    }

    return true;
  });
}

/** One facet bucket: value name + how many filtered rows carry it. */
export type ModelsFacetBucket = { name: string; count: number };
/** Faceted counts over a (search-)filtered result set. */
export type ModelsListFacets = {
  providers: ModelsFacetBucket[];
  capabilities: ModelsFacetBucket[];
};
/** Max buckets per facet — keeps the payload small on wide catalogs. */
export const MODELS_FACET_LIMIT = 12;

/**
 * Compute provider/capability facet counts over an already-filtered entry
 * list. Single in-memory pass with two Maps; buckets are sorted by descending
 * count (ties broken by name) and truncated to MODELS_FACET_LIMIT.
 */
export function buildModelsFacets(entries: readonly RankedEntry[]): ModelsListFacets {
  const providers = new Map<string, number>();
  const capabilities = new Map<string, number>();

  for (const entry of entries) {
    const provider = entry.model.provider;
    providers.set(provider, (providers.get(provider) ?? 0) + 1);
    for (const capability of entry.model.capabilities) {
      capabilities.set(capability, (capabilities.get(capability) ?? 0) + 1);
    }
  }

  const toBuckets = (counts: Map<string, number>): ModelsFacetBucket[] =>
    Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MODELS_FACET_LIMIT)
      .map(([name, count]) => ({ name, count }));

  return { providers: toBuckets(providers), capabilities: toBuckets(capabilities) };
}

/** Resolved pagination window + metadata for a bounded `/v1/models` page. */
export type ModelsPage = {
  limit: number;
  offset: number;
  pageEntries: RankedEntry[];
  total: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
};

/**
 * Clamp the requested page params and slice the matched entries into a single
 * bounded page. `limit` is clamped to [1, MAX_PAGE_SIZE] (so no request can
 * re-create the unbounded response) and `offset` is clamped to >= 0. This is
 * the only place that decides "how many rows leave the server", so it is the
 * unit-test boundary that proves the default response is bounded.
 */
export function resolveModelsPage(
  entries: readonly RankedEntry[],
  params: { limit?: number; offset?: number }
): ModelsPage {
  const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const total = entries.length;
  const pageEntries = entries.slice(offset, offset + limit) as RankedEntry[];
  const returned = pageEntries.length;
  const hasMore = offset + returned < total;
  return {
    limit,
    offset,
    pageEntries,
    total,
    returned,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

/**
 * Stream the `/v1/models` response as a JSON array, one row at a time.
 *
 * The whole point of the streamed path is bounded peak memory: emit the
 * envelope head, then serialize+yield each row individually so the V8 heap
 * never holds more than a single row's worth of string at once (plus the
 * lightweight `entries` ref array, which just points at already-loaded model
 * objects). Backpressure is honored automatically because the caller pipes the
 * Readable to the socket and `Readable.from` pauses this generator when the
 * internal buffer fills.
 *
 * `head` must be the response envelope WITHOUT its `data` key; we splice the
 * streamed array in by dropping the head's closing `}` and appending `"data":`.
 */
export async function* streamModelsResponse(
  head: Record<string, unknown>,
  entries: Iterable<RankedEntry>
): AsyncGenerator<string> {
  const headJson = JSON.stringify(head);
  yield `${headJson.slice(0, -1)},"data":[`;
  let first = true;
  for (const entry of entries) {
    const row = JSON.stringify(buildModelDto(entry));
    yield first ? row : `,${row}`;
    first = false;
  }
  yield ']}';
}
