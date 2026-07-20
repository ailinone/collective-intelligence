// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bulkhead Pattern Implementation
 *
 * Isolates resources by provider to prevent cascading failures.
 * Each provider gets its own resource pool (connections, threads, etc.)
 *
 * Benefits:
 * - Prevents one slow provider from exhausting all resources
 * - Limits blast radius of failures
 * - Better resource utilization
 * - Fair resource distribution
 */

import { EventEmitter } from 'events';
import { logger } from '@/utils/logger';

export interface BulkheadConfig {
  /**
   * Maximum concurrent operations allowed
   */
  maxConcurrent: number;

  /**
   * Maximum queue size for pending operations
   */
  maxQueueSize: number;

  /**
   * Timeout for queued operations (ms)
   */
  queueTimeout: number;

  /**
   * Provider name for logging
   */
  providerName: string;
}

export interface BulkheadStats {
  providerName: string;
  activeOperations: number;
  queuedOperations: number;
  totalExecuted: number;
  totalRejected: number;
  totalTimeout: number;
  maxConcurrentReached: number;
  avgExecutionTime: number;
}

interface QueuedOperation {
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  timeoutHandle?: NodeJS.Timeout;
}

/**
 * Bulkhead for a single provider
 *
 * Limits concurrent operations and queues excess requests
 * Note: Uses unknown internally for type erasure - callers are type-safe
 */
export class Bulkhead extends EventEmitter {
  private config: BulkheadConfig;
  private activeOperations = 0;
  private queue: QueuedOperation[] = [];
  private stats = {
    totalExecuted: 0,
    totalRejected: 0,
    totalTimeout: 0,
    maxConcurrentReached: 0,
    executionTimes: [] as number[],
  };

  constructor(config: BulkheadConfig) {
    super();
    this.config = config;

    logger.info(
      {
        provider: config.providerName,
        maxConcurrent: config.maxConcurrent,
        maxQueueSize: config.maxQueueSize,
      },
      'Bulkhead initialized'
    );
  }

  /**
   * Execute an operation through the bulkhead
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // Check if we can execute immediately
    if (this.activeOperations < this.config.maxConcurrent) {
      return this.executeImmediately(operation);
    }

    // Check if queue is full
    if (this.queue.length >= this.config.maxQueueSize) {
      this.stats.totalRejected++;
      this.emit('rejected', {
        provider: this.config.providerName,
        reason: 'queue_full',
      });

      logger.warn(
        {
          provider: this.config.providerName,
          queueSize: this.queue.length,
          maxQueueSize: this.config.maxQueueSize,
        },
        'Bulkhead queue full, request rejected'
      );

      throw new Error(
        `Bulkhead queue full for provider ${this.config.providerName}. Try again later.`
      );
    }

    // Queue the operation
    return this.enqueue(operation);
  }

  /**
   * Execute operation immediately
   */
  private async executeImmediately<T>(operation: () => Promise<T>): Promise<T> {
    this.activeOperations++;
    const startTime = Date.now();

    try {
      if (this.activeOperations > this.stats.maxConcurrentReached) {
        this.stats.maxConcurrentReached = this.activeOperations;
      }

      this.emit('operation_started', {
        provider: this.config.providerName,
        activeOperations: this.activeOperations,
      });

      const result = await operation();

      const executionTime = Date.now() - startTime;
      this.stats.totalExecuted++;
      this.stats.executionTimes.push(executionTime);

      // Keep only last 1000 execution times for avg calculation
      if (this.stats.executionTimes.length > 1000) {
        this.stats.executionTimes.shift();
      }

      this.emit('operation_completed', {
        provider: this.config.providerName,
        executionTime,
        activeOperations: this.activeOperations - 1,
      });

      return result;
    } catch (error) {
      this.emit('operation_failed', {
        provider: this.config.providerName,
        error,
      });
      throw error;
    } finally {
      this.activeOperations--;
      this.processQueue();
    }
  }

  /**
   * Enqueue an operation
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const queuedOp: QueuedOperation = {
        execute: operation as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      };

      // Set timeout for queued operation
      queuedOp.timeoutHandle = setTimeout(() => {
        const index = this.queue.indexOf(queuedOp);
        if (index !== -1) {
          this.queue.splice(index, 1);
          this.stats.totalTimeout++;

          this.emit('operation_timeout', {
            provider: this.config.providerName,
            queuedFor: Date.now() - queuedOp.enqueuedAt,
          });

          logger.warn(
            {
              provider: this.config.providerName,
              queuedFor: Date.now() - queuedOp.enqueuedAt,
              queueSize: this.queue.length,
            },
            'Queued operation timed out'
          );

          reject(
            new Error(`Operation timed out while queued for provider ${this.config.providerName}`)
          );
        }
      }, this.config.queueTimeout);

      this.queue.push(queuedOp);

      this.emit('operation_queued', {
        provider: this.config.providerName,
        queueSize: this.queue.length,
      });

      logger.debug(
        {
          provider: this.config.providerName,
          queueSize: this.queue.length,
          maxQueueSize: this.config.maxQueueSize,
        },
        'Operation queued'
      );
    });
  }

  /**
   * Process queued operations
   */
  private processQueue(): void {
    if (this.queue.length === 0) return;
    if (this.activeOperations >= this.config.maxConcurrent) return;

    const queuedOp = this.queue.shift();
    if (!queuedOp) return;

    // Clear timeout
    if (queuedOp.timeoutHandle) {
      clearTimeout(queuedOp.timeoutHandle);
    }

    const queuedFor = Date.now() - queuedOp.enqueuedAt;

    logger.debug(
      {
        provider: this.config.providerName,
        queuedFor,
        remainingInQueue: this.queue.length,
      },
      'Processing queued operation'
    );

    this.executeImmediately(queuedOp.execute).then(queuedOp.resolve).catch(queuedOp.reject);
  }

  /**
   * Get current bulkhead statistics
   */
  getStats(): BulkheadStats {
    const avgExecutionTime =
      this.stats.executionTimes.length > 0
        ? this.stats.executionTimes.reduce((a, b) => a + b, 0) / this.stats.executionTimes.length
        : 0;

    return {
      providerName: this.config.providerName,
      activeOperations: this.activeOperations,
      queuedOperations: this.queue.length,
      totalExecuted: this.stats.totalExecuted,
      totalRejected: this.stats.totalRejected,
      totalTimeout: this.stats.totalTimeout,
      maxConcurrentReached: this.stats.maxConcurrentReached,
      avgExecutionTime: Math.round(avgExecutionTime),
    };
  }

  /**
   * Check if bulkhead is healthy
   */
  isHealthy(): boolean {
    // Bulkhead is unhealthy if:
    // 1. Queue is >80% full
    // 2. Rejection rate is >10% of total
    const queueUtilization = this.queue.length / this.config.maxQueueSize;
    const totalRequests = this.stats.totalExecuted + this.stats.totalRejected;
    const rejectionRate = totalRequests > 0 ? this.stats.totalRejected / totalRequests : 0;

    return queueUtilization < 0.8 && rejectionRate < 0.1;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalExecuted: 0,
      totalRejected: 0,
      totalTimeout: 0,
      maxConcurrentReached: 0,
      executionTimes: [],
    };

    logger.info({ provider: this.config.providerName }, 'Bulkhead stats reset');
  }
}

/**
 * Bulkhead Manager
 *
 * Manages bulkheads for all providers
 */
export class BulkheadManager {
  private bulkheads = new Map<string, Bulkhead>();
  private defaultConfig: Omit<BulkheadConfig, 'providerName'> = {
    maxConcurrent: 10,
    maxQueueSize: 50,
    queueTimeout: 30000, // 30 seconds
  };

  /**
   * Get or create bulkhead for a provider
   * Note: The bulkhead stores operations of unknown type internally,
   * but the execute method is type-safe at the call site
   */
  getBulkhead(providerName: string, config?: Partial<BulkheadConfig>): Bulkhead {
    if (!this.bulkheads.has(providerName)) {
      const bulkheadConfig: BulkheadConfig = {
        ...this.defaultConfig,
        ...config,
        providerName,
      };

      const bulkhead = new Bulkhead(bulkheadConfig);
      this.bulkheads.set(providerName, bulkhead);

      logger.info(
        { provider: providerName, config: bulkheadConfig },
        'Bulkhead created for provider'
      );
    }

    return this.bulkheads.get(providerName)!;
  }

  /**
   * Get all bulkhead statistics
   */
  getAllStats(): BulkheadStats[] {
    return Array.from(this.bulkheads.values()).map((b) => b.getStats());
  }

  /**
   * Check if all bulkheads are healthy
   */
  areAllHealthy(): boolean {
    return Array.from(this.bulkheads.values()).every((b) => b.isHealthy());
  }

  /**
   * Reset all statistics
   */
  resetAllStats(): void {
    this.bulkheads.forEach((bulkhead) => bulkhead.resetStats());
  }
}

// Singleton instance
export const bulkheadManager = new BulkheadManager();
