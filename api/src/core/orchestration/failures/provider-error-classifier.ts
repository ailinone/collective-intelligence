// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-E — Provider Error Classifier.
 *
 * Maps a raw provider response (HTTP status + sanitized body) into a
 * structured classification that callers (hub adapters, base-strategy,
 * cross-provider retry, operability hub) use to decide:
 *   - is this failure retryable?
 *   - is the route still healthy for the same provider?
 *   - is the provider still authenticated?
 *   - is the model compatible with the provider's route?
 *
 * The classifier is INTENTIONALLY conservative: when in doubt it
 * classifies as non-retryable, because the 01C.1B failure case showed
 * the opposite default (default-retry) silently spending money on
 * provider-side credit/auth issues that retries cannot fix.
 *
 * Rules (Section 7.2 / 7.3 of 01C.1B-E spec):
 *   - 400 model_not_supported     → retryable=false, modelRouteCompatible=false
 *   - 400 invalid_model           → retryable=false, modelRouteCompatible=false
 *   - 401 invalid auth            → retryable=false, providerHealthy=false
 *   - 402 payment_required        → retryable=false, providerHealthy=false (credit)
 *   - 403 insufficient_credits    → retryable=false, providerHealthy=false (credit)
 *   - 403 credit balance too low  → retryable=false, providerHealthy=false (credit)
 *   - 403 consumer_suspended      → retryable=false, providerHealthy=false (auth)
 *   - 403 permission_denied       → retryable=false, providerHealthy=false (auth)
 *   - 404 model_not_found         → retryable=false, modelRouteCompatible=false
 *   - 408 / 425 / 429 / 5xx       → retryable=true (subject to caller retry budget)
 *   - timeout / ECONNRESET / EAI  → retryable=true (subject to caller retry budget)
 *   - anything else               → retryable=false (conservative)
 *
 * Sanitized message NEVER contains API keys, prompts, full response
 * bodies, or stack traces — re-uses the existing `sanitizeErrorString`
 * helper from `provider-failure-code.ts`.
 */
import { sanitizeErrorString } from './provider-failure-code';

export type ProviderErrorKind =
  | 'model_not_supported'
  | 'insufficient_credits'
  | 'consumer_suspended'
  | 'invalid_auth'
  | 'rate_limited'
  | 'timeout'
  | 'network_error'
  | 'server_error'
  | 'bad_request'
  | 'unknown';

export interface ProviderErrorClassification {
  readonly kind: ProviderErrorKind;
  /** True only when the underlying condition could plausibly succeed on
   *  the SAME route with a retry. Caller still gates on its own retry
   *  budget (e.g., `maxRetriesPerProvider`) — this flag is necessary
   *  but not sufficient. */
  readonly retryable: boolean;
  /** True when the route is operationally healthy independent of this
   *  request (e.g., 429 rate-limit ≠ route broken). False when the
   *  failure means the route should be excluded from future plans
   *  until a positive signal arrives (insufficient_credits, suspended,
   *  invalid_auth, model_not_supported). */
  readonly routeHealthy: boolean;
  /** True when the provider AS A WHOLE is healthy. Distinguishes
   *  per-route failures from account-wide failures (suspended /
   *  exhausted credit). */
  readonly providerHealthy: boolean;
  /** True when the specific model is compatible with this provider's
   *  route. False for 400 model_not_supported / 404 model_not_found. */
  readonly modelRouteCompatible: boolean;
  /** Optional cooldown hint in milliseconds. Set on 429 with retry-after,
   *  otherwise undefined. */
  readonly cooldownMs?: number;
  /** Short machine-readable reason — never includes secrets. */
  readonly reason: string;
  /** Raw HTTP status if available. */
  readonly rawStatus?: number;
  /** Sanitized first ~200 chars of the body for diagnostics. */
  readonly sanitizedMessage?: string;
}

const CREDIT_PATTERNS = [
  // 01C.1B-G3 — quantifier `?` on trailing `s` catches BOTH:
  //   Replicate: "You have insufficient credit to run this model" (singular)
  //   AIML / OpenRouter: "insufficient credits" (plural)
  /insufficient[_\s-]credits?/i,
  /insufficient[_\s-]balance/i,
  /credit\s+balance\s+(too\s+low|is\s+too\s+low|exhausted|depleted)/i,
  /balance.*too\s+low/i,
  /payment\s+required/i,
  /upgrade.+to\s+continue/i,
  /top\s+up.+balance/i,
  /please\s+top\s+up/i,
  /err_?insufficent_?credits/i,
  // 01C.1B-F — broader patterns observed in AIML / OpenRouter / etc.
  /(ran|run|running)\s+out\s+of\s+credits?/i,
  /out\s+of\s+credits/i,
  /quota\s+exceeded/i,
  /credit.+exhausted/i,
  // 01C.1B-G3 — OpenAI / Anthropic / Google quota & billing patterns.
  // OpenAI 429 message: "You exceeded your current quota, please check your
  // plan and billing details." This is credit exhaustion masquerading as
  // rate-limit; the body pattern check (which runs BEFORE status-429) routes
  // it to insufficient_credits where it belongs.
  /exceeded\s+your\s+(current\s+)?quota/i,
  /check\s+your\s+plan\s+and\s+billing/i,
  /plan\s+and\s+billing\s+details/i,
  /insufficient\s+quota/i,
  /billing\s+quota\s+exceeded/i,
  // Matches: "not enough credits" / "does not have enough credits" /
  // "don't have enough credits" / "doesn't have enough credits".
  /(?:not|don'?t|doesn'?t|haven'?t)\s+(?:have\s+)?enough\s+credits?/i,
  /resource_exhausted/i,
  /\bquota\b.{0,30}(plan|billing|upgrade)/i,
];
const SUSPENDED_PATTERNS = [
  /consumer.+(has\s+been\s+)?suspended/i,
  /account.+(has\s+been\s+)?suspended/i,
  /account.+disabled/i,
  /consumer_suspended/i,
];
const AUTH_PATTERNS = [
  /invalid\s+(api\s+)?key/i,
  /incorrect\s+api\s+key/i,
  /unauthorized/i,
  /authentication\s+failed/i,
  /invalid\s+username\s+or\s+password/i,
];
const MODEL_UNSUPPORTED_PATTERNS = [
  /model.+(not\s+supported|not\s+available|unknown|not\s+found)/i,
  /model_not_supported/i,
  /no\s+provider\s+(supports|configured)/i,
  /provider.+not\s+configured/i,
];
const NETWORK_PATTERNS = [
  /econnreset/i,
  /etimedout/i,
  /eai_again/i,
  /enotfound/i,
  /socket\s+hang\s+up/i,
  /network\s+error/i,
  /fetch\s+failed/i,
];
const TIMEOUT_PATTERNS = [
  /^timeout$/i,
  /request\s+timeout/i,
  /timed\s+out/i,
  /\babort/i,
];

function bodyMatches(patterns: readonly RegExp[], body: string): boolean {
  for (const p of patterns) if (p.test(body)) return true;
  return false;
}

export interface ClassifyInput {
  /** HTTP status code, when applicable. */
  readonly status?: number;
  /** Raw response body string (will be sanitized internally). May be
   *  the error message from a thrown Error.message. */
  readonly body?: string;
  /** Optional retry-after header in ms (already parsed). */
  readonly retryAfterMs?: number;
}

export function classifyProviderError(input: ClassifyInput): ProviderErrorClassification {
  const status = input.status;
  const rawBody = typeof input.body === 'string' ? input.body : '';
  const sanitized = sanitizeErrorString(rawBody);
  const bodyLower = rawBody.toLowerCase();

  // Order matters: most-specific signals first. Body-pattern checks run
  // regardless of status because providers don't agree on which status
  // to return for the same condition (Anthropic returns 400 for credit
  // exhausted; AIML returns 403; DeepInfra returns 403 with "not
  // authenticated" message that's actually credit).

  // 1) Credit / payment issues → non-retryable
  if (
    bodyMatches(CREDIT_PATTERNS, bodyLower) ||
    status === 402
  ) {
    return {
      kind: 'insufficient_credits',
      retryable: false,
      routeHealthy: false,
      providerHealthy: false,
      modelRouteCompatible: true,
      reason: 'insufficient_credits',
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }

  // 2) Account-level suspension
  if (bodyMatches(SUSPENDED_PATTERNS, bodyLower)) {
    return {
      kind: 'consumer_suspended',
      retryable: false,
      routeHealthy: false,
      providerHealthy: false,
      modelRouteCompatible: true,
      reason: 'consumer_suspended',
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }

  // 3) Auth failure (key invalid, unauthorized) — 401 OR body says so
  if (
    status === 401 ||
    bodyMatches(AUTH_PATTERNS, bodyLower)
  ) {
    return {
      kind: 'invalid_auth',
      retryable: false,
      routeHealthy: false,
      providerHealthy: false,
      modelRouteCompatible: true,
      reason: 'invalid_auth',
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }

  // 4) Model / route compatibility — 400 model_not_supported, 404 model_not_found
  if (
    status === 404 ||
    bodyMatches(MODEL_UNSUPPORTED_PATTERNS, bodyLower)
  ) {
    return {
      kind: 'model_not_supported',
      retryable: false,
      routeHealthy: true,        // provider may be fine, just not this model
      providerHealthy: true,
      modelRouteCompatible: false,
      reason: 'model_not_supported',
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }

  // 5) Permission denied — non-retryable, account-level
  if (status === 403) {
    return {
      kind: 'invalid_auth',
      retryable: false,
      routeHealthy: false,
      providerHealthy: false,
      modelRouteCompatible: true,
      reason: 'permission_denied',
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }

  // 6) Rate limited — retryable subject to caller budget
  if (status === 429 || status === 425) {
    return {
      kind: 'rate_limited',
      retryable: true,
      routeHealthy: true,
      providerHealthy: true,
      modelRouteCompatible: true,
      cooldownMs: input.retryAfterMs,
      reason: 'rate_limited',
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }

  // 7) Timeout/Network — retryable subject to caller budget. We treat
  //    timeouts as RETRYABLE because the next attempt on the same route
  //    may succeed if the transient slowdown clears. (Caller's
  //    maxRetriesPerProvider=0 still prevents the retry.)
  if (status === 408 || bodyMatches(TIMEOUT_PATTERNS, bodyLower)) {
    return {
      kind: 'timeout',
      retryable: true,
      routeHealthy: true,
      providerHealthy: true,
      modelRouteCompatible: true,
      reason: 'timeout',
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }
  if (bodyMatches(NETWORK_PATTERNS, bodyLower)) {
    return {
      kind: 'network_error',
      retryable: true,
      routeHealthy: true,
      providerHealthy: true,
      modelRouteCompatible: true,
      reason: 'network_error',
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }

  // 8) Server error (5xx) — retryable
  if (typeof status === 'number' && status >= 500) {
    return {
      kind: 'server_error',
      retryable: true,
      routeHealthy: true,
      providerHealthy: true,
      modelRouteCompatible: true,
      reason: `server_error_${status}`,
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }

  // 8b) 424 Failed Dependency — meta-aggregator gateways (Concentrate AI
  //     documents this explicitly) use it when THEIR upstream vendor failed,
  //     not when our request was malformed. Semantically it belongs with the
  //     5xx family: transient, the aggregator may route the retry to a
  //     different upstream. Without this rule it fell through to the generic
  //     4xx branch below and was misclassified as a non-retryable
  //     bad_request.
  if (status === 424) {
    return {
      kind: 'server_error',
      retryable: true,
      routeHealthy: true,
      providerHealthy: true,
      modelRouteCompatible: true,
      reason: 'upstream_provider_error_424',
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }

  // 9) Generic 4xx other than the specific cases above → bad request,
  //    non-retryable (e.g., schema validation, missing required field).
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return {
      kind: 'bad_request',
      retryable: false,
      routeHealthy: true,
      providerHealthy: true,
      modelRouteCompatible: true,
      reason: `bad_request_${status}`,
      rawStatus: status,
      sanitizedMessage: sanitized,
    };
  }

  // 10) Anything else (no status, unknown body) — conservative
  return {
    kind: 'unknown',
    retryable: false,
    routeHealthy: false,
    providerHealthy: false,
    modelRouteCompatible: true,
    reason: 'unknown',
    rawStatus: status,
    sanitizedMessage: sanitized,
  };
}
