// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Distributed Circuit Breaker
 *
 * Circuit breaker pattern with Redis-backed shared state for multi-instance deployments.
 *
 * Benefits over local circuit breaker:
 * - Shared state across all API instances
 * - Faster failure detection (one instance opens, all instances see it)
 * - Coordinated recovery (all instances try half-open together)
 * - Consistent behavior in load-balanced environment
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failing, reject requests immediately
 * - HALF_OPEN: Testing recovery, allow limited requests
 *
 * v5.0 - State-of-the-art distributed resilience
 */

import { EventEmitter } from 'events';
import { logger } from '@/utils/logger';
import { getRedisClient } from '@/cache/redis-client';
import { config as appConfig } from '@/config';
import { circuitBreakerState } from '@/observability/ci-metrics';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface DistributedCircuitBreakerConfig {
  /**
   * Identifier for this circuit (e.g., 'openai-chatCompletion')
   */
  name: string;

  /**
   * Number of failures before opening circuit
   */
  failureThreshold: number;

  /**
   * Number of successes in HALF_OPEN to close circuit
   */
  successThreshold: number;

  /**
   * Time window for counting failures (ms)
   */
  failureWindow: number;

  /**
   * How long to stay OPEN before trying HALF_OPEN (ms)
   */
  openDuration: number;

  /**
   * How many requests to allow in HALF_OPEN state
   */
  halfOpenMaxAttempts: number;

  /**
   * Timeout for operations (ms)
   */
  timeout: number;

  /**
   * Force distributed mode even in test/local environments
   */
  forceDistributed?: boolean;
}

export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  totalRequests: number;
  totalRejected: number;
  lastStateChange: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  uptime: number;
}

/**
 * Distributed Circuit Breaker
 *
 * Uses Redis for shared state across instances
 */
export class DistributedCircuitBreaker extends EventEmitter {
  private config: DistributedCircuitBreakerConfig;
  private redisKeyPrefix: string;

  // Local cache to reduce Redis calls
  private localCache = {
    state: 'CLOSED' as CircuitState,
    lastSync: 0,
    syncInterval: 100, // Sync every 100ms
  };

  // Local fallback state (when Redis unavailable)
  private localState = {
    state: 'CLOSED' as CircuitState,
    failures: 0,
    successes: 0,
    totalRequests: 0,
    totalRejected: 0,
    lastStateChange: Date.now(),
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
  };

  private useLocalFallback = false;

  constructor(config: DistributedCircuitBreakerConfig) {
    super();
    this.config = config;
    this.redisKeyPrefix = `circuit-breaker:${config.name}`;

    // Tests and local development can force local fallback to avoid external Redis dependency
    const shouldForceDistributed =
      config.forceDistributed === true ||
      appConfig.resilience.forceDistributedCircuits ||
      process.env.FORCE_DISTRIBUTED_CIRCUITS === 'true';

    if (
      !shouldForceDistributed &&
      (process.env.NODE_ENV === 'test' || process.env.TEST_USE_LOCAL_SERVICES === 'true')
    ) {
      this.useLocalFallback = true;
      logger.debug?.(
        { circuit: config.name },
        'Distributed circuit breaker running in local fallback mode'
      );
    }

    logger.info(
      {
        circuit: config.name,
        failureThreshold: config.failureThreshold,
        openDuration: config.openDuration,
      },
      'Distributed circuit breaker created'
    );
  }

  /**
   * Execute operation through circuit breaker
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    const state = await this.getState();

    if (state === 'OPEN') {
      const stats = await this.getStats();
      const timeSinceOpen = Date.now() - stats.lastStateChange;

      // Check if we should transition to HALF_OPEN
      if (timeSinceOpen >= this.config.openDuration) {
        await this.setState('HALF_OPEN');
        logger.info({ circuit: this.config.name }, 'Circuit transitioning to HALF_OPEN');
      } else {
        // Still open, reject immediately
        await this.incrementRejected();

        logger.warn(
          {
            circuit: this.config.name,
            retryAfter: Math.ceil((this.config.openDuration - timeSinceOpen) / 1000),
          },
          'Circuit breaker OPEN, request rejected'
        );

        throw new Error(
          `Circuit breaker ${this.config.name} is OPEN. Retry after ${Math.ceil(
            (this.config.openDuration - timeSinceOpen) / 1000
          )} seconds.`
        );
      }
    }

    // Execute operation with timeout
    try {
      const result = await this.executeWithTimeout(operation);

      // Record success
      await this.recordSuccess();

      return result;
    } catch (error) {
      // Record failure
      await this.recordFailure();

      throw error;
    }
  }

  /**
   * Execute operation with timeout
   */
  private async executeWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Operation timed out after ${this.config.timeout}ms`)),
          this.config.timeout
        )
      ),
    ]);
  }

  /**
   * Get current circuit state (with caching)
   */
  private async getState(): Promise<CircuitState> {
    // If using local fallback, return local state
    if (this.useLocalFallback) {
      return this.localState.state;
    }

    const now = Date.now();

    // Use cached state if recent
    if (now - this.localCache.lastSync < this.localCache.syncInterval) {
      return this.localCache.state;
    }

    // Sync from Redis
    try {
      const redis = getRedisClient();
      const state = await redis.get(`${this.redisKeyPrefix}:state`);

      this.localCache.state = (state as CircuitState) || 'CLOSED';
      this.localCache.lastSync = now;

      return this.localCache.state;
    } catch (error) {
      // Enable local fallback if Redis fails
      this.useLocalFallback = true;
      logger.warn(
        { error, circuit: this.config.name },
        'Redis unavailable, using local fallback mode'
      );
      return this.localState.state;
    }
  }

  /**
   * Set circuit state (distributed or local fallback)
   */
  private async setState(state: CircuitState): Promise<void> {
    // Update Prometheus gauge: 0=CLOSED, 1=OPEN, 2=HALF_OPEN
    const stateValue = state === 'CLOSED' ? 0 : state === 'OPEN' ? 1 : 2;
    circuitBreakerState.set({ provider: this.config.name }, stateValue);

    // If using local fallback, update local state
    if (this.useLocalFallback) {
      this.localState.state = state;
      this.localState.lastStateChange = Date.now();

      if (state === 'CLOSED') {
        this.localState.consecutiveFailures = 0;
        this.localState.consecutiveSuccesses = 0;
      } else if (state === 'HALF_OPEN') {
        this.localState.consecutiveSuccesses = 0;
      }

      this.emit('stateChange', { circuit: this.config.name, newState: state });
      logger.info(
        { circuit: this.config.name, newState: state, mode: 'local' },
        'Circuit state changed (local)'
      );
      return;
    }

    try {
      const redis = getRedisClient();
      const multi = redis.multi();

      multi.set(`${this.redisKeyPrefix}:state`, state);
      multi.set(`${this.redisKeyPrefix}:lastStateChange`, Date.now().toString());

      // Reset counters on state change
      if (state === 'CLOSED') {
        multi.set(`${this.redisKeyPrefix}:consecutiveFailures`, '0');
        multi.set(`${this.redisKeyPrefix}:consecutiveSuccesses`, '0');
      } else if (state === 'HALF_OPEN') {
        multi.set(`${this.redisKeyPrefix}:consecutiveSuccesses`, '0');
        multi.set(`${this.redisKeyPrefix}:halfOpenAttempts`, '0');
      }

      // Set TTL (1 hour)
      multi.expire(`${this.redisKeyPrefix}:state`, 3600);

      await multi.exec();

      // Update local cache
      this.localCache.state = state;
      this.localCache.lastSync = Date.now();

      // Emit event
      this.emit('stateChange', { circuit: this.config.name, newState: state });

      logger.info(
        { circuit: this.config.name, newState: state, mode: 'distributed' },
        'Circuit breaker state changed'
      );
    } catch (error) {
      // Fallback to local
      this.useLocalFallback = true;
      this.localState.state = state;
      this.localState.lastStateChange = Date.now();
      logger.warn(
        { error, circuit: this.config.name },
        'Redis failed, circuit state updated locally'
      );
    }
  }

  /**
   * Record successful operation
   */
  private async recordSuccess(): Promise<void> {
    // Local fallback mode
    if (this.useLocalFallback) {
      this.localState.totalRequests++;
      this.localState.successes++;
      this.localState.consecutiveSuccesses++;
      this.localState.consecutiveFailures = 0;

      const state = this.localState.state;
      if (
        state === 'HALF_OPEN' &&
        this.localState.consecutiveSuccesses >= this.config.successThreshold
      ) {
        await this.setState('CLOSED');
        logger.info({ circuit: this.config.name, mode: 'local' }, 'Circuit CLOSED (recovered)');
      }
      return;
    }

    try {
      const redis = getRedisClient();

      // Increment counters
      await redis.incr(`${this.redisKeyPrefix}:totalRequests`);
      await redis.incr(`${this.redisKeyPrefix}:successes`);
      const consecutive = await redis.incr(`${this.redisKeyPrefix}:consecutiveSuccesses`);
      await redis.set(`${this.redisKeyPrefix}:consecutiveFailures`, '0');

      const state = await this.getState();

      // State transition logic
      if (state === 'HALF_OPEN' && consecutive >= this.config.successThreshold) {
        // Enough successes in HALF_OPEN, close circuit
        await this.setState('CLOSED');
        logger.info(
          { circuit: this.config.name, mode: 'distributed' },
          'Circuit breaker CLOSED (recovered)'
        );
      }
    } catch (error) {
      this.useLocalFallback = true;
      logger.warn(
        { error, circuit: this.config.name },
        'Failed to record success, using local fallback'
      );
    }
  }

  /**
   * Record failed operation
   */
  private async recordFailure(): Promise<void> {
    // Local fallback mode
    if (this.useLocalFallback) {
      this.localState.totalRequests++;
      this.localState.failures++;
      this.localState.consecutiveFailures++;
      this.localState.consecutiveSuccesses = 0;

      const state = this.localState.state;
      if (
        state === 'CLOSED' &&
        this.localState.consecutiveFailures >= this.config.failureThreshold
      ) {
        await this.setState('OPEN');
        logger.error(
          {
            circuit: this.config.name,
            consecutive: this.localState.consecutiveFailures,
            mode: 'local',
          },
          'Circuit OPEN'
        );
      } else if (state === 'HALF_OPEN') {
        await this.setState('OPEN');
        logger.warn(
          { circuit: this.config.name, mode: 'local' },
          'Circuit OPEN (HALF_OPEN failed)'
        );
      }
      return;
    }

    try {
      const redis = getRedisClient();

      // Increment counters
      await redis.incr(`${this.redisKeyPrefix}:totalRequests`);
      await redis.incr(`${this.redisKeyPrefix}:failures`);
      const consecutive = await redis.incr(`${this.redisKeyPrefix}:consecutiveFailures`);
      await redis.set(`${this.redisKeyPrefix}:consecutiveSuccesses`, '0');

      const state = await this.getState();

      // State transition logic
      if (state === 'CLOSED' && consecutive >= this.config.failureThreshold) {
        // Too many failures, open circuit
        await this.setState('OPEN');
        logger.error(
          { circuit: this.config.name, consecutive, mode: 'distributed' },
          'Circuit breaker OPEN (too many failures)'
        );
      } else if (state === 'HALF_OPEN') {
        // Failure in HALF_OPEN, back to OPEN
        await this.setState('OPEN');
        logger.warn(
          { circuit: this.config.name, mode: 'distributed' },
          'Circuit breaker OPEN (HALF_OPEN failed)'
        );
      }
    } catch (error) {
      this.useLocalFallback = true;
      logger.warn(
        { error, circuit: this.config.name },
        'Failed to record failure, using local fallback'
      );
    }
  }

  /**
   * Increment rejected requests counter
   */
  private async incrementRejected(): Promise<void> {
    if (this.useLocalFallback) {
      this.localState.totalRejected++;
      return;
    }

    try {
      const redis = getRedisClient();
      await redis.incr(`${this.redisKeyPrefix}:totalRejected`);
    } catch (error) {
      this.useLocalFallback = true;
      this.localState.totalRejected++;
    }
  }

  /**
   * Get circuit breaker statistics
   */
  async getStats(): Promise<CircuitBreakerStats> {
    // Local fallback mode
    if (this.useLocalFallback) {
      const uptime = Date.now() - this.localState.lastStateChange;
      return {
        name: this.config.name,
        state: this.localState.state,
        failures: this.localState.failures,
        successes: this.localState.successes,
        totalRequests: this.localState.totalRequests,
        totalRejected: this.localState.totalRejected,
        lastStateChange: this.localState.lastStateChange,
        consecutiveFailures: this.localState.consecutiveFailures,
        consecutiveSuccesses: this.localState.consecutiveSuccesses,
        uptime,
      };
    }

    try {
      const redis = getRedisClient();

      const [
        state,
        failures,
        successes,
        totalRequests,
        totalRejected,
        lastStateChange,
        consecutiveFailures,
        consecutiveSuccesses,
      ] = await Promise.all([
        redis.get(`${this.redisKeyPrefix}:state`),
        redis.get(`${this.redisKeyPrefix}:failures`),
        redis.get(`${this.redisKeyPrefix}:successes`),
        redis.get(`${this.redisKeyPrefix}:totalRequests`),
        redis.get(`${this.redisKeyPrefix}:totalRejected`),
        redis.get(`${this.redisKeyPrefix}:lastStateChange`),
        redis.get(`${this.redisKeyPrefix}:consecutiveFailures`),
        redis.get(`${this.redisKeyPrefix}:consecutiveSuccesses`),
      ]);

      const lastChange = parseInt(lastStateChange || '0');
      const uptime = lastChange > 0 ? Date.now() - lastChange : 0;

      return {
        name: this.config.name,
        state: (state as CircuitState) || 'CLOSED',
        failures: parseInt(failures || '0'),
        successes: parseInt(successes || '0'),
        totalRequests: parseInt(totalRequests || '0'),
        totalRejected: parseInt(totalRejected || '0'),
        lastStateChange: lastChange,
        consecutiveFailures: parseInt(consecutiveFailures || '0'),
        consecutiveSuccesses: parseInt(consecutiveSuccesses || '0'),
        uptime,
      };
    } catch (error) {
      // Fallback to local
      this.useLocalFallback = true;
      logger.warn(
        { error, circuit: this.config.name },
        'Failed to get circuit stats, using local fallback'
      );

      const uptime = Date.now() - this.localState.lastStateChange;
      return {
        name: this.config.name,
        state: this.localState.state,
        failures: this.localState.failures,
        successes: this.localState.successes,
        totalRequests: this.localState.totalRequests,
        totalRejected: this.localState.totalRejected,
        lastStateChange: this.localState.lastStateChange,
        consecutiveFailures: this.localState.consecutiveFailures,
        consecutiveSuccesses: this.localState.consecutiveSuccesses,
        uptime,
      };
    }
  }

  /**
   * Manually open circuit (for maintenance, etc.)
   */
  async open(): Promise<void> {
    await this.setState('OPEN');
  }

  /**
   * Manually close circuit (force recovery)
   */
  async close(): Promise<void> {
    await this.setState('CLOSED');
  }

  /**
   * Reset circuit breaker (clear all stats)
   */
  async reset(): Promise<void> {
    if (this.useLocalFallback) {
      this.resetLocalState();
      logger.info(
        { circuit: this.config.name, mode: 'local' },
        'Circuit breaker reset (local fallback)'
      );
      return;
    }

    try {
      const redis = getRedisClient();
      const keys = await redis.keys(`${this.redisKeyPrefix}:*`);

      if (keys.length > 0) {
        await redis.del(...keys);
      }

      this.localCache.state = 'CLOSED';
      this.localCache.lastSync = Date.now();
      this.resetLocalState();

      logger.info({ circuit: this.config.name }, 'Circuit breaker reset');
    } catch (error) {
      logger.error({ error, circuit: this.config.name }, 'Failed to reset circuit breaker');
    }
  }

  private resetLocalState(): void {
    this.localState.state = 'CLOSED';
    this.localState.failures = 0;
    this.localState.successes = 0;
    this.localState.totalRequests = 0;
    this.localState.totalRejected = 0;
    this.localState.consecutiveFailures = 0;
    this.localState.consecutiveSuccesses = 0;
    this.localState.lastStateChange = Date.now();
  }
}

/**
 * Distributed Circuit Breaker Manager
 *
 * Manages circuit breakers for all providers/operations
 */
export class DistributedCircuitBreakerManager {
  private breakers = new Map<string, DistributedCircuitBreaker>();

  /**
   * Default configurations by service type
   */
  private defaultConfigs: Record<string, Omit<DistributedCircuitBreakerConfig, 'name'>> = {
    // LLM Provider API Calls
    'llm-provider': {
      failureThreshold: 5, // Open after 5 consecutive failures
      successThreshold: 3, // Close after 3 consecutive successes
      failureWindow: 60000, // 1 minute window
      openDuration: 30000, // Stay open for 30 seconds
      halfOpenMaxAttempts: 5, // Allow 5 attempts in HALF_OPEN
      timeout: 60000, // 60 second timeout
    },

    // Database Connections
    database: {
      failureThreshold: 3, // Open after 3 failures
      successThreshold: 2, // Close after 2 successes
      failureWindow: 30000, // 30 second window
      openDuration: 10000, // Stay open for 10 seconds
      halfOpenMaxAttempts: 3,
      timeout: 5000, // 5 second timeout
    },

    // Redis Connections
    redis: {
      failureThreshold: 3,
      successThreshold: 2,
      failureWindow: 30000,
      openDuration: 10000,
      halfOpenMaxAttempts: 3,
      timeout: 2000, // 2 second timeout
    },

    // External APIs (rate limits, etc.)
    'external-api': {
      failureThreshold: 10, // More tolerant
      successThreshold: 5,
      failureWindow: 120000, // 2 minute window
      openDuration: 60000, // Stay open for 1 minute
      halfOpenMaxAttempts: 10,
      timeout: 30000, // 30 second timeout
    },
  };

  /**
   * Get or create circuit breaker
   */
  getBreaker(
    name: string,
    type: 'llm-provider' | 'database' | 'redis' | 'external-api' = 'llm-provider',
    config?: Partial<DistributedCircuitBreakerConfig>
  ): DistributedCircuitBreaker {
    if (!this.breakers.has(name)) {
      const breakerConfig: DistributedCircuitBreakerConfig = {
        ...this.defaultConfigs[type],
        ...config,
        name,
      };

      if (
        breakerConfig.forceDistributed === undefined &&
        (appConfig.resilience.forceDistributedCircuits ||
          process.env.FORCE_DISTRIBUTED_CIRCUITS === 'true')
      ) {
        breakerConfig.forceDistributed = true;
      }

      const breaker = new DistributedCircuitBreaker(breakerConfig);
      this.breakers.set(name, breaker);

      logger.info(
        { circuit: name, type, config: breakerConfig },
        'Distributed circuit breaker registered'
      );
    }

    return this.breakers.get(name)!;
  }

  /**
   * Execute operation through circuit breaker
   */
  async execute<T>(
    circuitName: string,
    operation: () => Promise<T>,
    type?: 'llm-provider' | 'database' | 'redis' | 'external-api'
  ): Promise<T> {
    const breaker = this.getBreaker(circuitName, type);
    return breaker.execute(operation);
  }

  /**
   * Get statistics for all circuit breakers
   */
  async getAllStats(): Promise<CircuitBreakerStats[]> {
    const stats: CircuitBreakerStats[] = [];

    for (const breaker of this.breakers.values()) {
      stats.push(await breaker.getStats());
    }

    return stats;
  }

  /**
   * Get statistics for circuits in OPEN state
   */
  async getOpenCircuits(): Promise<CircuitBreakerStats[]> {
    const all = await this.getAllStats();
    return all.filter((s) => s.state === 'OPEN');
  }

  /**
   * Check if all circuits are healthy
   */
  async areAllClosed(): Promise<boolean> {
    const stats = await this.getAllStats();
    return stats.every((s) => s.state === 'CLOSED');
  }

  /**
   * Manually open a circuit
   */
  async openCircuit(circuitName: string): Promise<void> {
    const breaker = this.breakers.get(circuitName);
    if (breaker) {
      await breaker.open();
    }
  }

  /**
   * Manually close a circuit
   */
  async closeCircuit(circuitName: string): Promise<void> {
    const breaker = this.breakers.get(circuitName);
    if (breaker) {
      await breaker.close();
    }
  }

  /**
   * Reset all circuit breakers
   */
  async resetAll(): Promise<void> {
    for (const breaker of this.breakers.values()) {
      await breaker.reset();
    }

    logger.info('All circuit breakers reset');
  }
}

// Singleton instance
export const distributedCircuitBreakerManager = new DistributedCircuitBreakerManager();
