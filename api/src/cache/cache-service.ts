// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Multi-Layer Cache Service
 * Implements 3-layer caching with circuit breakers, metrics, and invalidation bus
 */

import { createHash, randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { getRedisClient, getGlobalRedisClient } from './redis-client';
import type { ChatRequest, ChatResponse } from '@/types';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import { cacheHits, cacheMisses, cacheLatency } from '@/utils/metrics';
import { disableCacheRuntime, isCacheEnabled } from './cache-runtime-state';
import { getErrorMessage, isError, serializeError } from '@/utils/type-guards';
import { canonicalizeStrategyInput } from '@/core/orchestration/strategy-contract';

export type CacheLayer = 'memory' | 'redis-local' | 'redis-global';

export interface CacheResult {
  hit: boolean;
  layer?: CacheLayer;
  data?: ChatResponse;
  latency?: number;
}

type CacheBusMessage =
  | { action: 'invalidate'; key: string; source: string }
  | { action: 'clear-all'; source: string };

interface CircuitState {
  failures: number;
  openUntil: number | null;
}

const KEY_PREFIX = 'chat';
const DEFAULT_ORGANIZATION_ID = 'system-global';
const LABELS: Record<CacheLayer, string> = {
  memory: 'memory',
  'redis-local': 'redis_local',
  'redis-global': 'redis_global',
};

const CIRCUIT_LAYERS: CacheLayer[] = ['redis-local', 'redis-global'];

export class CacheService {
  private readonly log = logger.child({ service: 'cache' });
  private readonly cacheBusChannel = config.cache.invalidateChannel;
  private readonly instanceId = randomUUID();
  private inMemoryCache: Map<string, { data: ChatResponse; expiresAt: number }> = new Map();
  private redisSubscriber: Redis | null = null;
  private circuits: Record<CacheLayer, CircuitState> = {
    memory: { failures: 0, openUntil: null },
    'redis-local': { failures: 0, openUntil: null },
    'redis-global': { failures: 0, openUntil: null },
  };

  private stats = {
    hits: { memory: 0, 'redis-local': 0, 'redis-global': 0 },
    misses: 0,
  };

  constructor() {
    if (isCacheEnabled()) {
      this.setupInvalidationChannel().catch((error) => {
        this.log.error({ error: serializeError(error) }, 'Failed to setup cache invalidation channel');
      });
    }
  }

  async get(
    request: ChatRequest,
    tenantContext?: { organizationId?: string }
  ): Promise<CacheResult> {
    const organizationId = tenantContext?.organizationId ?? DEFAULT_ORGANIZATION_ID;
    if (!isCacheEnabled({ organizationId })) {
      return { hit: false };
    }

    const cacheKey = this.buildCacheKey(request, organizationId);
    const startTime = Date.now();

    const memoryResult = this.getFromMemory(cacheKey);
    if (memoryResult) {
      const latency = Date.now() - startTime;
      this.recordHit('memory', latency);
      return { hit: true, layer: 'memory', data: memoryResult, latency };
    }

    const redisLocalResult = await this.getFromRedisLayer('redis-local', cacheKey, organizationId);
    if (redisLocalResult) {
      const latency = Date.now() - startTime;
      this.recordHit('redis-local', latency);
      this.setInMemory(cacheKey, redisLocalResult);
      return { hit: true, layer: 'redis-local', data: redisLocalResult, latency };
    }

    const redisGlobalResult = await this.getFromRedisLayer(
      'redis-global',
      cacheKey,
      organizationId
    );
    if (redisGlobalResult) {
      const latency = Date.now() - startTime;
      this.recordHit('redis-global', latency);
      this.setInMemory(cacheKey, redisGlobalResult);
      await this.setInRedisLayer(
        'redis-local',
        cacheKey,
        redisGlobalResult,
        this.determineTTLFromResponse(redisGlobalResult),
        organizationId
      );
      return { hit: true, layer: 'redis-global', data: redisGlobalResult, latency };
    }

    const latency = Date.now() - startTime;
    this.recordMiss(latency);
    return { hit: false, latency };
  }

  async set(
    request: ChatRequest,
    response: ChatResponse,
    tenantContext?: { organizationId?: string }
  ): Promise<void> {
    const organizationId = tenantContext?.organizationId ?? DEFAULT_ORGANIZATION_ID;
    if (!isCacheEnabled({ organizationId })) {
      return;
    }

    if (!this.isCacheable(request, response)) {
      this.log.debug('Response not cacheable');
      return;
    }

    const cacheKey = this.buildCacheKey(request, organizationId);
    const ttl = this.determineTTL(request, response);

    this.log.debug({ cacheKey, ttl }, 'Caching response');

    this.setInMemory(cacheKey, response, ttl);
    const redisWrites = await Promise.allSettled([
      this.setInRedisLayer('redis-local', cacheKey, response, ttl, organizationId),
      this.setInRedisLayer('redis-global', cacheKey, response, ttl, organizationId),
    ]);

    for (const write of redisWrites) {
      if (write.status === 'rejected') {
        this.log.error({ error: serializeError(write.reason) }, 'Failed to write cache entry to Redis');
      }
    }

    await this.publish({ action: 'invalidate', key: cacheKey, source: this.instanceId });
  }

  async invalidate(
    request: ChatRequest,
    tenantContext?: { organizationId?: string }
  ): Promise<void> {
    const organizationId = tenantContext?.organizationId ?? DEFAULT_ORGANIZATION_ID;
    if (!isCacheEnabled({ organizationId })) return;

    const cacheKey = this.buildCacheKey(request, organizationId);
    this.evictFromMemory(cacheKey);

    await Promise.allSettled([
      this.deleteFromRedisLayer('redis-local', cacheKey),
      this.deleteFromRedisLayer('redis-global', cacheKey),
    ]);

    await this.publish({ action: 'invalidate', key: cacheKey, source: this.instanceId });
  }

  async clear(tenantContext?: { organizationId?: string }): Promise<void> {
    const organizationId = tenantContext?.organizationId ?? DEFAULT_ORGANIZATION_ID;
    this.inMemoryCache.clear();

    await Promise.allSettled([
      this.deleteAllFromRedisLayer('redis-local', organizationId),
      this.deleteAllFromRedisLayer('redis-global', organizationId),
    ]);

    await this.publish({ action: 'clear-all', source: this.instanceId });
    this.log.info('All cache layers cleared');
  }

  getStats() {
    const totalHits =
      this.stats.hits.memory + this.stats.hits['redis-local'] + this.stats.hits['redis-global'];
    const totalMisses = this.stats.misses;
    const total = totalHits + totalMisses;

    return {
      hits: { ...this.stats.hits },
      misses: this.stats.misses,
      total,
      memorySize: this.inMemoryCache.size,
      hitRate: total > 0 ? totalHits / total : 0,
      circuitState: CIRCUIT_LAYERS.reduce<Record<string, CircuitState>>((acc, layer) => {
        acc[layer] = { ...this.circuits[layer] };
        return acc;
      }, {}),
    };
  }

  private buildCacheKey(request: ChatRequest, organizationId: string): string {
    const canonical = {
      model: request.model || 'auto',
      messages: this.canonicalizeMessages(request.messages),
      temperature: request.temperature ?? 0.7,
      top_p: request.top_p,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      max_tokens: request.max_tokens,
      stop: this.canonicalizeStop(request.stop),
      tools: request.tools || undefined,
      tool_choice: request.tool_choice,
      response_format: request.response_format,
      strategy: this.getStrategyKey(request),
      max_cost: request.max_cost,
      quality_target: request.quality_target,
      task_type: request.task_type,
      user_specified_model: request.user_specified_model,
      webSearch: request.webSearch ?? false,
      webSearchOptions: this.canonicalizeWebSearchOptions(request.webSearchOptions),
      organizationId,
    };

    const hash = createHash('sha256');
    hash.update(JSON.stringify(canonical));
    return `${KEY_PREFIX}:${organizationId}:${hash.digest('hex').substring(0, 32)}`;
  }

  private canonicalizeMessages(
    messages: ChatRequest['messages']
  ): Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  private canonicalizeStop(stop: ChatRequest['stop']): string[] | undefined {
    if (typeof stop === 'string') {
      return [stop];
    }
    if (Array.isArray(stop)) {
      return stop;
    }
    return undefined;
  }

  private canonicalizeWebSearchOptions(
    webSearchOptions: ChatRequest['webSearchOptions']
  ): { max_results?: number; search_context_size?: 'low' | 'medium' | 'high'; engine?: 'native' | 'exa' } | undefined {
    if (!webSearchOptions) {
      return undefined;
    }

    return {
      max_results: webSearchOptions.max_results,
      search_context_size: webSearchOptions.search_context_size,
      engine: webSearchOptions.engine,
    };
  }

  private getStrategyKey(request: ChatRequest): string {
    if (typeof request.strategy !== 'string') {
      return 'dynamic';
    }
    return canonicalizeStrategyInput(request.strategy) || request.strategy;
  }

  private isCacheable(request: ChatRequest, response: ChatResponse): boolean {
    if (request.tools && request.tools.length > 0) return false;
    if ((request.temperature ?? 0.7) > 0.5) return false;
    if (request.stream) return false;
    if (!response.choices || response.choices.length === 0) return false;
    if (!this.hasUsableAssistantResponse(response)) return false;

    const hasImages = request.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')
    );
    if (hasImages) return false;

    return true;
  }

  private hasUsableAssistantResponse(response: ChatResponse): boolean {
    const choice = response.choices?.[0];
    if (!choice || !choice.message) {
      return false;
    }

    const message = choice.message as {
      content?: unknown;
      tool_calls?: unknown;
      function_call?: unknown;
    };

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return true;
    }

    if (message.function_call) {
      return true;
    }

    const content = message.content;
    if (typeof content === 'string') {
      return content.trim().length > 0;
    }

    if (Array.isArray(content)) {
      return content.some((item) => {
        if (typeof item === 'string') {
          return item.trim().length > 0;
        }
        if (item && typeof item === 'object' && 'text' in item) {
          const textValue = (item as { text?: unknown }).text;
          return typeof textValue === 'string' && textValue.trim().length > 0;
        }
        return false;
      });
    }

    return false;
  }

  private determineTTL(request: ChatRequest, response: ChatResponse): number {
    const temp = request.temperature ?? 0.7;
    let ttl = config.cache.ttlResponses || 86400;

    if (temp < 0.3) {
      ttl = Math.max(ttl, 604800);
    } else if (temp < 0.5) {
      ttl = Math.max(ttl, 172800);
    }

    const responseDrivenTtl = this.determineTTLFromResponse(response);
    if (responseDrivenTtl < ttl) {
      ttl = responseDrivenTtl;
    } else if (responseDrivenTtl > ttl && temp <= 0.5) {
      ttl = responseDrivenTtl;
    }

    return ttl;
  }

  private determineTTLFromResponse(response: ChatResponse): number {
    const base = config.cache.ttlResponses || 86400;
    const totalTokens = response.usage?.total_tokens ?? 0;

    if (totalTokens === 0) {
      return base;
    }

    if (totalTokens > 4000) {
      return Math.min(base, 43200);
    }

    if (totalTokens < 500) {
      return Math.max(base, 259200);
    }

    return base;
  }

  private getFromMemory(key: string): ChatResponse | null {
    const entry = this.inMemoryCache.get(key);
    if (!entry) return null;

    if (entry.expiresAt < Date.now()) {
      this.inMemoryCache.delete(key);
      return null;
    }

    return entry.data;
  }

  private setInMemory(key: string, data: ChatResponse, ttlSeconds: number = 300): void {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.inMemoryCache.set(key, { data, expiresAt });
    cacheLatency.observe({ cache_type: LABELS.memory, operation: 'set' }, 0);

    if (this.inMemoryCache.size > config.cache.maxInMemoryEntries) {
      this.trimMemoryCache();
    }
  }

  private trimMemoryCache(): void {
    const desiredSize = Math.floor(config.cache.maxInMemoryEntries * 0.9);
    const currentSize = this.inMemoryCache.size;
    if (currentSize <= desiredSize) return;

    const entries = [...this.inMemoryCache.entries()].sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt
    );
    for (let i = 0; i < currentSize - desiredSize; i++) {
      const [key] = entries[i];
      this.inMemoryCache.delete(key);
    }

    this.log.debug(
      { removed: currentSize - desiredSize, remaining: this.inMemoryCache.size },
      'Evicted entries from memory cache'
    );
  }

  private evictFromMemory(key: string): void {
    if (this.inMemoryCache.delete(key)) {
      this.log.debug({ key }, 'Evicted entry from memory cache');
    }
  }

  private async getFromRedisLayer(
    layer: 'redis-local' | 'redis-global',
    key: string,
    organizationId: string
  ): Promise<ChatResponse | null> {
    if (!isCacheEnabled({ organizationId })) {
      return null;
    }

    if (this.isCircuitOpen(layer)) {
      this.log.warn({ layer }, 'Circuit open, skipping Redis layer');
      return null;
    }

    const start = Date.now();
    try {
      const client = layer === 'redis-local' ? getRedisClient() : getGlobalRedisClient();
      const raw = await client.get(key);
      cacheLatency.observe(
        { cache_type: LABELS[layer], operation: 'get' },
        (Date.now() - start) / 1000
      );

      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as ChatResponse;
      this.resetCircuit(layer);
      return parsed;
    } catch (error) {
      this.recordFailure(layer, isError(error) ? error : new Error(getErrorMessage(error)));
      this.log.error({ error, layer, key }, 'Failed to read from Redis layer');
      return null;
    }
  }

  private async setInRedisLayer(
    layer: 'redis-local' | 'redis-global',
    key: string,
    data: ChatResponse,
    ttlSeconds: number,
    organizationId: string
  ): Promise<void> {
    if (!isCacheEnabled({ organizationId })) {
      return;
    }

    if (this.isCircuitOpen(layer)) {
      this.log.warn({ layer }, 'Circuit open, skipping Redis write');
      return;
    }

    const start = Date.now();
    try {
      const client = layer === 'redis-local' ? getRedisClient() : getGlobalRedisClient();
      await client.set(key, JSON.stringify(data), 'EX', ttlSeconds);
      cacheLatency.observe(
        { cache_type: LABELS[layer], operation: 'set' },
        (Date.now() - start) / 1000
      );
      this.resetCircuit(layer);
    } catch (error) {
      this.recordFailure(layer, isError(error) ? error : new Error(getErrorMessage(error)));
      this.log.error({ error, key, layer }, 'Failed to write to Redis cache layer');
    }
  }

  private async deleteFromRedisLayer(
    layer: 'redis-local' | 'redis-global',
    key: string
  ): Promise<void> {
    try {
      const client = layer === 'redis-local' ? getRedisClient() : getGlobalRedisClient();
      await client.del(key);
    } catch (error) {
      this.log.error({ error, key, layer }, 'Failed to delete key from Redis layer');
    }
  }

  private async deleteAllFromRedisLayer(
    layer: 'redis-local' | 'redis-global',
    organizationId: string
  ): Promise<void> {
    if (!isCacheEnabled({ organizationId })) return;

    try {
      const client = layer === 'redis-local' ? getRedisClient() : getGlobalRedisClient();
      await client.flushdb();
    } catch (error) {
      this.log.error({ error, layer }, 'Failed to flush Redis layer');
    }
  }

  private recordHit(layer: CacheLayer, latencyMs: number): void {
    if (layer !== 'memory') {
      this.stats.hits[layer] += 1;
    } else {
      this.stats.hits.memory += 1;
    }
    cacheHits.inc({ cache_type: LABELS[layer], key_prefix: KEY_PREFIX });
    cacheLatency.observe({ cache_type: LABELS[layer], operation: 'get' }, latencyMs / 1000);
  }

  private recordMiss(latencyMs: number): void {
    this.stats.misses += 1;
    cacheMisses.inc({ cache_type: 'multi', key_prefix: KEY_PREFIX });
    cacheLatency.observe({ cache_type: 'multi', operation: 'get' }, latencyMs / 1000);
  }

  private isCircuitOpen(layer: CacheLayer): boolean {
    if (layer === 'memory') return false;
    const state = this.circuits[layer];
    return !!(state.openUntil && state.openUntil > Date.now());
  }

  private recordFailure(layer: CacheLayer, error: Error): void {
    if (layer === 'memory') return;
    const state = this.circuits[layer];
    state.failures += 1;

    if (state.failures >= config.cache.circuitBreaker.failureThreshold) {
      state.openUntil = Date.now() + config.cache.circuitBreaker.resetTimeoutMs;
      this.log.warn({ layer, error: error.message }, 'Cache circuit opened');

      if (config.cache.circuitBreaker.disableCacheOnOpen) {
        disableCacheRuntime('cache_circuit_open', { layer, error: error.message });
      }
    }
  }

  private resetCircuit(layer: CacheLayer): void {
    if (layer === 'memory') return;
    const state = this.circuits[layer];
    state.failures = 0;
    state.openUntil = null;
  }

  private async setupInvalidationChannel(): Promise<void> {
    if (!isCacheEnabled()) {
      this.log.debug('Cache disabled, skipping invalidation channel setup');
      return;
    }

    try {
      const subscriber = getRedisClient().duplicate();
      this.redisSubscriber = subscriber;

      await subscriber.subscribe(this.cacheBusChannel);
      subscriber.on('message', (_channel: string, message: string) => {
        this.handleBusMessage(message);
      });

      this.log.info({ channel: this.cacheBusChannel }, 'Subscribed to cache invalidation channel');
    } catch (error) {
      this.log.error({ error }, 'Unable to subscribe to cache invalidation channel');
      disableCacheRuntime('cache_invalidation_subscription_failed', error);
    }
  }

  private handleBusMessage(raw: string): void {
    try {
      const message = JSON.parse(raw) as CacheBusMessage;
      if (message.source === this.instanceId) {
        return;
      }

      if (message.action === 'invalidate') {
        this.evictFromMemory(message.key);
      }

      if (message.action === 'clear-all') {
        this.inMemoryCache.clear();
        this.log.warn('Received cache clear-all signal');
      }
    } catch (error) {
      this.log.error({ error, raw }, 'Failed to process cache bus message');
    }
  }

  private async publish(message: CacheBusMessage): Promise<void> {
    if (!isCacheEnabled()) return;

    try {
      const client = getRedisClient();
      await client.publish(this.cacheBusChannel, JSON.stringify(message));
    } catch (error) {
      this.log.error({ error, message }, 'Failed to publish cache bus message');
    }
  }
}

let globalCacheService: CacheService | null = null;

export function getCacheService(): CacheService {
  if (!globalCacheService) {
    globalCacheService = new CacheService();
  }
  return globalCacheService;
}
