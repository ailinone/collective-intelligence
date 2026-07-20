// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Circuit Breaker Pattern
 * Prevents cascade failures when dependencies (DB, Redis, LLM providers) fail
 */

import { logger } from './logger';
import { getErrorMessage, isError } from './type-guards';

const log = logger.child({ component: 'circuit-breaker' });

export enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Failing, reject requests
  HALF_OPEN = 'HALF_OPEN', // Testing if recovered
}

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold: number; // Number of failures before opening (default: 5)
  successThreshold: number; // Number of successes to close from half-open (default: 2)
  timeout: number; // Time in ms to wait before half-open (default: 60000)
  rollingWindowMs: number; // Time window to count failures (default: 60000)
}

interface FailureRecord {
  timestamp: number;
  error: Error;
}

/**
 * Circuit Breaker implementation
 * Protects against cascade failures
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: FailureRecord[] = [];
  private successes: number = 0;
  private lastStateChange: number = Date.now();
  private nextAttemptTime: number = 0;

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeout: number;
  private readonly rollingWindowMs: number;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold;
    this.successThreshold = options.successThreshold;
    this.timeout = options.timeout;
    this.rollingWindowMs = options.rollingWindowMs;

    log.info(
      {
        name: this.name,
        failureThreshold: this.failureThreshold,
        successThreshold: this.successThreshold,
        timeout: this.timeout,
      },
      'Circuit breaker initialized'
    );
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();

      // Check if timeout elapsed, transition to half-open
      if (now >= this.nextAttemptTime) {
        log.info({ name: this.name }, 'Circuit breaker transitioning to HALF_OPEN');
        this.state = CircuitState.HALF_OPEN;
        this.successes = 0;
      } else {
        const waitMs = this.nextAttemptTime - now;
        log.warn({ name: this.name, waitMs }, 'Circuit breaker is OPEN, rejecting request');
        throw new CircuitBreakerOpenError(
          `Circuit breaker ${this.name} is OPEN. Retry in ${waitMs}ms`
        );
      }
    }

    // Execute function
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(isError(error) ? error : new Error(getErrorMessage(error)));
      throw error;
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    // Remove old failures outside rolling window
    this.cleanOldFailures();

    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      log.info(
        { name: this.name, successes: this.successes, threshold: this.successThreshold },
        'Circuit breaker success in HALF_OPEN state'
      );

      if (this.successes >= this.successThreshold) {
        log.info({ name: this.name }, 'Circuit breaker closing (recovered)');
        this.state = CircuitState.CLOSED;
        this.failures = [];
        this.successes = 0;
        this.lastStateChange = Date.now();
      }
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(error: Error): void {
    const now = Date.now();
    this.failures.push({ timestamp: now, error });
    this.cleanOldFailures();

    const recentFailures = this.failures.length;

    log.warn(
      {
        name: this.name,
        state: this.state,
        recentFailures,
        threshold: this.failureThreshold,
        error: error.message,
      },
      'Circuit breaker failure recorded'
    );

    if (this.state === CircuitState.HALF_OPEN) {
      // Immediately open on failure in half-open state
      log.error({ name: this.name }, 'Circuit breaker opening (failed in HALF_OPEN)');
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = now + this.timeout;
      this.successes = 0;
      this.lastStateChange = now;
    } else if (this.state === CircuitState.CLOSED && recentFailures >= this.failureThreshold) {
      // Open circuit if threshold exceeded
      log.error(
        { name: this.name, failures: recentFailures, threshold: this.failureThreshold },
        'Circuit breaker opening (threshold exceeded)'
      );
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = now + this.timeout;
      this.lastStateChange = now;
    }
  }

  /**
   * Remove failures outside rolling window
   */
  private cleanOldFailures(): void {
    const cutoff = Date.now() - this.rollingWindowMs;
    this.failures = this.failures.filter((f) => f.timestamp > cutoff);
  }

  /**
   * Get circuit breaker status
   */
  getStatus(): {
    name: string;
    state: CircuitState;
    recentFailures: number;
    lastStateChange: number;
    nextAttemptTime: number;
  } {
    this.cleanOldFailures();
    return {
      name: this.name,
      state: this.state,
      recentFailures: this.failures.length,
      lastStateChange: this.lastStateChange,
      nextAttemptTime: this.nextAttemptTime,
    };
  }

  /**
   * Manually reset circuit breaker
   */
  reset(): void {
    log.info({ name: this.name }, 'Circuit breaker manually reset');
    this.state = CircuitState.CLOSED;
    this.failures = [];
    this.successes = 0;
    this.lastStateChange = Date.now();
    this.nextAttemptTime = 0;
  }
}

/**
 * Circuit Breaker Open Error
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Global circuit breakers registry
 */
class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /**
   * Get or create circuit breaker
   */
  get(name: string, options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
    if (!this.breakers.has(name)) {
      const breaker = new CircuitBreaker({
        name,
        failureThreshold: options?.failureThreshold || 5,
        successThreshold: options?.successThreshold || 2,
        timeout: options?.timeout || 60000, // 1 minute
        rollingWindowMs: options?.rollingWindowMs || 60000, // 1 minute window
      });
      this.breakers.set(name, breaker);
    }
    return this.breakers.get(name)!;
  }

  /**
   * Get all circuit breakers status
   */
  getAllStatus(): Record<string, ReturnType<CircuitBreaker['getStatus']>> {
    const status: Record<string, ReturnType<CircuitBreaker['getStatus']>> = {};
    for (const [name, breaker] of this.breakers) {
      status[name] = breaker.getStatus();
    }
    return status;
  }
}

/**
 * Global registry singleton
 */
export const circuitBreakers = new CircuitBreakerRegistry();

/**
 * Pre-configured circuit breakers for common dependencies
 */
export const databaseCircuitBreaker = circuitBreakers.get('database', {
  failureThreshold: 5,
  timeout: 30000, // 30 seconds
});

export const redisCircuitBreaker = circuitBreakers.get('redis', {
  failureThreshold: 5,
  timeout: 30000, // 30 seconds
});
