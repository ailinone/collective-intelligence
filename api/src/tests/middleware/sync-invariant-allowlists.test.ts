// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect } from 'vitest';
import { PUBLIC_ROUTES } from '@/api/middleware/api-key-auth-middleware';
import { OPERATIONAL_ROUTE_PATHS } from '@/api/middleware/token-bucket-rate-limit';
import { DEFAULT_QUOTA_SKIP_ROUTES } from '@/middleware/gateway_middleware';

/**
 * SYNC INVARIANT — cross-allowlist regression guard.
 *
 * The /v1/hcra/health gap (closed in commit ce5d48e) had this shape:
 *   • PUBLIC_ROUTES included /v1/hcra/health        (auth bypass: yes)
 *   • OPERATIONAL_ROUTE_PATHS included /v1/hcra/health (rate-limit bypass: yes)
 *   • DEFAULT_QUOTA_SKIP_ROUTES did NOT             (quota bypass: no)
 *
 * Result: probes without auth headers passed (200), but probes carrying any
 * junk credential — common with operational tooling — were treated as
 * authenticated requests and routed to the upstream quota service, which
 * 503'd. Bypass was credential-presence-gated, not path-name-gated.
 *
 * This test pins the contract: a path that appears in our canonical
 * "operational observability" set MUST appear in (or be covered by) all
 * three allowlists. If a future contributor adds an operational path to
 * one allowlist without the others, this test turns red — the gap
 * becomes a CI failure instead of a runtime 503.
 */

// ────────────────────────────────────────────────────────────────────────────
// TODO(user-decision): define the canonical set of operational paths that
// the three allowlists MUST agree on.
//
// Three valid scopes — pick one (or write your own):
//
//   (A) MINIMAL — only the path that already bit us:
//       const LOCKED_OPERATIONAL_PATHS = ['/v1/hcra/health'] as const;
//
//       Pro: defensible, narrow regression guard.
//       Con: doesn't surface the latent gap on /v1/status/health,
//            /health/ready, /.well-known/jwks.json etc.
//
//   (B) AGGRESSIVE — everything in OPERATIONAL_ROUTE_PATHS:
//       const LOCKED_OPERATIONAL_PATHS = OPERATIONAL_ROUTE_PATHS;
//
//       Pro: surfaces and forces fixes for all latent operational gaps.
//       Con: today this would FAIL — OPERATIONAL_ROUTE_PATHS has 11 paths
//            but DEFAULT_QUOTA_SKIP_ROUTES has only 3 of them. You'd need
//            to expand DEFAULT_QUOTA_SKIP_ROUTES first, then enable.
//
//   (C) CURATED — the operationally-critical subset that probes hit most:
//       const LOCKED_OPERATIONAL_PATHS = [
//         '/health',
//         '/metrics',
//         '/v1/hcra/health',
//         '/v1/status/health',
//       ] as const;
//
//       Pro: pragmatic — locks the high-signal operational surfaces.
//       Con: requires explicit judgment of which paths are "critical".
//
// Replace the line below with your choice.
const LOCKED_OPERATIONAL_PATHS: readonly string[] = [
  '/v1/hcra/health', // placeholder — start with option (A); broaden as appropriate
] as const;
// ────────────────────────────────────────────────────────────────────────────

/**
 * Each allowlist uses a slightly different matcher in production. We mirror
 * those rules here so the invariant test reflects real runtime behavior:
 *
 *   PUBLIC_ROUTES               → startsWith (loose)
 *   OPERATIONAL_ROUTE_PATHS     → exact OR prefix-with-slash (strict)
 *   DEFAULT_QUOTA_SKIP_ROUTES   → startsWith (loose)
 */
function isCoveredByPrefixList(path: string, list: readonly string[]): boolean {
  return list.some((entry) => path.startsWith(entry));
}

function isCoveredByExactOrSlashList(path: string, list: readonly string[]): boolean {
  return list.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

describe('SYNC INVARIANT — operational paths must appear in all three allowlists', () => {
  it.each(LOCKED_OPERATIONAL_PATHS.map((p) => [p]))(
    '%s is covered by PUBLIC_ROUTES (auth bypass)',
    (path) => {
      expect(isCoveredByPrefixList(path, PUBLIC_ROUTES)).toBe(true);
    }
  );

  it.each(LOCKED_OPERATIONAL_PATHS.map((p) => [p]))(
    '%s is covered by OPERATIONAL_ROUTE_PATHS (rate-limit bypass)',
    (path) => {
      expect(isCoveredByExactOrSlashList(path, OPERATIONAL_ROUTE_PATHS)).toBe(true);
    }
  );

  it.each(LOCKED_OPERATIONAL_PATHS.map((p) => [p]))(
    '%s is covered by DEFAULT_QUOTA_SKIP_ROUTES (quota bypass)',
    (path) => {
      expect(isCoveredByPrefixList(path, DEFAULT_QUOTA_SKIP_ROUTES)).toBe(true);
    }
  );

  // Sanity: the test would actually fail if an operational path were missing.
  // We verify the assertion logic itself by checking a non-allowlisted path
  // (a normal product route) is NOT covered by any list.
  it('sanity: a product route is NOT covered by any allowlist', () => {
    const productRoute = '/v1/chat/completions';
    expect(isCoveredByPrefixList(productRoute, PUBLIC_ROUTES)).toBe(false);
    expect(isCoveredByExactOrSlashList(productRoute, OPERATIONAL_ROUTE_PATHS)).toBe(false);
    expect(isCoveredByPrefixList(productRoute, DEFAULT_QUOTA_SKIP_ROUTES)).toBe(false);
  });
});
