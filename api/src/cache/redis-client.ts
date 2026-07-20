// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Redis Client
 * Connection management and health checks for Redis cache
 */

import Redis, { type RedisOptions } from 'ioredis';
import { config } from '@/config';
import { logger } from '@/utils/logger';

/**
 * Redis client singleton
 */
class RedisClientManager {
  private client: Redis | null = null;
  private globalClient: Redis | null = null;
  private queueClient: Redis | null = null;
  private readonly managedClients = new Map<Redis, string>();
  private readonly log = logger.child({ component: 'redis-client' });
  private isShuttingDown = false;

  /**
   * Get local Redis client
   */
  getClient(): Redis {
    if (!this.client) {
      this.client = this.createClient(config.redis, 'local');
    }
    return this.client;
  }

  /**
   * Get global Redis client (for distributed cache)
   */
  getGlobalClient(): Redis {
    if (!this.globalClient) {
      // Use same config for now (in production, would be different cluster)
      this.globalClient = this.createClient(
        {
          ...config.redis,
          db: 1, // Different database for global cache
        },
        'global'
      );
    }
    return this.globalClient;
  }

  /**
   * Get the money-path Redis client (BullMQ queues + idempotency store).
   * Uses `config.redisQueue`, which falls back to `config.redis`'s values
   * unless `REDIS_QUEUE_*` env vars point it at a separate instance — see
   * the `AppConfig.redisQueue` doc comment (types/index.ts) and
   * docs/audit/16-scale-to-100k-execution-plan.md, Phase 5.
   */
  getQueueClient(): Redis {
    if (!this.queueClient) {
      this.queueClient = this.createClient(config.redisQueue, 'queue');
    }
    return this.queueClient;
  }

  /**
   * Create dedicated Redis client, on the money-path (`config.redisQueue`)
   * connection — every current caller (BullMQ queues/workers, scheduled
   * jobs, the DLQ manager, batch worker, health-sync pub/sub) is queue/
   * coordination traffic, not evictable cache/rate-limit state.
   */
  createIsolatedClient(name: string, overrides: Partial<typeof config.redisQueue> = {}): Redis {
    const client = this.createClient(
      {
        ...config.redisQueue,
        ...overrides,
      },
      name
    );
    this.managedClients.set(client, name);
    client.once('end', () => {
      this.managedClients.delete(client);
    });
    return client;
  }

  /**
   * Release dedicated Redis client
   */
  async releaseClient(client: Redis): Promise<void> {
    const name = this.managedClients.get(client);
    if (!name) {
      await this.safeQuit(client, 'external');
      return;
    }
    await this.safeQuit(client, name);
    this.managedClients.delete(client);
  }

  /**
   * Create Redis client
   */
  private createClient(redisConfig: typeof config.redis, name: string): Redis {
    if (redisConfig.clusterEnabled) {
      // Fail fast rather than silently creating a single-node client while
      // claiming cluster mode is active (the prior behavior): BullMQ's key
      // scheme (queue-keys.js) has no hash-tag prefixing, so its multi-key
      // Lua scripts would hit CROSSSLOT errors once one queue's keys land on
      // different shards, and the "redis-global" cache layer relies on
      // `db: 1`, which Cluster mode does not support (single db 0 only).
      // Use REDIS_SENTINEL_ENABLED for HA instead — see
      // docs/audit/16-scale-to-100k-execution-plan.md, Phase 5.
      throw new Error(
        'REDIS_CLUSTER_ENABLED is not supported yet (BullMQ key scheme + multi-db cache layer ' +
          'are incompatible with Cluster mode) — use REDIS_SENTINEL_ENABLED for HA instead.'
      );
    }

    const baseOptions: RedisOptions = {
      password: redisConfig.password,
      db: redisConfig.db,
      retryStrategy: (times: number) => {
        if (this.isShuttingDown) {
          this.log.debug({ attempt: times }, 'Redis shutdown in progress, aborting reconnect');
          return null;
        }

        if (process.env.NODE_ENV === 'test' && times >= 5) {
          this.log.debug(
            { attempt: times },
            'Stopping Redis reconnect attempts in test mode to avoid hanging test runs'
          );
          return null;
        }

        // Retry with exponential backoff, max 3 seconds
        const delay = Math.min(times * 100, 3000);
        this.log.debug({ attempt: times, delay }, 'Retrying Redis connection');
        return delay;
      },
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true, // Use lazy connect to prevent immediate connection attempts
    };

    let options: RedisOptions;
    if (redisConfig.sentinelEnabled && redisConfig.sentinels && redisConfig.sentinels.length > 0) {
      this.log.info(
        { cache: name, sentinels: redisConfig.sentinels.length },
        'Creating Sentinel-monitored Redis client'
      );
      options = {
        ...baseOptions,
        sentinels: redisConfig.sentinels,
        name: redisConfig.sentinelName || 'mymaster',
      };
    } else {
      options = {
        ...baseOptions,
        host: redisConfig.host,
        port: redisConfig.port,
      };
    }

    const client = new Redis(options);
    this.setupEventHandlers(client, name);
    return client;
  }

  /**
   * Setup event handlers for logging
   */
  private setupEventHandlers(client: Redis, name: string): void {
    client.on('connect', () => {
      this.log.info({ cache: name }, 'Redis connected');
    });

    client.on('ready', () => {
      this.log.info({ cache: name }, 'Redis ready');
    });

    client.on('error', (error) => {
      this.log.error({ error, cache: name }, 'Redis error');
    });

    client.on('close', () => {
      this.log.warn({ cache: name }, 'Redis connection closed');
    });

    client.on('reconnecting', () => {
      this.log.info({ cache: name }, 'Redis reconnecting');
    });
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
    try {
      const startTime = Date.now();
      await this.getClient().ping();
      const latency = Date.now() - startTime;

      return { healthy: true, latency };
    } catch (error) {
      this.log.error({ error }, 'Redis health check failed');
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Disconnect all clients
   */
  async disconnect(): Promise<void> {
    this.log.info('Disconnecting Redis clients');
    this.isShuttingDown = true;

    const clientsToClose: Array<{ client: Redis; name: string }> = [];

    if (this.client) {
      clientsToClose.push({ client: this.client, name: 'local' });
      this.client = null;
    }

    if (this.globalClient) {
      clientsToClose.push({ client: this.globalClient, name: 'global' });
      this.globalClient = null;
    }

    if (this.queueClient) {
      clientsToClose.push({ client: this.queueClient, name: 'queue' });
      this.queueClient = null;
    }

    for (const [client, name] of this.managedClients.entries()) {
      clientsToClose.push({ client, name });
      this.managedClients.delete(client);
    }

    await Promise.all(clientsToClose.map(({ client, name }) => this.safeQuit(client, name)));

    this.log.info('Redis clients disconnected');
  }

  private async safeQuit(client: Redis, name: string): Promise<void> {
    try {
      client.removeAllListeners();
      await client.quit();
      client.disconnect(false);
    } catch (error) {
      this.log.warn(
        { error, cache: name },
        'Failed to quit Redis client gracefully, forcing disconnect'
      );
      await client.disconnect();
    }
  }
}

/**
 * Global Redis client manager
 */
const redisClientManager = new RedisClientManager();

/**
 * Get Redis client (local)
 */
export function getRedisClient(): Redis {
  return redisClientManager.getClient();
}

/**
 * Get global Redis client
 */
export function getGlobalRedisClient(): Redis {
  return redisClientManager.getGlobalClient();
}

/**
 * Get the money-path Redis client (BullMQ queues + the idempotency store).
 * See `AppConfig.redisQueue` (types/index.ts) for the split-by-concern
 * rationale.
 */
export function getQueueRedisClient(): Redis {
  return redisClientManager.getQueueClient();
}

/**
 * Create isolated Redis client, on the money-path (`config.redisQueue`)
 * connection.
 */
export function createRedisClient(
  name: string,
  overrides: Partial<typeof config.redisQueue> = {}
): Redis {
  return redisClientManager.createIsolatedClient(name, overrides);
}

/**
 * Release isolated Redis client
 */
export async function releaseRedisClient(client: Redis): Promise<void> {
  await redisClientManager.releaseClient(client);
}

/**
 * Health check Redis
 */
export async function checkRedisHealth(): Promise<{
  healthy: boolean;
  latency?: number;
  error?: string;
}> {
  return redisClientManager.healthCheck();
}

/**
 * Disconnect Redis
 */
export async function disconnectRedis(): Promise<void> {
  return redisClientManager.disconnect();
}
