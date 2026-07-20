// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model management routes
 * GET /v1/models/list
 * GET /v1/models/:id
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
// Authentication handled by global middleware
import { ProviderRegistry } from '@/providers/provider-registry';
import { logger } from '@/utils/logger';
import { getAllCatalogModels, getModelById } from '@/services/model-catalog-service';
import { prisma } from '@/database/client';
import type { Model } from '@/types';
import {
  extractModelModalities,
  inferEndpointCompatibility,
  inferSupportedEndpoints,
  normalizeOperationEndpoint,
  type ModelOperationEndpoint,
} from '@/services/model-capability-inference';
import { Readable } from 'node:stream';
// Serialization + pagination core. Extracted into a dependency-light module so
// the row-shaping and pagination logic is unit-testable without the heavy
// provider-registry/DB import chain. See models-list-serialization.ts for the
// 2026-06-10 OOM background that motivated bounded-by-default responses.
import {
  buildModelDto,
  entrySupportsEndpoint,
  getModelMetadata,
  resolveModelsPage,
  streamModelsResponse,
  type RankedEntry,
} from './models-list-serialization';

const CHAT_CAPABILITIES = new Set(['chat', 'text_generation', 'streaming']);
const OPENAI_CHAT_ENDPOINTS = new Set([
  'chat_completions',
  'chat_completions_special',
  'chat_completions_audio',
  'responses',
]);
// SOTA dynamic-discovery (2026-04-27): chat-eligibility for OpenAI models is
// determined by the fetcher-populated `metadata.endpoint` and the model's
// `capabilities` array — NOT by string-matching the model id against a
// hardcoded list of legacy completion-only families. The OpenAI fetcher
// already populates `endpoint: 'completions'` and `capabilities: ['completions',
// 'text_generation']` for legacy models (see openai-model-fetcher.ts), so the
// previous `OPENAI_COMPLETION_ONLY_HINTS` substring scan was redundant
// classification at the route layer that masked itself as discovery.
const RUNTIME_SIGNAL_LOOKBACK_HOURS = Math.max(
  1,
  Number(process.env.MODEL_RUNTIME_SIGNAL_LOOKBACK_HOURS || 48)
);
const RUNTIME_SIGNAL_CACHE_TTL_MS = Math.max(
  5_000,
  Number(process.env.MODEL_RUNTIME_SIGNAL_CACHE_TTL_MS || 60_000)
);

type RuntimeModelSignal = {
  successCount: number;
  provider404Count: number;
  policyBlockedCount: number;
};

type RuntimeSignalRow = {
  model_name: string;
  success_count: bigint | number;
  provider_404_count: bigint | number;
  policy_blocked_count: bigint | number;
};

type ModelsScope = 'runnable' | 'all' | 'discovered';

type ModelsListQuery = {
  scope?: ModelsScope;
  endpoint?: string;
  // Pagination (default path). `limit` is clamped to [1, MAX_PAGE_SIZE];
  // `offset` is clamped to >= 0. Fastify coerces the query strings to numbers
  // via the route schema, so non-integer input is rejected with 400 upstream.
  limit?: number;
  offset?: number;
  // Opt-in to the full, streamed inventory. When true, `limit`/`offset` are
  // ignored and the entire scoped+filtered result set is streamed as a JSON
  // array (memory-bounded). Default false → bounded page.
  all?: boolean;
};

let runtimeSignalsCache:
  | {
      expiresAt: number;
      value: Map<string, RuntimeModelSignal>;
    }
  | null = null;

function toNumber(value: bigint | number | null | undefined): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return typeof value === 'number' ? value : 0;
}

function modelLookupKey(name: string): string {
  return name.trim().toLowerCase();
}

function modelRuntimeSignal(
  model: Model,
  runtimeSignals: Map<string, RuntimeModelSignal>
): RuntimeModelSignal | undefined {
  return runtimeSignals.get(modelLookupKey(model.name));
}

async function getRuntimeSignals(): Promise<Map<string, RuntimeModelSignal>> {
  const now = Date.now();
  if (runtimeSignalsCache && runtimeSignalsCache.expiresAt > now) {
    return runtimeSignalsCache.value;
  }

  try {
    const rows = await prisma.$queryRaw<RuntimeSignalRow[]>`
      SELECT
        lower(trim(request->>'model')) AS model_name,
        COUNT(*) FILTER (WHERE status = 'success') AS success_count,
        COUNT(*) FILTER (
          WHERE status = 'error'
            AND (
              COALESCE(error_message, '') ILIKE '%OpenRouter API error: 404%'
              OR COALESCE(error_message, '') ILIKE '%No endpoints found matching your data policy%'
              OR COALESCE(error_message, '') ILIKE '%model_not_found%'
            )
        ) AS provider_404_count,
        COUNT(*) FILTER (
          WHERE status = 'error'
            AND COALESCE(error_message, '') ILIKE '%No endpoints found matching your data policy%'
        ) AS policy_blocked_count
      FROM request_logs
      WHERE endpoint = '/v1/chat/completions'
        AND created_at > NOW() - make_interval(hours => ${RUNTIME_SIGNAL_LOOKBACK_HOURS})
        AND request ? 'model'
        AND lower(trim(request->>'model')) <> 'auto'
      GROUP BY lower(trim(request->>'model'))
    `;

    const value = new Map<string, RuntimeModelSignal>();
    for (const row of rows) {
      const key = modelLookupKey(row.model_name);
      if (!key) continue;
      value.set(key, {
        successCount: toNumber(row.success_count),
        provider404Count: toNumber(row.provider_404_count),
        policyBlockedCount: toNumber(row.policy_blocked_count),
      });
    }

    runtimeSignalsCache = {
      expiresAt: now + RUNTIME_SIGNAL_CACHE_TTL_MS,
      value,
    };
    return value;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({ error: errorMessage }, 'Failed to load runtime model signals; continuing without signals');
    return new Map<string, RuntimeModelSignal>();
  }
}

function computeCatalogRank(model: Model, signal?: RuntimeModelSignal): number {
  const successScore = Math.min(signal?.successCount ?? 0, 200) * 10;
  const reliabilityScore = Number(model.performance?.reliability ?? 0) * 100;
  const qualityScore = Number(model.performance?.quality ?? 0) * 50;
  const policyPenalty = (signal?.policyBlockedCount ?? 0) * 1000;
  const provider404Penalty = (signal?.provider404Count ?? 0) * 250;
  const noChatPenalty = model.capabilities.includes('chat') ? 0 : 100;

  return successScore + reliabilityScore + qualityScore - policyPenalty - provider404Penalty - noChatPenalty;
}

function stripChatCapabilities(model: Model): Model {
  return {
    ...model,
    capabilities: model.capabilities.filter((capability) => !CHAT_CAPABILITIES.has(capability)),
  };
}

function sanitizeModelForChatEligibility(
  model: Model,
  signal?: RuntimeModelSignal
): Model {
  const metadata = getModelMetadata(model);

  if (signal && signal.policyBlockedCount > 0 && signal.successCount === 0) {
    return stripChatCapabilities(model);
  }

  if (model.provider === 'openai') {
    // SOTA dynamic-discovery: classify chat eligibility from upstream-derived
    // signals only (metadata.endpoint set by the fetcher; capabilities array
    // populated from the fetcher's classification). No model-id substring
    // matching at the route layer.
    const endpointRaw = metadata?.endpoint;
    const endpoint = typeof endpointRaw === 'string' ? endpointRaw.toLowerCase() : undefined;
    const endpointDisallowsChat = endpoint ? !OPENAI_CHAT_ENDPOINTS.has(endpoint) : false;
    const completionOnlyByCapability = model.capabilities.includes('completions');

    if (endpointDisallowsChat || completionOnlyByCapability) {
      return stripChatCapabilities(model);
    }

    return model;
  }

  if (model.provider !== 'google') {
    return model;
  }

  const supportsGenerateContentRaw = metadata?.supportsGenerateContent;
  const supportsGenerateContent =
    typeof supportsGenerateContentRaw === 'boolean' ? supportsGenerateContentRaw : undefined;

  const hasComputerUseCapability = model.capabilities.includes('computer_use');
  const nameSuggestsComputerUse = model.name.toLowerCase().includes('computer-use');

  const mustDisableChatCapabilities =
    supportsGenerateContent === false ||
    ((hasComputerUseCapability || nameSuggestsComputerUse) && supportsGenerateContent !== true);

  if (!mustDisableChatCapabilities) {
    return model;
  }

  return stripChatCapabilities(model);
}

function normalizeModelIdParam(rawId: string): string {
  if (!rawId.includes('%')) {
    return rawId;
  }

  try {
    return decodeURIComponent(rawId);
  } catch {
    return rawId;
  }
}

// Shared querystring schema for both /v1/models and /v1/models/list. Fastify
// coerces query strings to the declared types (so non-integer limit/offset is
// rejected with 400) and, because additionalProperties is false, unknown query
// params are rejected. `limit`/`offset`/`all` are the pagination controls.
const MODELS_LIST_QUERYSTRING_SCHEMA = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      enum: ['runnable', 'all', 'discovered'],
      description:
        'runnable=only providers with registered adapters (default; current ratio ≈ 99.99% of catalog after 2026-05-06 closure batch); all/discovered=full discovered inventory including providers without runtime adapters',
    },
    endpoint: {
      type: 'string',
      description:
        'Optional endpoint compatibility filter. Canonical: chat_completions, responses, completions, embeddings, images, videos, audio_speech, audio_transcriptions, realtime. Aliases accepted (e.g. chat, tts, stt).',
    },
    limit: {
      type: 'integer',
      description:
        'Max rows per page. Default 100, clamped to [1, 1000]. Ignored when all=true.',
    },
    offset: {
      type: 'integer',
      description:
        '0-based row offset into the scoped+endpoint-filtered result set. Default 0, clamped to >= 0. Ignored when all=true.',
    },
    all: {
      type: 'boolean',
      description:
        'Opt-in to the FULL inventory, streamed as a JSON array so peak memory stays bounded regardless of catalog size. Ignores limit/offset. Default false → bounded page. Prefer paging via limit/offset; only set all=true when you genuinely need every row.',
    },
  },
  additionalProperties: false,
} as const;

// Shared 200 response schema. NOTE: Fastify's response serializer DROPS any
// property absent from this schema, so `pagination` and `counts.matched` MUST
// be declared here or they vanish from the bounded-page response. (The
// `?all=true` stream path sends a raw Readable and bypasses this serializer.)
const MODELS_LIST_RESPONSE_200_SCHEMA = {
  description: 'List of models with count + pagination metadata',
  type: 'object',
  properties: {
    object: { type: 'string' },
    scope: { type: 'string' },
    endpointFilter: { type: ['string', 'null'] },
    counts: {
      type: 'object',
      description:
        'Cardinality at each filter stage so callers can see the runnable-vs-catalog gap without a second request. catalog≥runnable≥scoped≥matched≥returned.',
      properties: {
        catalog: { type: 'number', description: 'Total active rows in DB catalog' },
        runnable: { type: 'number', description: 'Models whose provider has a registered adapter' },
        scoped: { type: 'number', description: 'After applying scope filter (runnable/all/discovered)' },
        matched: { type: 'number', description: 'After applying optional endpoint filter (full result set being paged)' },
        returned: { type: 'number', description: 'Rows in THIS page (length of data array)' },
      },
      required: ['catalog', 'runnable', 'scoped', 'matched', 'returned'],
    },
    pagination: {
      type: 'object',
      description:
        'Bounded-page metadata. Page through the full result set by following nextOffset until hasMore is false. (Absent from the ?all=true streamed response.)',
      properties: {
        limit: { type: 'number', description: 'Effective page size after clamping to [1, 1000]' },
        offset: { type: 'number', description: 'Effective 0-based offset after clamping to >= 0' },
        total: { type: 'number', description: 'Total rows matching scope+endpoint filter (== counts.matched)' },
        returned: { type: 'number', description: 'Rows in this page (== counts.returned == data.length)' },
        hasMore: { type: 'boolean', description: 'True when more rows exist beyond this page' },
        nextOffset: { type: ['number', 'null'], description: 'offset+limit when hasMore, else null' },
      },
      required: ['limit', 'offset', 'total', 'returned', 'hasMore', 'nextOffset'],
    },
    data: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          displayName: { type: 'string' },
          provider: { type: 'string' },
          originProvider: { type: 'string' },
          executionProvider: { type: 'string' },
          resolvedProvider: { type: ['string', 'null'] },
          runnable: { type: 'boolean' },
          fallbackChain: { type: 'array', items: { type: 'string' } },
          operability: { type: 'string', enum: ['operational', 'non_operational'] },
          nonOperationalReasons: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          discoverySource: { type: ['string', 'null'] },
          discoveryTimestamp: { type: ['string', 'null'], format: 'date-time' },
          inventoryClass: {
            type: 'string',
            enum: [
              'compliant-dynamic-discovery',
              'compliant-deployment-discovery',
              'compliant-machine-readable-official-catalog',
              // Phase 6 Fix 7 (2026-04-30): pinnedFallback-by-design —
              // `pinnedFallback.reason: 'no-list-endpoint'` providers
              // (perplexity, recraft, runwayml, bfl, inworld, v0, xiaomi-mimo).
              // Compliant because the operator-curated list IS the inventory
              // contract.
              'pinnedFallback-by-design',
              'non-compliant-hardcoded-inventory',
              'non-compliant-no-machine-readable-discovery',
              'non-compliant-runtime-not-materialized',
              'not-applicable-non-model-surface',
              'self-hosted-runtime-dependent',
              'unclassified',
            ],
          },
          contextWindow: { type: 'number' },
          maxOutputTokens: { type: 'number' },
          capabilities: { type: 'array', items: { type: 'string' } },
          modalities: { type: 'array', items: { type: 'string' } },
          endpoints: { type: 'array', items: { type: 'string' } },
          endpointCompatibility: {
            type: 'object',
            additionalProperties: {
              type: 'string',
              enum: ['explicit', 'inferred'],
            },
          },
          pricing: {
            type: 'object',
            properties: {
              inputCostPer1M: { type: 'number' },
              outputCostPer1M: { type: 'number' },
              currency: { type: 'string' },
            },
          },
          performance: { type: 'object' },
          status: { type: 'string' },
        },
      },
    },
  },
} as const;

// ── Ranked-catalog computation cache ─────────────────────────────────────────
// The operability resolution + rank + O(n log n) sort over the FULL catalog
// (~64k models) used to run from scratch on EVERY /v1/models request — including
// each page of a paginated walk over identical data. The inputs only change when
// the catalog cache (6-min TTL) or the runtime-signals cache (60s TTL) refreshes,
// and both return the SAME object reference within their TTL — so reference
// identity is an exact, zero-cost invalidation signal. Keyed by scope+endpoint
// (a small enum product, ~30 combinations max).
interface RankedComputation {
  modelsRef: unknown;
  signalsRef: unknown;
  matchedEntries: RankedEntry[];
  scopedCount: number;
  runnableCount: number;
}
const rankedComputationCache = new Map<string, RankedComputation>();
const RANKED_CACHE_MAX_KEYS = 64;

/**
 * Register model routes
 */
export async function registerModelRoutes(
  server: FastifyInstance,
  _providerRegistry: ProviderRegistry
): Promise<void> {
  /**
   * GET /v1/models (alias for /v1/models/list for OpenAI compatibility)
   * GET /v1/models/list
   * List all available models from all providers
   */
  const listModelsHandler = async (
    request: FastifyRequest<{ Querystring: ModelsListQuery }>,
    reply: FastifyReply
  ) => {
    const requestLog = logger.child({
      endpoint: '/v1/models/list',
    });

    try {
      requestLog.debug('Fetching all models');

      const models = await getAllCatalogModels();

      // SOTA POLICY (2026-04-27): /v1/models reflects ONLY the runtime
      // materialized inventory. We do NOT fall back to a static catalog when
      // the DB is cold — emptiness is information, and a hardcoded fallback
      // would lie about what is actually reachable. Instead we kick the
      // central discovery service in the background and respond with an
      // empty list + a warn log. Subsequent requests after discovery completes
      // will surface the real, dynamically-discovered inventory.
      //
      // Discovery has built-in in-flight coalescing, so concurrent triggers
      // from many cold-start requests collapse into a single pass.
      if (models.length === 0) {
        requestLog.warn(
          'Model catalog empty at request time — triggering background discovery; ' +
            'response is empty until discovery completes (no static fallback by SOTA policy).'
        );
        void (async () => {
          try {
            const { getCentralModelDiscoveryService } = await import(
              '@/services/central-model-discovery-service'
            );
            const discovery = await getCentralModelDiscoveryService();
            await discovery.discoverAllModels();
          } catch (err) {
            requestLog.error(
              { error: err instanceof Error ? err.message : String(err) },
              'Background discovery trigger failed'
            );
          }
        })();
      }

      const runtimeSignals = await getRuntimeSignals();
      const requestedScope = request.query.scope ?? 'runnable';
      const scope: ModelsScope = requestedScope === 'all' || requestedScope === 'discovered'
        ? requestedScope
        : 'runnable';
      const endpointFilterRaw = request.query.endpoint;
      const endpointFilter =
        typeof endpointFilterRaw === 'string' && endpointFilterRaw.trim().length > 0
          ? normalizeOperationEndpoint(endpointFilterRaw)
          : undefined;

      if (typeof endpointFilterRaw === 'string' && endpointFilterRaw.trim().length > 0 && !endpointFilter) {
        return reply.status(400).send({
          error: {
            code: 'invalid_endpoint_filter',
            message:
              'Unsupported endpoint filter. Use one of: chat_completions, responses, completions, embeddings, images, videos, audio_speech, audio_transcriptions, realtime.',
          },
        });
      }

      // ── Cached ranked computation ─────────────────────────────────────────
      // Reference-identity check against BOTH inputs: a hit means neither the
      // catalog nor the runtime signals refreshed since this (scope, endpoint)
      // combination was last computed, so the derived result is byte-identical.
      const rankedCacheKey = `${scope}|${endpointFilter ?? '*'}`;
      const cachedComputation = rankedComputationCache.get(rankedCacheKey);
      let computation: RankedComputation;

      if (
        cachedComputation &&
        cachedComputation.modelsRef === models &&
        cachedComputation.signalsRef === runtimeSignals
      ) {
        computation = cachedComputation;
        requestLog.debug({ scope, endpointFilter }, 'Ranked catalog served from cache');
      } else {
        const modelsWithOperability = models.map((model) => ({
          model,
          operability: _providerRegistry.getModelOperability(model),
        }));

        const scopedModels =
          scope === 'runnable'
            ? modelsWithOperability.filter((entry) => entry.operability.runnable)
            : modelsWithOperability;

        if (scope === 'runnable' && scopedModels.length !== modelsWithOperability.length) {
          requestLog.info(
            {
              scope,
              totalModels: modelsWithOperability.length,
              runnableModels: scopedModels.length,
              filteredOut: modelsWithOperability.length - scopedModels.length,
            },
            'Filtered catalog models to runnable providers'
          );
        }

        requestLog.info({ modelCount: scopedModels.length, scope }, 'Models fetched successfully');

        const ranked = scopedModels
          .map(({ model: rawModel, operability }) => {
            const signal = modelRuntimeSignal(rawModel, runtimeSignals);
            const model = sanitizeModelForChatEligibility(rawModel, signal);
            const rank = computeCatalogRank(model, signal);
            return { model, operability, rank };
          })
          .sort((a, b) => {
            if (b.rank !== a.rank) return b.rank - a.rank;
            return a.model.name.localeCompare(b.model.name);
          });

        // Apply the optional endpoint filter on the LIGHTWEIGHT ranked entries
        // (a string-array membership check) BEFORE building any row DTOs, so the
        // pagination window and the streamed array both operate on the final,
        // filtered result set. Building the full ~64k-row DTO array here is
        // exactly what overran the heap; we now build DTOs only for the rows we
        // actually emit (one page, or one-at-a-time while streaming).
        const matched: RankedEntry[] =
          endpointFilter !== undefined
            ? ranked.filter((entry) =>
                entrySupportsEndpoint(entry, endpointFilter as ModelOperationEndpoint)
              )
            : ranked;

        if (endpointFilter !== undefined) {
          requestLog.info(
            {
              endpointFilter,
              beforeCount: ranked.length,
              afterCount: matched.length,
            },
            'Applied endpoint compatibility filter'
          );
        }

        computation = {
          modelsRef: models,
          signalsRef: runtimeSignals,
          matchedEntries: matched,
          scopedCount: scopedModels.length,
          runnableCount: modelsWithOperability.filter((entry) => entry.operability.runnable).length,
        };
        rankedComputationCache.set(rankedCacheKey, computation);
        while (rankedComputationCache.size > RANKED_CACHE_MAX_KEYS) {
          const oldest = rankedComputationCache.keys().next().value;
          if (oldest === undefined) break;
          rankedComputationCache.delete(oldest);
        }
      }

      const matchedEntries = computation.matchedEntries;

      // Expose count metadata so callers can see the runnable-vs-catalog
      // gap WITHOUT a second request to scope=all. Historically the gap
      // was severe (~5k runnable vs 64k catalog) which left users
      // confused about why "the catalog is so small". After the
      // 2026-05-06 closure batch (soft-fail registration + dedicated
      // factory bindings + alibaba/aws-bedrock catalog rows + env_file
      // fixes) the runnable count climbed to ~64,840 / 64,849 (99.99%).
      // The `counts` field stays in the response so any future
      // regression in adapter registration is immediately visible.
      const runnableCount = computation.runnableCount;
      const scopedCount = computation.scopedCount;
      const catalogTotal = models.length;
      const matchedTotal = matchedEntries.length;
      // Operator visibility: when runnable/catalog ratio is very low,
      // surface it. Indicates many providers lack registered adapters
      // (likely missing API keys / plugin not loaded).
      if (catalogTotal > 0 && runnableCount / catalogTotal < 0.2) {
        requestLog.warn(
          {
            catalog: catalogTotal,
            runnable: runnableCount,
            scoped: scopedCount,
            matched: matchedTotal,
            ratio: (runnableCount / catalogTotal).toFixed(3),
          },
          'Low runnable/catalog ratio — many providers may lack registered adapters',
        );
      }

      // ── Full-inventory opt-in: stream the whole matched set ──────────────
      // `?all=true` bypasses pagination and STREAMS the JSON array, serializing
      // one row at a time so peak memory stays bounded regardless of catalog
      // size. This is the memory-safe successor to the old default that
      // buffered all ~64k rows into a single ~53MB string and crash-looped the
      // container (2026-06-10 OOM / exit 139). Stream sends bypass Fastify's
      // response-schema serializer, so the shape here is authoritative.
      if (request.query.all === true) {
        const counts = {
          catalog: catalogTotal,
          runnable: runnableCount,
          scoped: scopedCount,
          matched: matchedTotal,
          returned: matchedTotal,
        };
        requestLog.info({ ...counts, streamed: true }, 'Streaming full model inventory (all=true)');
        const head = {
          object: 'list',
          scope,
          endpointFilter: endpointFilter ?? null,
          streamed: true,
          counts,
        };
        reply.header('content-type', 'application/json; charset=utf-8');
        return reply.send(
          Readable.from(streamModelsResponse(head, matchedEntries), { objectMode: false })
        );
      }

      // ── Default: bounded page ────────────────────────────────────────────
      // resolveModelsPage clamps limit to [1, MAX_PAGE_SIZE] and offset to >= 0,
      // then slices the matched set. Only THIS page's rows are turned into DTOs
      // and serialized, so peak memory is O(page) not O(catalog).
      const page = resolveModelsPage(matchedEntries, {
        limit: request.query.limit,
        offset: request.query.offset,
      });
      const data = page.pageEntries.map((entry) => buildModelDto(entry));

      const counts = {
        catalog: catalogTotal,                    // total rows in DB
        runnable: runnableCount,                  // pass operability gate
        scoped: scopedCount,                      // after scope filter
        matched: matchedTotal,                    // after endpoint filter (full result set)
        returned: page.returned,                  // rows in THIS page
      };

      return reply.send({
        object: 'list',
        scope,
        endpointFilter: endpointFilter ?? null,
        counts,
        pagination: {
          limit: page.limit,
          offset: page.offset,
          total: page.total,
          returned: page.returned,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
        },
        data,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      requestLog.error({ error: errorMessage }, 'Failed to fetch models');

      return reply.status(500).send({
        error: {
          code: 'internal_error',
          message: errorMessage,
        },
      });
    }
  };

  // Register /v1/models (OpenAI-compatible endpoint)
  server.get(
    '/v1/models',
    {
      schema: {
        tags: ['Models'],
        security: [],
        description:
          'List available models (OpenAI-compatible endpoint).\n\n' +
          'PAGINATED BY DEFAULT: returns a bounded page (default 100 rows, `?limit=` up to 1000, `?offset=` to page). The `pagination` field carries `total`/`hasMore`/`nextOffset` — follow `nextOffset` until `hasMore` is false to enumerate everything. Use `?all=true` to stream the entire inventory as one JSON array (memory-bounded, but large). This replaced the old buffer-everything behavior that serialized ~64k rows into a single ~53MB string and OOM-crashed the container (2026-06-10).\n\n' +
          'NOTE: by default `scope=runnable` — only models whose execution provider has a registered adapter at runtime are returned. The `counts` field exposes catalog/runnable/scoped/matched/returned so callers can confirm the runnable-vs-catalog gap without a second request. Use `?scope=all` to include catalog rows whose adapters are not currently registered (e.g. providers with missing keys or proprietary-schema providers in inventory-only mode).',
        querystring: MODELS_LIST_QUERYSTRING_SCHEMA,
        response: {
          200: MODELS_LIST_RESPONSE_200_SCHEMA,
        },
      },
      // Authentication handled by global middleware
    },
    listModelsHandler
  );

  // Register /v1/models/list (explicit endpoint)
  server.get(
    '/v1/models/list',
    {
      schema: {
        tags: ['Models'],
        security: [],
        description:
          'List available models from all providers.\n\n' +
          'PAGINATED BY DEFAULT: returns a bounded page (default 100 rows, `?limit=` up to 1000, `?offset=` to page). Follow `pagination.nextOffset` until `pagination.hasMore` is false to enumerate everything, or use `?all=true` to stream the full inventory as one JSON array (memory-bounded). This replaced the old buffer-everything behavior that OOM-crashed the container (2026-06-10).\n\n' +
          'NOTE: by default `scope=runnable` — only models whose execution provider has a registered adapter at runtime are returned. The `counts` field exposes catalog/runnable/scoped/matched/returned. Use `?scope=all` to include catalog rows whose adapters are not currently registered (e.g. providers with missing keys or proprietary-schema providers in inventory-only mode).',
        querystring: MODELS_LIST_QUERYSTRING_SCHEMA,
        response: {
          200: MODELS_LIST_RESPONSE_200_SCHEMA,
        },
      },
      // Authentication handled by global middleware
    },
    listModelsHandler
  );

  /**
   * GET /v1/models/:id
   * Get specific model details
   */
  server.get<{ Params: { id: string } }>(
    '/v1/models/:id',
    {
      schema: {
        tags: ['Models'],
        security: [],
        description: 'Get specific model details',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Model ID' },
          },
        },
        response: {
          200: {
            description: 'Model details',
            type: 'object',
            additionalProperties: true,
          },
          404: {
            description: 'Model not found',
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
                required: ['code', 'message'],
                additionalProperties: false,
              },
            },
            required: ['error'],
            additionalProperties: false,
          },
        },
      },
      // Authentication handled by global middleware
    },
    async (request, reply) => {
      const { id: rawId } = request.params;
      const normalizedId = normalizeModelIdParam(rawId);
      const requestLog = logger.child({
        endpoint: '/v1/models/:id',
        modelId: normalizedId,
        rawModelId: rawId,
      });

      try {
        requestLog.debug('Fetching model details');

        let result = await getModelById(normalizedId);
        if (!result && normalizedId !== rawId) {
          result = await getModelById(rawId);
        }

        if (!result) {
          requestLog.warn('Model not found');
          return reply.status(404).send({
            error: {
              code: 'model_not_found',
              message: `Model with ID '${normalizedId}' not found`,
            },
          });
        }

        requestLog.info({ modelName: result.name }, 'Model fetched successfully');

        const runtimeSignals = await getRuntimeSignals();
        const sanitized = sanitizeModelForChatEligibility(
          result,
          modelRuntimeSignal(result, runtimeSignals)
        );
        const metadata = getModelMetadata(sanitized);
        const operability = _providerRegistry.getModelOperability(sanitized);
        const modalities = extractModelModalities(metadata);
        const modalityList = Array.from(new Set([...modalities.input, ...modalities.output]));
        const endpointCompatibility = inferEndpointCompatibility(sanitized.capabilities, metadata);
        const endpoints = inferSupportedEndpoints(sanitized.capabilities, metadata);

        return reply.send({
          ...sanitized,
          runnable: operability.runnable,
          originProvider: operability.originProvider,
          executionProvider: operability.executionProvider,
          resolvedProvider: operability.resolvedProvider,
          fallbackChain: operability.fallbackChain,
          operability: operability.runnable ? 'operational' : 'non_operational',
          nonOperationalReasons: operability.nonOperationalReasons,
          warnings: operability.warnings,
          modalities: modalityList,
          endpoints,
          endpointCompatibility,
          pricing: {
            inputCostPer1M: sanitized.inputCostPer1k * 1000,
            outputCostPer1M: sanitized.outputCostPer1k * 1000,
            currency: 'USD',
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        requestLog.error({ error: errorMessage }, 'Failed to fetch model');

        return reply.status(500).send({
          error: {
            code: 'internal_error',
            message: errorMessage,
          },
        });
      }
    }
  );
}
