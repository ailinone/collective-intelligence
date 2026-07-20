// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dynamic Model Selector
 *
 * Learns from historical performance to select best models for each task.
 * Uses real production data to optimize model selection continuously.
 *
 * Enterprise-ready, production-grade implementation with:
 * - Historical performance tracking
 * - Real-time adaptation
 * - Cost-quality optimization
 * - Provider health monitoring
 * - Automatic degradation detection
 */

import type { Model, TaskType, OrchestrationContext, ModelCapability } from '@/types';
import { ensureModelCapabilityArray, ensureModelStatus } from '@/types';
import { ensureStringArray, getStringFromObject, getArrayFromObject, isObject, getErrorMessage } from '@/utils/type-guards';
import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';
import { getModelCapabilityValidator } from '@/services/model-capability-validator';
import { getModelPerformanceTracker } from '@/services/model-performance-tracker';
import { getProviderRegistry } from '@/providers/provider-registry';
import { createModelSelectionConfig } from '@/config/model-selection-config';
import { popularityPriorFromMetadata } from './popularity-prior';
import { getAllCatalogModels } from '@/services/model-catalog-service';
import { getModelRepository } from '@/services/model-repository';
import { validateSelectionCriteria } from './selection-criteria-validator';
import { getModelSelectionCache as _getModelSelectionCache } from './model-selection-cache';
import { getPerformanceMonitor } from './performance-monitor';
import { errorLearningSystem } from '@/core/learning/error-learning-system';
import { modelPerformanceTracker as corePerformanceTracker } from '@/core/selection/model-performance-tracker';
import { getCentralModelDiscoveryService } from '@/services/central-model-discovery-service';
import { classifyProviderKind } from './provider-kind';
import { legacyArrayToUriArray } from '@/capability/legacy-capability-uri';
import { getCapabilitySearchService } from '@/capability/search/capability-search-singleton';
import type { ModelSearchHit } from '@/capability/search/capability-search-service';
import {
  recordSelectionCandidates,
  recordNoEligibleModel,
  recordNativePreferred,
  recordProviderSelected,
} from './selection-metrics';

const log = logger.child({ component: 'dynamic-model-selector' });

// PROVE-BEFORE-ADMIT (2026-06-27): process-wide cache of the runtime-verified
// (non-hub-index) model PKs. The underlying query is REQUEST-INDEPENDENT (the same
// set for every request) but the chat selection cache key embeds per-request
// contextSize, so without this cache the raw catalog scan would run on essentially
// every request. A short TTL keeps it fresh as discovery (re)classifies rows.
// Module scope so it survives per-request selector instances.
let verifiedHubUidCache: { uids: string[]; expiresAt: number } | null = null;
const VERIFIED_HUB_TTL_MS = 60_000;

/**
 * Return the PKs (uid) of catalog models that are NOT unverified HuggingFace
 * hub-INDEX rows (metadata.hubInventoryClass='aggregated_index' — ~63k/72k catalog
 * rows that are catalog-only with no live endpoint → 404 model_not_found when
 * selected). Cached process-wide behind VERIFIED_HUB_TTL_MS. Returns [] on error
 * (callers fail open to the full catalog) or when the marker is unpopulated.
 */
async function getVerifiedHubUids(): Promise<string[]> {
  const now = Date.now();
  if (verifiedHubUidCache && verifiedHubUidCache.expiresAt > now) {
    return verifiedHubUidCache.uids;
  }
  try {
    // NULL-safe: `IS DISTINCT FROM` keeps rows where hubInventoryClass is ABSENT (the
    // common case for callable rows) — a plain `<>` would wrongly drop them. uid is the
    // PK; `id` is NON-unique (@@unique([id, providerId])) so filtering on it would
    // re-admit an aggregated_index sibling sharing the same id under another provider.
    const rows = await prisma.$queryRaw<Array<{ uid: string }>>`
      SELECT uid FROM models
      WHERE status <> 'disabled'
        AND (metadata->>'hubInventoryClass') IS DISTINCT FROM 'aggregated_index'
      ORDER BY usage_count DESC
      LIMIT 4000`;
    const uids = rows.map((r) => r.uid);
    verifiedHubUidCache = { uids, expiresAt: now + VERIFIED_HUB_TTL_MS };
    return uids;
  } catch (rawErr) {
    log.warn(
      { error: getErrorMessage(rawErr) },
      'Unverified-hub exclusion query failed — selecting over the full catalog (fail-open)',
    );
    // Brief negative cache so a failing DB is not hammered on every request.
    verifiedHubUidCache = { uids: [], expiresAt: now + 5_000 };
    return [];
  }
}

/**
 * Model selection criteria
 */
export interface SelectionCriteria {
  taskType: TaskType;
  complexity: 'low' | 'medium' | 'high';
  contextSize: number;
  maxCost?: number;
  qualityTarget?: number;
  preferSpeed?: boolean;
  requiredCapabilities?: ModelCapability[];
  requiredTools?: string[];
  requiredEndpoint?: string;
  excludeProviders?: string[];
  preferredProviders?: string[];
  maxInputCostPer1k?: number;
  maxOutputCostPer1k?: number;
  maxAverageCostPer1k?: number;
  /**
   * Free-text semantic query used to rerank candidates via the
   * CapabilitySearchService (ADR-022, RRF-fused lexical+vector).
   *
   * When set, after the standard reliability/health filters run, the
   * selector calls `searchModels({ query: semanticQuery, providerIds: ... })`
   * and uses the rank-1 normalised RRF score as a multiplicative boost on
   * each candidate's final score. The boost is bounded (≤ +30%) so it
   * cannot override health, balance, or capability filters — it only
   * reshuffles the order *within* the already-eligible pool.
   *
   * Leave undefined to skip the semantic rerank entirely (legacy path).
   */
  semanticQuery?: string;
}

/**
 * Per-candidate semantic rerank entry produced by `applySemanticRerank`.
 *
 * `rrfNorm` is the RRF score normalised so the top hit = 1.0 and the
 * lowest hit > 0. Multiplied by the configured rerank weight to yield
 * the final multiplicative boost on the candidate's selection score.
 */
interface SemanticRerankEntry {
  rank: number;            // 1-indexed position in the RRF result set
  rrfRaw: number;          // raw RRF score from CapabilitySearchService
  rrfNorm: number;         // normalised to [0, 1] (top = 1.0)
  matchedBy: ReadonlyArray<'lexical' | 'vector' | 'capability_filter'>;
}

/**
 * Stage-specific requirements for multi-stage tasks
 */
export interface StageRequirements {
  stageName: string;
  stageType: 'primary' | 'review' | 'validation' | 'specialized' | 'coordination';
  requiredCapabilities: ModelCapability[];
  requiredTools?: string[];
  preferredCapabilities?: ModelCapability[];
  maxCost?: number;
  qualityTarget?: number;
  preferSpeed?: boolean;
}

/**
 * Multi-stage model selection result
 */
export interface MultiStageSelection {
  stages: Array<{
    stageName: string;
    stageType: string;
    selectedModels: SelectedModel[];
  }>;
  totalModels: number;
  estimatedCost: number;
  estimatedDuration: number;
}

/**
 * Selected model with score
 */
export interface SelectedModel {
  model: Model;
  score: number;
  reason: string;
  historicalPerformance?: {
    successRate: number;
    avgQuality: number;
    avgCost: number;
    avgLatency: number;
    sampleSize: number;
  };
  realTimePerformance?: {
    latencyMs?: number;
    throughput?: number;
    quality?: number;
    reliability?: number;
  };
  validatedCapabilities?: {
    capabilities: string[];
    validationStatus: 'valid' | 'invalid' | 'unknown';
    confidence: number;
  };
}

/**
 * Configuration for Dynamic Model Selector
 */
export interface DynamicModelSelectorConfig {
  cacheExpiryMs: number;
  maxCacheSize: number;
  limits: {
    maxModelsPerSelection: number;
    maxModelsPerStage: number;
    maxModelsQuery: number;
    maxModelsPerTaskPreference: number;
    maxModelsPerTaskFallback: number;
    minModelsForSelection: number;
  };
  costEstimation: {
    defaultOutputTokens: number;
  };
  latencyReference: {
    fastMs: number;
    slowMs: number;
  };
  neutralBonuses: {
    noBudget: number;
    noQualityTarget: number;
  };
  scoringWeights: {
    realTime: {
      successRate: number;
      qualityScore: number;
      reliability: number;
      costEfficiency: number;
    };
    historical: {
      successRate: number;
      quality: number;
      costEfficiency: number;
      recentTrend: number;
    };
    fallback: {
      intrinsicQuality: number;
      noHistoryQuality: number;
    };
    taskFit: number;
    capabilityFit: number;
    costFit: number;
    qualityFit: number;
  };
  qualityDefaults: {
    fallbackScore: number;
    minimumThreshold: number;
  };
  performanceTracking: {
    minimumSamples: number;
    ttlDays: number;
    windowSize: number;
  };
}

/**
 * Performance history
 */
interface PerformanceHistory {
  modelId: string;
  taskType: string;
  successCount: number;
  totalCount: number;
  avgQuality: number;
  avgCost: number;
  avgLatency: number;
  lastUpdated: Date;
}

/**
 * Model performance metrics
 */
interface ModelMetrics {
  successRate: number; // 0-1
  avgQuality: number; // 0-1
  avgCost: number; // USD
  avgLatency: number; // ms
  costEfficiency: number; // quality per dollar
  speedScore: number; // 0-1
  recentTrend: number; // -1 to 1 (negative = degrading)
}

/**
 * Dynamic Model Selector
 */
export class DynamicModelSelector {
  private readonly config: DynamicModelSelectorConfig;
  private performanceCache: Map<string, PerformanceHistory | null> = new Map();
  private selectionCache: Map<string, Model[]> = new Map();
  private taskPreferenceCache: Map<string, { ids: string[]; expiresAt: number }> = new Map();
  private lastCacheUpdate = 0;

  /** Lazily-resolved operability skip fn (in-memory O(1) registry lookup, fed by
   *  fix D: 401/402/empty poison it). Resolved once per process in selectModels;
   *  absent => no health penalty (safe no-op). Read per-candidate in scoreModel. */
  private operabilitySkip?: (
    key: { providerId: string; modelId: string },
    opts?: { silent?: boolean },
  ) => { skip: boolean };

  constructor(config?: Partial<DynamicModelSelectorConfig>) {
    this.config = createModelSelectionConfig(config);
  }

  /**
   * Find models from database based on requirements
   * This is the PRIMARY method - searches database dynamically based on criteria
   */
  async findModelsByRequirements(
    criteria: SelectionCriteria,
    maxModels?: number
  ): Promise<Model[]> {
    const limit = maxModels ?? this.config.limits?.maxModelsQuery ?? 2000;
    const startTime = Date.now();
    const monitor = getPerformanceMonitor();

    // ✅ ENTERPRISE CACHING: Check cache first
    const cacheKey = `findModels:${JSON.stringify(criteria)}:${maxModels}`;
    const cachedResult = this.selectionCache.get(cacheKey);
    if (cachedResult) {
      // Record performance for cache hit
      monitor.recordSelection({
        requestId: 'cache-hit',
        duration: Date.now() - startTime,
        criteria,
        modelsFound: cachedResult.length,
        modelsSelected: cachedResult.length,
        cacheHits: 1,
        cacheMisses: 0,
        databaseQueries: 0,
        validationErrors: 0,
        strategy: 'cached',
        result: 'success',
      });
      log.debug(
        { cacheKey, count: cachedResult.length },
        '✅ Cache hit for findModelsByRequirements'
      );
      return cachedResult;
    }

    // ✅ VALIDATION: Validate input criteria
    const validation = validateSelectionCriteria(criteria);
    if (!validation.valid) {
      log.error({ errors: validation.errors, criteria }, 'Invalid SelectionCriteria provided');
      throw new Error(`Invalid SelectionCriteria: ${validation.errors.join(', ')}`);
    }

    // Use sanitized criteria if available
    const sanitizedCriteria = validation.sanitized || criteria;

    if (validation.warnings.length > 0) {
      log.warn(
        { warnings: validation.warnings, criteria },
        'SelectionCriteria validation warnings'
      );
    }

    log.info(
      {
        taskType: sanitizedCriteria.taskType,
        complexity: sanitizedCriteria.complexity,
        contextSize: sanitizedCriteria.contextSize,
        requiredCapabilities: sanitizedCriteria.requiredCapabilities,
        requiredTools: sanitizedCriteria.requiredTools,
      },
      'Finding models from database based on requirements'
    );

    // Build Prisma query based on requirements (use sanitized criteria)
    const where: Prisma.ModelWhereInput = {
      status: { not: 'disabled' },
    };

    // Filter by context window
    if (sanitizedCriteria.contextSize) {
      where.contextWindow = { gte: sanitizedCriteria.contextSize };
    }

    // Filter by provider (do this first as it's a native field)
    if (sanitizedCriteria.excludeProviders && sanitizedCriteria.excludeProviders.length > 0) {
      where.provider = {
        name: { notIn: sanitizedCriteria.excludeProviders },
      };
    }

    if (sanitizedCriteria.preferredProviders && sanitizedCriteria.preferredProviders.length > 0) {
      where.provider = {
        name: { in: sanitizedCriteria.preferredProviders },
      };
    }

    // Note: capabilities and metadata are JSON fields in Prisma
    // We'll filter them in memory após o fetch, mesma abordagem que o ranking legado usava

    // Query database (basic filters only - JSON fields filtered in memory).
    // C3 dev fix (2026-06-09): PRE-FILTER to serverless_callable models at the QUERY level so the
    // selector fetches the few-hundred runtime-callable rows instead of scanning + serializing the
    // full ~79k catalog (each row carries heavy JSONB capability columns). Falls back to the
    // unfiltered query when the flag is not yet populated (fresh DB) so selection never collapses.
    const prefilterCallable = process.env.SELECTION_PREFILTER_CALLABLE !== 'false';

    // PROVE-BEFORE-ADMIT (2026-06-27): ~87% of the catalog (~63k/72k) is HuggingFace
    // hub-INDEX rows tagged metadata.hubInventoryClass='aggregated_index' — catalog-only
    // entries with no live inference endpoint that 404 `model_not_found` when selected.
    // The serverless_callable prefilter is unpopulated in prod (measured 0/72825), so the
    // usage-ranked fallback below otherwise surfaces 100% index junk (measured: the top
    // 800 by usage_count are ALL aggregated_index → the per-request model_not_found /
    // retry-loop / ~24s tax). Restrict the candidate pool to the NON-index rows at the
    // QUERY level. A raw NULL-safe filter is required because most callable rows have the
    // key ABSENT and a Prisma `!=` would wrongly drop them (`IS DISTINCT FROM` keeps
    // absent-key rows). Env kill-switch + fail-open + never-collapse (below).
    let verifiedHubFilter: Prisma.ModelWhereInput = {};
    if (process.env.SELECTION_EXCLUDE_UNVERIFIED_HUB !== 'false') {
      const verifiedUids = await getVerifiedHubUids(); // process-wide TTL-cached, request-independent
      // never-collapse: only restrict selection if it yields a real candidate pool.
      if (verifiedUids.length >= 5) verifiedHubFilter = { uid: { in: verifiedUids } };
    }
    const restrictVerified = Object.keys(verifiedHubFilter).length > 0;

    // Mudança 4+5 (HF integration): the candidate pool must be the UNION of two
    // proven-operable sets, because serverless_callable is only written for HF
    // rows (the HF fetcher's transform), NOT for the curated/native catalog:
    //   - serverless_callable=true  → proven HF (HF's own status:live signal)
    //   - non-aggregated_index      → curated/native premium (openai/anthropic/…)
    //                                  which legitimately have no serverless_callable
    // Using serverless_callable ALONE would wrongly exclude every premium model.
    // This WHERE is only the candidate pool — real operability is still enforced
    // in-memory afterwards by filterModelsByProviderOperability (1c). The take is
    // capped below so the in-memory ranker stays fast regardless of pool size.
    const callableOr: Prisma.ModelWhereInput[] = [
      { metadata: { path: ['serverless_callable'], equals: true } },
    ];
    if (verifiedHubFilter.uid) callableOr.push({ uid: verifiedHubFilter.uid });
    const callableWhere: Prisma.ModelWhereInput = prefilterCallable
      ? { ...where, OR: callableOr }
      : { ...where, ...verifiedHubFilter };
    let models = await prisma.model.findMany({
      where: callableWhere,
      include: { provider: true },
      // Mudança 5: CAP the candidate pool. serverless_callable now matches ~60k
      // (HF) → the previous `limit*3` (=6000) flooded the in-memory ranker
      // (scoring + semantic rerank) and blew model=auto to a 90s timeout. Bound to
      // 800 (same ceiling the fallback already uses) and pre-rank by usage so the
      // capped sample leads with proven/known-good models.
      take: Math.min(limit * 3, 800),
      orderBy: [{ usageCount: 'desc' }],
    });
    if ((prefilterCallable || restrictVerified) && models.length < 5) {
      // Flag not populated (or too sparse) — degrade gracefully to the full candidate set.
      // C3 perf fix (2026-06-11): BOUND the fallback to the TOP-N most-used models via the existing
      // `models_usage_count_idx` (ORDER BY usage_count DESC). Previously this fetched `limit*3` (=6000)
      // heavy-JSONB rows over the full ~68k catalog with NO bound, which dominated request latency
      // (~7-10s observed in prod) whenever serverless_callable is unpopulated (e.g. after a reboot
      // wipes the flag — prod measured 0/68568 populated on 2026-06-11). usage_count DESC is indexed
      // (fast index scan, no full sort) AND returns the popular / known-good models, so the in-memory
      // ranker below still sees a high-quality candidate pool — without serializing the entire catalog.
      // The verifiedHubFilter is carried so this fallback also stays on non-index rows.
      models = await prisma.model.findMany({
        where: { ...where, ...verifiedHubFilter },
        include: { provider: true },
        orderBy: { usageCount: 'desc' },
        take: Math.min(limit * 3, 800),
      });
    }
    if (restrictVerified && models.length < 5) {
      // Terminal never-collapse: the verified-hub restriction combined with this request's
      // other filters left too few rows — drop the restriction rather than return an empty
      // pool (a degraded callable model still beats no model on the hot path).
      models = await prisma.model.findMany({
        where,
        include: { provider: true },
        orderBy: { usageCount: 'desc' },
        take: Math.min(limit * 3, 800),
      });
    }

    // POPULARITY SEED (2026-06-29): `orderBy usage_count` cannot surface popular
    // models when usage_count is uniformly 0 (the state right after a restart) —
    // the take:800 cap then returns physical-order rows, dominated by zero-signal
    // HF junk (measured: top-10 was `…moist_beaked_chameleon`, `…badendings`,
    // Gensyn-Swarm artifacts burying xai/grok-3). Prisma can't ORDER BY a JSON
    // field, so pull the top callable rows by metadata.downloads via a raw UID
    // lookup and merge them in. This is the WRITE-side companion to the cold-start
    // popularity prior: it guarantees the popular models are IN the candidate pool
    // so the (popularity-aware) scorer can actually rank them to the top.
    if (prefilterCallable && process.env.SELECTION_POPULARITY_SEED !== 'false') {
      try {
        const seedRows = await prisma.$queryRaw<Array<{ uid: string }>>`
          SELECT uid FROM models
          WHERE metadata->>'serverless_callable' = 'true'
            AND (metadata->>'downloads') IS NOT NULL
          ORDER BY (metadata->>'downloads')::numeric DESC
          LIMIT 300
        `;
        const have = new Set(models.map((m) => m.uid));
        const seedUids = seedRows.map((r) => r.uid).filter((u) => !have.has(u));
        if (seedUids.length > 0) {
          const seeded = await prisma.model.findMany({
            where: { uid: { in: seedUids } },
            include: { provider: true },
          });
          // Lead with the popular seed, keep the usage-ranked set, re-cap to the
          // in-memory ranker ceiling so scoring latency stays bounded.
          models = [...seeded, ...models].slice(0, 800);
        }
      } catch (err) {
        logger.warn({ err }, 'popularity-seed query skipped (selector pool)');
      }
    }

    // Map to Model type
    let mapped = models.map((record) => {
      // Handle Prisma JSON field: can be array or object with .set property
      const rawCaps = Array.isArray(record.capabilities)
        ? record.capabilities
        : getArrayFromObject(record.capabilities, 'set');
      const capabilities = ensureModelCapabilityArray(rawCaps);

      // ADR-022 / HCRA: prefer canonical capability_uris when populated.
      // Empty array (default for unbackfilled rows) means callers fall back
      // to the legacy `capabilities` projection above.
      const recordWithHcra = record as typeof record & {
        capabilityUris?: string[] | null;
        capabilityConfidence?: unknown;
      };
      const capabilityUris = Array.isArray(recordWithHcra.capabilityUris)
        ? recordWithHcra.capabilityUris.filter((u): u is string => typeof u === 'string')
        : [];
      const capabilityConfidence = isObject(recordWithHcra.capabilityConfidence)
        ? (recordWithHcra.capabilityConfidence as Record<string, number>)
        : undefined;

      const rawPerf = isObject(record.performance) ? record.performance : {};
      const performance = {
        latencyMs: Number(rawPerf.latencyMs ?? 0),
        throughput: Number(rawPerf.throughput ?? 0),
        quality: Number(rawPerf.quality ?? 0),
        reliability: Number(rawPerf.reliability ?? 0),
      };

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
        capabilities,
        capabilityUris: capabilityUris.length > 0 ? capabilityUris : undefined,
        capabilityConfidence,
        performance,
        status: ensureModelStatus(record.status),
        metadata: isObject(record.metadata)
          ? (record.metadata as Record<string, unknown>)
          : undefined,
      } satisfies Model;
    });

    // Safety guard for chat/completions selection:
    // avoid routing embedding-only/non-generative models when selecting for chat flows.
    if (this.shouldApplyChatGenerationGuard(sanitizedCriteria)) {
      mapped = mapped.filter((model) => this.isChatGenerationCapable(model));
    }

    // ✅ FILTER IN MEMORY: JSON fields (capabilities, metadata) filtered here
    // This is more reliable than Prisma JSON queries which vary by database

    // Filter by required capabilities (use sanitized criteria).
    //
    // Two-track matching post-HCRA (ADR-022):
    //   1. Canonical track: if the model has `capabilityUris` populated
    //      (HCRA backfill done), match against URIs. The required-capability
    //      list is translated legacy → URI once at the top of the filter.
    //   2. Legacy track: if `capabilityUris` is empty/undefined (row not yet
    //      backfilled), fall back to the legacy `capabilities` array.
    //
    // Both tracks use ALL-of semantics (every required cap must be present);
    // semantics are preserved so this stage is behavior-preserving for any
    // row whose URI projection equals its legacy projection (the post-
    // backfill invariant). Stage 3 of Caminho-C will add CapabilitySearch-
    // Service-driven recall on top of this filter for confidence-aware
    // ranking.
    if (
      sanitizedCriteria.requiredCapabilities &&
      sanitizedCriteria.requiredCapabilities.length > 0
    ) {
      const requiredUris = legacyArrayToUriArray(sanitizedCriteria.requiredCapabilities);
      mapped = mapped.filter((model) => {
        // Prefer canonical URI track when available.
        if (model.capabilityUris && model.capabilityUris.length > 0) {
          return requiredUris.every((uri) => model.capabilityUris!.includes(uri));
        }
        // Legacy fallback (pre-HCRA-backfill rows).
        const modelCaps = model.capabilities || [];
        return sanitizedCriteria.requiredCapabilities!.every((reqCap) =>
          modelCaps.includes(reqCap)
        );
      });
    }

    // Filter by required tools (stored in metadata.tools).
    // FAILSAFE (review fix, same spirit as the unreliable-provider/operability
    // gates below): metadata.tools has a CLOSED universe today (tools-inference
    // only ever writes web_search/code_interpreter/file_search/mcp), so a
    // request.tools entry with any other function name — client-supplied or
    // triage-recommended — used to zero the pool here with no fallback,
    // dropping the strategies into their local-scoring path that bypasses
    // every prove-before-admit gate. Server-side registry tools are executed
    // by the ORCHESTRATOR loop, not natively by the model — the model only
    // needs generic function_calling (already enforced via
    // requiredCapabilities when tools are present) — so when no model
    // declares the specific tool name, keep the pool rather than emptying it.
    if (sanitizedCriteria.requiredTools && sanitizedCriteria.requiredTools.length > 0) {
      const toolFiltered = mapped.filter((model) => {
        // Get metadata from original record
        const record = models.find((m) => m.id === model.id);
        if (!record) return false;

        const metadata = isObject(record.metadata) ? record.metadata : {};
        const tools = ensureStringArray(metadata.tools);

        return sanitizedCriteria.requiredTools!.every((reqTool) => tools.includes(reqTool));
      });
      if (toolFiltered.length > 0) {
        mapped = toolFiltered;
      } else {
        logger.warn(
          {
            requiredTools: sanitizedCriteria.requiredTools,
            poolBefore: mapped.length,
          },
          'FAILSAFE: requiredTools filter would empty the pool (no model declares these tool names in metadata.tools) — keeping unfiltered pool; tools execute via the orchestrator loop'
        );
      }
    }

    // Filter by required endpoint (stored in metadata.endpoint)
    if (sanitizedCriteria.requiredEndpoint) {
      mapped = mapped.filter((model) => {
        const record = models.find((m) => m.id === model.id);
        if (!record) return false;

        const metadata = isObject(record.metadata) ? record.metadata : {};
        const endpoint = getStringFromObject(metadata, 'endpoint');

        return endpoint === sanitizedCriteria.requiredEndpoint;
      });
    }

    // Filter by max input cost per 1k tokens
    if (
      typeof sanitizedCriteria.maxInputCostPer1k === 'number' &&
      Number.isFinite(sanitizedCriteria.maxInputCostPer1k)
    ) {
      mapped = mapped.filter(
        (model) => model.inputCostPer1k <= sanitizedCriteria.maxInputCostPer1k!
      );
    }

    // Filter by max output cost per 1k tokens
    if (
      typeof sanitizedCriteria.maxOutputCostPer1k === 'number' &&
      Number.isFinite(sanitizedCriteria.maxOutputCostPer1k)
    ) {
      mapped = mapped.filter(
        (model) => model.outputCostPer1k <= sanitizedCriteria.maxOutputCostPer1k!
      );
    }

    // Filter by max average cost per 1k tokens
    if (
      typeof sanitizedCriteria.maxAverageCostPer1k === 'number' &&
      Number.isFinite(sanitizedCriteria.maxAverageCostPer1k)
    ) {
      mapped = mapped.filter((model) => {
        const averageCostPer1k = (model.inputCostPer1k + model.outputCostPer1k) / 2;
        return averageCostPer1k <= sanitizedCriteria.maxAverageCostPer1k!;
      });
    }

    // Limit to maxModels after filtering
    mapped = mapped.slice(0, maxModels);

    log.info(
      {
        found: mapped.length,
        taskType: sanitizedCriteria.taskType,
        filters: {
          contextWindow: sanitizedCriteria.contextSize,
          capabilities: sanitizedCriteria.requiredCapabilities,
          tools: sanitizedCriteria.requiredTools,
          endpoint: sanitizedCriteria.requiredEndpoint,
          maxInputCostPer1k: sanitizedCriteria.maxInputCostPer1k,
          maxOutputCostPer1k: sanitizedCriteria.maxOutputCostPer1k,
          maxAverageCostPer1k: sanitizedCriteria.maxAverageCostPer1k,
        },
        note: 'JSON fields (capabilities, metadata) filtered in memory for reliability',
      },
      'Models found from database based on requirements'
    );

    // ✅ ENTERPRISE CACHING: Cache result
    this.selectionCache.set(cacheKey, mapped);

    // ✅ ENTERPRISE MONITORING: Record performance metrics
    monitor.recordSelection({
      requestId: 'find-models',
      duration: Date.now() - startTime,
      criteria,
      modelsFound: mapped.length,
      modelsSelected: mapped.length,
      cacheHits: 0,
      cacheMisses: 1,
      databaseQueries: 1,
      validationErrors: validation.errors.length,
      strategy: 'database',
      result: validation.valid ? 'success' : 'error',
    });

    return mapped;
  }

  /**
   * Select best models based on historical performance
   * Now supports both: receiving models OR finding from database
   */
  async selectModels(
    availableModels: Model[] | null,
    criteria: SelectionCriteria,
    context: OrchestrationContext,
    maxModels: number = 5
  ): Promise<SelectedModel[]> {
    const startTime = Date.now();
    const selectionMonitor = getPerformanceMonitor();

    // ✅ VALIDATION: Validate input criteria
    const validation = validateSelectionCriteria(criteria);
    if (!validation.valid) {
      log.error(
        { errors: validation.errors, criteria, requestId: context.requestId },
        'Invalid SelectionCriteria provided to selectModels'
      );
      throw new Error(`Invalid SelectionCriteria: ${validation.errors.join(', ')}`);
    }

    // Use sanitized criteria and merge orchestration-level constraints
    const baseCriteria = validation.sanitized || criteria;
    const sanitizedCriteria = this.mergeCriteriaWithContext(baseCriteria, context);

    // ✅ NORMALIZE: Normalize taskType from CLI format (snake_case) to API format (kebab-case)
    if (sanitizedCriteria.taskType) {
      sanitizedCriteria.taskType = this.normalizeTaskType(sanitizedCriteria.taskType);
    }

    if (validation.warnings.length > 0) {
      log.warn(
        { warnings: validation.warnings, criteria, requestId: context.requestId },
        'SelectionCriteria validation warnings'
      );
    }

    // ✅ PRIMARY IMPROVEMENT: If no models provided, find from database based on requirements
    // Resolve the operability skip fn once (cached across calls). scoreModel's
    // per-candidate health penalty reads it; if unresolved, no penalty (safe).
    if (!this.operabilitySkip) {
      try {
        const { shouldSkipNearZero } = await import('@/core/operability');
        this.operabilitySkip = shouldSkipNearZero;
      } catch { /* operability unavailable -> health penalty disabled (safe) */ }
    }

    let modelsToUse: Model[];
    if (!availableModels || availableModels.length === 0) {
      log.info(
        {
          requestId: context.requestId,
          taskType: sanitizedCriteria.taskType,
        },
        'No models provided, finding from database based on requirements'
      );
      modelsToUse = await this.findModelsByRequirements(
        sanitizedCriteria,
        this.config.limits?.maxModelsQuery ?? 2000
      ); // Consider ALL 509+ registered models
    } else {
      modelsToUse = availableModels;
    }

    if (this.shouldApplyChatGenerationGuard(sanitizedCriteria)) {
      const before = modelsToUse.length;
      modelsToUse = modelsToUse.filter((model) => this.isChatGenerationCapable(model));
      const removed = before - modelsToUse.length;
      if (removed > 0) {
        log.debug(
          {
            requestId: context.requestId,
            removed,
            remaining: modelsToUse.length,
          },
          'Filtered non-chat-capable models from selection candidates'
        );
      }
    }

    // Filter out models from providers with known health issues (402, 404, etc.)
    try {
      const healthRecs = await errorLearningSystem.getRecommendations(sanitizedCriteria.taskType ?? 'general');
      if (healthRecs.avoidProviders && healthRecs.avoidProviders.length > 0) {
        const avoidSet = new Set(healthRecs.avoidProviders.map((p: string) => p.toLowerCase()));
        const before = modelsToUse.length;
        modelsToUse = modelsToUse.filter((m) => !avoidSet.has((m.provider || '').toLowerCase()));
        const removed = before - modelsToUse.length;
        if (removed > 0) {
          log.info(
            { requestId: context.requestId, avoidProviders: healthRecs.avoidProviders, removed, remaining: modelsToUse.length },
            'Filtered models from unhealthy providers'
          );
        }
      }
    } catch {
      // Non-fatal: if health check fails, proceed without filtering
    }

    // Provider-level performance filter: sliding-window failure rate (see
    // model-performance-tracker.ts for details). Excludes ALL models from
    // providers with ≥60% failure rate in the last 15 minutes (min 5 samples).
    //
    // FAILSAFE: if applying this filter would eliminate (almost) the entire
    // pool, we BYPASS the filter instead. A zero-pool scenario almost always
    // means the reliability SIGNAL is broken (e.g. attribution bug, cascade of
    // transient network errors counted as provider failures), not that every
    // provider on the planet is simultaneously broken. In that case it's
    // better to let the request try the full pool and fail at the adapter/
    // circuit-breaker layer than to block every strategy with "0 available".
    const POOL_FAILSAFE_MIN = 10;
    {
      const unreliableProviders = corePerformanceTracker.getUnreliableProviders();
      if (unreliableProviders.length > 0) {
        const unreliableSet = new Set(unreliableProviders);
        const before = modelsToUse.length;
        const filtered = modelsToUse.filter((m) => {
          // Camada 2: hub-index models (~60k heterogeneous HF models under ONE
          // provider_id='huggingface') must NOT be dropped by this provider-LEVEL
          // filter — a few free fine-tunes failing would mark the whole provider
          // unreliable and wrongly remove the good ones (featherless/nscale/…) too.
          // The per-MODEL performance filter below handles these route-by-route.
          const meta = m.metadata as Record<string, unknown> | undefined;
          if (meta?.hubInventoryClass === 'aggregated_index') return true;
          return !unreliableSet.has((m.provider || '').toLowerCase());
        });
        const removed = before - filtered.length;

        if (filtered.length < POOL_FAILSAFE_MIN) {
          log.warn(
            {
              requestId: context.requestId,
              unreliableProviders,
              wouldRemove: removed,
              wouldRemain: filtered.length,
              poolSize: before,
              threshold: POOL_FAILSAFE_MIN,
            },
            'FAILSAFE: unreliable-provider filter would collapse pool below minimum — bypassing filter',
          );
          // Keep the original pool. Per-request circuit breakers will still
          // fail fast on actually-broken providers without blocking strategies.
        } else {
          modelsToUse = filtered;
          if (removed > 0) {
            log.info(
              {
                requestId: context.requestId,
                unreliableProviders,
                removed,
                remaining: modelsToUse.length,
              },
              'Filtered models from unreliable providers (provider-level performance filter)',
            );
          }
        }
      }
    }

    // ── Camada 1c: prove-before-advertise operability gate ───────────────────
    // Drop candidates whose PROVIDER the operability hub has proven non-operable
    // (auth_failed / no_credits / rate_limited / temporarily_unavailable). With
    // the hub now persisted (Camada 1a) + probe-fed (Camada 1b), this makes the
    // hot path advertise only operable providers instead of dead hub-index junk —
    // the missing link: the operability filter existed but the selector never
    // called it. OPERABILITY_SELECTOR_ALLOW_UNKNOWN=false also drops never-proven
    // providers (proven-only). FAILSAFE (same spirit as the unreliable-provider
    // filter above): never let the gate collapse the pool below POOL_FAILSAFE_MIN
    // — a near-empty result means the hub signal is cold/broken, not that the
    // whole world is down. Dynamic by construction — no static allow/deny list.
    try {
      const { filterModelsByProviderOperability } = await import('@/core/operability/operability-filter.js');
      const allowUnknown = process.env.OPERABILITY_SELECTOR_ALLOW_UNKNOWN !== 'false';
      // A COLLECTIVE (multi-model) selection additionally excludes PROVEN-FLAKY
      // (`degraded` = <60% recent success) providers from the pool: in an
      // expensive fan-out (debate/consensus), a flaky sub-call wastes a whole
      // debater/round and inflates tail latency, whereas a single-model request
      // is better served by a degraded model than by nothing. The FAILSAFE below
      // (POOL_FAILSAFE_MIN) still guarantees the tighter gate can never collapse
      // the pool. Env-tunable both ways; dynamic (measured success rate), no pins.
      const isCollectiveSelection = maxModels > 1;
      const allowDegraded = isCollectiveSelection
        ? process.env.OPERABILITY_SELECTOR_ALLOW_DEGRADED === 'true'
        : process.env.OPERABILITY_SELECTOR_ALLOW_DEGRADED !== 'false';
      const { eligible, blocked } = await filterModelsByProviderOperability(modelsToUse, {
        allowUnknown,
        allowDegraded,
        respectEnvBlocklist: true,
        reasonPrefix: 'dynamic-model-selector',
      });
      if (blocked.length > 0) {
        if (eligible.length >= POOL_FAILSAFE_MIN) {
          log.info(
            {
              requestId: context.requestId,
              before: modelsToUse.length,
              after: eligible.length,
              blocked: blocked.length,
              allowUnknown,
            },
            'Operability gate applied to candidate pool (Camada 1c)',
          );
          modelsToUse = eligible;
        } else {
          log.warn(
            {
              requestId: context.requestId,
              wouldRemain: eligible.length,
              poolSize: modelsToUse.length,
              threshold: POOL_FAILSAFE_MIN,
            },
            'FAILSAFE: operability gate would collapse pool below minimum — bypassing gate',
          );
        }
      }
    } catch (err) {
      log.warn(
        { requestId: context.requestId, error: String(err) },
        'Operability gate unavailable — proceeding without it',
      );
    }

    // ── #1 Dead-model gate (prove-before-admit) ──────────────────────────────
    // Drop candidates flagged dead by a PRIOR runtime 404 / model_not_found (a
    // dead catalog entry — HF aggregated-index junk, renamed/removed model). The
    // operability hub is per-(provider,family) and cannot gate a single model;
    // this per-exact-model set closes that gap (404 = 32 errors in the burst).
    // In-memory + TTL'd (self-healing) + never-collapse FAILSAFE + env kill-switch.
    if (process.env.SELECTION_DEAD_MODEL_GATE !== 'false') {
      try {
        const { getDeadModelRegistry } = await import('@/core/operability/dead-model-registry.js');
        const deadReg = getDeadModelRegistry();
        const beforeDead = modelsToUse.length;
        const aliveModels = modelsToUse.filter((m) => !deadReg.isDead(m.id));
        const deadRemoved = beforeDead - aliveModels.length;
        if (deadRemoved > 0) {
          if (aliveModels.length >= POOL_FAILSAFE_MIN) {
            log.info(
              {
                requestId: context.requestId,
                before: beforeDead,
                after: aliveModels.length,
                removed: deadRemoved,
              },
              'Dead-model gate applied — dropped models flagged dead by a prior 404 (prove-before-admit)',
            );
            modelsToUse = aliveModels;
          } else {
            log.warn(
              {
                requestId: context.requestId,
                wouldRemain: aliveModels.length,
                poolSize: beforeDead,
                threshold: POOL_FAILSAFE_MIN,
              },
              'FAILSAFE: dead-model gate would collapse pool below minimum — bypassing gate',
            );
          }
        }
      } catch (err) {
        log.warn(
          { requestId: context.requestId, error: String(err) },
          'Dead-model gate unavailable — proceeding without it',
        );
      }
    }

    // ── #2 Credential gate (prove-before-admit) ──────────────────────────────
    // Drop candidates with NO resolvable execution adapter — i.e. no registered
    // provider with a configured credential (registry membership == a key that
    // resolved at boot). These GUARANTEE a 401/auth failure at execution and
    // drive the fallback cascade (401 was the single largest error class in the
    // operability burst: 36 errors). Unlike the reactive hub gate above, this is
    // DETERMINISTIC — a key exists or it does not — and needs no prior runtime
    // failure. resolveAdapterForModel() walks the fallback chain, so a model with
    // a working fallback provider is kept. Same never-collapse FAILSAFE + env
    // kill-switch as the operability gate; fail-open on any error.
    if (process.env.SELECTION_CREDENTIAL_GATE !== 'false') {
      try {
        const registry = getProviderRegistry();
        const beforeCred = modelsToUse.length;
        const credEligible = modelsToUse.filter(
          (m) => registry.resolveAdapterForModel(m).adapter !== null,
        );
        const credRemoved = beforeCred - credEligible.length;
        if (credRemoved > 0) {
          if (credEligible.length >= POOL_FAILSAFE_MIN) {
            log.info(
              {
                requestId: context.requestId,
                before: beforeCred,
                after: credEligible.length,
                removed: credRemoved,
              },
              'Credential gate applied — dropped models whose execution provider has no configured key (prove-before-admit)',
            );
            modelsToUse = credEligible;
          } else {
            log.warn(
              {
                requestId: context.requestId,
                wouldRemain: credEligible.length,
                poolSize: beforeCred,
                threshold: POOL_FAILSAFE_MIN,
              },
              'FAILSAFE: credential gate would collapse pool below minimum — bypassing gate',
            );
          }
        }
      } catch (err) {
        log.warn(
          { requestId: context.requestId, error: String(err) },
          'Credential gate unavailable — proceeding without it',
        );
      }
    }

    // Balance-aware enrichment + #3 funding gate (prove-before-admit).
    // Enrich tags balanceStatus, then HARD-drop no-credits models (they 402 at
    // execution and feed the cascade — 27 errors in the operability burst). The
    // hub no_credits path is already gated above (Camada 1c); this closes the
    // balance-signal path, which was previously soft-scoring only. Never-collapse
    // FAILSAFE + env kill-switch. Local/self-hosted report 'local' (never dropped);
    // 'unknown' is kept and only soft-penalized in scoring below.
    try {
      const discoveryService = await getCentralModelDiscoveryService();
      discoveryService.enrichModelsWithBalanceStatus(modelsToUse);
      const statusCounts = { 'has-credits': 0, 'no-credits': 0, unknown: 0, local: 0 };
      for (const m of modelsToUse) {
        const s = m.balanceStatus || 'unknown';
        if (s in statusCounts) statusCounts[s as keyof typeof statusCounts]++;
      }
      log.info(
        { requestId: context.requestId, balanceStatusCounts: statusCounts },
        'Enriched models with balance status'
      );
      if (process.env.SELECTION_FUNDING_GATE !== 'false' && statusCounts['no-credits'] > 0) {
        const beforeFund = modelsToUse.length;
        const funded = modelsToUse.filter((m) => m.balanceStatus !== 'no-credits');
        if (funded.length >= POOL_FAILSAFE_MIN) {
          log.info(
            {
              requestId: context.requestId,
              before: beforeFund,
              after: funded.length,
              removed: beforeFund - funded.length,
            },
            'Funding gate applied — dropped no-credits models (prove-before-admit)'
          );
          modelsToUse = funded;
        } else {
          log.warn(
            {
              requestId: context.requestId,
              wouldRemain: funded.length,
              poolSize: beforeFund,
              threshold: POOL_FAILSAFE_MIN,
            },
            'FAILSAFE: funding gate would collapse pool below minimum — bypassing gate'
          );
        }
      }
    } catch {
      // Non-fatal: if discovery service is not ready, all models get 'unknown' status
    }

    // Per-model performance filter: exclude specific models that consistently fail.
    {
      const MIN_ATTEMPTS = 3;
      const MAX_SUCCESS_RATE = 0.20;
      const excluded: string[] = [];
      modelsToUse = modelsToUse.filter((m) => {
        const dynScore = corePerformanceTracker.getDynamicScore(m.id);
        if (!dynScore || dynScore.sampleCount < MIN_ATTEMPTS) return true;
        const successRate = 1 - dynScore.errorRate;
        if (successRate < MAX_SUCCESS_RATE) {
          excluded.push(`${m.id}(${m.provider}, ${(successRate * 100).toFixed(0)}% success, n=${dynScore.sampleCount})`);
          return false;
        }
        return true;
      });
      if (excluded.length > 0) {
        log.info(
          { requestId: context.requestId, excluded, removed: excluded.length, remaining: modelsToUse.length },
          'Filtered models with consistently high failure rate (per-model performance filter)'
        );
      }
    }

    log.info(
      {
        requestId: context.requestId,
        taskType: sanitizedCriteria.taskType,
        complexity: sanitizedCriteria.complexity,
        availableModels: modelsToUse.length,
        maxModels,
        source: availableModels ? 'provided' : 'database',
      },
      'Starting dynamic model selection'
    );

    // Refresh performance cache if needed
    await this.refreshCacheIfNeeded();

    // 🚨 Runtime capability validation
    //
    // NOTE (enterprise performance): Validating capabilities can trigger real provider calls.
    // Validating 300+ models on cold start can block requests and cause rate limiting/cost spikes.
    // We validate only a small, high-value subset per selection and rely on cached/declared
    // capabilities for the remainder.
    const capabilityValidator = getModelCapabilityValidator();
    const MAX_RUNTIME_CAPABILITY_VALIDATIONS = 25;
    const validationCandidateIds = new Set(
      modelsToUse
        .slice()
        .sort((a, b) => b.performance.quality - a.performance.quality)
        .slice(0, Math.min(MAX_RUNTIME_CAPABILITY_VALIDATIONS, modelsToUse.length))
        .map((m) => m.id)
    );

    if (modelsToUse.length > validationCandidateIds.size) {
      log.info(
        {
          totalModels: modelsToUse.length,
          validationCandidates: validationCandidateIds.size,
          maxValidations: MAX_RUNTIME_CAPABILITY_VALIDATIONS,
        },
        'Limiting runtime capability validation to top models to avoid blocking requests'
      );
    }
    let performanceTracker: ReturnType<typeof getModelPerformanceTracker> | null = null;
    try {
      performanceTracker = getModelPerformanceTracker();
    } catch (error) {
      log.warn({ error }, 'Model performance tracker not available, using historical data only');
    }

    // PERF (2026-06-29): warm the whole candidate pool's performance history in
    // ONE batched query before the scoring fan-out, so the per-candidate
    // getModelPerformance() calls below all hit the cache instead of firing ~N
    // concurrent ~8s learning_buckets lookups that self-contend on the same
    // table (measured ~20s sustained chat latency whenever the cache was cold).
    await this.prefetchModelPerformance(
      modelsToUse.map((m) => m.id),
      criteria.taskType
    );

    const modelsWithHistory = await Promise.all(
      modelsToUse.map(async (model) => {
        let validatedCapabilities = model.capabilities;

        // PERF (2026-06-28, Phase 1): resolve the adapter ONLY for the bounded
        // validation subset (validationCandidateIds, ~25 top-by-quality). Calling
        // providerRegistry.findModel(id) for ALL ~534 candidates was the dominant
        // cold-selection cost: findModel → getModelById does a `.find()` LINEAR SCAN
        // over the ~72k-row catalog cache, so ~534×72k ≈ 38M comparisons/request
        // (CPU-bound — matches the observed databaseQueries:1 with ~31s selectionTime).
        // Only these ~25 actually USE the adapter (for capability validation); the rest
        // resolved it and discarded it. Adapter resolution for EXECUTION happens later
        // in base-strategy, so this does not change which models are selectable.
        if (validationCandidateIds.has(model.id)) {
          try {
            const modelResult = await getProviderRegistry().findModel(model.id);
            if (modelResult?.adapter) {
              const validationResult = await capabilityValidator.validateCapabilities(
                model, // Current model from the catalog
                modelResult.adapter // Provider-specific adapter (OpenAI, VertexAI, etc.)
              );

              // Update capabilities if validation found issues
              if (validationResult.validationStatus !== 'valid') {
                validatedCapabilities = validationResult.capabilities;
                // ✅ UPDATE DATABASE: Persist validated capabilities for future requests.
                // Fire-and-forget — `validatedCapabilities` is already applied to THIS
                // request below; the DB write only benefits FUTURE requests, so it must
                // not block the per-model scoring Promise.all.
                void capabilityValidator.updateModelCapabilities(model.id, validatedCapabilities).catch(() => { /* non-critical */ });

                log.warn(
                  {
                    modelId: model.id,
                    provider: model.provider,
                    originalCapabilities: model.capabilities,
                    validatedCapabilities,
                    issues: validationResult.issues,
                    totalModelsValidated: modelsToUse.length,
                  },
                  '✅ Model capabilities validated and updated'
                );
              }
            }
          } catch (error) {
            log.warn(
              {
                error: getErrorMessage(error),
                modelId: model.id,
                provider: model.provider,
              },
              'Capability validation failed for model - continuing with declared capabilities'
            );
          }
        }

        // ✅ ENHANCED MODEL: Use validated capabilities for better selection
        const validatedModel = { ...model, capabilities: validatedCapabilities };

        // Get historical performance as fallback
        const history = await this.getModelPerformance(model.id, criteria.taskType);

        return {
          model: validatedModel, // Model with validated capabilities
          history, // Historical performance data
        };
      })
    );

    log.info(
      {
        totalModelsProcessed: modelsToUse.length,
        taskType: criteria.taskType,
        modelsValidated: modelsWithHistory.length,
      },
      '✅ COMPLETED: Runtime capability validation for models'
    );

    // ─── Caminho-C closure: HCRA semantic rerank via CapabilitySearchService ──
    //
    // When a `semanticQuery` is supplied on the criteria (or forwarded from
    // the OrchestrationContext via mergeCriteriaWithContext), call the
    // singleton-backed RRF (lexical + vector) search service and build a
    // `Map<modelId, SemanticRerankEntry>` keyed by the public `model.id`.
    // The map is consumed in the scoring loop below as a bounded
    // multiplicative boost — reshuffles within the eligible pool but never
    // overrides health / balance / capability gates already applied above.
    //
    // Failure-mode contract: any error in the search path (singleton not
    // ready, embedder down, pool exhausted) DEGRADES to legacy behaviour.
    // Selection still works; it just isn't semantically reranked.
    const candidatePool = modelsWithHistory.map(({ model }) => model);
    const semanticRerank = await this.applySemanticRerank(
      candidatePool,
      criteria,
      context.requestId,
    );

    // ✅ Score ALL  models using real-time metrics and capability validation
    // Caminho-C closure: bound the multiplicative boost so semantic
    // recall reshuffles WITHIN the eligible pool but never overrides
    // health/balance/capability gates above.
    const SEMANTIC_RERANK_MAX_BOOST = 0.30; // top RRF hit gets +30% on its score
    const scoredModels = await Promise.all(
      modelsWithHistory.map(async ({ model, history }) => {
        const baseScore = await this.scoreModel(model, history, criteria);
        const rerankKey = this.semanticRerankKey(model);
        const rerankEntry = semanticRerank.get(rerankKey);
        const semanticBoost = rerankEntry
          ? SEMANTIC_RERANK_MAX_BOOST * rerankEntry.rrfNorm
          : 0;
        const score = baseScore * (1 + semanticBoost);
        const reason = await this.explainScore(model, history, criteria, baseScore);

        // Include both real-time and historical performance data
        const realTimeMetrics = performanceTracker
          ? await performanceTracker.getPerformanceSummary(model.id, criteria.taskType)
          : { sampleSize: 0, successRate: 0, avgQualityScore: 0, avgCost: 0, avgLatency: 0 };

        // Type guard for realTimeMetrics
        const hasAvgLatency = 'avgLatency' in realTimeMetrics && typeof realTimeMetrics.avgLatency === 'number';
        const avgLatency = hasAvgLatency ? realTimeMetrics.avgLatency : ('avgResponseTime' in realTimeMetrics && typeof realTimeMetrics.avgResponseTime === 'number' ? realTimeMetrics.avgResponseTime : 0);

        return {
          model,
          score,
          reason,
          historicalPerformance: history
            ? {
                successRate: history.successCount / history.totalCount,
                avgQuality: history.avgQuality,
                avgCost: history.avgCost,
                avgLatency: history.avgLatency,
                sampleSize: history.totalCount,
              }
            : undefined,
          realTimePerformance: realTimeMetrics.sampleSize > 0
            ? {
                latencyMs: avgLatency,
                throughput: realTimeMetrics.avgCost > 0 ? 1 / realTimeMetrics.avgCost : undefined,
                quality: realTimeMetrics.avgQualityScore,
                reliability: realTimeMetrics.successRate,
              }
            : undefined,
          validatedCapabilities: {
            capabilities: model.capabilities,
            validationStatus: 'valid' as const,
            confidence: 1.0,
          },
        };
      })
    );

    log.info(
      {
        totalModelsScored: scoredModels.length, // All  models scored
        taskType: criteria.taskType,
        topScore: scoredModels[0]?.score,
        topModel: scoredModels[0]?.model.name,
        modelsWithRealTimeData: scoredModels.filter(
          (m) => m.realTimePerformance !== undefined
        ).length,
      },
      '✅ COMPLETED: Intelligent scoring for ALL  models using real-time metrics'
    );

    // Sort by score (descending) — balance-aware scoring already baked in
    scoredModels.sort((a, b) => b.score - a.score);

    // Select top N models with a small fallback pool for resiliency.
    const selectionLimit = Math.min(scoredModels.length, Math.max(maxModels, 5));
    const selected = scoredModels.slice(0, selectionLimit);

    // Filter out models with score below minimum threshold
    let filtered = selected.filter(
      (s) => s.score >= this.config.qualityDefaults.minimumThreshold
    );
    // NEVER-COLLAPSE FAILSAFE (C3 2026-06-11): if score penalties (the new health
    // penalty + the pre-existing -0.5 no-credits + cold-start penalties) would
    // zero the eligible pool while scored candidates still exist, fall back to the
    // top-N by raw score rather than returning []. A live-but-degraded route beats
    // a guaranteed no-eligible-model failure. Mirrors the unreliable-provider
    // POOL_FAILSAFE_MIN guard earlier in this method.
    if (filtered.length === 0 && selected.length > 0) {
      const failsafeN = Math.min(selected.length, Math.max(2, maxModels));
      filtered = selected.slice(0, failsafeN);
      log.warn(
        {
          requestId: context.requestId,
          scored: selected.length,
          kept: filtered.length,
          threshold: this.config.qualityDefaults.minimumThreshold,
        },
        'FAILSAFE: score-threshold filter would empty the pool — keeping top-N by raw score'
      );
    }

    // ── Lote 5 S2: Selection telemetry ──────────────────────────────────
    //
    // Counts candidates returned (post-filter) and — when a native provider
    // would have been chosen over a hub equivalent — records the preference
    // event. Also emits one `provider_selected` event per top result so
    // dashboards can see which providers are actually winning per task.
    recordSelectionCandidates(filtered.length, {
      taskType: String(criteria.taskType ?? 'general'),
      strategy: availableModels ? 'provided' : 'database',
    });
    if (filtered.length === 0) {
      recordNoEligibleModel({
        taskType: String(criteria.taskType ?? 'general'),
        totalScored: scoredModels.length,
      });
    } else {
      const top = filtered[0];
      const topKind = classifyProviderKind(top.model.provider);
      recordProviderSelected({
        provider: top.model.provider,
        providerKind: topKind,
        strategy: availableModels ? 'provided' : 'database',
        taskType: String(criteria.taskType ?? 'general'),
      });
      // Detect native-preferred-over-hub events: the top candidate is native
      // AND there exists a hub sibling (same model id family) earlier in the
      // unsorted score list. Emit one counter per event.
      if (topKind === 'native') {
        const hubSibling = scoredModels.find(
          (s) =>
            s.model.id === top.model.id &&
            classifyProviderKind(s.model.provider) === 'hub',
        );
        if (hubSibling) {
          recordNativePreferred({
            modelId: top.model.id,
            nativeProvider: top.model.provider,
            displacedHubProvider: hubSibling.model.provider,
          });
        }
      }
    }

    // Warn if all selected models are from providers with no credits
    if (filtered.length > 0 && filtered.every((s) => s.model.balanceStatus === 'no-credits')) {
      log.warn(
        {
          requestId: context.requestId,
          selectedCount: filtered.length,
          models: filtered.map((s) => `${s.model.name}(${s.model.provider})`),
        },
        'All selected models are from providers with no credits — requests may fail with HTTP 402/403'
      );
    }

    log.info(
      {
        requestId: context.requestId,
        selectedCount: filtered.length,
        topModel: filtered[0]?.model.name,
        topScore: filtered[0]?.score,
        selectionTime: Date.now() - startTime,
      },
      'Dynamic model selection completed'
    );

    // ✅ ENTERPRISE MONITORING: Record selection performance
    selectionMonitor.recordSelection({
      requestId: context.requestId,
      duration: Date.now() - startTime,
      criteria,
      modelsFound: modelsToUse.length,
      modelsSelected: filtered.length,
      cacheHits: 0, // Simplified for now
      cacheMisses: 0, // Simplified for now
      databaseQueries: availableModels ? 0 : 1,
      validationErrors: validation.errors.length,
      strategy: availableModels ? 'provided' : 'database',
      result: validation.valid ? 'success' : 'error',
    });

    return filtered;
  }

  /**
   * Select models for multi-stage collaborative tasks
   * Selects different models for different stages based on stage-specific requirements
   * Supports up to 9 models working collaboratively
   */
  async selectModelsForStages(
    stages: StageRequirements[],
    baseCriteria: SelectionCriteria,
    context: OrchestrationContext,
    maxModelsPerStage: number = 1
  ): Promise<MultiStageSelection> {
    log.info(
      {
        requestId: context.requestId,
        stages: stages.length,
        maxModelsPerStage,
      },
      'Selecting models for multi-stage collaborative task'
    );

    const stageSelections: Array<{
      stageName: string;
      stageType: string;
      selectedModels: SelectedModel[];
    }> = [];

    let totalCost = 0;
    let maxDuration = 0;

    // Select models for each stage
    for (const stage of stages) {
      // Build criteria for this specific stage
      const stageCriteria: SelectionCriteria = {
        ...baseCriteria,
        requiredCapabilities: stage.requiredCapabilities,
        requiredTools: stage.requiredTools,
        maxCost: stage.maxCost || baseCriteria.maxCost,
        qualityTarget: stage.qualityTarget || baseCriteria.qualityTarget,
        preferSpeed: stage.preferSpeed ?? baseCriteria.preferSpeed,
      };

      // Find models that meet this stage's requirements
      const stageModels = await this.findModelsByRequirements(
        stageCriteria,
        this.config.limits?.maxModelsPerStage ?? 50
      );

      // Select best models for this stage
      const selected = await this.selectModels(
        stageModels,
        stageCriteria,
        context,
        maxModelsPerStage
      );

      stageSelections.push({
        stageName: stage.stageName,
        stageType: stage.stageType,
        selectedModels: selected,
      });

      // Calculate cost and duration for this stage
      for (const selectedModel of selected) {
        const estimatedCost = this.estimateStageCost(selectedModel, baseCriteria);
        totalCost += estimatedCost;
      }

      // Estimate duration (use longest model latency)
      const stageDuration = Math.max(
        ...selected.map((m) => m.model.performance?.latencyMs || (this.config.latencyReference?.slowMs ?? 5000))
      );
      maxDuration += stageDuration;
    }

    log.info(
      {
        requestId: context.requestId,
        stages: stageSelections.length,
        totalModels: stageSelections.reduce((sum, s) => sum + s.selectedModels.length, 0),
        estimatedCost: totalCost,
        estimatedDuration: maxDuration,
      },
      'Multi-stage model selection completed'
    );

    return {
      stages: stageSelections,
      totalModels: stageSelections.reduce((sum, s) => sum + s.selectedModels.length, 0),
      estimatedCost: totalCost,
      estimatedDuration: maxDuration,
    };
  }

  /**
   * Estimate cost for a stage
   */
  private estimateStageCost(selectedModel: SelectedModel, criteria: SelectionCriteria): number {
    const estimatedInputTokens = criteria.contextSize;
    const estimatedOutputTokens = this.config.costEstimation?.defaultOutputTokens ?? 1000;

    return (
      (estimatedInputTokens / 1000) * selectedModel.model.inputCostPer1k +
      (estimatedOutputTokens / 1000) * selectedModel.model.outputCostPer1k
    );
  }

  /**
   * Rerank-map key for a runtime `Model`. The CapabilitySearchService
   * returns `modelId` which corresponds 1:1 to the public `model.id`
   * (e.g. "openai/gpt-4"); we use that as the lookup key on both sides.
   */
  private semanticRerankKey(model: Model): string {
    return model.id;
  }

  /**
   * Build a `Map<modelId, SemanticRerankEntry>` for the given candidate
   * pool by querying CapabilitySearchService.searchModels(). The map is
   * later consumed in the scoring loop to apply a bounded multiplicative
   * boost (≤ +30%).
   *
   * Returns an empty map if:
   *   - `criteria.semanticQuery` is missing or whitespace,
   *   - the candidate pool is empty,
   *   - the singleton or pg pool is unavailable,
   *   - the embedder fails AND lexical recall returns nothing.
   *
   * The query is bounded by `providerIds` derived from the candidate pool
   * so RRF cannot pull in models that already failed health / reliability /
   * balance gates above.
   */
  private async applySemanticRerank(
    candidates: Model[],
    criteria: SelectionCriteria,
    requestId?: string,
  ): Promise<Map<string, SemanticRerankEntry>> {
    const result = new Map<string, SemanticRerankEntry>();
    const query = criteria.semanticQuery?.trim();
    if (!query) return result;
    if (candidates.length === 0) return result;

    // Restrict the search universe to providers already in the candidate pool —
    // RRF must not surface models we've just filtered out for being unhealthy.
    const providerIds = Array.from(
      new Set(candidates.map((m) => m.providerId).filter((p): p is string => Boolean(p))),
    );

    const searchLimit = Math.max(20, Math.min(candidates.length, 100));

    let hits: ModelSearchHit[];
    try {
      const searchService = getCapabilitySearchService();
      hits = await searchService.searchModels({
        query,
        providerIds,
        limit: searchLimit,
      });
    } catch (err) {
      log.warn(
        { err: getErrorMessage(err), requestId, query, providerIds: providerIds.length },
        'Semantic rerank skipped — CapabilitySearchService unavailable',
      );
      return result;
    }

    if (hits.length === 0) {
      log.debug({ requestId, query }, 'Semantic rerank produced no hits');
      return result;
    }

    // Normalise RRF scores so the top hit = 1.0 and subsequent hits scale
    // down by their relative RRF magnitude. We use raw RRF (not rank) for
    // the norm so close ties stay close.
    const maxRrf = hits[0].score;
    const minRrf = hits[hits.length - 1].score;
    const span = Math.max(maxRrf - minRrf, 1e-9);

    hits.forEach((hit, idx) => {
      const rrfNorm = (hit.score - minRrf) / span;
      result.set(hit.modelId, {
        rank: idx + 1,
        rrfRaw: hit.score,
        rrfNorm: Number.isFinite(rrfNorm) ? Math.max(0, Math.min(1, rrfNorm)) : 0,
        matchedBy: hit.matchedBy,
      });
    });

    log.info(
      {
        requestId,
        query,
        candidatePoolSize: candidates.length,
        rerankHitCount: result.size,
        topModelId: hits[0]?.modelId,
        topRrfRaw: hits[0]?.score,
      },
      'Semantic rerank applied to candidate pool',
    );

    return result;
  }

  /**
   * Dynamic cold-start quality prior from HuggingFace's own popularity signals.
   *
   * The whole point: after a restart there is NO runtime history, so EVERY model
   * gets the same flat `fallbackScore` and an obscure 0-download fine-tune ties a
   * 2M-download model — the selector then picks junk by arbitrary table order.
   * Popularity (downloads/likes/trending) is a *live, dynamic* legitimacy signal
   * (re-fetched every discovery cycle), so using it pins NO specific model id and
   * still honours the "fully dynamic selection" invariant — it just stops the
   * cold-start from being blind.
   *
   * Returns a [0,1] prior, or `undefined` when the model carries NO popularity
   * signal at all (so the caller keeps the neutral flat fallback rather than
   * forcing a 0 onto e.g. curated native models that never had HF stats).
   * A captured `downloads: 0` is a REAL signal (→ ~0), distinct from an absent one.
   */
  private popularityPrior(model: Model): number | undefined {
    return popularityPriorFromMetadata(model.metadata as Record<string, unknown> | undefined);
  }

  /**
   * Score model based on historical performance and criteria
   */
  private async scoreModel(
    model: Model,
    history: PerformanceHistory | null,
    criteria: SelectionCriteria
  ): Promise<number> {
    let score = 0;
    const minimumSamples = this.config.performanceTracking.minimumSamples;

    // Check core tracker for real execution data (recorded by strategies/orchestration-engine).
    // Models with observed high error rates get a heavy penalty even if not yet excluded by the
    // pre-filter (e.g. only 1-2 samples so far).
    const coreDynScore = corePerformanceTracker.getDynamicScore(model.id);
    if (coreDynScore && coreDynScore.sampleCount >= 1) {
      const coreSuccessRate = 1 - coreDynScore.errorRate;
      if (coreSuccessRate < 0.20 && coreDynScore.sampleCount >= 3) {
        // Consistently broken — should not rank high even if pre-filter missed it
        return 0;
      }
      if (coreDynScore.errorRate > 0.5) {
        // More than half of attempts failed — heavy penalty
        score -= 0.4;
      } else if (coreDynScore.errorRate > 0.3) {
        score -= 0.2;
      }
    }

    const performanceTracker = getModelPerformanceTracker();
    const realTimeMetrics = await performanceTracker.getPerformanceSummary(
      model.id,
      criteria.taskType
    );

    if (realTimeMetrics.sampleSize >= minimumSamples) {
      score += realTimeMetrics.successRate * this.config.scoringWeights.realTime.successRate;
      score += realTimeMetrics.avgQualityScore * this.config.scoringWeights.realTime.qualityScore;
      score += realTimeMetrics.reliability * this.config.scoringWeights.realTime.reliability;
      score +=
        (realTimeMetrics.avgCost > 0 ? 1 / realTimeMetrics.avgCost : 1) *
        this.config.scoringWeights.realTime.costEfficiency;
    } else {
      // proven-first + popularity prior (2026-06-29): with no runtime samples,
      // anchor the prior on the model's measured quality if any, else on the
      // DYNAMIC HF popularity signal (downloads/likes), else the neutral flat
      // fallback. This is what sinks 0-download junk below real models at
      // cold-start without pinning any id. A captured downloads:0 → popPrior~0.
      const popPrior = this.popularityPrior(model);
      const intrinsicQuality =
        model.performance?.quality && model.performance.quality > 0
          ? model.performance.quality
          : popPrior ?? this.config.qualityDefaults.fallbackScore;
      score += intrinsicQuality * this.config.scoringWeights.fallback.intrinsicQuality;

      // Exploration penalty for low-observability candidates.
      // proven-first (2026-06-29): heavier penalty for ZERO-history models so an
      // obscure fine-tune can't tie a measured-good model (was 0.15).
      score -= realTimeMetrics.sampleSize === 0 ? 0.35 : 0.06;
    }

    if (history && history.totalCount >= 5 && realTimeMetrics.sampleSize < 10) {
      const metrics = await this.calculateMetrics(history, model.id);
      score += metrics.successRate * this.config.scoringWeights.historical.successRate;
      score += metrics.avgQuality * this.config.scoringWeights.historical.quality;
      score += metrics.costEfficiency * this.config.scoringWeights.historical.costEfficiency;
      score += metrics.recentTrend * 0.1;
    } else {
      // Same popularity-aware prior on the no-history branch (see above).
      const popPrior = this.popularityPrior(model);
      const intrinsicQuality =
        model.performance?.quality && model.performance.quality > 0
          ? model.performance.quality
          : popPrior ?? this.config.qualityDefaults.fallbackScore;
      score += intrinsicQuality * this.config.scoringWeights.fallback.noHistoryQuality;
    }

    if (realTimeMetrics.sampleSize >= minimumSamples && realTimeMetrics.successRate < 0.85) {
      score -= (0.85 - realTimeMetrics.successRate) * 0.35;
    }

    const observedLatencyMs =
      realTimeMetrics.sampleSize > 0
        ? realTimeMetrics.avgResponseTime
        : model.performance?.latencyMs || 0;

    if (criteria.preferSpeed) {
      if (realTimeMetrics.sampleSize === 0) {
        score -= 0.2;
      }
      if (observedLatencyMs > 0) {
        const fastMs = this.config.latencyReference.fastMs;
        const slowMs = this.config.latencyReference.slowMs;
        const speedFit = Math.max(
          0,
          Math.min(1, 1 - (observedLatencyMs - fastMs) / (slowMs - fastMs))
        );
        score += speedFit * 0.2;
      } else {
        // Missing latency signal under speed preference should be treated as risky.
        score -= 0.12;
      }

      if (observedLatencyMs >= 12_000) {
        score -= 0.12;
      }
      if (realTimeMetrics.sampleSize >= minimumSamples && realTimeMetrics.successRate < 0.9) {
        score -= 0.1;
      }

      const nameSignals = `${model.name || ''} ${model.id || ''}`.toLowerCase();
      const hasFastHint = ['mini', 'flash', 'fast', 'instant', 'turbo', 'nano', 'haiku'].some(
        (hint) => nameSignals.includes(hint)
      );
      if (hasFastHint) {
        score += 0.08;
      }

      // Penalize likely very large checkpoints for latency-sensitive flows.
      if (/\b\d{3,4}b\b/.test(nameSignals)) {
        score -= 0.2;
      } else if (/\b([7-9]\d|[1-9]\d{2,})b\b/.test(nameSignals)) {
        score -= 0.12;
      }
    }

    const taskFit = await this.calculateTaskFit(model, criteria.taskType);
    const taskFitConfidence =
      realTimeMetrics.sampleSize >= minimumSamples
        ? 1
        : realTimeMetrics.sampleSize > 0
          ? 0.75
          : 0.1; // proven-first (2026-06-29): a no-history model's task-fit is a GUESS — don't let it boost it into the pick (was 0.3)
    score += taskFit * this.config.scoringWeights.taskFit * taskFitConfidence;

    const capabilityFit = this.calculateCapabilityFit(model, criteria);
    score += capabilityFit * this.config.scoringWeights.capabilityFit;

    if (criteria.maxCost) {
      const costFit = this.calculateCostFit(model, criteria);
      score += costFit * this.config.scoringWeights.costFit;
    } else {
      score += this.config.neutralBonuses?.noBudget ?? 0.05;
    }

    if (criteria.qualityTarget) {
      const qualityFit = this.calculateQualityFit(model, history, criteria);
      score += qualityFit * this.config.scoringWeights.qualityFit;
    } else {
      score += this.config.neutralBonuses?.noQualityTarget ?? 0.05;
    }

    // Balance-aware scoring: prioritize models with known-working credits,
    // penalize (but don't exclude) models with no credits.
    const balanceStatus = model.balanceStatus || 'unknown';
    if (balanceStatus === 'has-credits' || balanceStatus === 'local') {
      score += 0.3;  // Strong boost for known-working providers
    } else if (balanceStatus === 'unknown') {
      score -= 0.1; // proven-first (2026-06-29): unproven credit is a mild risk — slight penalty so known-working models win ties (was neutral)
    } else if (balanceStatus === 'no-credits') {
      score -= 0.5;  // Heavy penalty but not excluded — last resort
    }

    // Operability health penalty (C3 2026-06-11): down-WEIGHT registry-poisoned
    // providers (fix D feeds 401/402/empty -> shouldSkipNearZero) so the FIRST
    // pick on the single/consensus path avoids known-dead gateways and the
    // collective's first fan-out lands on a live gateway (so B's retry stops
    // firing for poisoned providers). This runs in scoreModel (NOT a pre-sort
    // reorder) because the pool is re-sorted by score at L961, which would
    // discard positional intent. Keyed on the SAME effective provider the
    // balance enrichment uses (executionProvider||provider) so hub-routed rows
    // consult the execution provider, not the catalog provider. Bounded: the
    // penalty can never ALONE drive a >threshold model below minimumThreshold
    // (clamped to leave an epsilon above the gate); the terminal failsafe is the
    // second guard against pool collapse. O(1) in-memory registry read, silent
    // (no prom-client/timing emit on the hot path).
    if (this.operabilitySkip) {
      const execProvider =
        (typeof model.metadata?.executionProvider === 'string' && model.metadata.executionProvider) ||
        model.provider || '';
      const decision = this.operabilitySkip(
        { providerId: execProvider.toLowerCase(), modelId: model.id },
        { silent: true },
      );
      if (decision.skip) {
        const threshold = this.config.qualityDefaults.minimumThreshold;
        const maxPenalty = Math.max(0, score - (threshold - 0.01));
        score -= Math.min(0.3, maxPenalty);
      }
    }

    // ── Lote 5 S1: Provider-kind bias correction ────────────────────────
    //
    // Context: the local-run-4 benchmark exposed that the selector was
    // routing `openai/*` tasks through `nanogpt` (a hub with exhausted
    // credit) while native OpenAI ($19.02 balance) sat idle. Root causes:
    //   1. Native provider rows in the dev DB have `performance = {}`,
    //      which coerces `quality` to 0 → `fallbackScore = 0.5`.
    //   2. Hub rows have populated quality from catalog sync (>0.5).
    //   3. Balance probes hadn't run for most providers in dev → most
    //      providers sit at `unknown` with neutral score.
    //
    // Fix policy (explicit, not magic):
    //   - `native` + (has-credits OR unknown balance) → +0.1 bonus
    //   - `hub`    + unknown balance                  → -0.15 penalty
    //   - `local`  → no change (balance code already awards +0.3)
    //   - `unknown` kind → no change (preserve neutral for new providers)
    //
    // These numbers are small enough to be dominated by real performance
    // data when it exists, but large enough to flip a cold-start ranking
    // when everything else is tied. The operational effect is logged
    // via the `ailin_selection_*` metric family so dashboards can see
    // whether native preference is firing.
    const providerKind = classifyProviderKind(model.provider);
    if (providerKind === 'native' && balanceStatus !== 'no-credits') {
      score += 0.1;
    } else if (providerKind === 'hub' && balanceStatus !== 'no-credits') {
      // Penalize hub/proxy routes whenever a native route could serve instead.
      // BUGFIX (C3 2026-06-09): was gated on balanceStatus==='unknown', which let
      // FUNDED hubs (openrouter has-credits) keep the full +0.3 credit boost with
      // no hub offset and outrank native providers — so openrouter-proxied
      // anthropic/* models won the ranking and then returned empty/failed. A
      // no-credits hub already gets -0.5 elsewhere, so this stays additive.
      score -= 0.15;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Calculate recent trend from time-series performance data
   * Compares performance in last 7 days vs previous 30 days
   */
  private async calculateRecentTrend(modelId: string): Promise<number> {
    try {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Get recent performance (last 7 days)
      const recentMetrics = await prisma.modelPerformanceMetric.findMany({
        where: {
          modelId,
          timeBucket: {
            gte: sevenDaysAgo,
          },
        },
        select: {
          successRate: true,
          qualityScore: true,
        },
      });

      // Get historical performance (previous 30 days, excluding last 7)
      const historicalMetrics = await prisma.modelPerformanceMetric.findMany({
        where: {
          modelId,
          timeBucket: {
            gte: thirtyDaysAgo,
            lt: sevenDaysAgo,
          },
        },
        select: {
          successRate: true,
          qualityScore: true,
        },
      });

      if (recentMetrics.length === 0 || historicalMetrics.length === 0) {
        // Not enough data to calculate trend
        return 0;
      }

      // Calculate average quality score for recent period
      const recentAvgQuality = recentMetrics.reduce((sum, m) => sum + (m.qualityScore || 0), 0) / recentMetrics.length;

      // Calculate average quality score for historical period
      const historicalAvgQuality = historicalMetrics.reduce((sum, m) => sum + (m.qualityScore || 0), 0) / historicalMetrics.length;

      if (historicalAvgQuality === 0) {
        return 0;
      }

      // Calculate trend as percentage change (positive = improving, negative = degrading)
      const trend = (recentAvgQuality - historicalAvgQuality) / historicalAvgQuality;

      // Normalize to -1 to 1 range
      return Math.max(-1, Math.min(1, trend));
    } catch (error) {
      log.warn({ error, modelId }, 'Failed to calculate recent trend');
      return 0;
    }
  }

  /**
   * Calculate metrics from history
   */
  private async calculateMetrics(history: PerformanceHistory, modelId: string): Promise<ModelMetrics> {
    const successRate = history.successCount / history.totalCount;
    const avgQuality = history.avgQuality;
    const avgCost = history.avgCost;
    const avgLatency = history.avgLatency;

    // Cost efficiency: quality per dollar
    const costEfficiency = avgCost > 0 ? avgQuality / avgCost : 0;

    // Speed score: Normalize latency to 0-1 (lower is better)
    const fastMs = this.config.latencyReference?.fastMs ?? 500;
    const slowMs = this.config.latencyReference?.slowMs ?? 5000;
    const speedScore = Math.max(0, Math.min(1, 1 - (avgLatency - fastMs) / (slowMs - fastMs)));

    // Recent trend: Compare last 7 days vs. previous 30 days
    // Calculate trend from ModelPerformanceMetric time-series data
    const recentTrend = await this.calculateRecentTrend(modelId);

    return {
      successRate,
      avgQuality,
      avgCost,
      avgLatency,
      costEfficiency,
      speedScore,
      recentTrend,
    };
  }

  /**
   * Calculate task fit based on capabilities and performance, not model names
   * 100% dynamic - no hardcoded model name matching
   */
  private async calculateTaskFit(model: Model, taskType: TaskType): Promise<number> {
    try {
      // Load dynamic task preferences (returns model IDs sorted by score)
      const taskPreferences = await this.loadTaskPreferences(taskType);

      // Check if model ID is in the preferred list (by position/index)
      const modelIndex = taskPreferences.indexOf(model.id);
      if (modelIndex >= 0) {
        // Higher score for earlier matches (more preferred)
        // Models are already sorted by comprehensive score, so earlier = better
        return 1.0 - (modelIndex / taskPreferences.length) * 0.5; // Scale from 1.0 to 0.5
      }

      // If model not in preferences, use fallback calculation
      return this.calculateTaskFitFallback(model, taskType);
    } catch (error) {
      // Fallback to capability-based calculation if database unavailable
      log.warn(
        { error, taskType, modelId: model.id },
        'Failed to load task preferences, using fallback'
      );
      return this.calculateTaskFitFallback(model, taskType);
    }
  }

  /**
   * Load task preferences from database
   * 100% dynamic - no hardcoded model names, only capabilities and performance-based selection
   */
  private async loadTaskPreferences(taskType: TaskType | string): Promise<string[]> {
    // Normalize task type to ensure compatibility with CLI format
    const normalizedTaskType = this.normalizeTaskType(taskType);
    const taskPrefCacheKey = normalizedTaskType;
    const cachedTaskPref = this.taskPreferenceCache.get(taskPrefCacheKey);
    if (cachedTaskPref && cachedTaskPref.expiresAt > Date.now()) {
      return cachedTaskPref.ids;
    }

    // Dynamic model discovery: Query all available models and filter by capabilities
    try {
      const requiredCapabilities = this.getRequiredCapabilitiesForTask(normalizedTaskType);
      const availableModels = await this.discoverModelsByCapabilities(requiredCapabilities);

      if (availableModels.length === 0) {
        // Ultimate fallback: get generic task preferences (100% dynamic, no hardcoded models)
        log.warn(
          { taskType: normalizedTaskType },
          'No models found with required capabilities, using generic preferences'
        );
        const generic = await this.getGenericTaskPreferences([]);
        this.taskPreferenceCache.set(taskPrefCacheKey, {
          ids: generic,
          expiresAt: Date.now() + 60_000,
        });
        return generic;
      }

      // Return model IDs sorted by comprehensive preference score (capabilities + performance + cost)
      const sortedIds = availableModels
        .sort((a, b) => this.calculateModelPreferenceScore(b, normalizedTaskType) - this.calculateModelPreferenceScore(a, normalizedTaskType))
        .slice(0, this.config.limits?.maxModelsPerTaskPreference ?? 10)
        .map(model => model.id);
      this.taskPreferenceCache.set(taskPrefCacheKey, {
        ids: sortedIds,
        expiresAt: Date.now() + 60_000,
      });
      return sortedIds;
    } catch (error) {
      log.warn(
        { taskType: normalizedTaskType, error: error instanceof Error ? error.message : String(error) },
        'Dynamic model discovery failed, using generic preferences'
      );
      // Fallback to generic preferences (100% dynamic, no hardcoded models)
      const generic = await this.getGenericTaskPreferences([]);
      this.taskPreferenceCache.set(taskPrefCacheKey, {
        ids: generic,
        expiresAt: Date.now() + 60_000,
      });
      return generic;
    }
  }

  /**
   * Get generic task preferences based only on capabilities and performance
   * 100% dynamic - no hardcoded model names, fully capability and performance-based
   */
  private async getGenericTaskPreferences(excludeModels: string[] = []): Promise<string[]> {
    const excludeSet = new Set(excludeModels);

    try {
      // Get all available models from database
      const allModels = await getAllCatalogModels();
      const activeModels = allModels.filter(
        (m) => m.status === 'active' && !excludeSet.has(m.id)
      );

      if (activeModels.length === 0) {
        log.warn('No active models available for generic task preferences');
        return [];
      }

      // Filter for general-purpose models (chat + reasoning capabilities)
      const generalPurposeCandidates = activeModels.filter((m) => {
        const caps = new Set(m.capabilities ?? []);
        const hasChat = caps.has('chat' as ModelCapability) || caps.has('text_generation' as ModelCapability);
        const hasReasoning = caps.has('reasoning' as ModelCapability) || caps.has('analysis' as ModelCapability);
        return hasChat && hasReasoning;
      });

      // Use general-purpose models if available, otherwise use all active models
      const candidates = generalPurposeCandidates.length > 0 ? generalPurposeCandidates : activeModels;

      // Score all candidates based on general quality metrics (performance + cost efficiency)
      const scoredModels = candidates.map((model) => ({
        model,
        score: this.calculateGeneralModelScore(model),
      }));

      // Return top models sorted by general score
      return scoredModels
        .sort((a, b) => b.score - a.score)
        .slice(0, this.config.limits?.maxModelsPerTaskFallback ?? 6)
        .map((item) => item.model.id);
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to get generic task preferences'
      );
      return [];
    }
  }

  /**
   * Calculate general model score based on performance and cost efficiency
   * No hardcoded preferences - purely metrics-based
   */
  private calculateGeneralModelScore(model: Model): number {
    let score = 0;

    // Performance quality (40% weight)
    if (model.performance?.quality) {
      score += model.performance.quality * 0.4;
    } else {
      score += this.config.qualityDefaults?.fallbackScore ?? 0.5 * 0.4;
    }

    // Reliability (20% weight)
    if (model.performance?.reliability) {
      score += model.performance.reliability * 0.2;
    }

    // Cost efficiency (20% weight) - prefer lower cost for same quality
    if (model.inputCostPer1k && model.outputCostPer1k) {
      const avgCost = (model.inputCostPer1k + model.outputCostPer1k) / 2;
      // Lower cost = higher score (inverse relationship)
      const costScore = avgCost > 0 ? Math.max(0, 1 - Math.min(avgCost / 0.1, 1)) : 0.5;
      score += costScore * 0.2;
    }

    // Capability breadth (10% weight) - more capabilities = better
    const capabilityCount = model.capabilities?.length ?? 0;
    score += Math.min(capabilityCount / 10, 1) * 0.1;

    // Context window size (10% weight) - larger context = better (up to a point)
    if (model.contextWindow) {
      const contextScore = Math.min(model.contextWindow / 200000, 1); // Normalize to 200k max
      score += contextScore * 0.1;
    }

    return Math.min(1.0, score);
  }

  /**
   * Fallback task fit calculation when database is unavailable
   * Uses capability matching for more accurate scoring
   */
  private calculateTaskFitFallback(model: Model, taskType: TaskType | string): number {
    // Normalize task type to ensure compatibility
    const normalizedTaskType = this.normalizeTaskType(taskType);
    const capabilities = ensureModelCapabilityArray(model.capabilities);
    const requiredCaps = this.getRequiredCapabilitiesForTask(normalizedTaskType);

    // Calculate fit based on capability matching
    const matchedCaps = requiredCaps.filter(cap => capabilities.includes(cap));
    const fitRatio = requiredCaps.length > 0 ? matchedCaps.length / requiredCaps.length : 0;

    // Base score from capability fit (70% weight)
    let score = fitRatio * 0.7;

    // Bonus for additional relevant capabilities (30% weight distributed)
    if (capabilities.includes('vision')) score += 0.1;
    if (capabilities.includes('function_calling')) score += 0.1;
    if (capabilities.includes('streaming')) score += 0.05;

    // Performance bonus (10% weight)
    if (model.performance?.quality && model.performance.quality > 0.8) {
      score += 0.1;
    }

    return Math.min(1.0, score);
  }

  /**
   * Calculate capability fit
   *
   * Two-component blend:
   *
   *   1. Context-window adequacy — hard gate (returns 0 if context
   *      exceeds model.contextWindow) plus a small utilization penalty
   *      for over-provisioning. Existing behaviour, preserved.
   *
   *   2. HCRA capability-confidence — Caminho-C Stage 3. Among the
   *      survivors of the upstream URI/legacy filter, prefer models
   *      whose `capabilityConfidence` map shows stronger evidence for
   *      the required capabilities. See `calculateCapabilityConfidenceScore`.
   *
   * Why blend instead of replace: capability *presence* is already a
   * binary gate upstream (the ALL-of filter at line ~388). What was
   * missing was using HCRA's per-URI confidence to *rank* among the
   * survivors. Equal-weight blend keeps context fit influential for
   * narrow-window prompts while letting confidence break ties when
   * multiple models could serve the request.
   */
  private calculateCapabilityFit(model: Model, criteria: SelectionCriteria): number {
    // Hard gate — model can't fit the prompt at all.
    if (criteria.contextSize > model.contextWindow) {
      return 0;
    }

    // Component 1: context-window utilization (existing behaviour).
    const utilization = criteria.contextSize / model.contextWindow;
    const contextScore = utilization < 0.1 ? 0.9 : 1.0;

    // Component 2: HCRA confidence-aware score (new).
    const confidenceScore = this.calculateCapabilityConfidenceScore(
      model,
      criteria.requiredCapabilities,
    );

    // 50/50 blend. If we want to tune this later, surface as
    // scoringWeights.capabilityFit.{context,confidence}.
    return 0.5 * contextScore + 0.5 * confidenceScore;
  }

  /**
   * HCRA confidence score for a model against a set of required capabilities.
   *
   * Returns a value in [0, 1]:
   *
   *   - 1.0 when there are no required capabilities (confidence is
   *     irrelevant — neutral pass-through).
   *
   *   - 0.5 when the model has no capabilityConfidence map. This is the
   *     "backfill in progress" case: the row predates the HCRA backfill
   *     and has only the legacy `capabilities` array. We neither
   *     penalize nor reward — neutral 0.5 keeps these models ranked the
   *     same as if this scoring dimension didn't exist.
   *
   *   - geometric mean of per-URI confidence values otherwise. Geometric
   *     (vs arithmetic) mean enforces the same ALL-of semantic the
   *     filter uses: a model with confidence [1.0, 0.1] should rank
   *     below one at [0.6, 0.6] even though their arithmetic means tie.
   *
   * Defence in depth: if the upstream filter is bypassed and a model
   * with a missing URI reaches this method, the geometric mean returns
   * a small positive number (clamped to ≥ 0.01) instead of zero, so
   * the score degrades smoothly rather than crashing the multi-objective
   * optimizer's downstream weighted sum.
   */
  private calculateCapabilityConfidenceScore(
    model: Model,
    requiredCapabilities: ModelCapability[] | undefined,
  ): number {
    if (!requiredCapabilities || requiredCapabilities.length === 0) {
      return 1.0;
    }

    const confidence = model.capabilityConfidence;
    if (!confidence || Object.keys(confidence).length === 0) {
      return 0.5;
    }

    const requiredUris = legacyArrayToUriArray(requiredCapabilities);
    let logSum = 0;
    for (const uri of requiredUris) {
      const c = confidence[uri];
      // Clamp to [0.01, 1] — keeps log finite, lets a missing URI
      // contribute a heavy but bounded penalty rather than zero-ing.
      const clamped = Math.max(0.01, Math.min(1, typeof c === 'number' ? c : 0.01));
      logSum += Math.log(clamped);
    }
    return Math.exp(logSum / requiredUris.length);
  }

  /**
   * Calculate cost fit
   */
  private calculateCostFit(model: Model, criteria: SelectionCriteria): number {
    if (!criteria.maxCost) return 1.0;

    // Estimate cost for this request
    const estimatedInputTokens = criteria.contextSize;
    const estimatedOutputTokens = this.config.costEstimation?.defaultOutputTokens ?? 1000;

    const estimatedCost =
      (estimatedInputTokens / 1000) * model.inputCostPer1k +
      (estimatedOutputTokens / 1000) * model.outputCostPer1k;

    if (estimatedCost > criteria.maxCost) {
      return 0; // Too expensive
    }

    // Prefer models that use budget efficiently
    const budgetUtilization = estimatedCost / criteria.maxCost;

    if (budgetUtilization > 0.5 && budgetUtilization < 0.9) {
      return 1.0; // Optimal range
    } else if (budgetUtilization <= 0.5) {
      return 0.7; // Under-utilizing budget
    } else {
      return 0.5; // Close to limit
    }
  }

  /**
   * Calculate quality fit
   */
  private calculateQualityFit(
    model: Model,
    history: PerformanceHistory | null,
    criteria: SelectionCriteria
  ): number {
    if (!criteria.qualityTarget) return 1.0;

    // Use historical quality if available, otherwise intrinsic
    const quality = history?.avgQuality || model.performance?.quality || 0.5;

    if (quality >= criteria.qualityTarget) {
      return 1.0; // Meets or exceeds target
    } else {
      // Proportional penalty
      return quality / criteria.qualityTarget;
    }
  }

  /**
   * Explain score (for transparency)
   */
  private async explainScore(
    model: Model,
    history: PerformanceHistory | null,
    criteria: SelectionCriteria,
    _score: number
  ): Promise<string> {
    const reasons: string[] = [];

    // Historical performance
    if (history && history.totalCount >= 5) {
      const successRate = (history.successCount / history.totalCount) * 100;
      reasons.push(`${successRate.toFixed(0)}% success rate`);
      reasons.push(`avg quality ${history.avgQuality.toFixed(2)}`);
    } else {
      reasons.push('limited history');
    }

    // Task fit
    const taskFit = await this.calculateTaskFit(model, criteria.taskType);
    if (taskFit >= 0.8) {
      reasons.push('excellent task fit');
    } else if (taskFit >= 0.6) {
      reasons.push('good task fit');
    }

    // Cost
    if (criteria.maxCost) {
      const estimatedOutputTokens = this.config.costEstimation?.defaultOutputTokens ?? 1000;
      const estimatedCost =
        (criteria.contextSize / 1000) * model.inputCostPer1k +
        (estimatedOutputTokens / 1000) * model.outputCostPer1k;
      reasons.push(`est. $${estimatedCost.toFixed(4)}`);
    }

    return reasons.join(', ');
  }

  /**
   * Get model performance from history
   */
  private async getModelPerformance(
    modelId: string,
    taskType: string
  ): Promise<PerformanceHistory | null> {
    const cacheKey = `${modelId}:${taskType}`;

    // Check cache. Use has() so a cached `null` (model with no history) is
    // honoured and never re-queried — the bulk prefetch below relies on this.
    if (this.performanceCache.has(cacheKey)) {
      return this.performanceCache.get(cacheKey) ?? null;
    }

    try {
      // Query learning buckets for last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const buckets = await prisma.learningBucket.findMany({
        where: {
          strategyId: modelId,
          bucketTime: {
            gte: thirtyDaysAgo,
          },
        },
        select: {
          executionCount: true,
          successCount: true,
          avgQuality: true,
          avgCostUsd: true,
          avgDurationMs: true,
        },
      });

      if (buckets.length === 0) {
        this.performanceCache.set(cacheKey, null);
        return null;
      }

      const history = this.aggregateBuckets(modelId, taskType, buckets);
      this.performanceCache.set(cacheKey, history);

      return history;
    } catch (error) {
      log.error(
        {
          error,
          modelId,
          taskType,
        },
        'Failed to get model performance'
      );
      return null;
    }
  }

  /**
   * Aggregate a model's learning buckets into a PerformanceHistory. Shared by
   * the per-candidate getModelPerformance() path and the bulk prefetch below so
   * the weighting math stays in one place.
   */
  private aggregateBuckets(
    modelId: string,
    taskType: string,
    buckets: ReadonlyArray<{
      executionCount: number;
      successCount: number;
      avgQuality: unknown;
      avgCostUsd: unknown;
      avgDurationMs: unknown;
    }>
  ): PerformanceHistory {
    const totalCount = buckets.reduce((sum, b) => sum + b.executionCount, 0);
    const successCount = buckets.reduce((sum, b) => sum + b.successCount, 0);
    const avgQuality =
      buckets.reduce((sum, b) => sum + Number(b.avgQuality ?? 0) * b.executionCount, 0) /
      (totalCount || 1);
    const avgCost =
      buckets.reduce((sum, b) => sum + Number(b.avgCostUsd ?? 0) * b.executionCount, 0) /
      (totalCount || 1);
    const avgLatency =
      buckets.reduce((sum, b) => sum + Number(b.avgDurationMs ?? 0) * b.executionCount, 0) /
      (totalCount || 1);

    return {
      modelId,
      taskType,
      successCount,
      totalCount,
      avgQuality,
      avgCost,
      avgLatency,
      lastUpdated: new Date(),
    };
  }

  /**
   * PERF (2026-06-29): Bulk-load historical performance for an entire candidate
   * pool in ONE query before the scoring fan-out.
   *
   * Measured root cause of sustained ~20s chat latency: the per-candidate
   * getModelPerformance() each fired a `learning_buckets` lookup that ran ~8s
   * under load, and ~N of them executed concurrently inside the scoring
   * Promise.all (model:'auto' scores the whole pool). They hammer the same
   * large table and self-contend, so the request only stayed fast when the
   * cache was warm — and refreshCacheIfNeeded() clears that cache periodically,
   * so most requests paid the cold fan-out.
   *
   * One batched IN-list query does a single index scan and populates the cache
   * for the whole pool, INCLUDING a cached `null` for models with no history so
   * they are never re-queried individually. Fail-open: on any error the
   * per-candidate path still works.
   */
  private async prefetchModelPerformance(modelIds: string[], taskType: string): Promise<void> {
    const uncached = Array.from(new Set(modelIds)).filter(
      (id) => !this.performanceCache.has(`${id}:${taskType}`)
    );
    if (uncached.length === 0) {
      return;
    }

    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const rows = await prisma.learningBucket.findMany({
        where: {
          strategyId: { in: uncached },
          bucketTime: { gte: thirtyDaysAgo },
        },
        select: {
          strategyId: true,
          executionCount: true,
          successCount: true,
          avgQuality: true,
          avgCostUsd: true,
          avgDurationMs: true,
        },
      });

      const byModel = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = byModel.get(row.strategyId);
        if (list) {
          list.push(row);
        } else {
          byModel.set(row.strategyId, [row]);
        }
      }

      for (const id of uncached) {
        const buckets = byModel.get(id);
        this.performanceCache.set(
          `${id}:${taskType}`,
          buckets && buckets.length > 0 ? this.aggregateBuckets(id, taskType, buckets) : null
        );
      }
    } catch (error) {
      // Fail-open: leave the cache as-is; getModelPerformance() falls back to
      // its existing per-candidate path. Never block selection on prefetch.
      log.warn(
        { error: getErrorMessage(error), candidates: uncached.length, taskType },
        'Bulk performance prefetch failed - falling back to per-candidate lookups'
      );
    }
  }

  /**
   * Refresh cache if needed
   */
  private async refreshCacheIfNeeded(): Promise<void> {
    const now = Date.now();

    if (now - this.lastCacheUpdate > this.config.cacheExpiryMs) {
      log.debug('Refreshing performance and selection caches');
      this.performanceCache.clear();
      // selectionCache (findModelsByRequirements' candidate-pool cache) was never
      // cleared here — it lived for the lifetime of the process. A provider that
      // recovers/degrades, or a catalog change from discovery, would never be
      // reflected in candidate pools for identical criteria until restart. Same
      // TTL as performanceCache: it's the same "how stale can a selection be"
      // policy (cacheExpiryMs / MODEL_CACHE_EXPIRY_MS), just a different cache.
      this.selectionCache.clear();
      this.lastCacheUpdate = now;
    }
  }

  /**
   * Format date for bucket query
   */
  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    return `${year}-${month}-${day}-${hour}`;
  }

  /**
   * Record model performance (called after execution)
   */
  async recordPerformance(
    modelId: string,
    taskType: string,
    success: boolean,
    quality: number,
    cost: number,
    latency: number
  ): Promise<void> {
    try {
      // This would be called by the orchestration engine after each execution
      // Data is aggregated into learning buckets by the auto-learning system
      log.debug(
        {
          modelId,
          taskType,
          success,
          quality,
          cost,
          latency,
        },
        'Recording model performance'
      );

      // Invalidate cache for this model/task
      const cacheKey = `${modelId}:${taskType}`;
      this.performanceCache.delete(cacheKey);
    } catch (error) {
      log.error(
        {
          error,
          modelId,
          taskType,
        },
        'Failed to record model performance'
      );
    }
  }

  private mergeCriteriaWithContext(
    criteria: SelectionCriteria,
    context: OrchestrationContext
  ): SelectionCriteria {
    const mergedCapabilities = Array.from(
      new Set([
        ...(criteria.requiredCapabilities ?? []),
        ...(context.requiredCapabilities ?? []),
      ])
    ) as ModelCapability[];

    const mergedTools = Array.from(
      new Set([...(criteria.requiredTools ?? []), ...(context.requiredTools ?? [])])
    );

    const toLowerUnique = (values?: string[]): string[] | undefined => {
      if (!values || values.length === 0) {
        return undefined;
      }
      const normalized = values.map((value) => value.toLowerCase().trim()).filter(Boolean);
      return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
    };

    const preferredProviders = toLowerUnique(
      criteria.preferredProviders && criteria.preferredProviders.length > 0
        ? criteria.preferredProviders
        : context.preferredProviders
    );
    const excludeProviders = toLowerUnique(
      criteria.excludeProviders && criteria.excludeProviders.length > 0
        ? criteria.excludeProviders
        : context.excludedProviders
    );

    const merged: SelectionCriteria = {
      ...criteria,
      contextSize: criteria.contextSize,
      requiredCapabilities: mergedCapabilities.length > 0 ? mergedCapabilities : undefined,
      requiredTools: mergedTools.length > 0 ? mergedTools : undefined,
      requiredEndpoint: criteria.requiredEndpoint ?? context.requiredEndpoint,
      preferredProviders,
      excludeProviders,
      maxCost: criteria.maxCost ?? context.maxCost,
      qualityTarget: criteria.qualityTarget ?? context.qualityTarget,
      maxInputCostPer1k: criteria.maxInputCostPer1k ?? context.maxInputCostPer1k,
      maxOutputCostPer1k: criteria.maxOutputCostPer1k ?? context.maxOutputCostPer1k,
      maxAverageCostPer1k:
        criteria.maxAverageCostPer1k ?? context.maxAverageCostPer1k,
      // Caminho-C: forward the semantic query from context so the
      // selector's RRF rerank can run when callers populated it on
      // OrchestrationContext (HTTP path) instead of SelectionCriteria.
      semanticQuery: criteria.semanticQuery ?? context.semanticQuery,
    };

    return merged;
  }

  private shouldApplyChatGenerationGuard(criteria: SelectionCriteria): boolean {
    const endpoint = criteria.requiredEndpoint?.toLowerCase();
    if (endpoint === 'embeddings' || endpoint === 'images' || endpoint === 'audio_speech') {
      return false;
    }

    // Skip guard when non-text modalities are required (image gen, audio, video, vision).
    // This allows multimodal models to be selected for requests that need them.
    const nonTextCaps = [
      'image_generation', 'image_editing', 'video_generation', 'video_editing',
      'audio_generation', 'text_to_speech', 'vision', 'multimodal', 'computer_use',
    ];
    if (criteria.requiredCapabilities?.some(cap => nonTextCaps.includes(cap))) {
      return false;
    }

    // For orchestration task types, default to generative/chat-capable models.
    return true;
  }

  private isChatGenerationCapable(model: Model): boolean {
    const caps = new Set(model.capabilities || []);
    const hasChatTextCapability =
      caps.has('chat') || caps.has('text_generation');
    const isCompletionsOnly = caps.has('completions') && !hasChatTextCapability;
    const hasEmbeddingCapability = caps.has('embedding') || caps.has('embeddings');
    const isEmbeddingOnly = hasEmbeddingCapability && !hasChatTextCapability;
    const endpoint =
      model.metadata && typeof model.metadata.endpoint === 'string'
        ? model.metadata.endpoint.toLowerCase()
        : undefined;
    const isNonChatEndpoint =
      endpoint === 'embeddings' ||
      endpoint === 'images' ||
      endpoint === 'audio_speech' ||
      endpoint === 'completions';
    const normalizedName = `${model.name || ''} ${model.id || ''}`.toLowerCase();
    const hasNonChatNameSignal = [
      'transcribe',
      'transcription',
      'speech-to-text',
      'audio-transcribe',
      'audio-transcription',
      'text-to-speech',
      ' tts',
      '-tts',
      '_tts',
    ].some((signal) => normalizedName.includes(signal));
    const providerName = (model.provider || '').toLowerCase();
    const isOpenAIFamily =
      providerName === 'openai' || normalizedName.includes('openai/');
    const hasCompletionOnlyNameSignal =
      /-(001|002)\b/.test(normalizedName) ||
      (isOpenAIFamily &&
        ['babbage', 'davinci', 'curie', 'ada', 'instruct'].some((hint) =>
          normalizedName.includes(hint)
        ));

    return (
      hasChatTextCapability &&
      !isCompletionsOnly &&
      !isEmbeddingOnly &&
      !isNonChatEndpoint &&
      !hasNonChatNameSignal &&
      !hasCompletionOnlyNameSignal
    );
  }

  /**
   * Normalize task type from CLI format (snake_case) to API format (kebab-case)
   * Supports both formats for backward compatibility
   */
  private normalizeTaskType(taskType: TaskType | string): TaskType {
    // Map CLI snake_case to API kebab-case
    const taskTypeMap: Record<string, TaskType> = {
      'code_generation': 'code-generation',
      'code-generation': 'code-generation',
      'code_review': 'code-review',
      'code-review': 'code-review',
      'git_operation': 'general', // Map git_operation to general
      'chat': 'general',
      'general': 'general',
      'debugging': 'debugging',
      'refactoring': 'refactoring',
      'documentation': 'documentation',
      'testing': 'testing',
      'analysis': 'analysis',
      'qa': 'qa',
    };

    return taskTypeMap[taskType] ?? 'general';
  }

  /**
   * Get required capabilities for a specific task type
   */
  private getRequiredCapabilitiesForTask(taskType: TaskType | string): ModelCapability[] {
    const normalizedTaskType = this.normalizeTaskType(taskType);
    const capabilityMap: Record<TaskType, ModelCapability[]> = {
      'code-generation': ['text_generation', 'code_interpreter'],
      'debugging': ['text_generation', 'reasoning', 'code_interpreter'],
      'code-review': ['text_generation', 'reasoning', 'analysis'],
      'refactoring': ['text_generation', 'reasoning', 'code_generation'],
      'documentation': ['text_generation', 'reasoning', 'code_generation'],
      'analysis': ['reasoning', 'analysis', 'text_generation'],
      'qa': ['text_generation', 'reasoning', 'analysis'],
      'general': ['chat', 'text_generation'],
      'testing': ['text_generation', 'code_interpreter', 'analysis'],
      'caching': ['chat', 'text_generation'],
      'reasoning': ['reasoning', 'thinking_mode', 'text_generation'],
      'decision-making': ['reasoning', 'analysis', 'text_generation'],
      'architecture': ['reasoning', 'analysis', 'text_generation', 'code_generation'],
      'creative': ['text_generation', 'chat'],
      'factual-qa': ['text_generation', 'reasoning', 'chat'],
      'adversarial': ['reasoning', 'text_generation', 'chat'],
      'document-understanding': ['reasoning', 'analysis', 'text_generation'],
    };

    return capabilityMap[normalizedTaskType] || ['text_generation'];
  }

  /**
   * Discover models that match required capabilities from all providers
   */
  private async discoverModelsByCapabilities(requiredCapabilities: ModelCapability[]): Promise<Model[]> {
    try {
      // Try to get models from database first
      const dbModels = await this.getModelsFromDatabase(requiredCapabilities);
      if (dbModels.length > 0) {
        return dbModels;
      }

      // Relaxed fallback: accept models that match ANY requested capability.
      const repository = getModelRepository();
      const relaxedModels = await repository.findModelsWithCapabilities(requiredCapabilities, {
        anyMatch: true,
        limit: 100,
      });
      if (relaxedModels.length > 0) {
        log.warn(
          { requiredCapabilities, count: relaxedModels.length },
          'No strict capability match found; using relaxed capability matching from local catalog'
        );
        return relaxedModels;
      }

      // Real-time provider discovery is expensive and can overload local dev evals.
      // Keep it opt-in for explicit experiments.
      if (process.env.MODEL_SELECTION_REALTIME_DISCOVERY === 'true') {
        return await this.discoverModelsFromProviders(requiredCapabilities);
      }

      log.warn(
        { requiredCapabilities },
        'No capability match found in local catalog and realtime discovery disabled'
      );
      return [];
    } catch (error) {
      console.warn('Failed to discover models by capabilities:', error);
      return [];
    }
  }

  /**
   * Get models from database that match capabilities
   */
  private async getModelsFromDatabase(requiredCapabilities: ModelCapability[]): Promise<Model[]> {
    try {
      if (requiredCapabilities.length === 0) {
        // If no specific capabilities required, get all active models
        const repository = getModelRepository();
        return repository.getAllModels();
      }

      // Use ModelRepository to query models with required capabilities
      const repository = getModelRepository();
      const models = await repository.findModelsWithCapabilities(requiredCapabilities, {
        anyMatch: false, // Require ALL capabilities
        limit: 100, // Reasonable limit
      });

      log.debug(
        {
          requiredCapabilities,
          foundModels: models.length,
        },
        'Queried models from database'
      );

      return models;
    } catch (error: unknown) {
      const { getErrorMessage } = await import('@/utils/type-guards');
      const errorMessage = getErrorMessage(error);
      
      // IMPORTANT: Database errors should NOT be masked
      // Log the error but re-throw to ensure proper error handling upstream
      // This ensures database connectivity issues are properly alerted
      log.error(
        { error: errorMessage, requiredCapabilities },
        'Database model query failed - this indicates a database connectivity or schema issue that must be resolved'
      );
      
      // Re-throw to ensure proper error propagation
      // Database connectivity is critical and must not be silently ignored
      throw error;
    }
  }

  /**
   * Discover models from providers in real-time
   */
  private async discoverModelsFromProviders(_requiredCapabilities: ModelCapability[]): Promise<Model[]> {
    const discoveredModels: Model[] = [];

    try {
      // Import and use the central discovery service
      const { getCentralModelDiscoveryService } = await import('../../services/central-model-discovery-service.js');

      const discoveryService = await getCentralModelDiscoveryService();

      // Discover from all providers
      const discoveryResults = await discoveryService.discoverAllModels();

      // After discovery, models are stored in the database
      // Query the database to get the actual discovered models
      const repository = getModelRepository();
      const discoveredModelsFromDb = await repository.findModelsWithCapabilities(_requiredCapabilities, {
        anyMatch: false,
        limit: 100,
      });

      log.debug(
        {
          requiredCapabilities: _requiredCapabilities,
          discoveryResultsCount: discoveryResults.length,
          discoveredModelsFromDb: discoveredModelsFromDb.length,
        },
        'Discovered models from providers and queried from database'
      );

      return discoveredModelsFromDb;
    } catch (error) {
      console.warn('Provider discovery failed:', error);
    }

    return discoveredModels;
  }

  /**
   * Check if a model has the required capabilities
   */
  private modelHasCapabilities(model: Model, requiredCapabilities: ModelCapability[]): boolean {
    if (!model.capabilities || !Array.isArray(model.capabilities)) {
      return false;
    }

    // Check if model has ALL required capabilities
    return requiredCapabilities.every(requiredCap =>
      model.capabilities.some((modelCap: ModelCapability) =>
        modelCap === requiredCap ||
        this.capabilityMatches(modelCap, requiredCap)
      )
    );
  }

  /**
   * Check if capabilities match (with some flexibility)
   */
  private capabilityMatches(modelCapability: ModelCapability, requiredCapability: ModelCapability): boolean {
    // Use Partial to allow not all capabilities to have aliases
    // This is safer than Record<> which requires all capabilities to have aliases
    const capabilityAliases: Partial<Record<ModelCapability, ModelCapability[]>> = {
      'text_generation': ['chat', 'code_generation'],
      'chat': ['text_generation'],
      'reasoning': ['analysis', 'thinking_mode'],
      'code_interpreter': ['function_calling', 'tool_use'],
      'coding': ['code_generation', 'code_completion', 'code_review', 'debugging', 'refactoring'],
      'analysis': ['reasoning', 'qa'],
      'web_search': ['tool_use', 'function_calling'],
      'function_calling': ['tool_use', 'code_interpreter'],
      'tool_use': ['function_calling', 'code_interpreter'],
      'thinking_mode': ['reasoning'],
      'qa': ['analysis', 'reasoning'],
      'code_generation': ['text_generation'],
      'deep_search': ['deep_research', 'research', 'web_search'],
      'deep_research': ['deep_search', 'research', 'web_search'],
      'transcription': ['speech_to_text', 'video_transcription', 'video_to_text'],
      'listen': ['audio', 'speech_to_text'],
      'audio_to_audio': ['realtime_audio', 'audio'],
      'video_to_text': ['video_understanding', 'transcription'],
      'video_transcription': ['video_to_text', 'transcription'],
      'image_to_video': ['video_generation'],
      'video_to_video': ['video_generation'],
      'health': ['analysis', 'reasoning'],
    };

    const aliases = capabilityAliases[requiredCapability] || [];
    return aliases.includes(modelCapability);
  }

  /**
   * Calculate preference score for model-task combination
   */
  private calculateModelPreferenceScore(model: Model, taskType: TaskType | string): number {
    let score = 0;

    // Normalize task type to ensure compatibility
    const normalizedTaskType = this.normalizeTaskType(taskType);

    // Base score from model capabilities match
    const requiredCaps = this.getRequiredCapabilitiesForTask(normalizedTaskType);
    const matchCount = requiredCaps.filter(cap =>
      model.capabilities?.some((modelCap: ModelCapability) => modelCap === cap)
    ).length;
    score += matchCount * 20; // 20 points per matching capability

    // Performance bonus
    if (model.performance?.quality) {
      score += model.performance.quality * 10;
    }

    // Recency bonus (newer models)
    if (model.metadata?.version) {
      const versionStr = String(model.metadata.version);
      const version = parseFloat(versionStr);
      if (!isNaN(version)) {
        score += Math.min(version * 5, 50); // Max 50 points for version
      }
    }

    // Provider reliability bonus (configurable via config, not hardcoded)
    // Use model's performance reliability metric instead of hardcoded provider list
    if (model.performance?.reliability) {
      score += model.performance.reliability * 15; // Scale reliability (0-1) to 0-15 points
    }

    // Cost efficiency (prefer lower cost for same capability)
    if (model.inputCostPer1k && model.inputCostPer1k < 0.01) {
      score += 10; // Bonus for very cheap models
    }

    // Task-specific bonuses based on capabilities, not model names
    // This ensures dynamic selection without hardcoded model preferences
    const requiredCapsForTaskBonus = this.getRequiredCapabilitiesForTask(normalizedTaskType);
    const hasAllRequiredCaps = requiredCapsForTaskBonus.every(cap => 
      model.capabilities?.some((modelCap: ModelCapability) => modelCap === cap)
    );
    
    if (hasAllRequiredCaps) {
      // Bonus for models that have all required capabilities for the task
      switch (normalizedTaskType) {
        case 'code-generation':
        case 'debugging':
          // Bonus for models with function_calling capability (essential for coding tasks)
          if (model.capabilities?.includes('function_calling' as ModelCapability)) {
            score += 25;
          }
          break;
        case 'analysis':
          // Bonus for models with strong reasoning capabilities
          if (model.capabilities?.includes('reasoning')) {
            score += 20;
          }
          break;
        case 'general': {
          // Bonus for general-purpose models with broad capabilities
          const capabilityCount = model.capabilities?.length ?? 0;
          if (capabilityCount >= 5) {
            score += 15;
          }
          break;
        }
      }
    }

    return score;
  }
}

/**
 * Singleton instance
 */
let selectorInstance: DynamicModelSelector | null = null;

/**
 * Get selector instance
 */
export function getDynamicModelSelector(): DynamicModelSelector {
  if (!selectorInstance) {
    selectorInstance = new DynamicModelSelector();
  }
  return selectorInstance;
}
