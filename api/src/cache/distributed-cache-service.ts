// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Distributed Cache Service
 * Provides namespace-aware cache API for CLI consumers without mocks.
 */

import type { Redis } from 'ioredis';
import { getRedisClient, getGlobalRedisClient } from './redis-client';
import { serializeError } from '@/utils/type-guards';
import { logger } from '@/utils/logger';

interface CacheEntryPayload {
  version: number;
  key: string;
  namespace: string;
  value: unknown;
  storedAt: number;
  ttlSeconds?: number;
  expiresAt?: number;
}

export interface CacheGetResult {
  hit: boolean;
  value?: unknown;
}

export interface CacheStats {
  items: number;
  hits: number;
  misses: number;
}

interface TenantScopedParams {
  organizationId?: string;
}

interface SetCacheValueParams extends TenantScopedParams {
  key: string;
  value: unknown;
  namespace?: string;
  ttlSeconds?: number;
}

interface DeleteCacheValueParams extends TenantScopedParams {
  key: string;
  namespace?: string;
}

interface ClearNamespaceParams extends TenantScopedParams {
  namespace?: string;
}

const STORAGE_PREFIX = 'distributed-cache';
const VALUE_PREFIX = `${STORAGE_PREFIX}:value`;
const KEYS_SET_SUFFIX = 'keys';
const STATS_SUFFIX = 'stats';

export class DistributedCacheService {
  private readonly redis: Redis;
  private readonly globalRedis: Redis | null;
  private readonly log = logger.child({ component: 'distributed-cache-service' });

  constructor() {
    this.redis = getRedisClient();

    try {
      this.globalRedis = getGlobalRedisClient();
    } catch (error) {
      this.log.warn(
        { error },
        'Global Redis client initialization failed. Operating with local Redis only.'
      );
      this.globalRedis = null;
    }
  }

  async getValue(params: DeleteCacheValueParams): Promise<CacheGetResult> {
    const namespace = this.resolveNamespace(params.namespace, params.organizationId);
    const storageKey = this.buildStorageKey(namespace, params.key);
    const statsKey = this.buildStatsKey(namespace);
    const keysSetKey = this.buildKeysSetKey(namespace);

    const raw = await this.redis.get(storageKey);
    if (!raw) {
      await this.recordMiss(statsKey);
      await this.redis.srem(keysSetKey, storageKey);
      return { hit: false };
    }

    let payload: CacheEntryPayload;
    try {
      payload = JSON.parse(raw) as CacheEntryPayload;
    } catch (error) {
      this.log.error({ error, storageKey }, 'Failed to parse cache entry payload. Removing key.');
      await this.deleteInternal(namespace, params.key);
      await this.recordMiss(statsKey);
      return { hit: false };
    }

    if (payload.expiresAt && payload.expiresAt <= Date.now()) {
      await this.deleteInternal(namespace, params.key);
      await this.recordMiss(statsKey);
      return { hit: false };
    }

    await this.recordHit(statsKey);
    return { hit: true, value: payload.value };
  }

  async setValue(params: SetCacheValueParams): Promise<void> {
    const namespace = this.resolveNamespace(params.namespace, params.organizationId);
    const storageKey = this.buildStorageKey(namespace, params.key);
    const keysSetKey = this.buildKeysSetKey(namespace);

    const payload: CacheEntryPayload = {
      version: 1,
      key: params.key,
      namespace,
      value: params.value,
      storedAt: Date.now(),
      ttlSeconds: params.ttlSeconds,
      expiresAt:
        typeof params.ttlSeconds === 'number'
          ? Date.now() + Math.max(0, params.ttlSeconds) * 1000
          : undefined,
    };

    const serialized = JSON.stringify(payload);

    await this.writeEntry(this.redis, storageKey, serialized, params.ttlSeconds);
    await this.redis.sadd(keysSetKey, storageKey);
    if (typeof params.ttlSeconds === 'number' && params.ttlSeconds > 0) {
      await this.redis.expire(keysSetKey, Math.max(params.ttlSeconds, 3600));
    }

    if (this.globalRedis) {
      await this.writeEntry(this.globalRedis, storageKey, serialized, params.ttlSeconds).catch(
        (error) => {
          this.log.error({ error: serializeError(error), storageKey }, 'Failed to replicate cache entry to global Redis');
        }
      );
    }
  }

  async deleteValue(params: DeleteCacheValueParams): Promise<boolean> {
    const namespace = this.resolveNamespace(params.namespace, params.organizationId);
    return this.deleteInternal(namespace, params.key);
  }

  async clearNamespace(params: ClearNamespaceParams = {}): Promise<number> {
    const namespace = this.resolveNamespace(params.namespace, params.organizationId);
    const pattern = `${VALUE_PREFIX}:${namespace}:*`;
    const keysSetKey = this.buildKeysSetKey(namespace);
    const statsKey = this.buildStatsKey(namespace);

    const deletedLocal = await this.scanAndDelete(this.redis, pattern);
    await this.redis.del(keysSetKey);
    await this.resetStats(statsKey);

    if (this.globalRedis) {
      await this.scanAndDelete(this.globalRedis, pattern).catch((error) => {
        this.log.error({ error: serializeError(error), namespace }, 'Failed to clear namespace from global Redis replica');
      });
    }

    return deletedLocal;
  }

  async getStats(params: ClearNamespaceParams = {}): Promise<CacheStats> {
    const namespace = this.resolveNamespace(params.namespace, params.organizationId);
    const statsKey = this.buildStatsKey(namespace);
    const keysSetKey = this.buildKeysSetKey(namespace);

    const [hitsRaw, missesRaw, items] = await Promise.all([
      this.redis.hget(statsKey, 'hits'),
      this.redis.hget(statsKey, 'misses'),
      this.redis.scard(keysSetKey),
    ]);

    return {
      items: items ?? 0,
      hits: hitsRaw ? Number.parseInt(hitsRaw, 10) || 0 : 0,
      misses: missesRaw ? Number.parseInt(missesRaw, 10) || 0 : 0,
    };
  }

  private async deleteInternal(namespace: string, key: string): Promise<boolean> {
    const storageKey = this.buildStorageKey(namespace, key);
    const keysSetKey = this.buildKeysSetKey(namespace);

    const [deleted] = await Promise.all([
      this.redis.del(storageKey),
      this.redis.srem(keysSetKey, storageKey),
    ]);

    if (this.globalRedis) {
      await Promise.allSettled([
        this.globalRedis.del(storageKey),
        this.globalRedis.srem(keysSetKey, storageKey),
      ]);
    }

    return (deleted ?? 0) > 0;
  }

  private async recordHit(statsKey: string): Promise<void> {
    await this.redis.hincrby(statsKey, 'hits', 1);
    await this.redis.hset(statsKey, 'updatedAt', Date.now().toString());
  }

  private async recordMiss(statsKey: string): Promise<void> {
    await this.redis.hincrby(statsKey, 'misses', 1);
    await this.redis.hset(statsKey, 'updatedAt', Date.now().toString());
  }

  private async resetStats(statsKey: string): Promise<void> {
    await this.redis.hset(statsKey, {
      hits: 0,
      misses: 0,
      updatedAt: Date.now().toString(),
    });
  }

  private async writeEntry(
    client: Redis,
    key: string,
    value: string,
    ttlSeconds?: number
  ): Promise<void> {
    if (typeof ttlSeconds === 'number' && ttlSeconds > 0) {
      await client.set(key, value, 'EX', Math.max(1, Math.floor(ttlSeconds)));
    } else {
      await client.set(key, value);
    }
  }

  private async scanAndDelete(client: Redis, pattern: string): Promise<number> {
    let cursor = '0';
    let totalDeleted = 0;

    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = nextCursor;

      if (keys.length > 0) {
        const deleted = await client.del(...keys);
        totalDeleted += deleted ?? 0;
      }
    } while (cursor !== '0');

    return totalDeleted;
  }

  private buildStorageKey(namespace: string, key: string): string {
    const encoded = this.encodeKey(key);
    return `${VALUE_PREFIX}:${namespace}:${encoded}`;
  }

  private buildKeysSetKey(namespace: string): string {
    return `${STORAGE_PREFIX}:${namespace}:${KEYS_SET_SUFFIX}`;
  }

  private buildStatsKey(namespace: string): string {
    return `${STORAGE_PREFIX}:${namespace}:${STATS_SUFFIX}`;
  }

  private resolveNamespace(namespace: string | undefined, organizationId?: string): string {
    const tenantSegment = this.normalizeTenantId(organizationId);
    const normalizedNamespace = this.normalizeNamespace(namespace);
    return `${tenantSegment}:${normalizedNamespace}`;
  }

  private normalizeTenantId(organizationId?: string): string {
    const tenant = (organizationId ?? 'shared').trim();
    if (!tenant) {
      return 'shared';
    }

    if (!/^[a-zA-Z0-9:_\-]+$/.test(tenant)) {
      throw new Error(
        `Invalid organization identifier "${organizationId ?? ''}". Allowed characters: letters, numbers, colon, underscore, hyphen.`
      );
    }

    return tenant;
  }

  private normalizeNamespace(namespace?: string): string {
    const normalized = (namespace ?? 'default').trim();
    if (!normalized) {
      return 'default';
    }

    if (!/^[a-zA-Z0-9:_\-]+$/.test(normalized)) {
      const attempted = namespace ?? '';
      throw new Error(
        `Invalid namespace "${attempted}". Allowed characters: letters, numbers, colon, underscore, hyphen.`
      );
    }

    return normalized;
  }

  private encodeKey(key: string): string {
    if (!key || typeof key !== 'string') {
      throw new Error('Cache key must be a non-empty string');
    }

    const trimmed = key.trim();
    if (!trimmed) {
      throw new Error('Cache key cannot be empty or whitespace');
    }

    return Buffer.from(trimmed).toString('base64url');
  }
}

let distributedCacheService: DistributedCacheService | null = null;

export function getDistributedCacheService(): DistributedCacheService {
  if (!distributedCacheService) {
    distributedCacheService = new DistributedCacheService();
  }
  return distributedCacheService;
}
