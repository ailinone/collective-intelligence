// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { Prisma } from '@/generated/prisma/index.js';
import { Prisma as PrismaNamespace, prisma } from '@/database/client';
import type { Model } from '@/types';
import { logger } from '@/utils/logger';
import { getErrorMessage, isError } from '@/utils/type-guards';
import { modelCacheService } from '@/services/model-cache-service';
import { computeModelUid } from '@/database/model-uid';
import { toInputJson } from '@/utils/json';

export type ProviderCatalogEntry = {
  name: string;
  displayName: string;
  status: 'active' | 'maintenance' | 'disabled';
  metadata?: Record<string, unknown>;
  models: CatalogModelEntry[];
};

export type CatalogModelEntry = {
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1K: number;
  outputCostPer1K: number;
  capabilities: Model['capabilities'];
  performance?: Model['performance'];
  status?: Model['status'];
  metadata?: Record<string, unknown>;
  // GPT-5.1 awareness (November 2025)
  gpt5Features?: {
    isGPT5?: boolean;
    releaseDate?: string;
    enhancedCapabilities?: string[];
    performanceImprovements?: Record<string, number>;
  };
};

const log = logger.child({ component: 'model-catalog-service' });

function decimal(value: number): PrismaNamespace.Decimal {
  return new PrismaNamespace.Decimal(value);
}

// ── Phase 6 Fix 2: catalog hot-path field allowlist ──────────────────
// The catalog cache loads ALL non-disabled rows (~64k) every 60s. Without
// a select clause, Prisma loaded every column including heavy JSONB
// (capabilitySources, capabilityConfidence) and the capabilityUris array
// — ~100MB wire payload that mapPrismaModel never reads. Production runs
// observed 13.9s for this query while EXPLAIN ANALYZE projected 7.9ms,
// confirming wire-size + JSON-parse as the bottleneck (not the index).
//
// CATALOG_HOT_PATH_SELECT enforces a closed allowlist: any field added to
// mapPrismaModel below MUST also be added here, and vice versa. The
// invariant test in __tests__/model-catalog-service-select.test.ts asserts
// this by checking that every read in mapPrismaModel has a matching key.
//
// Why allowlist (select:) instead of omit:? The codebase has a history of
// adding heavy JSONB/array columns to Model (capabilityUris 2026-04-20,
// lifecycleStatus 2026-04-24, capabilityConfidence 2026-04-22). An omit:
// list would silently re-regress every time a heavy column is added.
// select: forces every schema migration to confront the catalog cost.
const CATALOG_HOT_PATH_SELECT = {
  id: true,
  providerId: true,
  name: true,
  displayName: true,
  contextWindow: true,
  maxOutputTokens: true,
  inputCostPer1k: true,
  outputCostPer1k: true,
  capabilities: true,
  performance: true,
  status: true,
  metadata: true,
  lastSyncedAt: true,
  provider: { select: { name: true } },
} as const satisfies Prisma.ModelSelect;

type CatalogHotPathRecord = Prisma.ModelGetPayload<{ select: typeof CATALOG_HOT_PATH_SELECT }>;

function mapPrismaModel(record: CatalogHotPathRecord): Model {
  // Handle Prisma Json field - can be array, object with 'set' property, or other formats
  let capabilities: string[] = [];
  if (Array.isArray(record.capabilities)) {
    capabilities = record.capabilities as string[];
  } else if (record.capabilities && typeof record.capabilities === 'object') {
    const capabilitiesObj = record.capabilities as Record<string, unknown>;
    if (Array.isArray(capabilitiesObj.set)) {
      capabilities = capabilitiesObj.set as string[];
    }
  }

  const rawPerformance = (record.performance as Record<string, unknown> | null) ?? {};
  const performance = {
    latencyMs: Number(rawPerformance.latencyMs ?? 0),
    throughput: Number(rawPerformance.throughput ?? 0),
    quality: Number(rawPerformance.quality ?? 0),
    reliability: Number(rawPerformance.reliability ?? 0),
  } satisfies Model['performance'];

  // SOTA dynamic-discovery (2026-04-27): merge the Prisma row's `lastSyncedAt`
  // into the model metadata so downstream consumers (notably /v1/models) can
  // surface `discoveryTimestamp` without a Model-interface schema change.
  // The fetcher-supplied `discoverySource` is already persisted inside
  // metadata at write time (central-model-discovery-service.ts).
  const baseMetadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : undefined;

  const metadataWithSyncStamp: Record<string, unknown> | undefined =
    record.lastSyncedAt instanceof Date
      ? { ...(baseMetadata ?? {}), lastSyncedAt: record.lastSyncedAt.toISOString() }
      : baseMetadata;

  return {
    id: record.id,
    providerId: record.providerId,
    provider: record.provider.name,
    name: record.name,
    displayName: record.displayName,
    contextWindow: record.contextWindow,
    maxOutputTokens: record.maxOutputTokens,
    inputCostPer1k: Number(record.inputCostPer1k),
    outputCostPer1k: Number(record.outputCostPer1k),
    capabilities: capabilities as Model['capabilities'],
    performance,
    status: (record.status as Model['status']) ?? 'active',
    metadata: metadataWithSyncStamp,
  };
}

export async function syncModelCatalog(catalog: ProviderCatalogEntry[]): Promise<void> {
  const syncLog = log.child({ stage: 'sync' });
  const start = Date.now();
  const updatedModelIds: string[] = [];

  try {
    syncLog.info({ catalogSize: catalog.length }, 'Starting model catalog synchronization');

    await prisma.$transaction(
      async (tx) => {
        for (const providerEntry of catalog) {
          syncLog.debug(
            { provider: providerEntry.name, modelCount: providerEntry.models.length },
            'Syncing provider'
          );
          const providerCreate: Prisma.ProviderUncheckedCreateInput = {
            id: providerEntry.name,
            name: providerEntry.name,
            displayName: providerEntry.displayName,
            status: providerEntry.status,
            metadata: toInputJson(providerEntry.metadata ?? null),
          };

          const providerUpdate: Prisma.ProviderUncheckedUpdateInput = {
            displayName: providerEntry.displayName,
            status: providerEntry.status,
            metadata: toInputJson(providerEntry.metadata ?? null),
            updatedAt: new Date(),
          };

          const provider = await tx.provider.upsert({
            where: { name: providerEntry.name },
            update: providerUpdate,
            create: providerCreate,
          });

          for (const modelEntry of providerEntry.models) {
            const modelId = `${providerEntry.name}-${modelEntry.name}`;
            const modelCreate: Prisma.ModelCreateInput = {
              uid: computeModelUid(provider.id, modelId),
              id: modelId,
              provider: { connect: { id: provider.id } },
              name: modelEntry.name,
              displayName: modelEntry.displayName,
              contextWindow: modelEntry.contextWindow,
              maxOutputTokens: modelEntry.maxOutputTokens,
              inputCostPer1k: decimal(modelEntry.inputCostPer1K),
              outputCostPer1k: decimal(modelEntry.outputCostPer1K),
              capabilities: toInputJson(modelEntry.capabilities),
              performance: toInputJson(modelEntry.performance ?? {}),
              status: modelEntry.status ?? 'active',
              metadata: toInputJson(modelEntry.metadata ?? {}),
            };

            const modelUpdate: Prisma.ModelUpdateInput = {
              displayName: modelEntry.displayName,
              contextWindow: modelEntry.contextWindow,
              maxOutputTokens: modelEntry.maxOutputTokens,
              inputCostPer1k: decimal(modelEntry.inputCostPer1K),
              outputCostPer1k: decimal(modelEntry.outputCostPer1K),
              capabilities: toInputJson(modelEntry.capabilities),
              performance: toInputJson(modelEntry.performance ?? {}),
              status: modelEntry.status ?? 'active',
              metadata: toInputJson(modelEntry.metadata ?? {}),
              updatedAt: new Date(),
            };

            const result = await tx.model.upsert({
              where: {
                providerId_name: {
                  providerId: provider.id,
                  name: modelEntry.name,
                },
              },
              update: modelUpdate,
              create: modelCreate,
            });

            updatedModelIds.push(result.id);
          }
        }
      },
      {
        timeout: 60000, // 60 second timeout for large catalogs
      }
    );

    syncLog.info(
      { modelsSynced: updatedModelIds.length },
      'Transaction completed, invalidating cache...'
    );

    await modelCacheService.invalidateAll();

    if (updatedModelIds.length > 0) {
      await modelCacheService.bulkGet(updatedModelIds);
    }

    const duration = Date.now() - start;
    syncLog.info(
      {
        providers: catalog.length,
        models: updatedModelIds.length,
        duration,
        durationSeconds: Math.round(duration / 1000),
      },
      '✅ Model catalog synchronized successfully'
    );
  } catch (error) {
    const duration = Date.now() - start;
    syncLog.error(
      {
        error: getErrorMessage(error),
        stack: isError(error) ? error.stack : undefined,
        providers: catalog.length,
        modelsSynced: updatedModelIds.length,
        duration,
      },
      '❌ Model catalog synchronization failed'
    );
    throw error; // Re-throw to be handled by caller
  }
}

// In-process cache for the full catalog list.
// The orchestration engine and dynamic-model-selector call getAllCatalogModels()
// on every chat request (often multiple times per request). With ~5700 rows and
// a `include: { provider: true }` generating a very large IN clause against the
// providers table, hitting Postgres on every call crushes throughput — each
// query is ~1s, 180+ calls per second under experiment load.
//
// We cache the mapped result for a short TTL so that most calls hit memory.
// This is safe because:
//   - Model discovery writes go through upsert() which doesn't invalidate
//     this cache directly, but the TTL keeps staleness bounded to a minute.
//   - Consumers already tolerate the catalog being slightly stale between
//     discovery cycles (which run every ~5 minutes).
// 6min — the catalog only changes when discovery rebuilds it (~5min cycle), and
// consumers already tolerate that staleness (see above). The old 60s TTL expired
// ~5×/cycle on sparse traffic, forcing a cold ~69k-row re-load on the chat hot path
// that contends with the discovery write burst (~32s cold tax). onPoolRebuilt
// (index.ts) invalidates+re-warms this AFTER each rebuild, so the cache stays fresh
// AND warm and the heavy load never lands on a request. Env-overridable.
const CATALOG_CACHE_TTL_MS = Number(process.env.CATALOG_CACHE_TTL_MS) || 6 * 60_000;
let catalogCache: { expiresAt: number; models: Model[] } | null = null;
// Per-provider list cache (Camada 5 follow-up): getModelsByProvider is hit on the
// execution hot path (adapter.getModels()) and for a huge provider like
// `huggingface` the findMany returns ~60k rows (~1.2s observed). Cache the mapped
// list per provider with the same short TTL so repeated calls within the window
// hit memory instead of re-running the heavy query.
const byProviderCache = new Map<string, { expiresAt: number; models: Model[] }>();
// Single-flight guards (residual fix): on a cold cache, N concurrent callers would
// each fire the same heavy findMany (thundering-herd — observed at deploy/restart
// when the catalog query ran 3-5× concurrently). These hold the in-flight promise
// so concurrent misses await ONE query instead of all racing the DB.
let catalogInFlight: Promise<Model[]> | null = null;
const byProviderInFlight = new Map<string, Promise<Model[]>>();

export function invalidateCatalogCache(): void {
  catalogCache = null;
  byProviderCache.clear();
}

export async function getAllCatalogModels(): Promise<Model[]> {
  // IMPORTANT: The schema has UNIQUE(id, provider_id) — the same model `id`
  // can legitimately exist under multiple providers (e.g. `claude-opus-4-6`
  // is available via native `anthropic`, `aihubmix`, `cometapi`, etc.).
  //
  // Previous implementation used `new Set(ids)` + a cache keyed by `id` alone,
  // which silently collapsed all provider variants into ONE arbitrary record,
  // dropping hundreds of models from the orchestration pool — including every
  // native provider entry that happened to share an id with a hub variant.
  //
  // Fix: load ALL rows directly with their provider relation, preserving every
  // (id, providerId) combination, and cache the mapped array in-process with a
  // short TTL to avoid pounding Postgres on every chat request.
  //
  // INTENTIONAL FULL ENUMERATION — do NOT add `take:` cap. The orchestration
  // engine, model-fallback strategy, and dynamic-model-selector all depend on
  // the catalog being complete. Truncation would silently degrade routing
  // quality without raising errors. The CATALOG_CACHE_TTL_MS gate amortizes
  // the cost across all chat requests within the window.
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) {
    return catalogCache.models;
  }
  // Single-flight: dedup concurrent cold-cache misses onto ONE query.
  if (catalogInFlight) {
    return catalogInFlight;
  }
  catalogInFlight = rebuildCatalogCache();
  return catalogInFlight;
}

/**
 * Shared builder for the catalog cache: runs the full enumeration query and
 * swaps the cache atomically on completion. Used by the cold-miss path above
 * and by `refreshCatalogCacheAhead()` below.
 */
async function rebuildCatalogCache(): Promise<Model[]> {
  try {
    const records = await prisma.model.findMany({
      where: { status: { not: 'disabled' } },
      select: CATALOG_HOT_PATH_SELECT,
    });
    const mapped = records.map((record) => mapPrismaModel(record));
    catalogCache = { expiresAt: Date.now() + CATALOG_CACHE_TTL_MS, models: mapped };
    return mapped;
  } finally {
    catalogInFlight = null;
  }
}

/**
 * Stale-while-revalidate refresh for the catalog cache (keep-warm): rebuilds
 * in the background and swaps atomically on completion, so the current
 * (possibly stale) cache keeps serving reads the whole time and NO request
 * ever pays the cold rebuild (~1-2s query + map over the full catalog).
 * Called on a timer (see services/cache-refresh-ahead.ts) at an interval
 * shorter than CATALOG_CACHE_TTL_MS, which means the TTL expiry path in
 * getAllCatalogModels() effectively never fires while the refresher runs.
 * No-ops onto the in-flight promise if a rebuild is already running.
 */
export async function refreshCatalogCacheAhead(): Promise<void> {
  if (catalogInFlight) {
    await catalogInFlight;
    return;
  }
  catalogInFlight = rebuildCatalogCache();
  await catalogInFlight;
}

/**
 * INTENTIONAL FULL ENUMERATION (per-provider) — do NOT add `take:` cap.
 *
 * Caller contract: this returns every active model for the named provider.
 * Adding a hard cap would silently truncate the result for any provider
 * whose model count exceeds the cap (HuggingFace Hub serves ~58K models;
 * Together / OpenRouter aggregate thousands). Callers that want bounded
 * pagination should use `searchModels({ providers: [name], limit })` on
 * `ModelRepository` instead.
 */
export async function getModelsByProvider(providerName: string): Promise<Model[]> {
  const now = Date.now();
  const cachedList = byProviderCache.get(providerName);
  if (cachedList && cachedList.expiresAt > now) {
    return cachedList.models;
  }
  // Single-flight: dedup concurrent cold-cache misses for the same provider (e.g.
  // the ~60k-row `huggingface` query) onto ONE findMany.
  const existing = byProviderInFlight.get(providerName);
  if (existing) {
    return existing;
  }
  const p = (async (): Promise<Model[]> => {
    try {
      const provider = await prisma.provider.findUnique({ where: { name: providerName } });
      if (!provider) {
        return [];
      }

      const models = await prisma.model.findMany({
        where: { providerId: provider.id, status: { not: 'disabled' } },
        select: CATALOG_HOT_PATH_SELECT,
        orderBy: { displayName: 'asc' },
      });

      if (models.length === 0) {
        return [];
      }

      const mapped = models.map((record) => mapPrismaModel(record));

      byProviderCache.set(providerName, { expiresAt: Date.now() + CATALOG_CACHE_TTL_MS, models: mapped });
      await modelCacheService.setMany(mapped);

      return mapped;
    } finally {
      byProviderInFlight.delete(providerName);
    }
  })();
  byProviderInFlight.set(providerName, p);
  return p;
}

export async function getModelById(modelId: string, preferredProvider?: string): Promise<Model | null> {
  // Fast path: check the in-process catalog cache first. This avoids hammering
  // Postgres with per-model findFirst queries during orchestration — the
  // dynamic-model-selector and other consumers call getModelById in tight
  // loops over the candidate pool (5700+ models), and each DB round-trip
  // was ~1s under load (index scans over a large table with the `include:
  // provider` JOIN), collapsing overall throughput.
  //
  // The catalog cache has a 60s TTL which is well within the staleness
  // tolerance of model lookups during experiment execution.
  const now = Date.now();
  if (!catalogCache || catalogCache.expiresAt <= now) {
    // Cache is cold or expired — warm it with a single bulk query. This trades
    // one slightly-expensive findMany for hundreds of per-model findFirst
    // queries that would otherwise fire during the scoring/selection loops.
    try {
      await getAllCatalogModels();
    } catch {
      // If warming fails, fall through to the direct DB path below.
    }
  }
  if (catalogCache) {
    if (preferredProvider) {
      const hit = catalogCache.models.find(
        (m) => m.id === modelId && m.provider === preferredProvider,
      );
      if (hit) return hit;
    }
    // Match any non-disabled entry in cache (catalog query already filters
    // status != 'disabled'). The previous strict `=== 'active'` check would
    // fall through to DB for `experimental`, `preview`, etc. — causing the
    // per-model N+1 to re-appear for non-active variants.
    const hit = catalogCache.models.find((m) => m.id === modelId);
    if (hit) return hit;
    // Not in cache → fall through to DB (rare — only for models inserted
    // between cache builds).
  }

  // With the multi-provider schema (uid PK, composite unique id+provider_id),
  // the same model ID can exist under multiple providers. When preferredProvider
  // is set, use findFirst with provider filter to select the correct entry.
  if (preferredProvider) {
    const record = await prisma.model.findFirst({
      where: { id: modelId, provider: { name: preferredProvider } },
      select: CATALOG_HOT_PATH_SELECT,
    });
    if (record) return mapPrismaModel(record);
    // Fallback: try without provider filter
  }

  // No provider preference: return any active entry. The provider-registry's
  // findModel() handles operability checking — it will try all providers
  // dynamically if the first one isn't operational. No hardcoded provider
  // lists here; operability is a runtime concern, not a catalog concern.
  const record = await prisma.model.findFirst({
    where: { id: modelId, status: 'active' },
    select: CATALOG_HOT_PATH_SELECT,
  });
  return record ? mapPrismaModel(record) : null;
}

export async function listCatalogModels(): Promise<Model[]> {
  return getAllCatalogModels();
}

export async function listCatalogModelsByProvider(providerName: string): Promise<Model[]> {
  return getModelsByProvider(providerName);
}

export async function getCatalogModel(modelId: string, preferredProvider?: string): Promise<Model | null> {
  return getModelById(modelId, preferredProvider);
}

/**
 * Get models that are actually eligible for chat execution.
 *
 * Filters the full catalog to exclude:
 * - Models without 'chat' or 'text_generation' capability
 * - Audio-only, embedding-only, image-only, video-only models
 * - Self-hosted/local models (unless explicitly requested)
 *
 * This prevents the misleading "5700 models in pool" number when most
 * are not usable for chat. The C3 pilot showed 606 models tracked in
 * model_health but many were TTS, STT, embedding, or defunct endpoints.
 */
export async function getChatEligibleModels(options?: {
  includeSelfHosted?: boolean;
  /**
   * Self-hosted models are excluded by default (see SELF_HOSTED_PROVIDERS
   * below). When the caller pinned an exact model id (`user_specified_model`
   * on the request), that one self-hosted model is let through even though
   * `includeSelfHosted` is not set — otherwise a pin to e.g. an Ollama model
   * is silently dropped from the pool before the exact-match lookup in
   * SingleModelStrategy.selectBestModel() ever runs, and the request falls
   * through to DynamicModelSelector, which substitutes an unrelated external
   * model (observed: `qwen3:8b`/`llama3.2:3b` pins served by
   * `Qwen/Qwen3-8B`/`DeepSeek-V4-Flash` on hosted providers — H-B mini-run
   * routing-fidelity audit, 0/283 executions actually reached the pin).
   * Auto-routing (no pin) is unaffected: self-hosted models still never
   * appear in the pool DynamicModelSelector picks from.
   */
  allowSelfHostedModelIds?: string[];
}): Promise<Model[]> {
  const all = await getAllCatalogModels();
  const allowSelfHostedIds = new Set(options?.allowSelfHostedModelIds ?? []);

  const CHAT_CAPABILITIES = new Set(['chat', 'text_generation', 'function_calling', 'streaming']);
  const EXCLUDED_CAPABILITIES = new Set([
    'text_to_speech', 'tts', 'audio_generation',
    'speech_to_text', 'transcription', 'diarization',
    'embeddings', 'embedding',
    'image_generation', 'image_editing',
    'video_generation', 'video_editing',
    'moderation',
  ]);
  // Kept in sync with core/provider-operability-hub.ts SELF_HOSTED_PROVIDERS.
  // The coherence guard at
  // core/__tests__/provider-operability-hub.self-hosted.test.ts asserts this
  // set includes every catalog self-hosted-* row. If adding a new self-hosted
  // catalog entry, update BOTH sets.
  const SELF_HOSTED_PROVIDERS = new Set([
    'self-hosted',
    'ollama', 'local-llama', 'local-kobold', 'local-embeddings',
    'vllm', 'lm-studio', 'xinference', 'triton',
    'local-ocr', 'local-docling', 'local-piper', 'local-nllb',
  ]);

  return all.filter((model) => {
    // Exclude self-hosted unless explicitly requested or individually pinned
    if (!options?.includeSelfHosted && !allowSelfHostedIds.has(model.id) && !allowSelfHostedIds.has(model.name)) {
      const provider = (model.provider || '').toLowerCase();
      if (SELF_HOSTED_PROVIDERS.has(provider) || provider.startsWith('local-') || provider.includes('local')) {
        return false;
      }
    }

    // Must have at least one chat capability
    const caps = Array.isArray(model.capabilities) ? model.capabilities as string[] : [];
    const hasChatCapability = caps.some((c) => CHAT_CAPABILITIES.has(c));
    if (!hasChatCapability) return false;

    // Must not be primarily a non-chat model
    const isExcludedOnly = caps.length > 0 && caps.every((c) => EXCLUDED_CAPABILITIES.has(c));
    if (isExcludedOnly) return false;

    return true;
  });
}

/**
 * Get ALL entries for a model across all providers, including variant IDs.
 *
 * Models exist under different IDs across providers:
 *   gpt-5.4-pro (native) vs openai/gpt-5.4-pro (OpenRouter) vs openai/gpt-5.4 (EdenAI)
 *
 * This function searches for:
 * 1. Exact ID match
 * 2. Provider-prefixed variants (e.g., "openai/gpt-5.4-pro" for "gpt-5.4-pro")
 * 3. Base name from prefixed ID (e.g., "gpt-5.4-pro" from "openai/gpt-5.4-pro")
 */
export async function getAllEntriesForModel(modelId: string): Promise<Model[]> {
  // Strategy 1: Equivalence service (L2) — finds cross-provider matches via embedding similarity
  try {
    const { getModelEquivalenceService } = await import('@/services/model-equivalence-service');
    const equivalenceService = getModelEquivalenceService();
    const group = equivalenceService.getEquivalentModels(modelId);

    if (group && group.members.length > 0) {
      // Fetch full model records for all members in the equivalence group
      const uids = group.members.map(m => m.uid);
      const records = await prisma.model.findMany({
        where: { uid: { in: uids }, status: 'active' },
        // Phase 6 Fix 2: catalog hot-path allowlist. We additionally need
        // `uid` here so we can preserve the equivalence-group sort order.
        select: { ...CATALOG_HOT_PATH_SELECT, uid: true },
      });
      if (records.length > 0) {
        // Sort by source type (native first) — already done by equivalence service
        const uidOrder = new Map(uids.map((uid, i) => [uid, i]));
        records.sort((a, b) => (uidOrder.get(a.uid) ?? 99) - (uidOrder.get(b.uid) ?? 99));
        return records.map(mapPrismaModel);
      }
    }
  } catch {
    // Equivalence service not initialized or failed — fall through to prefix matching
  }

  // Strategy 2: Prefix-based variant matching (fallback)
  const variants: string[] = [modelId];

  if (!modelId.includes('/')) {
    const familyPrefixes: Record<string, string[]> = {
      gpt: ['openai'], o1: ['openai'], o3: ['openai'], o4: ['openai'], chatgpt: ['openai'],
      claude: ['anthropic'],
      gemini: ['google'], gemma: ['google'],
      grok: ['xai', 'x-ai'],
      deepseek: ['deepseek'],
      mistral: ['mistralai', 'mistral'],
    };
    for (const [prefix, families] of Object.entries(familyPrefixes)) {
      if (modelId.toLowerCase().startsWith(prefix)) {
        for (const fam of families) variants.push(`${fam}/${modelId}`);
      }
    }
  } else {
    const base = modelId.split('/').slice(1).join('/');
    if (base) variants.push(base);
  }

  // Strategy 3: Also search for date-stripped variants (e.g., gpt-5.4-pro-2026-03-05 → gpt-5.4-pro)
  const dateStripped = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (dateStripped !== modelId) variants.push(dateStripped);
  // And reverse: if searching for gpt-5.4-pro, also find gpt-5.4-pro-2026-*
  const baseName = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, '');

  const records = await prisma.model.findMany({
    where: {
      OR: [
        { id: { in: [...new Set(variants)] }, status: 'active' },
        // LIKE query for date-versioned variants (e.g., baseName-YYYY-MM-DD)
        { id: { startsWith: baseName + '-' }, status: 'active' },
      ],
    },
    select: CATALOG_HOT_PATH_SELECT,
    orderBy: { usageCount: 'desc' },
  });
  // Filter Strategy 3 LIKE results to only date-versioned variants (baseName-YYYY-MM-DD)
  const variantSet = new Set(variants);
  const filtered = records.filter(r => {
    if (variantSet.has(r.id)) return true; // Strategy 2 exact match — keep
    const suffix = r.id.slice(baseName.length);
    return /^-\d{4}-\d{2}-\d{2}/.test(suffix);
  });
  return filtered.map(mapPrismaModel);
}

export async function removeDisabledCatalogEntries(
  validProviders: ProviderCatalogEntry[]
): Promise<void> {
  const validProviderNames = new Set(validProviders.map((provider) => provider.name));
  const providers = await prisma.provider.findMany();

  const providersToDisable = providers.filter((provider) => !validProviderNames.has(provider.name));

  for (const provider of providersToDisable) {
    await prisma.provider.update({
      where: { id: provider.id },
      data: { status: 'disabled', updatedAt: new Date() },
    });
    await prisma.model.updateMany({
      where: { providerId: provider.id },
      data: { status: 'disabled', updatedAt: new Date() },
    });
  }

  if (providersToDisable.length > 0) {
    await modelCacheService.invalidateAll();
  }
}

export const modelCatalogService = {
  syncModelCatalog,
  listModels: listCatalogModels,
  listModelsByProvider: listCatalogModelsByProvider,
  getModel: getCatalogModel,
  getAllCatalogModels,
  getModelsByProvider,
  getModelById,
  getAllEntriesForModel,
  removeDisabledCatalogEntries,
} as const;
