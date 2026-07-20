// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — provider failure classifier.
 *
 * Wraps `classifyParticipantFailure` (in consensus-strategy) with a
 * structured ProviderFailure record. Two paths:
 *
 *   1. The adapter already emitted a structured code/object — we use
 *      `source='structured_provider_error'`. (Hook for future adapters
 *      that emit typed errors. Not exercised by current adapters.)
 *
 *   2. The adapter emitted a string — we parse with keyword matching
 *      and emit `source='parsed_string_fallback'`. Operators see this
 *      and know to lift adapter error contracts later.
 */
import type {
  ProviderFailure,
  ProviderFailureCode,
  ProviderFailureSource,
} from './provider-failure-code';
import { sanitizeErrorString } from './provider-failure-code';

const ERROR_KEYWORDS: ReadonlyArray<{ pattern: RegExp; code: ProviderFailureCode }> = [
  { pattern: /\b402\b|no\s+credit|insufficient/i, code: 'no_credits' },
  { pattern: /\b401\b|unauthor|invalid\s+api\s+key|forbidden\s+auth/i, code: 'auth_failed' },
  { pattern: /\b429\b|rate\s*limit|too\s+many\s+requests|quota/i, code: 'rate_limited' },
  { pattern: /timeout|timed\s*out|deadline/i, code: 'timeout' },
  { pattern: /\b404\b|not\s+found|model_not_found/i, code: 'model_not_found' },
  { pattern: /unsupported|incompatib/i, code: 'unsupported_model' },
  { pattern: /invalid|malformed|parse/i, code: 'invalid_response' },
  { pattern: /exception|stack/i, code: 'exception' },
];

export interface StructuredAdapterError {
  readonly code: ProviderFailureCode;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly retryable?: boolean;
  readonly message?: string;
}

export function buildProviderFailureFromStructured(
  err: StructuredAdapterError,
): ProviderFailure {
  return {
    code: err.code,
    source: 'structured_provider_error',
    providerId: err.providerId,
    modelId: err.modelId,
    retryable: err.retryable,
    observedAt: new Date().toISOString(),
    rawErrorSanitized: sanitizeErrorString(err.message),
  };
}

export function buildProviderFailureFromString(input: {
  readonly raw: string | undefined;
  readonly providerId?: string;
  readonly modelId?: string;
}): ProviderFailure {
  const raw = input.raw ?? '';
  let code: ProviderFailureCode = 'unknown';
  let source: ProviderFailureSource = 'unknown';
  if (raw.length === 0) {
    code = 'unknown';
    source = 'unknown';
  } else {
    source = 'parsed_string_fallback';
    for (const rule of ERROR_KEYWORDS) {
      if (rule.pattern.test(raw)) {
        code = rule.code;
        break;
      }
    }
    if (code === 'unknown') code = 'provider_error';
  }
  // Retryable: rate_limited and timeout are typically retryable; auth_failed
  // and no_credits typically aren't (operator action required).
  const retryable =
    code === 'rate_limited' || code === 'timeout' || code === 'provider_error';
  return {
    code,
    source,
    providerId: input.providerId,
    modelId: input.modelId,
    retryable,
    observedAt: new Date().toISOString(),
    rawErrorSanitized: sanitizeErrorString(raw),
  };
}
