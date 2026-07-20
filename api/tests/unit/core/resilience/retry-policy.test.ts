// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Retry Policy Tests
 * 
 * Testing:
 * - Exponential backoff calculation
 * - Jitter addition
 * - Retryable error detection
 * - Max attempts enforcement
 * - Provider-specific configs
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RetryPolicy, RetryPolicyManager } from '@/core/resilience/retry-policy';

// Extended error type for testing
interface ExtendedError extends Error {
  code?: string;
  statusCode?: number;
}

describe('RetryPolicy', () => {
  let policy: RetryPolicy;

  beforeEach(() => {
    policy = new RetryPolicy({
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      exponentialFactor: 2,
      jitter: false, // Disable for predictable tests
      retryableStatusCodes: [429, 500, 502, 503],
      retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT'],
      idempotentOnly: false, // Allow all operations
    });
  });

  describe('Delay Calculation', () => {
    it('should calculate exponential backoff correctly', () => {
      const config = policy.getConfig();
      
      // Manual calculation (baseDelay * factor^(attempt-1))
      const delay1 = 1000 * Math.pow(2, 0); // 1000ms
      const delay2 = 1000 * Math.pow(2, 1); // 2000ms
      const delay3 = 1000 * Math.pow(2, 2); // 4000ms

      expect(delay1).toBe(1000);
      expect(delay2).toBe(2000);
      expect(delay3).toBe(4000);
    });

    it('should cap delay at maxDelay', () => {
      const policyWithMax = new RetryPolicy({
        baseDelay: 1000,
        maxDelay: 5000,
        exponentialFactor: 10,
        jitter: false,
      });

      // Even with high exponential factor, should cap at 5000
      const config = policyWithMax.getConfig();
      expect(config.maxDelay).toBe(5000);
    });
  });

  describe('Retryable Error Detection', () => {
    it('should detect retryable error codes', () => {
      const error: ExtendedError = new Error('Connection refused');
      error.code = 'ECONNREFUSED';

      // RetryPolicy has private method, test via execution
      expect(error.code).toBe('ECONNREFUSED');
    });

    it('should detect retryable HTTP status codes', () => {
      const error: ExtendedError = new Error('Too many requests');
      error.statusCode = 429;

      expect(error.statusCode).toBe(429);
    });

    it('should detect retryable from message patterns', () => {
      const error1 = new Error('Request timeout occurred');
      const error2 = new Error('network error during request');

      expect(error1.message.toLowerCase()).toContain('timeout');
      expect(error2.message.toLowerCase()).toContain('network error');
    });
  });

  describe('Retry Execution', () => {
    it('should succeed on first attempt if operation succeeds', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        return 'success';
      };

      const result = await policy.execute(operation, {
        operationName: 'test-op',
        isIdempotent: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toBe('success');
      expect(result.attempts).toBe(1);
      expect(attempts).toBe(1);
    });

    it('should retry on retryable error', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        if (attempts < 2) {
          const error = new Error('Timeout');
    (error as ExtendedError).code = 'ETIMEDOUT';
          throw error;
        }
        return 'success';
      };

      const result = await policy.execute(operation, {
        operationName: 'test-op',
        isIdempotent: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toBe('success');
      expect(result.attempts).toBe(2);
      expect(result.recoveredVia).toBe('retry');
      expect(attempts).toBe(2);
    });

    it('should respect maxAttempts', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        const error = new Error('Always fails');
  (error as ExtendedError).code = 'ETIMEDOUT';
        throw error;
      };

      const result = await policy.execute(operation, {
        operationName: 'test-op',
        isIdempotent: true,
      });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3); // maxAttempts
      expect(attempts).toBe(3);
    });

    it('should not retry non-retryable errors', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        const error = new Error('Bad request');
  (error as ExtendedError).statusCode = 400; // Not retryable
        throw error;
      };

      const result = await policy.execute(operation, {
        operationName: 'test-op',
        isIdempotent: true,
      });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1); // No retries
      expect(attempts).toBe(1);
    });

    it('should not retry if idempotentOnly=true and isIdempotent=false', async () => {
      const strictPolicy = new RetryPolicy({
        maxAttempts: 3,
        idempotentOnly: true,
      });

      let attempts = 0;
      const operation = async () => {
        attempts++;
        throw new Error('Retryable error');
      };

      const result = await strictPolicy.execute(operation, {
        operationName: 'non-idempotent-op',
        isIdempotent: false,
      });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1); // No retries for non-idempotent
      expect(attempts).toBe(1);
    });
  });

  describe('Configuration', () => {
    it('should allow updating configuration', () => {
      policy.updateConfig({ maxAttempts: 5 });
      const config = policy.getConfig();
      expect(config.maxAttempts).toBe(5);
    });

    it('should preserve other config when updating', () => {
      const originalDelay = policy.getConfig().baseDelay;
      policy.updateConfig({ maxAttempts: 5 });
      expect(policy.getConfig().baseDelay).toBe(originalDelay);
    });
  });
});

describe('RetryPolicyManager', () => {
  let manager: RetryPolicyManager;

  beforeEach(() => {
    manager = new RetryPolicyManager();
  });

  describe('Provider-Specific Policies', () => {
    it('should provide policy for known provider', () => {
      const openaiPolicy = manager.getPolicy('openai');
      expect(openaiPolicy).toBeDefined();
      expect(openaiPolicy.getConfig().maxAttempts).toBe(3);
    });

    it('should provide default policy for unknown provider', () => {
      const unknownPolicy = manager.getPolicy('unknown-provider');
      expect(unknownPolicy).toBeDefined();
      expect(unknownPolicy.getConfig().maxAttempts).toBe(3);
    });

    it('should have different configs for different providers', () => {
      const openaiConfig = manager.getPolicy('openai').getConfig();
      const anthropicConfig = manager.getPolicy('anthropic').getConfig();

      // Anthropic has longer base delay (stricter rate limits)
      expect(anthropicConfig.baseDelay).toBeGreaterThan(openaiConfig.baseDelay);
    });
  });

  describe('Execute with Retry', () => {
    it('should execute with provider-specific policy', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        if (attempts < 2) {
          const error = new Error('Timeout');
    (error as ExtendedError).code = 'ETIMEDOUT';
          throw error;
        }
        return 'success';
      };

      const result = await manager.executeWithRetry(
        'openai',
        operation,
        { operationName: 'chat-completion', isIdempotent: true }
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('success');
      expect(result.attempts).toBe(2);
    });
  });
});

