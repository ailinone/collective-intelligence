// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for the boot-time operational-route invariant (Caminho C — chosen
 * 2026-04-25 as the closure for the HCRA `/v1/hcra/health` allowlist gap).
 *
 * Two falsifiers anchor this suite:
 *
 *   1. POSITIVE: with the current code, the invariant returns zero
 *      violations. If this test fails, it means a real allowlist
 *      regression has slipped past code review and the boot guard is
 *      doing its job.
 *
 *   2. NEGATIVE (the gap reproducer): with `/v1/hcra/health` removed
 *      from the gateway QUOTA_SKIP_ROUTES (the original bug), the
 *      invariant flags it specifically. This proves the guard catches
 *      the exact class of drift it is designed to catch.
 *
 * No mock-of-mock chicanery. We do this by re-importing the canonical
 * list with a temporary stub that omits the entry, and asserting on the
 * structured InvariantViolation list.
 */

describe('operational-route boot invariant', () => {
  it('returns zero violations against the current code (positive baseline)', async () => {
    const { checkOperationalRouteInvariant } = await import(
      '@/config/operational-routes-invariant'
    );
    const violations = checkOperationalRouteInvariant();
    // The current state of the three sibling lists honors every canonical
    // route. If you added a new entry to OPERATIONAL_ROUTES, you must
    // also add it to PUBLIC_ROUTES, OPERATIONAL_ROUTE_PATHS, and either
    // DEFAULT_QUOTA_SKIP_ROUTES or rely on a covering prefix that is
    // already present.
    expect(violations).toEqual([]);
  });

  it('flags the exact route that is missing from a sibling list (negative falsifier)', async () => {
    // Reproduce the original HCRA bug: simulate /v1/hcra/health absent
    // from the gateway quota skip list while present in the other two.
    // We do this by stubbing the QUOTA_SKIP_ROUTES export to an array
    // that intentionally omits /v1/hcra/health.
    vi.resetModules();
    vi.doMock('@/middleware/gateway_middleware', () => ({
      QUOTA_SKIP_ROUTES: ['/health', '/metrics', '/v1/enterprise/quotas'],
    }));

    const { checkOperationalRouteInvariant } = await import(
      '@/config/operational-routes-invariant'
    );
    const violations = checkOperationalRouteInvariant();

    // Find the specific violation for /v1/hcra/health
    const hcraViolation = violations.find((v) => v.route === '/v1/hcra/health');
    expect(hcraViolation).toBeDefined();
    expect(hcraViolation?.missingFrom).toContain(
      'QUOTA_SKIP_ROUTES (gateway_middleware)'
    );
    // Should NOT be flagged in the other two lists — they're correctly
    // configured with the route present.
    expect(hcraViolation?.missingFrom).not.toContain(
      'PUBLIC_ROUTES (api-key-auth-middleware)'
    );
    expect(hcraViolation?.missingFrom).not.toContain(
      'OPERATIONAL_ROUTE_PATHS (token-bucket-rate-limit)'
    );

    vi.doUnmock('@/middleware/gateway_middleware');
    vi.resetModules();
  });

  it('assertOperationalRouteInvariant throws with a formatted message when violations exist', async () => {
    vi.resetModules();
    vi.doMock('@/middleware/gateway_middleware', () => ({
      QUOTA_SKIP_ROUTES: [], // strip out everything → maximal violation
    }));

    const { assertOperationalRouteInvariant } = await import(
      '@/config/operational-routes-invariant'
    );

    expect(() => assertOperationalRouteInvariant()).toThrow(
      /OPERATIONAL ROUTE INVARIANT VIOLATION/
    );
    expect(() => assertOperationalRouteInvariant()).toThrow(
      /\/v1\/hcra\/health/
    );

    vi.doUnmock('@/middleware/gateway_middleware');
    vi.resetModules();
  });

  it('formatViolations produces a readable multi-line message with all missing-from labels', async () => {
    const { formatViolations } = await import(
      '@/config/operational-routes-invariant'
    );

    const message = formatViolations([
      {
        route: '/v1/hcra/health',
        missingFrom: [
          'PUBLIC_ROUTES (api-key-auth-middleware)',
          'QUOTA_SKIP_ROUTES (gateway_middleware)',
        ],
      },
    ]);

    expect(message).toContain('OPERATIONAL ROUTE INVARIANT VIOLATION');
    expect(message).toContain('/v1/hcra/health');
    expect(message).toContain('PUBLIC_ROUTES (api-key-auth-middleware)');
    expect(message).toContain('QUOTA_SKIP_ROUTES (gateway_middleware)');
    expect(message).toContain('Fix:');
  });
});
