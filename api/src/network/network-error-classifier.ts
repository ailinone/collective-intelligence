// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Network vs provider error classifier.
 *
 * Why this exists: `fetch failed` from a DNS outage looks identical to
 * `fetch failed` from a 401 wrapped by a buggy adapter. Before this
 * module, all such errors were lumped into `failure_mode: api-error`,
 * making operator debugging painful. We need to know whether to blame
 * the local container's network or the upstream provider.
 *
 * Categories (specific → permissive):
 *   - network_dns_error      ENOTFOUND / EAI_AGAIN / TCP DNS NXDOMAIN
 *   - network_connect_error  ECONNREFUSED / ETIMEDOUT (TCP-level)
 *   - network_tls_error      CERT_HAS_EXPIRED / DEPTH_ZERO_SELF_SIGNED_CERT / UNABLE_TO_VERIFY_LEAF_SIGNATURE
 *   - provider_auth_error    HTTP 401 / 403 (without quota signal)
 *   - provider_quota_error   HTTP 402 / 429-with-billing / payment-required / insufficient credit
 *   - provider_model_error   HTTP 404 + body matches "model not found" / "unknown model"
 *   - provider_http_error    HTTP 4xx/5xx not matched above
 *   - unknown                anything else
 */

export type NetworkErrorClass =
  | 'network_dns_error'
  | 'network_connect_error'
  | 'network_tls_error'
  | 'provider_auth_error'
  | 'provider_quota_error'
  | 'provider_model_error'
  | 'provider_http_error'
  | 'provider_config_error'
  | 'unknown';

export interface ClassifiedError {
  category: NetworkErrorClass;
  reason: string;
  isLocalInfra: boolean;
  isRetryable: boolean;
}

interface ClassifierInput {
  /** Node error code (e.g. ENOTFOUND, ECONNREFUSED). Pull from err.code. */
  code?: string;
  /** HTTP status if the request reached the wire. */
  httpStatus?: number;
  /** Error message text (used for fallback string matching). */
  message?: string;
  /** Optional response body (lower-case, truncated) for model-not-found etc. */
  body?: string;
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL']);
const CONNECT_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ETIMEOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
]);

function matches(msg: string | undefined, patterns: string[]): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return patterns.some((p) => m.includes(p));
}

export function classifyNetworkError(input: ClassifierInput): ClassifiedError {
  const code = input.code ?? '';
  const status = input.httpStatus;
  const msg = input.message?.toLowerCase();
  const body = input.body?.toLowerCase();

  // 1. Network-layer code is the strongest signal.
  if (DNS_CODES.has(code)) {
    return { category: 'network_dns_error', reason: `dns_${code}`, isLocalInfra: true, isRetryable: true };
  }
  if (CONNECT_CODES.has(code)) {
    return { category: 'network_connect_error', reason: `connect_${code}`, isLocalInfra: true, isRetryable: true };
  }
  if (TLS_CODES.has(code)) {
    return { category: 'network_tls_error', reason: `tls_${code}`, isLocalInfra: true, isRetryable: false };
  }

  // 1.5a Provider config errors — LOCAL infra / env / SDK auth setup.
  // Distinct from quota: config means we never had a chance to talk to
  // the provider, quota means the provider rejected because of our
  // billing state. Operators fix these very differently.
  if (matches(msg, [
    'gcloud', 'application-default-print-access-token',
    'adc not found', 'application default credentials',
    'api key missing', 'api key not configured', 'apikey is required',
    'apikey is empty', 'no api key', 'authentication credentials not found',
    'no credentials configured',
  ])) {
    return { category: 'provider_config_error', reason: 'config_msg_match', isLocalInfra: true, isRetryable: false };
  }
  // 1.5b Provider quota errors detectable from message text alone.
  // Common patterns from the orchestrator that don't carry HTTP status
  // by the time the error reaches the runner.
  if (matches(msg, [
    'insufficient_credit', 'insufficient credit',
    'all_providers_no_credits', 'credit balance is too low',
    'billing balance', 'payment required',
    'insufficient_balance', 'insufficient balance',
    'insufficient_quota', 'quota exceeded',
    'insufficient ai credit', 'requiredbalance', 'availablebalance',
    'top up your balance', 'add more credits',
  ])) {
    return { category: 'provider_quota_error', reason: 'quota_msg_match', isLocalInfra: false, isRetryable: false };
  }
  // 1.5b2 Provider auth errors from message text alone — many orchestrator
  // wrappers report `skipped: auth_failed` or `auth_failed` without an
  // HTTP status. Same shape as the quota matcher above so the classifier
  // doesn't fall back to `unknown` → `api-error` for these.
  if (matches(msg, [
    'auth_failed', 'authentication failed', 'authentication credentials',
    'invalid api key', 'invalid_api_key', 'invalid token',
    'missing api key', 'no api key',
    'skipped: auth_failed', 'unauthorized',
  ])) {
    return { category: 'provider_auth_error', reason: 'auth_msg_match', isLocalInfra: false, isRetryable: false };
  }
  // 1.5c No eligible providers — operability-hub-side problem (config,
  // hub readiness, or pool exhaustion). NOT a network or provider HTTP
  // error. Treat as config until the orchestrator carries a more
  // specific reason.
  if (matches(msg, ['no_eligible_providers', 'no eligible providers'])) {
    return { category: 'provider_config_error', reason: 'no_eligible_providers_msg_match', isLocalInfra: true, isRetryable: false };
  }

  // 2. Bare 'fetch failed' from undici doesn't carry a code at top level —
  //    inspect the message text.
  if (matches(msg, ['enotfound', 'getaddrinfo', 'dns lookup'])) {
    return { category: 'network_dns_error', reason: 'dns_msg_match', isLocalInfra: true, isRetryable: true };
  }
  if (matches(msg, ['econnrefused', 'etimedout', 'connect etimedout', 'socket hang up', 'network'])) {
    return { category: 'network_connect_error', reason: 'connect_msg_match', isLocalInfra: true, isRetryable: true };
  }
  if (matches(msg, ['certificate', 'self signed', 'tls handshake'])) {
    return { category: 'network_tls_error', reason: 'tls_msg_match', isLocalInfra: true, isRetryable: false };
  }

  // 3. HTTP-level classification.
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      // 403 with billing/credit hint = quota, not auth.
      if (matches(body, ['insufficient', 'billing', 'quota', 'credit', 'subscription', 'top up'])) {
        return { category: 'provider_quota_error', reason: `http_${status}_quota_body`, isLocalInfra: false, isRetryable: false };
      }
      return { category: 'provider_auth_error', reason: `http_${status}`, isLocalInfra: false, isRetryable: false };
    }
    if (status === 402) {
      return { category: 'provider_quota_error', reason: 'http_402', isLocalInfra: false, isRetryable: false };
    }
    if (status === 429) {
      // 429 with billing hint = quota; otherwise generic rate-limit
      if (matches(body, ['quota', 'billing', 'insufficient'])) {
        return { category: 'provider_quota_error', reason: 'http_429_quota_body', isLocalInfra: false, isRetryable: true };
      }
      return { category: 'provider_http_error', reason: 'http_429_rate_limited', isLocalInfra: false, isRetryable: true };
    }
    // Require BOTH "model" in body AND one of the not-found markers, so
    // a plain "404 Not Found" page doesn't get mis-classified as a model
    // error. Adapters that return JSON like `{"error":"unknown model foo"}`
    // match cleanly.
    if (status === 404 && matches(body, ['model']) && matches(body, ['unknown', 'not found', 'does not exist', 'no such'])) {
      return { category: 'provider_model_error', reason: 'http_404_model', isLocalInfra: false, isRetryable: false };
    }
    if (status >= 400) {
      return { category: 'provider_http_error', reason: `http_${status}`, isLocalInfra: false, isRetryable: status >= 500 };
    }
  }

  // 4. Fallback.
  return { category: 'unknown', reason: code || msg || 'unspecified', isLocalInfra: false, isRetryable: false };
}
