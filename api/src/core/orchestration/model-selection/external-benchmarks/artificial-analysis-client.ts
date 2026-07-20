// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6 §7 — Artificial Analysis API client.
 *
 * Fetches the official AA LLM models data endpoint via `x-api-key`.
 *
 * Safety invariants:
 *   - the API key is ONLY read from the function input — never from
 *     module-level state — and is NEVER logged or returned in errors
 *   - error messages are sanitized to redact any occurrence of the key
 *   - default timeout 30s; AbortController for clean cancellation
 *   - validates the response shape minimally (status code + JSON.data array)
 *
 * No network call happens at import time. Tests inject a `fetchFn`.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface ArtificialAnalysisLlmModel {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
  readonly model_creator?: {
    readonly id?: string;
    readonly name?: string;
    readonly slug?: string;
  };
  readonly evaluations?: Record<string, number | null | undefined>;
  readonly pricing?: {
    readonly price_1m_blended_3_to_1?: number | null;
    readonly price_1m_input_tokens?: number | null;
    readonly price_1m_output_tokens?: number | null;
  };
  readonly median_output_tokens_per_second?: number | null;
  readonly median_time_to_first_token_seconds?: number | null;
  readonly median_time_to_first_answer_token?: number | null;
}

export interface ArtificialAnalysisModelsResponse {
  readonly status?: number;
  readonly prompt_options?: Record<string, unknown>;
  readonly data: ReadonlyArray<ArtificialAnalysisLlmModel>;
}

export interface FetchArtificialAnalysisInput {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  /** Test seam — defaults to globalThis.fetch. */
  readonly fetchFn?: typeof globalThis.fetch;
}

export interface FetchArtificialAnalysisResult {
  readonly response: ArtificialAnalysisModelsResponse;
  readonly httpStatus: number;
  readonly rateLimit: {
    readonly limit: string | null;
    readonly remaining: string | null;
    readonly reset: string | null;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────

export const ARTIFICIAL_ANALYSIS_DEFAULT_ENDPOINT =
  'https://artificialanalysis.ai/api/v2/data/llms/models' as const;
export const DEFAULT_TIMEOUT_MS = 30_000 as const;

// ─── Sanitization ─────────────────────────────────────────────────────────

function sanitizeMessage(message: string, secret: string): string {
  if (!secret) return message;
  // Safe replace: case-sensitive on the literal value, with NO regex
  // metacharacters injected from the secret.
  return message.split(secret).join('[REDACTED_ARTIFICIAL_ANALYSIS_API_KEY]');
}

class AaClientError extends Error {
  readonly httpStatus?: number;
  readonly bodyPrefix?: string;
  constructor(message: string, httpStatus?: number, bodyPrefix?: string) {
    super(message);
    this.name = 'AaClientError';
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (bodyPrefix !== undefined) this.bodyPrefix = bodyPrefix;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch the official Artificial Analysis LLM models endpoint.
 *
 * NEVER throws with the API key in the message. Callers can attach the
 * `rateLimit` headers to their cache artifact for audit.
 */
export async function fetchArtificialAnalysisLlmModels(
  input: FetchArtificialAnalysisInput,
): Promise<FetchArtificialAnalysisResult> {
  const apiKey = input.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new AaClientError('apiKey is required (non-empty string)');
  }
  const endpoint = input.endpoint ?? ARTIFICIAL_ANALYSIS_DEFAULT_ENDPOINT;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new AaClientError('fetch is not available in this runtime');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(endpoint, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'user-agent': 'ailin-01c1b-j2c-r6/1.0',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new AaClientError(`AA fetch failed: ${sanitizeMessage(msg, apiKey)}`);
  }
  clearTimeout(timer);

  const httpStatus = res.status;
  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AaClientError(
      `AA body read failed: ${sanitizeMessage(msg, apiKey)}`,
      httpStatus,
    );
  }

  if (!res.ok) {
    const bodyPrefix = bodyText.slice(0, 500);
    throw new AaClientError(
      `AA request failed; status=${httpStatus}`,
      httpStatus,
      bodyPrefix,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new AaClientError(
      `AA response was not JSON; status=${httpStatus}`,
      httpStatus,
      bodyText.slice(0, 200),
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { data?: unknown }).data)
  ) {
    throw new AaClientError(
      'AA response missing data array',
      httpStatus,
      bodyText.slice(0, 200),
    );
  }

  const response = parsed as ArtificialAnalysisModelsResponse;

  return {
    response,
    httpStatus,
    rateLimit: {
      limit: res.headers.get('x-ratelimit-limit'),
      remaining: res.headers.get('x-ratelimit-remaining'),
      reset: res.headers.get('x-ratelimit-reset'),
    },
  };
}
