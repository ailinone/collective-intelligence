// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Error classification — exhaustive cases per ProviderErrorClass.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyProviderError,
  extractHttpStatus,
  parseRetryAfterMs,
  extractRetryAfter,
} from '../error-classification';

describe('classifyProviderError', () => {
  describe('auth_failed', () => {
    it('detects 401 status as auth_failed', () => {
      const r = classifyProviderError({ status: 401, message: 'Unauthorized' });
      expect(r.errorClass).toBe('auth_failed');
      expect(r.scope).toBe('account');
      expect(r.retryability).toBe('non_retryable');
      expect(r.shouldSkipNearZero).toBe(true);
      expect(r.shouldRemoveFromCandidatePool).toBe(true);
      expect(r.cooldownMs).toBeGreaterThan(60 * 60 * 1000); // > 1 hour
    });

    it('detects 403 status as auth_failed', () => {
      const r = classifyProviderError({ status: 403, message: 'Forbidden' });
      expect(r.errorClass).toBe('auth_failed');
    });

    it('detects "invalid api key" message as auth_failed', () => {
      const r = classifyProviderError(new Error('Invalid API key provided'));
      expect(r.errorClass).toBe('auth_failed');
    });

    it('detects nested response.status=401', () => {
      const r = classifyProviderError({ response: { status: 401 } });
      expect(r.errorClass).toBe('auth_failed');
    });
  });

  describe('insufficient_credit', () => {
    it('detects 402 as insufficient_credit', () => {
      const r = classifyProviderError({ status: 402, message: 'Payment required' });
      expect(r.errorClass).toBe('insufficient_credit');
      expect(r.scope).toBe('account');
      expect(r.shouldSkipNearZero).toBe(true);
    });

    it('detects "insufficient quota" message', () => {
      const r = classifyProviderError(new Error('You have insufficient quota in your account'));
      expect(r.errorClass).toBe('insufficient_credit');
    });

    it('detects "credit balance" message', () => {
      const r = classifyProviderError(new Error('Credit balance is too low'));
      expect(r.errorClass).toBe('insufficient_credit');
    });
  });

  describe('rate_limited', () => {
    it('detects 429 as rate_limited', () => {
      const r = classifyProviderError({
        status: 429,
        message: 'Too many requests',
        response: { headers: { 'retry-after': '30' } },
      });
      expect(r.errorClass).toBe('rate_limited');
      expect(r.retryability).toBe('retryable_after_cooldown');
      expect(r.shouldRemoveFromCandidatePool).toBe(false); // transient
      expect(r.shouldSkipNearZero).toBe(true);
      expect(r.cooldownMs).toBe(30_000); // from Retry-After
    });

    it('falls back to default cooldown when no Retry-After', () => {
      const r = classifyProviderError({ status: 429 });
      expect(r.errorClass).toBe('rate_limited');
      expect(r.cooldownMs).toBe(60_000); // DEFAULT_COOLDOWNS.rate_limited
    });
  });

  describe('quota_exceeded', () => {
    it('detects "quota" without "rate" keyword as quota_exceeded', () => {
      const r = classifyProviderError(new Error('Monthly quota exceeded'));
      expect(r.errorClass).toBe('quota_exceeded');
    });
  });

  describe('model_not_found — scope MUST be provider_model', () => {
    it('does NOT mark provider as failed when only one model is missing', () => {
      const r = classifyProviderError(new Error("Model 'gpt-4o-mini' not found"));
      expect(r.errorClass).toBe('model_not_found');
      expect(r.scope).toBe('provider_model'); // critical
      expect(r.shouldRemoveFromCandidatePool).toBe(true); // remove the tuple, not the provider
    });

    it('detects 404 with "model" in message', () => {
      const r = classifyProviderError({ status: 404, message: 'Model not found' });
      expect(r.errorClass).toBe('model_not_found');
      expect(r.scope).toBe('provider_model');
    });
  });

  describe('endpoint_not_found', () => {
    it('detects 404 without model keyword as endpoint_not_found', () => {
      const r = classifyProviderError({ status: 404, message: 'Not Found' });
      expect(r.errorClass).toBe('endpoint_not_found');
      expect(r.scope).toBe('endpoint');
    });
  });

  describe('context_exceeded — scope MUST be request, NOT provider', () => {
    it('does not mark provider as unhealthy', () => {
      const r = classifyProviderError(new Error('context_length_exceeded: input is too long'));
      expect(r.errorClass).toBe('context_exceeded');
      expect(r.scope).toBe('request');
      expect(r.healthState).toBe('healthy');
      expect(r.shouldRemoveFromCandidatePool).toBe(false);
      expect(r.shouldSkipNearZero).toBe(false);
      expect(r.cooldownMs).toBe(0);
      expect(r.retryability).toBe('never_retry_same_request');
    });

    it('detects 413 as context_exceeded', () => {
      const r = classifyProviderError({ status: 413 });
      expect(r.errorClass).toBe('context_exceeded');
      expect(r.scope).toBe('request');
    });
  });

  describe('provider_timeout', () => {
    it('detects ETIMEDOUT', () => {
      const r = classifyProviderError(new Error('connect ETIMEDOUT 1.2.3.4:443'));
      expect(r.errorClass).toBe('provider_timeout');
      expect(r.healthState).toBe('timeout_suspected');
      expect(r.shouldRemoveFromCandidatePool).toBe(false);
      expect(r.shouldSkipNearZero).toBe(false); // not skipped near-zero — let reprobe
    });

    it('detects EAI_AGAIN as transient', () => {
      const r = classifyProviderError(new Error('getaddrinfo EAI_AGAIN api.example.com'));
      expect(r.errorClass).toBe('provider_timeout');
      expect(r.healthState).toBe('timeout_suspected');
    });

    it('detects "fetch failed" as transient', () => {
      const r = classifyProviderError(new TypeError('fetch failed'));
      expect(r.errorClass).toBe('provider_timeout');
    });
  });

  describe('provider_5xx', () => {
    it('detects 500-599 status', () => {
      for (const status of [500, 502, 503, 504]) {
        const r = classifyProviderError({ status });
        expect(r.errorClass).toBe('provider_5xx');
        expect(r.retryability).toBe('retryable_after_cooldown');
      }
    });
  });

  describe('invalid_request', () => {
    it('detects 400 as invalid_request', () => {
      const r = classifyProviderError({ status: 400, message: 'Bad request' });
      expect(r.errorClass).toBe('invalid_request');
      expect(r.scope).toBe('request');
      expect(r.healthState).toBe('healthy'); // request fault, not provider fault
    });
  });

  describe('unknown_error fallback', () => {
    it('returns unknown_error for empty input', () => {
      const r = classifyProviderError({});
      expect(r.errorClass).toBe('unknown_error');
      expect(r.retryability).toBe('retryable_after_cooldown');
    });

    it('returns unknown_error for plain string', () => {
      const r = classifyProviderError('something went wrong');
      expect(r.errorClass).toBe('unknown_error');
    });
  });

  describe('priority: credit keywords beat 401', () => {
    // Some providers return 401 for billing issues; the keyword wins.
    it('treats 401 + "credit" message as insufficient_credit', () => {
      const r = classifyProviderError({
        status: 401,
        message: 'No credit balance available',
      });
      expect(r.errorClass).toBe('insufficient_credit');
    });
  });
});

describe('extractHttpStatus', () => {
  it('reads status from object', () => {
    expect(extractHttpStatus({ status: 401 })).toBe(401);
  });
  it('reads statusCode from object', () => {
    expect(extractHttpStatus({ statusCode: 500 })).toBe(500);
  });
  it('reads response.status', () => {
    expect(extractHttpStatus({ response: { status: 429 } })).toBe(429);
  });
  it('parses HTTP NNN from message', () => {
    expect(extractHttpStatus({ message: 'request failed: HTTP 404 Not Found' })).toBe(404);
  });
  it('returns undefined when absent', () => {
    expect(extractHttpStatus({ message: 'no status' })).toBeUndefined();
    expect(extractHttpStatus(null)).toBeUndefined();
    expect(extractHttpStatus('string')).toBeUndefined();
  });
});

describe('parseRetryAfterMs', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfterMs('60')).toBe(60_000);
    expect(parseRetryAfterMs('1.5')).toBe(1500);
  });
  it('parses HTTP-date', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThanOrEqual(28_000);
    expect(ms!).toBeLessThanOrEqual(31_000);
  });
  it('returns undefined for garbage', () => {
    expect(parseRetryAfterMs('not a date')).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});

describe('extractRetryAfter', () => {
  it('reads from response.headers', () => {
    expect(extractRetryAfter({ response: { headers: { 'retry-after': '45' } } })).toBe(45_000);
  });
  it('reads capitalized header', () => {
    expect(extractRetryAfter({ response: { headers: { 'Retry-After': '30' } } })).toBe(30_000);
  });
  it('reads top-level retryAfter', () => {
    expect(extractRetryAfter({ retryAfter: '15' })).toBe(15_000);
  });
});
