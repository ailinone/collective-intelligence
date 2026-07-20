// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Distributed Bulkhead
 *
 * Scale-to-100k Phase 2 (docs/audit/16-scale-to-100k-execution-plan.md).
 *
 * Problem this replaces: `bulkhead-pattern.ts`'s `Bulkhead` is a plain
 * in-process integer counter. With N replicas, the FLEET-WIDE concurrency
 * cap for a provider is `maxConcurrent * N` — it multiplies as you scale
 * out, which is backwards: it risks tripping the upstream provider's real
 * account-level rate limit while looking like more headroom than actually
 * exists (docs/audit/15-capacity-100k-assessment.md, bottleneck #1).
 *
 * This tracks active "leases" in a Redis sorted set shared by every
 * replica, keyed by provider name — the cap is enforced fleet-wide
 * regardless of how many replicas are running. Each lease is scored by its
 * own expiry time, so a replica that crashes while holding a lease doesn't
 * permanently shrink capacity: the lease is swept (ZREMRANGEBYSCORE) by the
 * next acquire attempt from any replica, bounded by leaseTtlMs.
 *
 * Follows the same idioms as distributed-circuit-breaker.ts: Redis-backed
 * by default, falls back to an in-process `Bulkhead` (bulkhead-pattern.ts)
 * if Redis throws, and defaults to local-only in tests unless forced
 * distributed (FORCE_DISTRIBUTED_BULKHEADS / config.resilience).
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'events';
import { logger } from '@/utils/logger';
import { getRedisClient } from '@/cache/redis-client';
import { config as appConfig } from '@/config';
import { Bulkhead } from '@/core/resilience/bulkhead-pattern';
import {
  bulkheadActiveLeases,
  bulkheadRejectedTotal,
  bulkheadMode,
} from '@/observability/ci-metrics';

/**
 * Shape both the legacy in-process `Bulkhead` and `DistributedBulkhead`
 * satisfy, so `ProviderAdapter` can hold either behind one field type.
 */
export interface BulkheadLike {
  execute<T>(operation: () => Promise<T>): Promise<T>;
}

export interface DistributedBulkheadConfig {
  /** Identifier for this bulkhead (provider name) */
  name: string;
  /** Fleet-wide max concurrent operations for this provider */
  maxConcurrent: number;
  /**
   * How long a caller will retry acquiring a lease before giving up (ms).
   * Mirrors the legacy Bulkhead's queueTimeout semantics.
   */
  queueTimeout?: number;
  /**
   * Max time a lease is honored before being swept as abandoned/crashed
   * (ms). Must be >= the slowest expected real operation duration for this
   * provider, or in-flight calls will have their lease reclaimed by someone
   * else while still running (harmless for correctness — capacity is only
   * ever undercounted, never oversold twice for the same slot — but it
   * defeats the cap during that window).
   */
  leaseTtlMs?: number;
  /** maxQueueSize for the LOCAL fallback engine only (distributed mode has no fixed queue — it retries until queueTimeout) */
  maxQueueSize?: number;
  /** Force distributed mode even in test/local environments */
  forceDistributed?: boolean;
}

export interface DistributedBulkheadStats {
  name: string;
  mode: 'distributed' | 'local_fallback';
  activeLeases: number;
  maxConcurrent: number;
  totalExecuted: number;
  totalRejected: number;
}

const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
const DEFAULT_LEASE_TTL_MS = 90_000; // comfortably above the provider adapters' 60s call timeout default
const ACQUIRE_RETRY_MIN_MS = 20;
const ACQUIRE_RETRY_MAX_MS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DistributedBulkhead extends EventEmitter implements BulkheadLike {
  private readonly config: Required<
    Pick<DistributedBulkheadConfig, 'name' | 'maxConcurrent' | 'queueTimeout' | 'leaseTtlMs' | 'maxQueueSize'>
  >;

  private readonly redisKey: string;
  private useLocalFallback = false;
  private localBulkhead: Bulkhead | null = null;
  private totalExecuted = 0;
  private totalRejected = 0;

  constructor(config: DistributedBulkheadConfig) {
    super();
    this.config = {
      name: config.name,
      maxConcurrent: config.maxConcurrent,
      queueTimeout: config.queueTimeout ?? DEFAULT_QUEUE_TIMEOUT_MS,
      leaseTtlMs: config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      maxQueueSize: config.maxQueueSize ?? 200,
    };
    this.redisKey = `bulkhead:${config.name}:leases`;

    const shouldForceDistributed =
      config.forceDistributed === true ||
      appConfig.resilience.forceDistributedBulkheads ||
      process.env.FORCE_DISTRIBUTED_BULKHEADS === 'true';

    if (
      !shouldForceDistributed &&
      (process.env.NODE_ENV === 'test' || process.env.TEST_USE_LOCAL_SERVICES === 'true')
    ) {
      this.enableLocalFallback('test/local environment');
    }

    logger.info(
      { provider: config.name, maxConcurrent: this.config.maxConcurrent },
      'Distributed bulkhead created'
    );
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.useLocalFallback) {
      return this.getLocalBulkhead().execute(operation);
    }

    const deadline = Date.now() + this.config.queueTimeout;
    const leaseId = randomUUID();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let acquired: boolean;
      let activeAfter: number;
      try {
        [acquired, activeAfter] = await this.tryAcquire(leaseId);
      } catch (error) {
        // Redis itself failed (not "at capacity" — an actual error) — fall
        // back to local-only enforcement rather than let provider egress
        // hang or fail outright while Redis recovers.
        logger.warn(
          { provider: this.config.name, error },
          'Distributed bulkhead: Redis unavailable, switching to local fallback'
        );
        this.enableLocalFallback('redis error');
        return this.getLocalBulkhead().execute(operation);
      }

      bulkheadActiveLeases.set({ provider: this.config.name }, activeAfter);

      if (acquired) {
        return this.runWithLease(leaseId, operation);
      }

      if (Date.now() >= deadline) {
        this.totalRejected++;
        bulkheadRejectedTotal.inc({ provider: this.config.name });
        this.emit('rejected', { provider: this.config.name, reason: 'at_capacity' });
        logger.warn(
          { provider: this.config.name, maxConcurrent: this.config.maxConcurrent },
          'Distributed bulkhead at capacity (fleet-wide), request rejected'
        );
        throw new Error(
          `Bulkhead at capacity for provider ${this.config.name} (fleet-wide cap ${this.config.maxConcurrent}). Try again later.`
        );
      }

      const jitter = ACQUIRE_RETRY_MIN_MS + Math.random() * (ACQUIRE_RETRY_MAX_MS - ACQUIRE_RETRY_MIN_MS);
      await sleep(Math.min(jitter, Math.max(0, deadline - Date.now())));
    }
  }

  private async runWithLease<T>(leaseId: string, operation: () => Promise<T>): Promise<T> {
    this.emit('operation_started', { provider: this.config.name });
    try {
      const result = await operation();
      this.totalExecuted++;
      this.emit('operation_completed', { provider: this.config.name });
      return result;
    } catch (error) {
      this.emit('operation_failed', { provider: this.config.name, error });
      throw error;
    } finally {
      await this.release(leaseId);
    }
  }

  /**
   * Atomically sweep expired leases, then acquire one if under the cap.
   * Returns [acquired, activeLeaseCountAfterThisCall].
   */
  private async tryAcquire(leaseId: string): Promise<[boolean, number]> {
    const redis = getRedisClient();
    const now = Date.now();
    const expiresAt = now + this.config.leaseTtlMs;

    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local maxConcurrent = tonumber(ARGV[2])
      local leaseId = ARGV[3]
      local expiresAt = tonumber(ARGV[4])

      redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
      local active = redis.call('ZCARD', key)

      if active < maxConcurrent then
        redis.call('ZADD', key, expiresAt, leaseId)
        redis.call('EXPIRE', key, math.ceil((expiresAt - now) / 1000) + 60)
        return {1, active + 1}
      else
        return {0, active}
      end
    `;

    const result = (await redis.eval(
      script,
      1,
      this.redisKey,
      now.toString(),
      this.config.maxConcurrent.toString(),
      leaseId,
      expiresAt.toString()
    )) as [number, number];

    return [result[0] === 1, result[1]];
  }

  private async release(leaseId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.zrem(this.redisKey, leaseId);
      const active = await redis.zcard(this.redisKey);
      bulkheadActiveLeases.set({ provider: this.config.name }, active);
    } catch (error) {
      // Releasing is best-effort: if this fails, the lease still expires on
      // its own via leaseTtlMs, so capacity self-heals rather than leaking
      // permanently.
      logger.debug({ provider: this.config.name, error }, 'Distributed bulkhead release failed (will self-expire)');
    }
  }

  private enableLocalFallback(reason: string): void {
    if (this.useLocalFallback) return;
    this.useLocalFallback = true;
    bulkheadMode.set({ provider: this.config.name }, 1);
    logger.warn({ provider: this.config.name, reason }, 'Distributed bulkhead running in local fallback mode');
  }

  private getLocalBulkhead(): Bulkhead {
    if (!this.localBulkhead) {
      this.localBulkhead = new Bulkhead({
        maxConcurrent: this.config.maxConcurrent,
        maxQueueSize: this.config.maxQueueSize,
        queueTimeout: this.config.queueTimeout,
        providerName: this.config.name,
      });
    }
    return this.localBulkhead;
  }

  async getStats(): Promise<DistributedBulkheadStats> {
    if (this.useLocalFallback) {
      const local = this.getLocalBulkhead().getStats();
      return {
        name: this.config.name,
        mode: 'local_fallback',
        activeLeases: local.activeOperations,
        maxConcurrent: this.config.maxConcurrent,
        totalExecuted: local.totalExecuted,
        totalRejected: local.totalRejected,
      };
    }

    try {
      const redis = getRedisClient();
      const now = Date.now();
      await redis.zremrangebyscore(this.redisKey, '-inf', now);
      const activeLeases = await redis.zcard(this.redisKey);
      return {
        name: this.config.name,
        mode: 'distributed',
        activeLeases,
        maxConcurrent: this.config.maxConcurrent,
        totalExecuted: this.totalExecuted,
        totalRejected: this.totalRejected,
      };
    } catch (error) {
      logger.warn({ provider: this.config.name, error }, 'Failed to read distributed bulkhead stats');
      return {
        name: this.config.name,
        mode: 'distributed',
        activeLeases: 0,
        maxConcurrent: this.config.maxConcurrent,
        totalExecuted: this.totalExecuted,
        totalRejected: this.totalRejected,
      };
    }
  }
}

/**
 * Distributed Bulkhead Manager — one bulkhead per provider name, fleet-wide.
 */
export class DistributedBulkheadManager {
  private bulkheads = new Map<string, DistributedBulkhead>();

  getBulkhead(name: string, config?: Partial<Omit<DistributedBulkheadConfig, 'name'>>): DistributedBulkhead {
    if (!this.bulkheads.has(name)) {
      const bulkheadConfig: DistributedBulkheadConfig = {
        maxConcurrent: 10,
        ...config,
        name,
      };

      if (
        bulkheadConfig.forceDistributed === undefined &&
        (appConfig.resilience.forceDistributedBulkheads || process.env.FORCE_DISTRIBUTED_BULKHEADS === 'true')
      ) {
        bulkheadConfig.forceDistributed = true;
      }

      this.bulkheads.set(name, new DistributedBulkhead(bulkheadConfig));
    }
    return this.bulkheads.get(name)!;
  }

  async getAllStats(): Promise<DistributedBulkheadStats[]> {
    return Promise.all(Array.from(this.bulkheads.values()).map((b) => b.getStats()));
  }
}

export const distributedBulkheadManager = new DistributedBulkheadManager();
