// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cache Invalidation Strategy
 * Pub/Sub based cache invalidation across instances
 */

import { getRedisClient } from './redis-client';
import { narrowAs } from '@/utils/type-guards';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'cache-invalidation' });

/**
 * Cache invalidation events
 */
export enum CacheInvalidationEvent {
  MODEL_UPDATED = 'model:updated',
  MODEL_DELETED = 'model:deleted',
  PROVIDER_UPDATED = 'provider:updated',
  PROVIDER_DELETED = 'provider:deleted',
  ORGANIZATION_UPDATED = 'organization:updated',
  USER_UPDATED = 'user:updated',
  ALL = 'cache:invalidate:all',
}

/**
 * Cache invalidation message
 */
export interface CacheInvalidationMessage {
  event: CacheInvalidationEvent;
  key?: string;
  pattern?: string;
  timestamp: number;
  source: string; // Instance ID
}

/**
 * Cache Invalidation Service
 * Handles cache invalidation across distributed instances
 */
export class CacheInvalidationService {
  private redis = getRedisClient();
  private subscribers: Map<CacheInvalidationEvent, Array<(msg: CacheInvalidationMessage) => void>> =
    new Map();

  private instanceId = `instance-${process.pid}-${Date.now()}`;
  private subscribed = false;

  /**
   * Initialize cache invalidation service
   */
  async initialize(): Promise<void> {
    if (this.subscribed) {
      return;
    }

    try {
      // Subscribe to cache invalidation channel
      const subscriber = this.redis.duplicate();

      await subscriber.subscribe('cache:invalidation', (err) => {
        if (err) {
          log.error({ error: err }, 'Failed to subscribe to cache invalidation channel');
        } else {
          log.info('✅ Subscribed to cache invalidation channel');
          this.subscribed = true;
        }
      });

      // Handle invalidation messages
      subscriber.on('message', (channel, message) => {
        if (channel === 'cache:invalidation') {
          try {
            const msg = narrowAs<CacheInvalidationMessage>(JSON.parse(message));

            // Ignore messages from self
            if (msg.source === this.instanceId) {
              return;
            }

            log.info({ event: msg.event, key: msg.key }, 'Cache invalidation received');
            this.handleInvalidation(msg);
          } catch (error) {
            log.error({ error }, 'Failed to parse cache invalidation message');
          }
        }
      });
    } catch (error) {
      log.error({ error }, 'Failed to initialize cache invalidation service');
    }
  }

  /**
   * Publish cache invalidation event
   */
  async invalidate(event: CacheInvalidationEvent, key?: string, pattern?: string): Promise<void> {
    const message: CacheInvalidationMessage = {
      event,
      key,
      pattern,
      timestamp: Date.now(),
      source: this.instanceId,
    };

    try {
      await this.redis.publish('cache:invalidation', JSON.stringify(message));
      log.info({ event, key, pattern }, 'Cache invalidation published');

      // Also handle locally
      this.handleInvalidation(message);
    } catch (error) {
      log.error({ error, event, key }, 'Failed to publish cache invalidation');
    }
  }

  /**
   * Handle invalidation message
   */
  private async handleInvalidation(msg: CacheInvalidationMessage): Promise<void> {
    try {
      // Invalidate specific key
      if (msg.key) {
        await this.redis.del(msg.key);
        log.debug({ key: msg.key }, 'Cache key invalidated');
      }

      // Invalidate pattern
      if (msg.pattern) {
        const keys = await this.redis.keys(msg.pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
          log.debug({ pattern: msg.pattern, count: keys.length }, 'Cache pattern invalidated');
        }
      }

      // Call event-specific subscribers
      const subscribers = this.subscribers.get(msg.event) || [];
      for (const callback of subscribers) {
        try {
          callback(msg);
        } catch (error) {
          log.error({ error, event: msg.event }, 'Subscriber callback failed');
        }
      }
    } catch (error) {
      log.error({ error, message: msg }, 'Failed to handle cache invalidation');
    }
  }

  /**
   * Subscribe to invalidation events
   */
  on(event: CacheInvalidationEvent, callback: (msg: CacheInvalidationMessage) => void): void {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, []);
    }
    this.subscribers.get(event)!.push(callback);
  }

  /**
   * Invalidate all caches
   */
  async invalidateAll(): Promise<void> {
    await this.invalidate(CacheInvalidationEvent.ALL, undefined, 'cache:*');
  }

  /**
   * Invalidate model cache
   */
  async invalidateModel(modelId: string): Promise<void> {
    await this.invalidate(CacheInvalidationEvent.MODEL_UPDATED, `model:${modelId}`);
  }

  /**
   * Invalidate provider cache
   */
  async invalidateProvider(providerId: string): Promise<void> {
    await this.invalidate(
      CacheInvalidationEvent.PROVIDER_UPDATED,
      undefined,
      `provider:${providerId}:*`
    );
  }

  /**
   * Invalidate organization cache
   */
  async invalidateOrganization(organizationId: string): Promise<void> {
    await this.invalidate(
      CacheInvalidationEvent.ORGANIZATION_UPDATED,
      undefined,
      `org:${organizationId}:*`
    );
  }
}

/**
 * Global cache invalidation service
 */
export const cacheInvalidation = new CacheInvalidationService();

/**
 * Initialize cache invalidation
 */
export async function initializeCacheInvalidation(): Promise<void> {
  await cacheInvalidation.initialize();
}
