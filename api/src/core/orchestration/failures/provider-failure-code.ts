// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — structured provider failure codes.
 *
 * The current pipeline emits string-based errors from adapters
 * (BaseStrategy.executeModel returns `ModelExecution.error: string`).
 * This module is the FUTURE contract for structured failures.
 * Implementations consumed by ConsensusStrategy classify failures as
 * either `structured_provider_error` (the adapter already returned a
 * typed code) or `parsed_string_fallback` (we inferred the code from
 * the string). Operators can audit `source` to know how reliable the
 * classification is.
 *
 * 10 buckets aligned with `ParticipantFailureReason` in
 * `consensus-artifacts.ts` plus a structural `outlier_rejected` for
 * voters that ran but failed the evaluator's structural filter.
 */

export type ProviderFailureCode =
  | 'provider_error'
  | 'auth_failed'
  | 'no_credits'
  | 'rate_limited'
  | 'timeout'
  | 'model_not_found'
  | 'unsupported_model'
  | 'empty_response'
  | 'invalid_response'
  | 'exception'
  | 'outlier_rejected'
  | 'unknown';

export type ProviderFailureSource =
  | 'structured_provider_error'
  | 'parsed_string_fallback'
  | 'unknown';

export interface ProviderFailure {
  readonly code: ProviderFailureCode;
  readonly source: ProviderFailureSource;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly routeId?: string;
  readonly retryable?: boolean;
  readonly observedAt: string;
  /** Sanitized — must NOT contain API keys, prompts, response bodies. */
  readonly rawErrorSanitized?: string;
}

/**
 * Sanitize an error string for inclusion in artifacts. Strips
 * common-format API keys (Bearer / api_key=) and bounds to 200 chars.
 */
export function sanitizeErrorString(s: string | undefined): string | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  let out = s;
  // Strip "Bearer XXX" / "api_key=XXX" / "x-api-key: XXX"
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]');
  out = out.replace(/api[_-]?key\s*[:=]\s*[A-Za-z0-9._\-]+/gi, 'api_key=[redacted]');
  out = out.replace(/x-api-key\s*:\s*[A-Za-z0-9._\-]+/gi, 'x-api-key: [redacted]');
  out = out.replace(/sk-[A-Za-z0-9_\-]{10,}/g, 'sk-[redacted]');
  return out.slice(0, 200);
}
