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

import type { Model } from '@/types';
import type { ModelOperability } from '@/providers/provider-operability';
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
export function entrySupportsEndpoint(entry: RankedEntry, endpoint: ModelOperationEndpoint): boolean {
  const endpoints = inferSupportedEndpoints(entry.model.capabilities, getModelMetadata(entry.model));
  return endpoints.includes(endpoint);
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
  const limit = Math.min(
    Math.max(1, Math.trunc(params.limit ?? DEFAULT_PAGE_SIZE)),
    MAX_PAGE_SIZE
  );
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
  entries: readonly RankedEntry[]
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
