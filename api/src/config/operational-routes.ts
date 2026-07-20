// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Single source of truth for operational route paths.
 *
 * "Operational" routes are the small set of endpoints that exist for the
 * benefit of the *infrastructure* (probes, monitoring, JWKS publishing,
 * health discovery) rather than for product functionality. They MUST be
 * uniformly excluded from three product-tier middlewares:
 *
 *   1. api-key-auth-middleware → PUBLIC_ROUTES   (auth bypass)
 *   2. token-bucket-rate-limit → OPERATIONAL_ROUTE_PATHS  (rate-limit bypass)
 *   3. gateway_middleware      → DEFAULT_QUOTA_SKIP_ROUTES (quota bypass)
 *
 * This file is the canonical list. Each consumer should import
 * `OPERATIONAL_ROUTES` and use it directly — no duplication, no drift.
 *
 * Adding a new operational endpoint:
 *   - Add the path here (single point of change)
 *   - The three middlewares pick it up automatically
 *   - The OpenAPI generator should mark it `x-public: true` so the
 *     gateway WAF allowlist stays in sync as well (gateway lives in a
 *     separate repo; we cannot enforce that from here, but flagging
 *     it in OpenAPI is the contract)
 *
 * Why a frozen readonly array of plain strings:
 *   - Keeps the import graph trivially cheap (no runtime cost)
 *   - Strings are easy to grep, easy to diff in PRs
 *   - Freeze prevents accidental in-place mutation by a consumer
 *
 * Why no regex / glob support:
 *   - Operational routes are exactly enumerable. If we ever need a
 *     wildcard, we can add a `OPERATIONAL_ROUTE_PATTERNS: RegExp[]`
 *     sibling — but lazy-add, don't pre-bake.
 */

export const OPERATIONAL_ROUTES = Object.freeze([
  '/health',
  '/health/ready',
  '/health/live',
  '/health/startup',
  '/metrics',
  '/.well-known/jwks.json',
  '/console/api/v1/jwks',
  '/v1/status',
  '/v1/status/health',
  '/v1/status/ready',
  '/v1/hcra/health',
] as const);

export type OperationalRoute = (typeof OPERATIONAL_ROUTES)[number];

/**
 * Strict-segment match — exact path OR prefix-followed-by-slash.
 * Never a bare prefix, so `/healthcare` is NOT treated as `/health`.
 *
 * The `path` argument should already have the query string stripped
 * (call sites do `url.split('?')[0]` before invoking this).
 */
export function isOperationalRoute(path: string): boolean {
  for (const route of OPERATIONAL_ROUTES) {
    if (path === route || path.startsWith(`${route}/`)) {
      return true;
    }
  }
  return false;
}
