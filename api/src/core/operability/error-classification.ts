// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Provider error classification — single source of truth for "what kind of
 * failure is this and what should we do about it".
 *
 * The function is deliberately pure (no I/O, no globals) so it can be unit
 * tested exhaustively and called both at probe time (discovery) and at runtime
 * (post-execution failure handling).
 *
 * Anti-patterns this prevents:
 *   - 401 from one model removing the entire provider (correct scope: account)
 *   - `model not found` removing all models for a provider (correct scope:
 *     provider_model — only the (providerId, modelId) tuple is affected)
 *   - context_exceeded marking provider as unhealthy (correct scope: request)
 *   - 429 without Retry-After defaulting to a long cooldown
 */

import {
  type ProviderErrorClassification,
  type ProviderErrorClass,
  DEFAULT_COOLDOWNS,
} from './types';

// ─── Pattern matchers ──────────────────────────────────────────────────────

/**
 * Tries to extract a numeric HTTP status from arbitrary error shapes.
 * We see at least 4 patterns from the various adapters:
 *   - `{ status: 401 }`
 *   - `{ statusCode: 401 }`
 *   - `{ response: { status: 401 } }`
 *   - error message containing "HTTP 401" or "status 401"
 */
export function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;

  const e = err as Record<string, unknown>;

  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;

  const response = e.response;
  if (typeof response === 'object' && response !== null) {
    const r = response as Record<string, unknown>;
    if (typeof r.status === 'number') return r.status;
    if (typeof r.statusCode === 'number') return r.statusCode;
  }

  const message = typeof e.message === 'string' ? e.message : '';
  const httpMatch = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (httpMatch) return parseInt(httpMatch[1], 10);

  const statusMatch = message.match(/\bstatus\s+(\d{3})\b/i);
  if (statusMatch) return parseInt(statusMatch[1], 10);

  return undefined;
}

/**
 * Extracts the error message string from arbitrary error shapes.
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    const nested = e.error;
    if (typeof nested === 'object' && nested !== null) {
      const n = nested as Record<string, unknown>;
      if (typeof n.message === 'string') return n.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Parses a `Retry-After` value into milliseconds.
 * The header may carry seconds (`"60"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 */
export function parseRetryAfterMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim();
  if (!str) return undefined;

  // Numeric (seconds)
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const seconds = Number(str);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }

  // HTTP-date
  const date = Date.parse(str);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}

/**
 * Extracts Retry-After from common error shapes (object header bag,
 * fetch Response, or message hint).
 */
export function extractRetryAfter(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;

  // Direct
  const direct = parseRetryAfterMs(e.retryAfter);
  if (direct !== undefined) return direct;

  // Headers object on response
  const response = e.response;
  if (typeof response === 'object' && response !== null) {
    const r = response as Record<string, unknown>;
    const headers = r.headers;
    if (typeof headers === 'object' && headers !== null) {
      const h = headers as Record<string, unknown>;
      const ra = h['retry-after'] ?? h['Retry-After'];
      const parsed = parseRetryAfterMs(ra);
      if (parsed !== undefined) return parsed;
    }
  }

  return undefined;
}

// ─── Per-class detectors ──────────────────────────────────────────────────

const AUTH_KEYWORDS = [
  'unauthorized',
  'invalid api key',
  'invalid_api_key',
  'incorrect api key',
  'authentication',
  'authentication_error',
  'forbidden',
  'access denied',
  'invalid token',
  'expired token',
  'invalid bearer',
];

const CREDIT_KEYWORDS = [
  'insufficient',
  'insufficient_quota',
  'no credit',
  'no credits',
  'out of credit',
  'credit balance',
  'credit_balance',
  'billing',
  'payment required',
  'payment_required',
  'add credit',
  'add credits',
  'top up',
  'top-up',
  'subscription expired',
  'plan expired',
  'account balance',
  'low balance',
];

const QUOTA_KEYWORDS = [
  'quota',
  'usage limit',
  'usage_limit',
  'monthly limit',
  'daily limit',
  'spending limit',
];

const RATE_LIMIT_KEYWORDS = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'throttled',
  'throttling',
  'overloaded',
];

const MODEL_NOT_FOUND_KEYWORDS = [
  'model not found',
  'model_not_found',
  'unknown model',
  'invalid model',
  'no such model',
  'model is not supported',
  'is not supported by any provider',
];

/**
 * Regex patterns for "model X not found" where X is the model id, e.g.:
 *   "Model 'gpt-4o-mini' not found"
 *   "model `claude-3` does not exist"
 *   "deployment 'foo' not found"
 *   "The model `bar` is not available"
 */
const MODEL_NOT_FOUND_REGEX = [
  /\bmodel\b[^.]*?\bnot\s+found\b/i,
  /\bmodel\b[^.]*?\bdoes\s+not\s+exist\b/i,
  /\bmodel\b[^.]*?\bnot\s+available\b/i,
  /\bdeployment\b[^.]*?\bnot\s+found\b/i,
  /\bmodel_not_found\b/i,
];

const ENDPOINT_NOT_FOUND_KEYWORDS = [
  'endpoint not found',
  'route not found',
  'no such endpoint',
  'unknown endpoint',
];

const TIMEOUT_KEYWORDS = [
  'etimedout',
  'eai_again',
  'enotfound',
  'econnreset',
  'econnrefused',
  'epipe',
  'socket hang up',
  'request timeout',
  'request timed out',
  'fetch timeout',
  'timeout exceeded',
  'aborted due to timeout',
  'fetch failed', // undici default error message — DNS/TCP/TLS issues
];

const CONTEXT_EXCEEDED_KEYWORDS = [
  'context length',
  'context_length',
  'context window',
  'maximum context',
  'too long',
  'context_length_exceeded',
  'reduce the length',
  'maximum tokens',
  'tokens_exceed',
  'input is too long',
];

const UNSUPPORTED_CAPABILITY_KEYWORDS = [
  'unsupported capability',
  'capability not supported',
  'streaming not supported',
  'tools not supported',
  'json mode not supported',
  'modality not supported',
];

const STREAMING_BROKEN_KEYWORDS = [
  'stream',
  'streaming',
  'chunk',
  'sse',
];

// HTTP 200 OK but no usable assistant text. Unfunded gateways frequently
// 200-OK an empty body ("Provider returned empty assistant response").
const EMPTY_RESPONSE_KEYWORDS = [
  'empty assistant response',
  'empty response',
  'no content returned',
  'no usable content',
  'blank response',
];

function lower(value: string): string {
  return value.toLowerCase();
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) return true;
  }
  return false;
}

// ─── Factory helpers ───────────────────────────────────────────────────────

function classification(
  errorClass: ProviderErrorClass,
  partial: Partial<ProviderErrorClassification> & {
    scope: ProviderErrorClassification['scope'];
    retryability: ProviderErrorClassification['retryability'];
    healthState: ProviderErrorClassification['healthState'];
    shouldRemoveFromCandidatePool: boolean;
    shouldSkipNearZero: boolean;
  },
  defaultsContext?: { retryAfterMs?: number; httpStatus?: number; message?: string },
): ProviderErrorClassification {
  const cooldown = partial.cooldownMs
    ?? defaultsContext?.retryAfterMs
    ?? DEFAULT_COOLDOWNS[errorClass];
  return {
    errorClass,
    cooldownMs: cooldown,
    httpStatus: defaultsContext?.httpStatus,
    retryAfterMs: defaultsContext?.retryAfterMs,
    message: defaultsContext?.message,
    ...partial,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Classifies an arbitrary error from a provider call into a
 * `ProviderErrorClassification`. Pure function, no I/O.
 *
 * Order of checks matters: more specific patterns first. For example,
 * a 402 with the word "credit" in the body should be `insufficient_credit`,
 * not `auth_failed`, even though some providers return 401 for billing
 * issues — the keyword takes precedence over the status code.
 */
export function classifyProviderError(error: unknown): ProviderErrorClassification {
  const message = extractErrorMessage(error);
  const messageLower = lower(message);
  const httpStatus = extractHttpStatus(error);
  const retryAfterMs = extractRetryAfter(error);
  const truncatedMessage = message.length > 500 ? message.slice(0, 500) + '…' : message;
  const ctx = { retryAfterMs, httpStatus, message: truncatedMessage };

  // ─── Explicit credit/billing ─────────────────────────────────────────
  if (containsAny(messageLower, CREDIT_KEYWORDS)) {
    return classification(
      'insufficient_credit',
      {
        scope: 'account',
        retryability: 'non_retryable',
        healthState: 'insufficient_credit',
        shouldRemoveFromCandidatePool: true,
        shouldSkipNearZero: true,
      },
      ctx,
    );
  }

  // ─── 402 Payment Required ────────────────────────────────────────────
  if (httpStatus === 402) {
    return classification(
      'insufficient_credit',
      {
        scope: 'account',
        retryability: 'non_retryable',
        healthState: 'insufficient_credit',
        shouldRemoveFromCandidatePool: true,
        shouldSkipNearZero: true,
      },
      ctx,
    );
  }

  // ─── Quota (separate from rate-limit: quota is usage cap, rate is QPS) ─
  if (containsAny(messageLower, QUOTA_KEYWORDS) && !containsAny(messageLower, RATE_LIMIT_KEYWORDS)) {
    return classification(
      'quota_exceeded',
      {
        scope: 'account',
        retryability: retryAfterMs !== undefined ? 'retryable_after_cooldown' : 'non_retryable',
        healthState: 'rate_limited',
        shouldRemoveFromCandidatePool: false,
        shouldSkipNearZero: true,
      },
      ctx,
    );
  }

  // ─── 429 Too Many Requests ───────────────────────────────────────────
  if (httpStatus === 429 || containsAny(messageLower, RATE_LIMIT_KEYWORDS)) {
    return classification(
      'rate_limited',
      {
        scope: 'provider',
        retryability: 'retryable_after_cooldown',
        healthState: 'rate_limited',
        shouldRemoveFromCandidatePool: false,
        shouldSkipNearZero: true,
      },
      ctx,
    );
  }

  // ─── 401/403 (after credit/quota checks above) ───────────────────────
  if (httpStatus === 401 || httpStatus === 403 || containsAny(messageLower, AUTH_KEYWORDS)) {
    return classification(
      'auth_failed',
      {
        scope: 'account',
        retryability: 'non_retryable',
        healthState: 'auth_failed',
        shouldRemoveFromCandidatePool: true,
        shouldSkipNearZero: true,
      },
      ctx,
    );
  }

  // ─── Model not found (4xx with model keywords) ───────────────────────
  // Important: scope is provider_model, NOT provider — only this tuple is
  // poisoned, the provider continues serving other models.
  // Two-stage match: cheap substring keywords first, then regex for
  // patterns like "Model 'X' not found" where the model id is interpolated.
  const matchesModelNotFound =
    containsAny(messageLower, MODEL_NOT_FOUND_KEYWORDS) ||
    MODEL_NOT_FOUND_REGEX.some((rx) => rx.test(messageLower)) ||
    (httpStatus === 404 && (messageLower.includes('model') || messageLower.includes('deployment')));
  if (matchesModelNotFound) {
    return classification(
      'model_not_found',
      {
        scope: 'provider_model',
        retryability: 'non_retryable',
        healthState: 'model_not_found',
        shouldRemoveFromCandidatePool: true,
        shouldSkipNearZero: true,
      },
      ctx,
    );
  }

  // ─── Generic 404 Endpoint not found ──────────────────────────────────
  if (httpStatus === 404 || containsAny(messageLower, ENDPOINT_NOT_FOUND_KEYWORDS)) {
    return classification(
      'endpoint_not_found',
      {
        scope: 'endpoint',
        retryability: 'non_retryable',
        healthState: 'endpoint_not_found',
        shouldRemoveFromCandidatePool: true,
        shouldSkipNearZero: true,
      },
      ctx,
    );
  }

  // ─── Context exceeded (request-scoped, NOT provider-scoped) ──────────
  if (
    containsAny(messageLower, CONTEXT_EXCEEDED_KEYWORDS) ||
    httpStatus === 413
  ) {
    return classification(
      'context_exceeded',
      {
        scope: 'request',
        retryability: 'never_retry_same_request',
        cooldownMs: 0,
        healthState: 'healthy',
        shouldRemoveFromCandidatePool: false,
        shouldSkipNearZero: false,
      },
      ctx,
    );
  }

  // ─── Unsupported capability ─────────────────────────────────────────
  if (containsAny(messageLower, UNSUPPORTED_CAPABILITY_KEYWORDS)) {
    return classification(
      'unsupported_capability',
      {
        scope: 'provider_model',
        retryability: 'non_retryable',
        healthState: 'healthy',
        shouldRemoveFromCandidatePool: true,
        shouldSkipNearZero: true,
      },
      ctx,
    );
  }

  // ─── Timeout / network failure ──────────────────────────────────────
  // Note: provider_timeout is treated as transient — penalize but allow
  // recovery on next probe cycle. Network errors (EAI_AGAIN, ENOTFOUND)
  // also fall here; they often clear within seconds in containerized envs.
  if (containsAny(messageLower, TIMEOUT_KEYWORDS)) {
    return classification(
      'provider_timeout',
      {
        scope: 'provider',
        retryability: 'retryable_after_cooldown',
        healthState: 'timeout_suspected',
        shouldRemoveFromCandidatePool: false,
        shouldSkipNearZero: false,
      },
      ctx,
    );
  }

  // ─── 5xx ─────────────────────────────────────────────────────────────
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus < 600) {
    return classification(
      'provider_5xx',
      {
        scope: 'provider',
        retryability: 'retryable_after_cooldown',
        healthState: 'degraded',
        shouldRemoveFromCandidatePool: false,
        shouldSkipNearZero: false,
      },
      ctx,
    );
  }

  // ─── 400 Invalid request ────────────────────────────────────────────
  if (httpStatus === 400) {
    return classification(
      'invalid_request',
      {
        scope: 'request',
        retryability: 'never_retry_same_request',
        cooldownMs: 0,
        healthState: 'healthy',
        shouldRemoveFromCandidatePool: false,
        shouldSkipNearZero: false,
      },
      ctx,
    );
  }

  // ─── Streaming-specific failures ────────────────────────────────────
  // Conservative match: only when message has BOTH a streaming keyword and
  // an error indicator (SSE parse error, chunk decoding failure).
  if (
    containsAny(messageLower, STREAMING_BROKEN_KEYWORDS) &&
    (messageLower.includes('parse') || messageLower.includes('decode') || messageLower.includes('malformed'))
  ) {
    return classification(
      'streaming_broken',
      {
        scope: 'provider',
        retryability: 'retryable_after_cooldown',
        healthState: 'degraded',
        shouldRemoveFromCandidatePool: false,
        shouldSkipNearZero: false,
      },
      ctx,
    );
  }

  // ─── Malformed response (parse error without streaming context) ─────
  if (messageLower.includes('json') && (messageLower.includes('parse') || messageLower.includes('unexpected'))) {
    return classification(
      'malformed_response',
      {
        scope: 'provider',
        retryability: 'retryable_after_cooldown',
        healthState: 'degraded',
        shouldRemoveFromCandidatePool: false,
        shouldSkipNearZero: false,
      },
      ctx,
    );
  }

  // ─── Adapter-internal errors (TypeError, ReferenceError, etc.) ──────
  if (error instanceof TypeError || error instanceof ReferenceError) {
    return classification(
      'adapter_error',
      {
        scope: 'provider',
        retryability: 'retryable_after_cooldown',
        healthState: 'degraded',
        shouldRemoveFromCandidatePool: false,
        shouldSkipNearZero: false,
      },
      ctx,
    );
  }

  // ─── Empty / blank assistant response (HTTP 200, no usable text) ──────
  // Unfunded gateways frequently 200-OK an empty body. Treat as a
  // provider_model degradation + skip so the gateway is dropped from the
  // candidate pool and skipped on the next pick — previously this fell
  // through to unknown_error (shouldSkipNearZero:false), so empty-returning
  // gateways were never deprioritized and got re-selected every request.
  if (containsAny(messageLower, EMPTY_RESPONSE_KEYWORDS)) {
    return classification(
      'unknown_error',
      {
        scope: 'provider_model',
        retryability: 'retryable_after_cooldown',
        healthState: 'degraded',
        shouldRemoveFromCandidatePool: true,
        shouldSkipNearZero: true,
      },
      ctx,
    );
  }

  // ─── Fall-through ────────────────────────────────────────────────────
  return classification(
    'unknown_error',
    {
      scope: 'provider',
      retryability: 'retryable_after_cooldown',
      healthState: 'degraded',
      shouldRemoveFromCandidatePool: false,
      shouldSkipNearZero: false,
    },
    ctx,
  );
}
