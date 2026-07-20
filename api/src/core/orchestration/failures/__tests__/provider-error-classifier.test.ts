// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-E — ProviderErrorClassifier coverage.
 *
 * The classifier is consumed by the hub adapter retry loop AND by the
 * cross-provider rescue gate in BaseStrategy. These tests pin the
 * body-pattern + status-code combinations observed during the 01C.1B
 * billable probe, so a regression that re-introduces "retry on credit
 * exhaustion" or "retry on consumer suspended" fails fast.
 */
import { describe, it, expect } from 'vitest';
import { classifyProviderError } from '../provider-error-classifier';

describe('classifyProviderError — non-retryable provider conditions', () => {
  it('AIML 403 "insufficient credits" → insufficient_credits, not retryable, provider unhealthy', () => {
    const c = classifyProviderError({
      status: 403,
      body: '{"title":"Forbidden","status":403,"message":"You\'ve run out of credits. Please top up","error":{"data":{"kind":"err_insufficent_credits"}}}',
    });
    expect(c.kind).toBe('insufficient_credits');
    expect(c.retryable).toBe(false);
    expect(c.providerHealthy).toBe(false);
    expect(c.routeHealthy).toBe(false);
    expect(c.modelRouteCompatible).toBe(true);
  });

  it('Anthropic 400 "credit balance too low" → insufficient_credits despite 400 status', () => {
    const c = classifyProviderError({
      status: 400,
      body: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
    });
    expect(c.kind).toBe('insufficient_credits');
    expect(c.retryable).toBe(false);
    expect(c.providerHealthy).toBe(false);
  });

  it('Gemini 403 "Consumer has been suspended" → consumer_suspended, not retryable', () => {
    const c = classifyProviderError({
      status: 403,
      body: '{"error":{"code":403,"message":"Permission denied: Consumer has been suspended.","reason":"CONSUMER_SUSPENDED"}}',
    });
    expect(c.kind).toBe('consumer_suspended');
    expect(c.retryable).toBe(false);
    expect(c.providerHealthy).toBe(false);
  });

  it('HuggingFace 400 "model_not_supported" → model_not_supported, route healthy', () => {
    const c = classifyProviderError({
      status: 400,
      body: '{"error":{"message":"The requested model is not supported by any provider you have enabled.","code":"model_not_supported"}}',
    });
    expect(c.kind).toBe('model_not_supported');
    expect(c.retryable).toBe(false);
    expect(c.routeHealthy).toBe(true);          // provider OK
    expect(c.providerHealthy).toBe(true);
    expect(c.modelRouteCompatible).toBe(false); // this specific model isn't supported
  });

  it('401 "Invalid username or password" → invalid_auth, not retryable', () => {
    const c = classifyProviderError({
      status: 401,
      body: '{"error":"Invalid username or password."}',
    });
    expect(c.kind).toBe('invalid_auth');
    expect(c.retryable).toBe(false);
    expect(c.providerHealthy).toBe(false);
  });

  it('402 payment_required → insufficient_credits even with empty body', () => {
    const c = classifyProviderError({ status: 402, body: '' });
    expect(c.kind).toBe('insufficient_credits');
    expect(c.retryable).toBe(false);
  });

  it('404 → model_not_supported (route healthy)', () => {
    const c = classifyProviderError({
      status: 404,
      body: '{"error":{"message":"model not found"}}',
    });
    expect(c.kind).toBe('model_not_supported');
    expect(c.retryable).toBe(false);
    expect(c.routeHealthy).toBe(true);
  });
});

describe('classifyProviderError — 01C.1B-G3 quota / billing patterns', () => {
  it('OpenAI 429 "You exceeded your current quota" → insufficient_credits, not retryable', () => {
    const c = classifyProviderError({
      status: 429,
      body: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.',
    });
    expect(c.kind).toBe('insufficient_credits');
    expect(c.retryable).toBe(false);
    expect(c.providerHealthy).toBe(false);
    expect(c.routeHealthy).toBe(false);
  });

  it('OpenAI message starting with raw "429 …" + quota body → insufficient_credits', () => {
    // Audit script extracts status from the leading number now; even if it
    // didn't, body alone must route to insufficient_credits.
    const c = classifyProviderError({
      status: undefined,
      body: '429 You exceeded your current quota, please check your plan and billing details.',
    });
    expect(c.kind).toBe('insufficient_credits');
    expect(c.retryable).toBe(false);
  });

  it('OpenAI bare "exceeded your quota" without "current" → insufficient_credits', () => {
    const c = classifyProviderError({
      status: 429,
      body: 'You have exceeded your quota for this period. Please upgrade your plan.',
    });
    expect(c.kind).toBe('insufficient_credits');
  });

  it('Anthropic / Google "check your plan and billing details" alone → insufficient_credits', () => {
    const c = classifyProviderError({
      status: 400,
      body: 'Request rejected: check your plan and billing details to continue.',
    });
    expect(c.kind).toBe('insufficient_credits');
  });

  it('"insufficient quota" (Google AI Studio variant) → insufficient_credits', () => {
    const c = classifyProviderError({
      status: 429,
      body: '{"error":{"code":429,"message":"insufficient quota for project","status":"RESOURCE_EXHAUSTED"}}',
    });
    expect(c.kind).toBe('insufficient_credits');
  });

  it('"RESOURCE_EXHAUSTED" status (gRPC translation) → insufficient_credits', () => {
    const c = classifyProviderError({
      status: 429,
      body: 'Status: RESOURCE_EXHAUSTED. Please upgrade your tier.',
    });
    expect(c.kind).toBe('insufficient_credits');
  });

  it('"not enough credits" → insufficient_credits', () => {
    const c = classifyProviderError({
      status: 403,
      body: 'Account does not have enough credits to perform this request.',
    });
    expect(c.kind).toBe('insufficient_credits');
  });

  it('plain "rate limited" body (no quota/billing words) STAYS rate_limited at 429', () => {
    // Regression guard: the new patterns must NOT capture vanilla rate-limit
    // messages — those are still retryable transient signals.
    const c = classifyProviderError({
      status: 429,
      body: 'Too many requests. Please slow down.',
    });
    expect(c.kind).toBe('rate_limited');
    expect(c.retryable).toBe(true);
  });

  it('"billing quota exceeded" → insufficient_credits, not generic rate_limited', () => {
    const c = classifyProviderError({
      status: 429,
      body: 'Billing quota exceeded for your tier.',
    });
    expect(c.kind).toBe('insufficient_credits');
  });

  it('quota body does NOT escalate to invalid_auth', () => {
    // Negative test: quota must never be mis-classified as auth (a common
    // operator confusion that would trigger key-rotation churn).
    const c = classifyProviderError({
      status: 429,
      body: 'You exceeded your current quota, please check your plan and billing details.',
    });
    expect(c.kind).not.toBe('invalid_auth');
  });

  it('quota body does NOT fall through to unknown', () => {
    // Negative test: regression guard for the G2 finding where openai
    // ended up in V_unknown_unclassified.
    const c = classifyProviderError({
      status: undefined,
      body: 'exceeded your current quota; please check your plan and billing details',
    });
    expect(c.kind).not.toBe('unknown');
    expect(c.kind).toBe('insufficient_credits');
  });

  it('Replicate 402 "insufficient credit" (SINGULAR) → insufficient_credits', () => {
    // Regression guard: G2 audit showed replicate fell to errorKind=unknown
    // because /insufficient[_\s-]credits/i required plural form.
    const c = classifyProviderError({
      status: 402,
      body: '{"title":"Insufficient credit","detail":"You have insufficient credit to run this model. Go to https://replicate.com/account/billing"}',
    });
    expect(c.kind).toBe('insufficient_credits');
    expect(c.retryable).toBe(false);
  });

  it('"insufficient credit" inline (singular, no leading slash) → insufficient_credits', () => {
    const c = classifyProviderError({
      status: undefined,
      body: 'Error: insufficient credit on your account',
    });
    expect(c.kind).toBe('insufficient_credits');
  });
});

describe('classifyProviderError — retryable conditions (caller still budgets)', () => {
  it('429 rate_limit → retryable', () => {
    const c = classifyProviderError({ status: 429, body: 'rate limited' });
    expect(c.kind).toBe('rate_limited');
    expect(c.retryable).toBe(true);
  });

  it('504 → server_error, retryable (HF router observed during probe)', () => {
    const c = classifyProviderError({ status: 504, body: 'gateway timeout' });
    expect(c.kind).toBe('server_error');
    expect(c.retryable).toBe(true);
  });

  it('500 → server_error, retryable', () => {
    const c = classifyProviderError({ status: 500, body: 'internal' });
    expect(c.kind).toBe('server_error');
    expect(c.retryable).toBe(true);
  });

  it('408 → timeout, retryable', () => {
    const c = classifyProviderError({ status: 408, body: 'request timeout' });
    expect(c.kind).toBe('timeout');
    expect(c.retryable).toBe(true);
  });

  it('EAI_AGAIN message → network_error, retryable', () => {
    const c = classifyProviderError({
      status: undefined,
      body: 'fetch failed | cause: EAI_AGAIN',
    });
    expect(c.kind).toBe('network_error');
    expect(c.retryable).toBe(true);
  });

  it('424 (Concentrate AI upstream-provider failure) → server_error, retryable, route stays healthy', () => {
    // Concentrate's documented shape: {error, message, model} with 424 when
    // the upstream vendor behind the aggregator failed — NOT a bad request.
    const c = classifyProviderError({
      status: 424,
      body: '{"error":"upstream_error","message":"provider failed to respond","model":"gpt-4o-mini"}',
    });
    expect(c.kind).toBe('server_error');
    expect(c.retryable).toBe(true);
    expect(c.routeHealthy).toBe(true);
    expect(c.providerHealthy).toBe(true);
    expect(c.reason).toBe('upstream_provider_error_424');
  });

  it('424 with a credit-pattern body still routes to insufficient_credits (body wins over status)', () => {
    const c = classifyProviderError({
      status: 424,
      body: 'upstream rejected: insufficient credits on downstream account',
    });
    expect(c.kind).toBe('insufficient_credits');
    expect(c.retryable).toBe(false);
  });
});

describe('classifyProviderError — sanitization', () => {
  it('strips Bearer tokens from sanitizedMessage', () => {
    const c = classifyProviderError({
      status: 401,
      body: 'Authorization failed for Bearer sk-abcdef-very-secret-token',
    });
    expect(c.sanitizedMessage).toBeDefined();
    expect(c.sanitizedMessage!).not.toContain('sk-abcdef');
    expect(c.sanitizedMessage!).toContain('[redacted]');
  });

  it('strips api_key=… from sanitizedMessage', () => {
    const c = classifyProviderError({
      status: 401,
      body: 'Bad request: api_key=very-secret-12345',
    });
    expect(c.sanitizedMessage!).not.toContain('very-secret-12345');
  });
});
