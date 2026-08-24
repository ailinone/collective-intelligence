// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Typed provider failure classification (Workstream F, 2026-08-17).
 *
 * Single source of truth for mapping raw provider failure signals
 * (HTTP status + error code + message + circuit state) onto a small,
 * quarantine-aware state taxonomy. The taxonomy deliberately separates
 * CAUSE (why it failed) from POLICY (what to do about it):
 *
 *   - `QUARANTINE_STATES` are the states that mean "this provider cannot
 *     serve ANY request right now and will not self-correct within a
 *     request budget" — invalid/missing credentials, exhausted billing,
 *     restricted account, dead endpoint. Pool builders and cascade
 *     candidate selection MUST exclude providers in these states.
 *   - Everything else (rate limit, timeout, 5xx, open circuit) is
 *     transient: demote/back off, but keep the provider reachable.
 *
 * Pure functions only — no I/O, no globals, no secret material. Messages
 * are matched by lowercase substring/regex; the classifier never logs or
 * echoes the raw message (callers must sanitize before logging).
 */

export type ProviderFailureState =
  | 'HEALTHY'
  | 'TRANSIENT_FAILURE'
  | 'RATE_LIMITED'
  | 'AUTH_INVALID'
  | 'AUTH_MISSING'
  | 'BILLING_EXHAUSTED'
  | 'ACCOUNT_RESTRICTED'
  | 'CIRCUIT_OPEN'
  | 'DEGRADED'
  | 'PROVIDER_DEAD'
  | 'UNKNOWN';

/**
 * States that MUST exclude a provider from the eligible pool / cascade
 * candidates. A user request must never sequentially try a provider in
 * one of these states — that is the quarantine contract.
 */
export const QUARANTINE_STATES: ReadonlySet<ProviderFailureState> = new Set([
  'AUTH_INVALID',
  'AUTH_MISSING',
  'BILLING_EXHAUSTED',
  'ACCOUNT_RESTRICTED',
  'PROVIDER_DEAD',
]);

export interface ProviderFailureSignals {
  /** HTTP status code, when known. */
  readonly httpStatus?: number;
  /** Provider-specific error code string (e.g. `ACCESS_TOKEN_TYPE_UNSUPPORTED`). */
  readonly errorCode?: string;
  /** Raw error message (matched, never re-emitted). */
  readonly message?: string;
  /** Circuit-breaker state, when classification is being done at selection time. */
  readonly circuitState?: 'OPEN' | 'HALF_OPEN';
}

export interface ProviderFailureClassification {
  readonly state: ProviderFailureState;
  /** True when the state is in QUARANTINE_STATES. */
  readonly quarantine: boolean;
  /** Short machine-readable reason — never contains secret material. */
  readonly reason: string;
}

const CREDIT_PATTERNS: readonly RegExp[] = [
  /insufficient[_\s-]credits?/,
  /insufficient[_\s-]balance/,
  /credit\s+balance/,
  /balance.*too\s+low/,
  /\bquota\b.{0,30}(plan|billing|exceeded)/,
  /exceeded\s+your\s+(current\s+)?quota/,
  /check\s+your\s+plan\s+and\s+billing/,
  /out\s+of\s+(credits?|funds)/,
  /(ran|run|running)\s+out\s+of\s+credits?/,
  /(?:not|don'?t|doesn'?t|haven'?t)\s+(?:have\s+)?enough\s+credits?/,
  /payment\s+required/,
  /top\s+up/,
  /recharge/,
  /billing/,
  /resource_exhausted/,
];

const AUTH_MISSING_PATTERNS: readonly RegExp[] = [
  /api[_\s-]?key\s+(is\s+)?(missing|not\s+set|not\s+configured|empty)/,
  /credential\s+(missing|not\s+configured)/,
  /no\s+api\s+key/,
  /not\s+configured/,
  /secret\s+not\s+found/,
];

const AUTH_INVALID_PATTERNS: readonly RegExp[] = [
  /invalid\s+(api\s+)?key/,
  /incorrect\s+api\s+key/,
  /api\s+key\s+not\s+valid/,
  /api_?key_?invalid/,
  /invalid_api_key/,
  /unauthorized/,
  /authentication/,
  /access[_\s]?token[_\s]?type[_\s]?unsupported/,
  /credential[_\s]?type[_\s]?(mismatch|unsupported)/,
];

const ACCOUNT_RESTRICTED_PATTERNS: readonly RegExp[] = [
  /consumer.+(has\s+been\s+)?suspended/,
  /account.+(has\s+been\s+)?(suspended|disabled|on\s+hold)/,
  /consumer_suspended/,
  /permission\s+denied/,
  /banned/,
  /forbidden/,
  /access\s+denied/,
];

const DEAD_ENDPOINT_PATTERNS: readonly RegExp[] = [
  /model\s+not\s+found/,
  /model_not_found/,
  /no\s+such\s+model/,
  /model\s+does\s+not\s+exist/,
  /does\s+not\s+exist/,
  /unknown\s+model/,
  // 400 InvalidArgument shape (live 2026-08-21 evidence, inworld via
  // openai-compatible-hub): "The requested model 'claude-3-5-sonnet' is
  // currently not supported" — permanent per-model condition that previously
  // classified as UNKNOWN, so the route was never marked dead and every pass
  // re-picked it. Scoped to "model ... not supported" to avoid matching
  // feature-level wording like "streaming not supported".
  /model\s+[^.]{0,80}(is\s+)?(currently\s+)?not\s+supported/,
  /endpoint\s+(not\s+found|gone)/,
];

const TIMEOUT_PATTERNS: readonly RegExp[] = [
  /^timeout$/i,
  /timed?\s*out/,
  /request\s+timeout/,
  /\babort/i,
  /etimedout/i,
];

const NETWORK_PATTERNS: readonly RegExp[] = [
  /econnreset/i,
  /eai_again/i,
  /enotfound/i,
  /socket\s+hang\s+up/i,
  /network\s+error/i,
  /fetch\s+failed/i,
];

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

function classify(
  state: ProviderFailureState,
  reason: string
): ProviderFailureClassification {
  return { state, quarantine: QUARANTINE_STATES.has(state), reason };
}

/**
 * Map raw failure signals to a typed state. Ordering mirrors the
 * precedence used by `classifyError` in provider-operability-hub.ts
 * (billing before auth, auth before route-death) so the two classifiers
 * cannot disagree on precedence:
 *
 *   1. billing exhaustion (402, or credit wording on any status)
 *   2. account restriction (suspension/ban wording)
 *   3. auth (401; missing-vs-invalid split by wording)
 *   4. dead endpoint (404/410 + model/endpoint-gone wording)
 *   5. rate limit (429/425)
 *   6. timeout / network / 5xx / 424 → transient
 *   7. circuit state (when supplied) → CIRCUIT_OPEN
 *   8. fallback → UNKNOWN
 */
export function classifyProviderFailure(
  signals: ProviderFailureSignals
): ProviderFailureClassification {
  const status = signals.httpStatus;
  const text = `${signals.errorCode ?? ''} ${signals.message ?? ''}`.toLowerCase();

  // 1) Billing / credits — on any status, because providers disagree
  //    (Anthropic 400, AIML 403, OpenAI 429).
  if (status === 402 || matches(CREDIT_PATTERNS, text)) {
    return classify('BILLING_EXHAUSTED', status === 402 ? 'http_402_payment_required' : 'billing_exhausted');
  }

  // 2) Account-level restriction (suspension, ban, permission denied).
  if (matches(ACCOUNT_RESTRICTED_PATTERNS, text)) {
    return classify('ACCOUNT_RESTRICTED', 'account_restricted');
  }

  // 3) Auth. Split missing (nothing configured) from invalid (configured
  //    but wrong/revoked/wrong TYPE — e.g. an OAuth token stored where an
  //    API key belongs, which Google answers with 401
  //    ACCESS_TOKEN_TYPE_UNSUPPORTED).
  if (
    status === 401 ||
    matches(AUTH_INVALID_PATTERNS, text) ||
    matches(AUTH_MISSING_PATTERNS, text)
  ) {
    if (matches(AUTH_MISSING_PATTERNS, text)) {
      return classify('AUTH_MISSING', 'credential_missing');
    }
    if (/access[_\s]?token[_\s]?type/.test(text) || /credential[_\s]?type/.test(text)) {
      return classify('AUTH_INVALID', 'credential_type_mismatch');
    }
    return classify('AUTH_INVALID', status === 401 ? 'http_401_unauthorized' : 'auth_invalid');
  }

  // 3b) Bare non-credit 403 — FORBIDDEN (IP ban, region block, revoked
  //     permission). The live 2026-08-17 evidence (xai 403 + circuit
  //     oscillation) is exactly this shape: sticky, quarantine-worthy.
  if (status === 403) {
    return classify('ACCOUNT_RESTRICTED', 'http_403_forbidden');
  }

  // 4) Dead endpoint / model gone (404, 410 Gone, EOL).
  if (status === 404 || status === 410 || matches(DEAD_ENDPOINT_PATTERNS, text)) {
    return classify('PROVIDER_DEAD', status === 410 ? 'http_410_gone' : 'endpoint_not_found');
  }

  // 5) Rate limit — transient with cooldown.
  if (status === 429 || status === 425 || /rate.?limit|too\s+many\s+requests/.test(text)) {
    return classify('RATE_LIMITED', 'rate_limited');
  }

  // 6) Transient failures.
  if (matches(TIMEOUT_PATTERNS, text)) {
    return classify('TRANSIENT_FAILURE', 'timeout');
  }
  if (matches(NETWORK_PATTERNS, text)) {
    return classify('TRANSIENT_FAILURE', 'network_error');
  }
  if (typeof status === 'number' && status >= 500) {
    return classify('TRANSIENT_FAILURE', `server_error_${status}`);
  }
  if (status === 424) {
    return classify('TRANSIENT_FAILURE', 'upstream_provider_error_424');
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return classify('UNKNOWN', `bad_request_${status}`);
  }

  // 7) Circuit state supplied by the caller (selection-time classification).
  if (signals.circuitState === 'OPEN') {
    return classify('CIRCUIT_OPEN', 'circuit_open');
  }

  // 8) Fallback.
  return classify('UNKNOWN', 'unknown');
}

/**
 * Extract an HTTP status from an arbitrary error message. Adapters throw
 * at least these shapes:
 *   - `... HTTP 401 ...`        (hub adapters)
 *   - `[401] API key not valid` (@google/generative-ai SDK)
 *   - `status=401` / `status: 401`
 */
export function extractHttpStatusFromMessage(message: string): number | undefined {
  const patterns = [
    /\bHTTP\s+(\d{3})\b/i,
    /\[(\d{3})\]/,
    /\bstatus\s*[=:]\s*(\d{3})\b/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m) {
      const code = parseInt(m[1]!, 10);
      if (code >= 100 && code < 600) return code;
    }
  }
  return undefined;
}

// ─── Google credential TYPE check (no secret material emitted) ────────────

export type GoogleCredentialShape =
  | 'empty'
  | 'api_key'
  | 'oauth_access_token'
  | 'service_account_json'
  | 'jwt'
  | 'unknown';

/**
 * Classify the SHAPE of the value stored in the google API-key secret slot.
 * Google AI Studio (Generative Language API) keys start with `AIza` and are
 * sent as `x-goog-api-key` / `?key=`. If the secret instead holds an OAuth
 * access token (`ya29.`), a JWT (`eyJ`) or a service-account JSON, Google
 * answers 401 `ACCESS_TOKEN_TYPE_UNSUPPORTED` — a credential TYPE mismatch,
 * not a revoked key. This check lets boot classify the failure precisely
 * (and quarantine immediately) WITHOUT ever logging the value.
 */
export function classifyGoogleCredentialShape(value: string): GoogleCredentialShape {
  const v = (value ?? '').trim();
  if (!v) return 'empty';
  if (v.startsWith('AIza')) return 'api_key';
  if (v.startsWith('ya29.')) return 'oauth_access_token';
  if (v.startsWith('eyJ')) return 'jwt';
  if (v.startsWith('{')) {
    try {
      const parsed = JSON.parse(v) as Record<string, unknown>;
      if ('client_email' in parsed || 'private_key' in parsed) return 'service_account_json';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}
