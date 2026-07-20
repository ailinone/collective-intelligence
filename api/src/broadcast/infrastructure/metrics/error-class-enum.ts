// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Bounded enum for the `error_class` Prometheus label (ADR-021).
 *
 * Cardinality discipline: Prometheus label values multiply series. A single
 * unbounded field (e.g., `http_418` vs `http_419` vs `http_420`) can explode
 * the series count — each new arm/destination_type/outcome combo silently
 * doubles memory. Our SLO dashboards stay cheap only if `error_class` stays
 * bounded.
 *
 * Contract:
 *   1. Adapter-facing DeliveryOutcome.errorClass is a FREE-FORM string — it
 *      feeds DLQ row `error_class` (≤32 chars) and logs. Fine to be precise.
 *   2. At the METRIC boundary (delivery-executor → broadcastMetrics), every
 *      errorClass MUST pass through `normalizeErrorClass()` which clamps
 *      unknown values to `'other'`.
 *
 * Adding a new class:
 *   1. Append to ERROR_CLASS_ENUM.
 *   2. Update Grafana dashboard variable list.
 *   3. Bump the test in __tests__/error-class-enum.test.ts fixture list
 *      so the no-new-unbounded-classes guardrail stays honest.
 *
 * Generic fallbacks (`http_other`, `network_other`) exist so adapters don't
 * have to map every exotic HTTP status — their errorClassForStatus() already
 * narrows to known statuses and lets the rest land on `http_other`.
 */

export const ERROR_CLASS_ENUM = [
  // Pipeline errors (pre-adapter)
  'none', // success path sentinel
  'unknown', // defensive default when an adapter forgets to classify
  'other', // fallback for any string not in this list
  'config_decrypt_failed',
  'config_invalid',
  'no_adapter',
  'adapter_threw',
  'kek_unavailable', // KEK circuit breaker open — transient, retryable (Fase 3.2)

  // HTTP dispatch errors (narrowed)
  'auth_failed', // 401/403
  'bad_request', // 400/422
  'not_found', // 404/410
  'rate_limited', // 429
  'request_timeout', // 408 / client-side timeout
  'timeout', // AbortController-driven timeout
  'payload_too_large', // 413
  'server_error', // 5xx
  'http_other', // 2xx/3xx we didn't expect, and unknown 4xx
  'adapter_4xx', // langfuse/datadog/otlp generic 4xx
  'adapter_5xx', // langfuse/datadog/otlp generic 5xx
  'partial_failure', // langfuse batch: some events 200, some failed

  // Transport / SSRF guard outcomes
  'dns_resolution_failed',
  'network_error',
  'network_other',
  'ssrf_blocked', // generic SSRF guard reject
  'ssrf_loopback',
  'ssrf_private',
  'ssrf_linklocal',
  'ssrf_multicast',
  'ssrf_reserved',
  'ssrf_scheme_disallowed',
] as const;

export type ErrorClass = (typeof ERROR_CLASS_ENUM)[number];

const ENUM_SET = new Set<string>(ERROR_CLASS_ENUM);

/**
 * Clamp an adapter-provided errorClass string to the bounded enum. Unknown
 * values fall back to `'other'` so Prometheus cardinality stays capped.
 *
 * Nullish input → `'none'` so success paths (which have no error) still get
 * a label (Prometheus labels can't be empty strings without a value).
 */
export function normalizeErrorClass(raw: string | null | undefined): ErrorClass {
  if (raw == null || raw === '') return 'none';
  if (ENUM_SET.has(raw)) return raw as ErrorClass;
  // SSRF reasons come in with underscores already matching `ssrf_*`; otherwise
  // we might be seeing a new adapter string that slipped in. Default `other`.
  return 'other';
}

/**
 * Introspection helper for the guardrail test — returns the raw enum as a
 * Set so the test can check invariants without re-exporting internals.
 */
export function knownErrorClasses(): ReadonlySet<string> {
  return ENUM_SET;
}
