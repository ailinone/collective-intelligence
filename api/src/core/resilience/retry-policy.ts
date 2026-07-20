// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Retry Policy (v5.0)
 *
 * Intelligent retry with:
 * - Exponential backoff
 * - Jitter (prevent thundering herd)
 * - Retryable error detection
 * - Idempotency enforcement
 * - Circuit breaker integration
 *
 * Based on: AWS SDK, Google Cloud Client Libraries
 */

import { logger } from '../../utils/logger.js';
import { getErrorMessage, isError } from '../../utils/type-guards.js';

// ============================================
// Types & Interfaces
// ============================================

export interface RetryPolicyConfig {
  maxAttempts: number; // Default: 3
  baseDelay: number; // Default: 1000ms (1s)
  maxDelay: number; // Default: 30000ms (30s)
  exponentialFactor: number; // Default: 2 (doubles each time)
  jitter: boolean; // Default: true
  retryableStatusCodes: number[]; // Default: [408, 429, 500, 502, 503, 504]
  retryableErrors: string[]; // Default: ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']
  idempotentOnly: boolean; // Default: true (only retry safe operations)
}

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  lastError: Error;
  startTime: number;
  totalDelay: number;
  operation: string;
}

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  totalDuration: number;
  recoveredVia?: 'retry' | 'fallback' | 'cache';
  totalBackoffMs?: number;
}

// ============================================
// Default Configurations
// ============================================

const DEFAULT_CONFIG: RetryPolicyConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  exponentialFactor: 2,
  jitter: true,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  retryableErrors: [
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNRESET',
    'EPIPE',
    'NETWORK_ERROR',
    'PROVIDER_TIMEOUT',
  ],
  idempotentOnly: true,
};

// Provider-specific configs
const PROVIDER_CONFIGS: Record<string, Partial<RetryPolicyConfig>> = {
  openai: {
    maxAttempts: 3,
    baseDelay: 1000,
    retryableStatusCodes: [429, 500, 502, 503],
  },
  anthropic: {
    maxAttempts: 3,
    baseDelay: 2000, // Anthropic is stricter on rate limits
  },
  google: {
    maxAttempts: 5,
    baseDelay: 500,
  },
};

// ============================================
// Retry Policy Class
// ============================================

export class RetryPolicy {
  private config: RetryPolicyConfig;

  constructor(config: Partial<RetryPolicyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute operation with retry logic
   */
  async execute<T>(
    operation: () => Promise<T>,
    context: { operationName: string; isIdempotent: boolean }
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    let lastError: Error | null = null;
    let totalBackoffMs = 0;

    // Check idempotency requirement
    if (this.config.idempotentOnly && !context.isIdempotent) {
      logger.warn(
        {
          operation: context.operationName,
        },
        'Operation is not idempotent, retries disabled'
      );

      try {
        const data = await operation();
        return {
          success: true,
          data,
          attempts: 1,
          totalDuration: Date.now() - startTime,
          totalBackoffMs: 0,
        };
      } catch (error) {
        return {
          success: false,
          error: error as Error,
          attempts: 1,
          totalDuration: Date.now() - startTime,
          totalBackoffMs: 0,
        };
      }
    }

    // Retry loop
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        logger.debug(
          {
            operation: context.operationName,
            attempt,
            maxAttempts: this.config.maxAttempts,
          },
          'Executing operation (attempt ${attempt})'
        );

        const data = await operation();

        // Success!
        if (attempt > 1) {
          logger.info(
            {
              operation: context.operationName,
              attempt,
              totalDuration: Date.now() - startTime,
            },
            `✅ Operation succeeded after ${attempt} attempts`
          );
        }

        return {
          success: true,
          data,
          attempts: attempt,
          totalDuration: Date.now() - startTime,
          recoveredVia: attempt > 1 ? 'retry' : undefined,
          totalBackoffMs,
        };
      } catch (error) {
        lastError = error as Error;

        // Check if error is retryable
        const isRetryable = isError(error) && this.isRetryableError(error);

        if (!isRetryable || attempt === this.config.maxAttempts) {
          // Final attempt or non-retryable error
          logger.error(
            {
              operation: context.operationName,
              attempt,
              error: getErrorMessage(error),
              retryable: isRetryable,
            },
            'Operation failed (not retrying)'
          );

          return {
            success: false,
            error: error as Error,
            attempts: attempt,
            totalDuration: Date.now() - startTime,
            totalBackoffMs,
          };
        }

        // Calculate delay for next retry
        const delay = this.calculateDelay(attempt);
        totalBackoffMs += delay;

        logger.warn(
          {
            operation: context.operationName,
            attempt,
            nextAttempt: attempt + 1,
            delayMs: delay,
            error: getErrorMessage(error),
          },
          `Retry scheduled after ${delay}ms`
        );

        // Wait before retry
        await this.sleep(delay);
      }
    }

    // Should never reach here (loop handles all cases)
    return {
      success: false,
      error: lastError || new Error('Unknown error'),
      attempts: this.config.maxAttempts,
      totalDuration: Date.now() - startTime,
      totalBackoffMs,
    };
  }

  /**
   * Calculate retry delay with exponential backoff and jitter
   */
  private calculateDelay(attempt: number): number {
    // Exponential backoff: baseDelay * (factor ^ (attempt - 1))
    let delay = this.config.baseDelay * Math.pow(this.config.exponentialFactor, attempt - 1);

    // Cap at max delay
    delay = Math.min(delay, this.config.maxDelay);

    // Add jitter (random 0-50% of delay)
    if (this.config.jitter) {
      const jitterAmount = delay * 0.5 * Math.random();
      delay += jitterAmount;
    }

    return Math.floor(delay);
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    // Extended error types
    interface ErrorWithCode extends Error {
      code?: string;
    }
    interface ErrorWithStatusCode extends Error {
      statusCode?: number;
      status?: number;
    }

    const errorWithCode = error as ErrorWithCode;
    const errorWithStatus = error as ErrorWithStatusCode;

    // Check error code/name
    const errorCode = errorWithCode.code || '';
    if (this.config.retryableErrors.includes(errorCode)) {
      return true;
    }

    // Check HTTP status code (if available)
    const statusCode = errorWithStatus.statusCode || errorWithStatus.status;
    if (statusCode && this.config.retryableStatusCodes.includes(statusCode)) {
      return true;
    }

    // Check error message patterns
    const message = error.message.toLowerCase();
    const retryablePatterns = [
      'timeout',
      'timed out',
      'connection refused',
      'econnrefused',
      'network error',
      'temporary failure',
      'service unavailable',
      'rate limit',
      'too many requests',
    ];

    return retryablePatterns.some((pattern) => message.includes(pattern));
  }

  /**
   * Sleep helper (Promise-based)
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RetryPolicyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): RetryPolicyConfig {
    return { ...this.config };
  }
}

// ============================================
// Provider-Specific Policies
// ============================================

export class RetryPolicyManager {
  private policies: Map<string, RetryPolicy>;

  constructor() {
    this.policies = new Map();
    this.initializeDefaultPolicies();
  }

  private initializeDefaultPolicies(): void {
    // Create provider-specific policies
    for (const [provider, config] of Object.entries(PROVIDER_CONFIGS)) {
      this.policies.set(provider, new RetryPolicy(config));
    }

    // Default policy for unknown providers
    this.policies.set('default', new RetryPolicy(DEFAULT_CONFIG));

    logger.info(
      {
        providers: Array.from(this.policies.keys()),
      },
      '✅ Retry policies initialized'
    );
  }

  /**
   * Get retry policy for provider
   */
  getPolicy(provider: string): RetryPolicy {
    return this.policies.get(provider) || this.policies.get('default')!;
  }

  /**
   * Execute with provider-specific retry policy
   */
  async executeWithRetry<T>(
    provider: string,
    operation: () => Promise<T>,
    context: { operationName: string; isIdempotent: boolean }
  ): Promise<RetryResult<T>> {
    const policy = this.getPolicy(provider);
    return await policy.execute(operation, context);
  }
}

// ============================================
// Global Instance
// ============================================

export const retryPolicyManager = new RetryPolicyManager();
