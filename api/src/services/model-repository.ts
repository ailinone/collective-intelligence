// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Central Model Repository
 *
 * Repositório central que gerencia todos os modelos descobertos de todas as fontes.
 * Fornece funcionalidades avançadas de busca, filtragem e gerenciamento de metadados.
 */

import { logger } from '@/utils/logger';
import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { getModelSelectionCache } from '@/core/selection/model-selection-cache';
import type { Model, ModelCapability, ModelPerformance, TaskType } from '@/types';
import type { Model as PrismaModel } from '@/generated/prisma/index.js';

export interface ModelSearchCriteria {
  providers?: string[];
  capabilities?: ModelCapability[];
  minContextWindow?: number;
  maxContextWindow?: number;
  maxCostPer1k?: number; // Máximo custo por 1k tokens
  minQuality?: number;
  minReliability?: number;
  taskType?: TaskType;
  tags?: string[];
  specializations?: string[];
  status?: 'active' | 'inactive' | 'maintenance';
  excludeProviders?: string[];
  preferProviders?: string[];
  sortBy?: 'cost' | 'quality' | 'context' | 'performance' | 'reliability';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ModelSimilarityScore {
  model: Model;
  similarity: number;
  reasons: string[];
}

export interface ModelRepositoryStats {
  totalModels: number;
  activeModels: number;
  modelsByProvider: Record<string, number>;
  modelsByCapability: Record<string, number>;
  averageCostPer1k: number;
  averageContextWindow: number;
  lastUpdated: Date | null;
}

export class ModelRepository {
  private log = logger.child({ component: 'model-repository' });
  private cache = getModelSelectionCache();

  /**
   * In-flight dedup for `searchModelsComplete`: a full-catalog assembly is
   * many sequential page queries, so N concurrent callers with the same
   * criteria would each run the entire page loop before the result cache
   * fills. Static so the dedup holds across `getModelRepository()` instances
   * (the factory returns a fresh instance per call; the cache is already a
   * shared singleton).
   */
  private static inFlightCompleteSearches = new Map<string, Promise<Model[]>>();

  /**
   * Busca modelos com critérios avançados
   * 
   * Uses PostgreSQL native JSON queries with GIN indexes for efficient filtering/ordering
   * instead of in-memory processing. All filtering and sorting is pushed to the database.
   */
  async searchModels(criteria: ModelSearchCriteria = {}): Promise<Model[]> {
    const cacheKey = `searchModels:${JSON.stringify(criteria)}`;
    const cached = this.cache.get<Model[]>(cacheKey);
    if (cached) {
      return cached;
    }

    return this.searchModelsUncachedPage(criteria, cacheKey);
  }

  /**
   * Search that reaches the ENTIRE catalog for the given criteria — no result
   * window. `searchModels` has a silent `limit || 100` default combined with
   * `ORDER BY created_at DESC`, which turns every capability pool into "the
   * 100 most recently discovered rows" (audit 2026-07-17: the video pool saw
   * 97 of 494 catalog models, all from the newest-onboarded providers, while
   * aiml/poe/huggingface/imagerouter never entered). Media candidate pools
   * must see everything the catalog has; how many candidates get TRIED is
   * governed by the fallback time budget, never by what enters the pool.
   *
   * Pages internally (the page size is an I/O batching detail, not a result
   * cap — the loop always runs to exhaustion) and caches the assembled set
   * under its own key with the same TTL as `searchModels`.
   */
  async searchModelsComplete(criteria: ModelSearchCriteria = {}): Promise<Model[]> {
    const { limit: _ignoredLimit, offset: _ignoredOffset, ...rest } = criteria;
    const cacheKey = `searchModelsComplete:${JSON.stringify(rest)}`;
    const cached = this.cache.get<Model[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const inFlight = ModelRepository.inFlightCompleteSearches.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const assembly = (async () => {
      const pageSize = 500;
      const all: Model[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = await this.searchModelsUncachedPage(
          { ...rest, limit: pageSize, offset },
          undefined
        );
        all.push(...page);
        if (page.length < pageSize) break;
      }

      this.cache.set(cacheKey, all, 10 * 60 * 1000); // 10 minutes
      return all;
    })();

    ModelRepository.inFlightCompleteSearches.set(cacheKey, assembly);
    try {
      return await assembly;
    } finally {
      ModelRepository.inFlightCompleteSearches.delete(cacheKey);
    }
  }

  private async searchModelsUncachedPage(
    criteria: ModelSearchCriteria,
    cacheKey: string | undefined
  ): Promise<Model[]> {
    // Check if we need PostgreSQL native JSON queries (array containment, JSON path sorting)
    const needsNativeJson = 
      (criteria.capabilities && criteria.capabilities.length > 0) ||
      (criteria.tags && criteria.tags.length > 0) ||
      (criteria.specializations && criteria.specializations.length > 0) ||
      criteria.sortBy === 'quality' ||
      criteria.sortBy === 'reliability' ||
      criteria.sortBy === 'performance' ||
      (criteria.preferProviders && criteria.preferProviders.length > 0);

    if (needsNativeJson) {
      // Use raw SQL for complex JSON queries (leverages GIN indexes)
      return this.searchModelsWithNativeJson(criteria, cacheKey);
    }

    // Use Prisma for simple queries (no JSON array containment or JSON path sorting)
    const where: Prisma.ModelWhereInput = {
      status: criteria.status || 'active',
    };

    // Basic filters
    if (criteria.providers?.length) {
      where.provider = {
        id: { in: criteria.providers },
      };
    }

    if (criteria.excludeProviders?.length) {
      if (where.provider && typeof where.provider === 'object' && 'id' in where.provider) {
        const existingProviderFilter = where.provider.id as { in?: string[] } | undefined;
        where.provider = {
          id: existingProviderFilter && 'in' in existingProviderFilter
            ? { in: existingProviderFilter.in, notIn: criteria.excludeProviders }
            : { notIn: criteria.excludeProviders },
        };
      } else {
        where.provider = {
          id: { notIn: criteria.excludeProviders },
        };
      }
    }

    if (criteria.minContextWindow) {
      const existingContextWindow = where.contextWindow && typeof where.contextWindow === 'object' ? where.contextWindow : {};
      where.contextWindow = { ...existingContextWindow, gte: criteria.minContextWindow };
    }

    if (criteria.maxContextWindow) {
      const existingContextWindow = where.contextWindow && typeof where.contextWindow === 'object' ? where.contextWindow : {};
      where.contextWindow = { ...existingContextWindow, lte: criteria.maxContextWindow };
    }

    if (criteria.maxCostPer1k) {
      where.OR = [
        { inputCostPer1k: { lte: criteria.maxCostPer1k } },
        { outputCostPer1k: { lte: criteria.maxCostPer1k } },
      ];
    }

    // JSON path filters (Prisma supports these, leverages GIN indexes)
    const jsonFilters: Prisma.ModelWhereInput[] = [];

    if (criteria.minQuality) {
      jsonFilters.push({
        performance: { path: ['quality'], gte: criteria.minQuality },
      });
    }

    if (criteria.minReliability) {
      jsonFilters.push({
        performance: { path: ['reliability'], gte: criteria.minReliability },
      });
    }

    if (jsonFilters.length > 0) {
      where.AND = jsonFilters;
    }

    // Ordering
    let orderBy: Prisma.ModelOrderByWithRelationInput | Prisma.ModelOrderByWithRelationInput[] = { createdAt: 'desc' };

    if (criteria.sortBy) {
      switch (criteria.sortBy) {
        case 'cost':
          orderBy = [
            { inputCostPer1k: criteria.sortOrder || 'asc' },
            { outputCostPer1k: criteria.sortOrder || 'asc' },
          ];
          break;
        case 'context':
          orderBy = { contextWindow: criteria.sortOrder || 'desc' };
          break;
      }
    }

    const models = await prisma.model.findMany({
      where,
      orderBy,
      take: criteria.limit || 100,
      skip: criteria.offset || 0,
      include: {
        provider: true,
      },
    });

    const result = models.map(this.mapPrismaToModel);
    if (cacheKey) {
      this.cache.set(cacheKey, result, 10 * 60 * 1000); // 10 minutes
    }
    return result;
  }

  /**
   * Search models using PostgreSQL native JSON queries with GIN indexes
   * Handles complex JSON array containment and JSON path sorting
   *
   * `cacheKey` is the caller's cache slot (undefined for internal pages of
   * `searchModelsComplete` — those must NOT be cached individually, or every
   * page pollutes the `searchModels:` namespace with its own entry).
   */
  private async searchModelsWithNativeJson(
    criteria: ModelSearchCriteria,
    cacheKey: string | undefined
  ): Promise<Model[]> {
    const status = criteria.status || 'active';
    const limit = criteria.limit || 100;
    const offset = criteria.offset || 0;
    const sortOrder = criteria.sortOrder || 'desc';

    // Build WHERE conditions
    const conditions: string[] = [];
    const params: unknown[] = [status];
    let paramIndex = 1;

    // Add status filter
    conditions.push(`m.status = $${paramIndex}`);

    // Provider filters
    if (criteria.providers && criteria.providers.length > 0) {
      paramIndex++;
      conditions.push(`p.id = ANY($${paramIndex}::text[])`);
      params.push(criteria.providers);
    }

    if (criteria.excludeProviders && criteria.excludeProviders.length > 0) {
      paramIndex++;
      conditions.push(`p.id != ALL($${paramIndex}::text[])`);
      params.push(criteria.excludeProviders);
    }

    // Context window filters
    if (criteria.minContextWindow !== undefined) {
      paramIndex++;
      conditions.push(`m.context_window >= $${paramIndex}`);
      params.push(criteria.minContextWindow);
    }

    if (criteria.maxContextWindow !== undefined) {
      paramIndex++;
      conditions.push(`m.context_window <= $${paramIndex}`);
      params.push(criteria.maxContextWindow);
    }

    // Cost filters
    if (criteria.maxCostPer1k !== undefined) {
      paramIndex++;
      conditions.push(`(m.input_cost_per_1k <= $${paramIndex} OR m.output_cost_per_1k <= $${paramIndex})`);
      params.push(criteria.maxCostPer1k);
    }

    // JSON path filters (quality, reliability) - use PostgreSQL JSON operators
    if (criteria.minQuality !== undefined) {
      paramIndex++;
      conditions.push(`(m.performance->>'quality')::numeric >= $${paramIndex}`);
      params.push(criteria.minQuality);
    }

    if (criteria.minReliability !== undefined) {
      paramIndex++;
      conditions.push(`(m.performance->>'reliability')::numeric >= $${paramIndex}`);
      params.push(criteria.minReliability);
    }

    // JSON array containment filters (capabilities, tags, specializations) - uses GIN indexes
    if (criteria.capabilities && criteria.capabilities.length > 0) {
      paramIndex++;
      // Use @> operator for array containment (leveraging GIN index)
      conditions.push(`m.capabilities @> $${paramIndex}::jsonb`);
      params.push(JSON.stringify(criteria.capabilities));
    }

    if (criteria.tags && criteria.tags.length > 0) {
      // Check if metadata->tags array contains any of the specified tags
      const tagConditions = criteria.tags.map((tag) => {
        paramIndex++;
        params.push(JSON.stringify([tag])); // @> requires array format
        return `(m.metadata->'tags')::jsonb @> $${paramIndex}::jsonb`;
      });
      conditions.push(`(${tagConditions.join(' OR ')})`);
    }

    if (criteria.specializations && criteria.specializations.length > 0) {
      // Check if metadata->specializations array contains any of the specified specializations
      const specConditions = criteria.specializations.map((spec) => {
        paramIndex++;
        params.push(JSON.stringify([spec])); // @> requires array format
        return `(m.metadata->'specializations')::jsonb @> $${paramIndex}::jsonb`;
      });
      conditions.push(`(${specConditions.join(' OR ')})`);
    }

    // Build ORDER BY clause
    let orderByClause = 'm.created_at DESC';
    if (criteria.sortBy) {
      switch (criteria.sortBy) {
        case 'cost':
          orderByClause = `m.input_cost_per_1k ${sortOrder}, m.output_cost_per_1k ${sortOrder}`;
          break;
        case 'quality':
          // JSON path ordering (leveraging GIN index)
          orderByClause = `(m.performance->>'quality')::numeric ${sortOrder} NULLS LAST`;
          break;
        case 'reliability':
          orderByClause = `(m.performance->>'reliability')::numeric ${sortOrder} NULLS LAST`;
          break;
        case 'performance':
          // Combined performance metric (lower latency + higher throughput = better)
          orderByClause = `((COALESCE((m.performance->>'latencyMs')::numeric, 1000) + (1000 - COALESCE((m.performance->>'throughput')::numeric, 100))) ${sortOrder})`;
          break;
        case 'context':
          orderByClause = `m.context_window ${sortOrder}`;
          break;
      }
    }

    // Prefer providers (add to ORDER BY)
    if (criteria.preferProviders && criteria.preferProviders.length > 0) {
      paramIndex++;
      params.push(criteria.preferProviders);
      orderByClause = `CASE WHEN p.id = ANY($${paramIndex}::text[]) THEN 0 ELSE 1 END, ${orderByClause}`;
    }

    // Build final SQL query — TWO-PHASE (Camada 4). The heavy JSONB columns
    // (capabilities/performance/metadata, ~958B/row) made the ORDER BY sort
    // materialize tens of thousands of matching rows' JSONB before the LIMIT —
    // measured ~22.7s under concurrency. Phase 1 sorts + paginates on a LIGHT
    // uid-only projection (measured ~113ms); phase 2 hydrates only the page.
    // The ORDER BY is repeated in phase 2 to preserve ordering of the final rows.
    //
    // `m.uid ASC` tiebreaker: every sort key above admits ties (created_at
    // shares a timestamp across a discovery sync batch), and LIMIT/OFFSET
    // pagination over a non-total order may skip/duplicate rows between
    // pages — the unique uid makes the order total and pagination stable.
    const sql = `
      WITH page AS (
        SELECT m.uid
        FROM models m
        JOIN providers p ON p.id = m.provider_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderByClause}, m.uid ASC
        LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}
      )
      SELECT
        m.id,
        m.provider_id,
        m.name,
        m.display_name,
        m.context_window,
        m.max_output_tokens,
        m.input_cost_per_1k,
        m.output_cost_per_1k,
        m.capabilities,
        m.performance,
        m.metadata,
        m.status,
        m.created_at,
        m.updated_at,
        p.name as provider_name
      FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.uid IN (SELECT uid FROM page)
      ORDER BY ${orderByClause}, m.uid ASC
    `;

    params.push(limit);
    params.push(offset);

    // Execute raw SQL query
    // IMPORTANT: Database connection errors should NOT be masked
    // If database is unavailable, the application should fail fast and alert operations
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string;
      provider_id: string;
      name: string;
      display_name: string;
      context_window: number;
      max_output_tokens: number;
      input_cost_per_1k: Prisma.Decimal;
      output_cost_per_1k: Prisma.Decimal;
      capabilities: Prisma.JsonValue;
      performance: Prisma.JsonValue;
      metadata: Prisma.JsonValue;
      status: string;
      created_at: Date;
      updated_at: Date;
      provider_name: string;
    }>>(sql, ...params);

    // Map results to Model type
    const result = rows.map((row) => this.mapRawRowToModel(row));

    // Cache under the CALLER's key only. Internal pages of
    // searchModelsComplete arrive with cacheKey undefined and must stay
    // uncached — the assembled set is cached once by the caller.
    if (cacheKey) {
      this.cache.set(cacheKey, result, 10 * 60 * 1000); // 10 minutes
    }
    return result;
  }

  /**
   * Maps raw SQL query result to Model type
   */
  private mapRawRowToModel(row: {
    id: string;
    provider_id: string;
    name: string;
    display_name: string;
    context_window: number;
    max_output_tokens: number;
    input_cost_per_1k: Prisma.Decimal;
    output_cost_per_1k: Prisma.Decimal;
    capabilities: Prisma.JsonValue;
    performance: Prisma.JsonValue;
    metadata: Prisma.JsonValue;
    status: string;
    created_at: Date;
    updated_at: Date;
    provider_name: string;
  }): Model {
    const inputCost = row.input_cost_per_1k instanceof Prisma.Decimal 
      ? row.input_cost_per_1k.toNumber() 
      : typeof row.input_cost_per_1k === 'number' 
        ? row.input_cost_per_1k 
        : 0;
    const outputCost = row.output_cost_per_1k instanceof Prisma.Decimal 
      ? row.output_cost_per_1k.toNumber() 
      : typeof row.output_cost_per_1k === 'number' 
        ? row.output_cost_per_1k 
        : 0;

    let capabilities: ModelCapability[] = [];
    if (Array.isArray(row.capabilities)) {
      capabilities = row.capabilities as ModelCapability[];
    }

    let metadata: Record<string, unknown> = {};
    if (row.metadata && typeof row.metadata === 'object' && row.metadata !== null) {
      metadata = row.metadata as Record<string, unknown>;
    }

    let performance: ModelPerformance;
    if (row.performance && typeof row.performance === 'object' && row.performance !== null) {
      const perfObj = row.performance as Record<string, unknown>;
      performance = {
        latencyMs: typeof perfObj.latencyMs === 'number' ? perfObj.latencyMs : 0,
        throughput: typeof perfObj.throughput === 'number' ? perfObj.throughput : 0,
        quality: typeof perfObj.quality === 'number' ? perfObj.quality : 0,
        reliability: typeof perfObj.reliability === 'number' ? perfObj.reliability : 0,
      };
    } else {
      performance = {
        latencyMs: 0,
        throughput: 0,
        quality: 0,
        reliability: 0,
      };
    }

    return {
      id: row.id,
      providerId: row.provider_id,
      provider: row.provider_name || row.provider_id,
      name: row.name,
      displayName: row.display_name,
      contextWindow: row.context_window,
      maxOutputTokens: row.max_output_tokens,
      inputCostPer1k: inputCost,
      outputCostPer1k: outputCost,
      capabilities,
      metadata,
      status: row.status as Model['status'],
      performance,
    };
  }

  /**
   * Busca modelos similares para fallback
   */
  async findSimilarModels(
    failedModelId: string,
    requiredCapabilities: ModelCapability[] = [],
    maxCostIncrease = 2.0, // Máximo 2x o custo
    limit = 5
  ): Promise<ModelSimilarityScore[]> {
    const cacheKey = `similarModels:${failedModelId}:${requiredCapabilities.join(',')}:${maxCostIncrease}`;
    const cached = this.cache.get<ModelSimilarityScore[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // Busca o modelo que falhou
    const failedModel = await this.getModelById(failedModelId);
    if (!failedModel) {
      return [];
    }

    // Busca candidatos similares
    const candidates = await this.searchModels({
      capabilities: requiredCapabilities,
      maxCostPer1k: Math.max(
        Number(failedModel.inputCostPer1k) * maxCostIncrease,
        Number(failedModel.outputCostPer1k) * maxCostIncrease
      ),
      status: 'active',
      excludeProviders: [failedModel.provider], // Evita mesmo provedor
      limit: 50,
    });

    // Calcula similaridade para cada candidato
    const similarities: ModelSimilarityScore[] = candidates
      .filter((model) => model.id !== failedModelId)
      .map((model) => this.calculateSimilarity(failedModel, model, requiredCapabilities))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    this.cache.set(cacheKey, similarities, 5 * 60 * 1000); // 5 minutos
    return similarities;
  }

  /**
   * Busca modelos por tarefa específica
   */
  async findModelsForTask(
    taskType: TaskType,
    options: {
      maxCost?: number;
      minQuality?: number;
      preferSpeed?: boolean;
      requiredCapabilities?: ModelCapability[];
      limit?: number;
    } = {}
  ): Promise<Model[]> {
    const taskCapabilities = this.getTaskRequiredCapabilities(taskType);
    const allCapabilities = [...taskCapabilities, ...(options.requiredCapabilities || [])];

    return this.searchModels({
      taskType,
      capabilities: allCapabilities,
      maxCostPer1k: options.maxCost,
      minQuality: options.minQuality,
      sortBy: options.preferSpeed ? 'performance' : 'quality',
      sortOrder: options.preferSpeed ? 'asc' : 'desc',
      limit: options.limit || 10,
    });
  }

  /**
   * Busca modelos com capacidades específicas
   */
  async findModelsWithCapabilities(
    capabilities: ModelCapability[],
    options: {
      anyMatch?: boolean; // true = pelo menos uma capacidade, false = todas as capacidades
      maxCost?: number;
      minContextWindow?: number;
      providers?: string[];
      limit?: number;
    } = {}
  ): Promise<Model[]> {
    return this.searchModels({
      capabilities: options.anyMatch ? undefined : capabilities, // Para "todas" usa o filtro normal
      maxCostPer1k: options.maxCost,
      minContextWindow: options.minContextWindow,
      providers: options.providers,
      limit: options.limit || 20,
    }).then((models) => {
      if (options.anyMatch) {
        // Filtra em memória para "pelo menos uma"
        return models.filter((model) =>
          capabilities.some((cap) => model.capabilities.includes(cap))
        );
      }
      return models;
    });
  }

  /**
   * Busca modelos econômicos para tarefas simples
   */
  async findBudgetModels(options: {
    maxCostPer1k: number;
    requiredCapabilities?: ModelCapability[];
    minContextWindow?: number;
    limit?: number;
  }): Promise<Model[]> {
    return this.searchModels({
      capabilities: options.requiredCapabilities,
      maxCostPer1k: options.maxCostPer1k,
      minContextWindow: options.minContextWindow,
      sortBy: 'cost',
      sortOrder: 'asc',
      limit: options.limit || 10,
    });
  }

  /**
   * Busca modelos premium para tarefas complexas
   */
  async findPremiumModels(options: {
    taskType: TaskType;
    minQuality?: number;
    minContextWindow?: number;
    maxCostPer1k?: number;
    limit?: number;
  }): Promise<Model[]> {
    const taskCapabilities = this.getTaskRequiredCapabilities(options.taskType);

    return this.searchModels({
      capabilities: taskCapabilities,
      minQuality: options.minQuality || 0.8,
      minContextWindow: options.minContextWindow || 32000,
      maxCostPer1k: options.maxCostPer1k,
      sortBy: 'quality',
      sortOrder: 'desc',
      limit: options.limit || 5,
    });
  }

  /**
   * Obtém modelo por ID
   */
  /**
   * Resolve ALL active rows matching an exact id OR name, directly in SQL.
   * Callers that used to do `searchModels({}).find(...)` were silently
   * searching only the 100 most recent rows (the searchModels default
   * window) — an explicit model reference must reach the whole catalog.
   *
   * Returns a LIST because the same model id exists under N providers
   * (uid = MD5(provider:id)): a findFirst without orderBy returned an
   * arbitrary row, making the capability gate and billing non-deterministic
   * run to run. Returning every row lets the caller pick a runnable one
   * (and fall back across providers of the same id). Order is deterministic:
   * newest first, uid as unique tiebreaker.
   */
  async findModelsByIdOrName(idOrName: string): Promise<Model[]> {
    const cacheKey = `modelsByIdOrName:${idOrName}`;
    const cached = this.cache.get<Model[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const prismaModels = await prisma.model.findMany({
      where: {
        status: 'active',
        OR: [{ id: idOrName }, { name: idOrName }],
      },
      orderBy: [{ createdAt: 'desc' }, { uid: 'asc' }],
      include: { provider: true },
    });

    const models = prismaModels.map((m) => this.mapPrismaToModel(m));
    // Negative caching included: an empty list is a valid (cacheable) answer.
    this.cache.set(cacheKey, models, 10 * 60 * 1000); // 10 minutes
    return models;
  }

  async getModelById(id: string): Promise<Model | null> {
    const cacheKey = `model:${id}`;
    const cached = this.cache.get<Model>(cacheKey);
    if (cached) {
      return cached;
    }

    const prismaModel = await prisma.model.findFirst({
      where: { id },
      include: { provider: true },
    });

    if (!prismaModel) {
      return null;
    }

    const model = this.mapPrismaToModel(prismaModel);
    this.cache.set(cacheKey, model, 30 * 60 * 1000); // 30 minutos
    return model;
  }

  /**
   * Lista todos os provedores disponíveis
   */
  async getAvailableProviders(): Promise<
    Array<{
      name: string;
      displayName: string;
      status: string;
    }>
  > {
    const providers = await prisma.provider.findMany({
      orderBy: { name: 'asc' },
    });

    return providers.map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      status: p.status,
    }));
  }

  /**
   * Estatísticas do repositório.
   *
   * Performance-critical: previous implementation materialized all ~64K model
   * rows into Node memory just to compute aggregates (count-by-provider,
   * count-by-capability, AVG cost, AVG context). That collapsed under load —
   * a single `getStats()` call could pull >100MB of JSONB capabilities + Decimal
   * pricing across the wire and burn ~3s of GC on the result.
   *
   * Current implementation pushes every aggregate to PostgreSQL:
   *   - `aggregate({ _count, _avg })` — global counts + averages in one query
   *   - `count({ where: status })` — active count via index
   *   - `groupBy({ by: providerId, _count })` — per-provider distribution
   *   - raw SQL `jsonb_array_elements_text` — per-capability distribution
   *     (Postgres-native JSONB unnesting; orders of magnitude faster than
   *     Node-side iteration over deserialized arrays)
   *   - bounded `findFirst({ orderBy: updatedAt desc })` — last-updated stamp
   *
   * Average semantics preserved exactly: original computed
   * `(SUM(in) + SUM(out)) / (2 * N)`, mathematically identical to
   * `(AVG(in) + AVG(out)) / 2` which is what `_avg` returns.
   */
  async getStats(): Promise<ModelRepositoryStats> {
    const [aggregates, activeModels, byProvider, byCapability, lastUpdated] = await Promise.all([
      prisma.model.aggregate({
        _count: { _all: true },
        _avg: {
          inputCostPer1k: true,
          outputCostPer1k: true,
          contextWindow: true,
        },
      }),
      prisma.model.count({ where: { status: 'active' } }),
      prisma.model.groupBy({
        by: ['providerId'],
        _count: { _all: true },
      }),
      // jsonb_array_elements_text expands `capabilities` into one row per element,
      // letting us COUNT/GROUP at the SQL layer. This preserves the original
      // semantics of reading the (deprecated) `capabilities` JSONB column —
      // migrating to `capability_uris` is a separate concern.
      prisma.$queryRaw<Array<{ capability: string; count: bigint }>>`
        SELECT cap.value AS capability, COUNT(*)::bigint AS count
        FROM models m,
             jsonb_array_elements_text(m.capabilities) AS cap(value)
        GROUP BY cap.value
      `,
      prisma.model.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
    ]);

    const totalModels = aggregates._count._all;

    // Resolve providerId → providerName in a single query. The original code
    // got the name from the `include: { provider: true }` JOIN — we replicate
    // that with a bounded findMany over the providerIds we just discovered.
    const providerIds = byProvider.map((r) => r.providerId);
    const providers =
      providerIds.length > 0
        ? await prisma.provider.findMany({
            where: { id: { in: providerIds } },
            select: { id: true, name: true },
          })
        : [];
    const providerIdToName = new Map(providers.map((p) => [p.id, p.name]));

    const modelsByProvider: Record<string, number> = {};
    for (const row of byProvider) {
      const name = providerIdToName.get(row.providerId) ?? row.providerId;
      modelsByProvider[name] = row._count._all;
    }

    const modelsByCapability: Record<string, number> = {};
    for (const row of byCapability) {
      // bigint → number is safe here: capability counts are bounded by
      // totalModels (max ~64K today, far under Number.MAX_SAFE_INTEGER).
      modelsByCapability[row.capability as ModelCapability] = Number(row.count);
    }

    const avgInput = Number(aggregates._avg.inputCostPer1k ?? 0);
    const avgOutput = Number(aggregates._avg.outputCostPer1k ?? 0);
    const averageCostPer1k = totalModels > 0 ? (avgInput + avgOutput) / 2 : 0;
    const averageContextWindow = aggregates._avg.contextWindow ?? 0;

    return {
      totalModels,
      activeModels,
      modelsByProvider,
      modelsByCapability,
      averageCostPer1k,
      averageContextWindow,
      lastUpdated: lastUpdated?.updatedAt || null,
    };
  }

  /**
   * Atualiza performance de um modelo
   */
  async updateModelPerformance(
    modelId: string,
    performance: {
      latencyMs?: number;
      throughput?: number;
      quality?: number;
      reliability?: number;
      codeScore?: number;
      codeTier?: string;
      codeBackendScore?: number;
      codeFrontendScore?: number;
      codeDataScienceScore?: number;
    }
  ): Promise<void> {
    const existing = await prisma.model.findFirst({
      where: { id: modelId },
      select: { uid: true, performance: true },
    });

    if (!existing) {
      throw new Error(`Model ${modelId} not found`);
    }

    const currentPerformance = (existing.performance as Record<string, unknown> | null) || {};
    const updatedPerformance = { ...currentPerformance, ...performance };

    await prisma.model.update({
      where: { uid: existing.uid },
      data: {
        performance: updatedPerformance,
        updatedAt: new Date(),
      },
    });

    // Invalida cache
    await this.invalidateModelCache(modelId);
  }

  /**
   * Marca modelo como inativo
   */
  async deactivateModel(modelId: string, reason?: string): Promise<void> {
    const model = await prisma.model.findFirst({ where: { id: modelId }, select: { uid: true } });
    if (!model) return;

    await prisma.model.update({
      where: { uid: model.uid },
      data: {
        status: 'inactive',
        metadata: {
          deactivatedAt: new Date().toISOString(),
          deactivationReason: reason,
        },
        updatedAt: new Date(),
      },
    });

    await this.invalidateModelCache(modelId);
  }

  /**
   * Reativa modelo
   */
  async reactivateModel(modelId: string): Promise<void> {
    const model = await prisma.model.findFirst({ where: { id: modelId }, select: { uid: true } });
    if (!model) return;

    await prisma.model.update({
      where: { uid: model.uid },
      data: {
        status: 'active',
        metadata: {
          reactivatedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      },
    });

    await this.invalidateModelCache(modelId);
  }

  /**
   * Calcula similaridade entre dois modelos
   */
  private calculateSimilarity(
    baseModel: Model,
    candidateModel: Model,
    requiredCapabilities: ModelCapability[]
  ): ModelSimilarityScore {
    let similarity = 0;
    const reasons: string[] = [];

    // Capacidades obrigatórias (peso alto)
    const baseCaps = new Set(baseModel.capabilities);
    const candidateCaps = new Set(candidateModel.capabilities);
    const requiredMatch = requiredCapabilities.every((cap) => candidateCaps.has(cap));
    if (requiredMatch) {
      similarity += 0.4;
      reasons.push('Atende todas as capacidades obrigatórias');
    }

    // Interseção de capacidades (peso médio)
    const intersection = new Set([...baseCaps].filter((cap) => candidateCaps.has(cap)));
    const union = new Set([...baseCaps, ...candidateCaps]);
    const capabilitySimilarity = intersection.size / union.size;

    similarity += capabilitySimilarity * 0.3;
    reasons.push(`${intersection.size}/${union.size} capacidades em comum`);

    // Diferença de custo (peso médio)
    const baseAvgCost = (Number(baseModel.inputCostPer1k) + Number(baseModel.outputCostPer1k)) / 2;
    const candidateAvgCost =
      (Number(candidateModel.inputCostPer1k) + Number(candidateModel.outputCostPer1k)) / 2;

    if (candidateAvgCost <= baseAvgCost * 1.5) {
      similarity += 0.2;
      reasons.push(`Custo similar (${(candidateAvgCost / baseAvgCost).toFixed(2)}x)`);
    } else if (candidateAvgCost <= baseAvgCost * 3) {
      similarity += 0.1;
      reasons.push(`Custo maior mas aceitável (${(candidateAvgCost / baseAvgCost).toFixed(2)}x)`);
    }

    // Contexto similar (peso baixo)
    const contextRatio =
      Math.min(baseModel.contextWindow, candidateModel.contextWindow) /
      Math.max(baseModel.contextWindow, candidateModel.contextWindow);

    similarity += contextRatio * 0.1;
    reasons.push(`Contexto compatível (${Math.round(contextRatio * 100)}%)`);

    return {
      model: candidateModel,
      similarity: Math.min(similarity, 1.0), // Máximo 1.0
      reasons,
    };
  }

  /**
   * Obtém capacidades necessárias para uma tarefa
   */
  private getTaskRequiredCapabilities(taskType: TaskType): ModelCapability[] {
    const taskCapabilities: Record<TaskType, ModelCapability[]> = {
      'code-generation': ['chat', 'code_interpreter'],
      'code-review': ['chat', 'reasoning'],
      debugging: ['chat', 'reasoning', 'code_interpreter'],
      refactoring: ['chat', 'code_interpreter'],
      testing: ['chat', 'reasoning'],
      documentation: ['chat', 'text_generation'],
      analysis: ['chat', 'reasoning'],
      qa: ['chat', 'reasoning'],
      general: ['chat'],
      caching: ['chat'],
      'reasoning': ['chat', 'reasoning', 'thinking_mode'],
      'decision-making': ['chat', 'reasoning', 'analysis'],
      'architecture': ['chat', 'reasoning', 'analysis', 'code_generation'],
      'creative': ['chat', 'text_generation'],
      'factual-qa': ['chat', 'reasoning'],
      'adversarial': ['chat', 'reasoning'],
      'document-understanding': ['chat', 'reasoning', 'analysis'],
    };

    return taskCapabilities[taskType] || ['chat'];
  }

  /**
   * Mapeia modelo do Prisma para formato Model
   */
  private mapPrismaToModel(prismaModel: PrismaModel & { provider?: { name: string } }): Model {
    // Convert Decimal to number
    const inputCost = prismaModel.inputCostPer1k instanceof Prisma.Decimal 
      ? prismaModel.inputCostPer1k.toNumber() 
      : typeof prismaModel.inputCostPer1k === 'number' 
        ? prismaModel.inputCostPer1k 
        : 0;
    const outputCost = prismaModel.outputCostPer1k instanceof Prisma.Decimal 
      ? prismaModel.outputCostPer1k.toNumber() 
      : typeof prismaModel.outputCostPer1k === 'number' 
        ? prismaModel.outputCostPer1k 
        : 0;

    // Convert capabilities from JsonValue to ModelCapability[]
    let capabilities: ModelCapability[] = [];
    if (Array.isArray(prismaModel.capabilities)) {
      capabilities = prismaModel.capabilities as ModelCapability[];
    }

    // Convert metadata from JsonValue to Record<string, unknown>
    let metadata: Record<string, unknown> = {};
    if (prismaModel.metadata && typeof prismaModel.metadata === 'object' && prismaModel.metadata !== null) {
      metadata = prismaModel.metadata as Record<string, unknown>;
    }

    // Convert performance from JsonValue to ModelPerformance
    let performance: ModelPerformance;
    if (prismaModel.performance && typeof prismaModel.performance === 'object' && prismaModel.performance !== null) {
      const perfObj = prismaModel.performance as Record<string, unknown>;
      performance = {
        latencyMs: typeof perfObj.latencyMs === 'number' ? perfObj.latencyMs : 0,
        throughput: typeof perfObj.throughput === 'number' ? perfObj.throughput : 0,
        quality: typeof perfObj.quality === 'number' ? perfObj.quality : 0,
        reliability: typeof perfObj.reliability === 'number' ? perfObj.reliability : 0,
      };
    } else {
      performance = {
        latencyMs: 0,
        throughput: 0,
        quality: 0,
        reliability: 0,
      };
    }

    return {
      id: prismaModel.id,
      providerId: prismaModel.providerId || '',
      provider: prismaModel.provider?.name || prismaModel.providerId,
      name: prismaModel.name,
      displayName: prismaModel.displayName,
      contextWindow: prismaModel.contextWindow,
      maxOutputTokens: prismaModel.maxOutputTokens,
      inputCostPer1k: inputCost,
      outputCostPer1k: outputCost,
      capabilities,
      metadata,
      status: prismaModel.status as Model['status'],
      performance,
    };
  }

  /**
   * Invalida cache de um modelo específico.
   * I6 fix: Selective invalidation instead of cache.clear() to prevent thundering herd.
   * When cache.clear() was used, ALL concurrent requests after a single model update
   * would miss cache simultaneously and stampede the database.
   *
   * Now we only delete the specific model's entries. Search result caches
   * (prefixed "searchModels:") naturally expire via their 10-minute TTL.
   * This means search results may serve slightly stale data for up to 10 minutes
   * after a model update — an acceptable trade-off vs. thundering herd on every
   * model discovery sync cycle (which runs every few minutes for 40+ providers).
   */
  private async invalidateModelCache(modelId: string): Promise<void> {
    // Remove caches directly related to this specific model
    this.cache.delete(`model:${modelId}`);
    this.cache.delete(`similarModels:${modelId}`);
    // Search caches (searchModels:*) expire naturally via TTL — no cache.clear() needed
  }

  /**
   * Obtém todos os modelos (para inicialização).
   *
   * INTENTIONAL FULL ENUMERATION — do NOT add `take:` cap. This is called once
   * at boot to materialize the in-memory model registry; truncating would
   * silently drop models from orchestration. If row count grows beyond what
   * fits comfortably in memory (~64K today, well under 1GB heap), migrate to
   * cursor-based pagination rather than capping. The boot path can tolerate
   * the latency; downstream consumers cannot tolerate missing models.
   */
  async getAllModels(): Promise<Model[]> {
    const prismaModels = await prisma.model.findMany({
      orderBy: { name: 'asc' },
    });
    return prismaModels.map(model => this.mapPrismaToModel(model));
  }

  /**
   * Obtém contagem total de modelos
   */
  async getTotalModelCount(): Promise<number> {
    return await prisma.model.count();
  }

  /**
   * Obtém contagem de modelos ativos
   */
  async getActiveModelCount(): Promise<number> {
    return await prisma.model.count({
      where: { status: 'active' },
    });
  }

  /**
   * Obtém contagem de modelos válidos (ativos + com performance)
   */
  async getValidModelCount(): Promise<number> {
    return await prisma.model.count({
      where: {
        status: 'active',
        performance: {
          not: Prisma.JsonNull,
        },
      },
    });
  }
}

export function getModelRepository(): ModelRepository {
  return new ModelRepository();
}
