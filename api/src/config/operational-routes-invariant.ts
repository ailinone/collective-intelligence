// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Boot-time invariant: every canonical operational route must be honored
 * by all three sibling allowlists.
 *
 * Why this exists (Caminho C — chosen 2026-04-25)
 * ────────────────────────────────────────────────
 * Three middlewares each maintain an allowlist of routes that MUST bypass
 * their respective check:
 *
 *   1. PUBLIC_ROUTES               (auth bypass)         — api-key-auth-middleware.ts
 *   2. OPERATIONAL_ROUTE_PATHS     (rate-limit bypass)   — token-bucket-rate-limit.ts
 *   3. QUOTA_SKIP_ROUTES           (gateway quota bypass) — gateway_middleware.ts
 *
 * The original HCRA bug (resolved 2026-04-25, commits 1c3b8e6 + ce5d48e)
 * was caused by `/v1/hcra/health` being present in lists 1 and 2 but
 * absent from list 3. Probes that sent zero credentials short-circuited
 * the gateway middleware (correct), but probes carrying *any* credential
 * tripped the upstream-quota fetch with junk creds → 503.
 *
 * We chose a guard rather than a structural refactor:
 *   - The three lists stay where they are (clear ownership per middleware)
 *   - A single canonical list (OPERATIONAL_ROUTES, in operational-routes.ts)
 *     is the source of truth
 *   - This module asserts at boot that every canonical route is covered
 *     by all three siblings under their actual matching semantics
 *
 * If a future change drops `/v1/hcra/health` from any of the three lists,
 * or if an operator misconfigures `GATEWAY_QUOTA_SKIP_ROUTES` to omit it,
 * the server crashes at boot with a loud, specific error. The misconfiguration
 * cannot reach a production probe.
 *
 * Matching semantics — preserved per consumer (NOT unified)
 * ──────────────────────────────────────────────────────────
 * Each consumer's matcher has slightly different rules; this module
 * mirrors them locally rather than calling them, to keep the invariant
 * a static structural check (no module-load side effects from middleware
 * imports beyond the lists themselves).
 *
 *   - PUBLIC_ROUTES + OPERATIONAL_ROUTE_PATHS: segment-strict —
 *     `path === entry || path.startsWith(entry + '/')`
 *   - QUOTA_SKIP_ROUTES: bare prefix —
 *     `path.startsWith(entry)` (laxer; `/healthcheck` matches `/health`)
 *
 * For canonical routes that are exact-enumerable (every entry in
 * OPERATIONAL_ROUTES is a literal endpoint with no descendants relevant
 * to the bypass), all three semantics yield the same answer. The
 * invariant therefore catches both literal-omission and prefix-coverage
 * gaps uniformly.
 *
 * What this module does NOT check
 * ────────────────────────────────
 *  - The fourth allowlist lives in the gateway-nginx repo
 *    (`ci-api-public-paths.map.conf`). That is a separate process and
 *    cannot be loaded from here. The OpenAPI generator marks operational
 *    routes `x-public: true` as the cross-repo contract. See ADR-022.
 *  - Behavioral correctness of the middlewares themselves (covered by
 *    their own unit tests).
 */

import { OPERATIONAL_ROUTES } from './operational-routes';
import { PUBLIC_ROUTES } from '@/api/middleware/api-key-auth-middleware';
import { OPERATIONAL_ROUTE_PATHS } from '@/api/middleware/token-bucket-rate-limit';
import { QUOTA_SKIP_ROUTES } from '@/middleware/gateway_middleware';

export interface InvariantViolation {
  /** Canonical operational route that is not honored */
  route: string;
  /** Human-readable list names where the route is missing */
  missingFrom: string[];
}

/**
 * Segment-strict cover: does ANY entry in `list` cover `route` such that
 * a request to `route` would match by `path === entry || path.startsWith(entry + '/')`?
 *
 * Mirrors the matchers in api-key-auth-middleware.ts:120-125 and
 * token-bucket-rate-limit.ts:63-69.
 */
function segmentStrictCovers(list: readonly string[], route: string): boolean {
  for (const entry of list) {
    // Trailing-slash entries (PUBLIC_ROUTES allows them) → bare prefix
    if (entry.endsWith('/')) {
      if (route.startsWith(entry)) return true;
      continue;
    }
    if (route === entry || route.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/**
 * Bare-prefix cover: does ANY entry in `list` cover `route` such that
 * `route.startsWith(entry)`?
 *
 * Mirrors `routeMatchesPrefix` in gateway_middleware.ts:146-148.
 */
function barePrefixCovers(list: readonly string[], route: string): boolean {
  return list.some((entry) => route.startsWith(entry));
}

/**
 * Pure structural check — returns the list of violations without throwing.
 *
 * Use this in tests to assert specific drift scenarios without crashing
 * the test process. The boot-time wrapper `assertOperationalRouteInvariant`
 * is what should be called from `server.ts`.
 */
export function checkOperationalRouteInvariant(): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  for (const route of OPERATIONAL_ROUTES) {
    const missingFrom: string[] = [];

    if (!segmentStrictCovers(PUBLIC_ROUTES, route)) {
      missingFrom.push('PUBLIC_ROUTES (api-key-auth-middleware)');
    }
    if (!segmentStrictCovers(OPERATIONAL_ROUTE_PATHS, route)) {
      missingFrom.push('OPERATIONAL_ROUTE_PATHS (token-bucket-rate-limit)');
    }
    if (!barePrefixCovers(QUOTA_SKIP_ROUTES, route)) {
      missingFrom.push('QUOTA_SKIP_ROUTES (gateway_middleware)');
    }

    if (missingFrom.length > 0) {
      violations.push({ route, missingFrom });
    }
  }

  return violations;
}

/**
 * Format a violation list as a human-readable multi-line error message.
 * Exposed for tests and for `assertOperationalRouteInvariant`'s thrown error.
 */
export function formatViolations(violations: readonly InvariantViolation[]): string {
  const lines: string[] = [
    'OPERATIONAL ROUTE INVARIANT VIOLATION',
    '',
    'One or more canonical operational routes are not honored by every',
    'sibling allowlist. This will cause hard-to-debug 401/429/503 errors',
    'on production probes. See src/config/operational-routes-invariant.ts',
    'for the full contract.',
    '',
  ];

  for (const v of violations) {
    lines.push(`  • ${v.route}`);
    for (const list of v.missingFrom) {
      lines.push(`      ↳ MISSING FROM: ${list}`);
    }
  }

  lines.push('');
  lines.push('Fix: add the route to the listed allowlist(s), or correct');
  lines.push('the GATEWAY_QUOTA_SKIP_ROUTES env var if the gap is operator-side.');

  return lines.join('\n');
}

/**
 * Boot-time guard. Call from server.ts before `server.listen`.
 *
 * Strategy: ALWAYS THROW (chosen 2026-04-25). A misconfigured operational
 * allowlist is never acceptable — degraded boots silently leak the gap to
 * production probes. We crash the container so Swarm/the operator notices
 * immediately, and the message is structured enough to point directly at
 * the missing entry.
 *
 * This applies in every environment (dev, test, prod). Local dev surfaces
 * the gap as a fast crash with a clear error message; production refuses
 * to boot, restart-loops, and the operator fixes it. The boot path is
 * only invoked from `start()` in server.ts — vitest does not boot the
 * server holistically, so this does not affect test runs.
 */
export function assertOperationalRouteInvariant(): void {
  const violations = checkOperationalRouteInvariant();
  if (violations.length === 0) {
    return;
  }
  throw new Error(formatViolations(violations));
}
