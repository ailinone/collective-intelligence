// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-E — Cross-provider rescue gate (BaseStrategy).
 *
 * BaseStrategy historically had AUTO-RETRY that, on a balance/auth
 * failure, looked up alternative provider entries for the SAME model
 * and silently tried them — spending money the caller didn't authorize.
 * The 01C.1B billable probe revealed this rescued aiml/glm (403
 * insufficient credits) by switching to vercel-ai-gateway/glm, costing
 * $0.0095744.
 *
 * The fix in `base-strategy.ts` gates that rescue on
 * `request.eval?.maxRetriesPerProvider`:
 *   - `0` AND no explicit `allowCrossProviderRouteFallback=true` → skip rescue
 *   - any other value → preserve legacy rescue behavior (back-compat)
 *
 * These tests verify the gate decision logic by exercising the helper
 * that BaseStrategy's body now uses. We do NOT spin up the full
 * BaseStrategy class (that requires significant DB/registry setup);
 * instead we encapsulate the gate predicate so it's exercisable in
 * isolation.
 */
import { describe, it, expect } from 'vitest';

/**
 * Local copy of the gate predicate used inside base-strategy.ts.
 * Keep this in sync with the inline logic at the cross-provider
 * rescue block.
 */
function crossProviderRescueAllowed(
  evalBag: { maxRetriesPerProvider?: number; allowCrossProviderRouteFallback?: boolean } | undefined,
): boolean {
  const maxRetries = typeof evalBag?.maxRetriesPerProvider === 'number'
    ? evalBag.maxRetriesPerProvider
    : undefined;
  const allow = evalBag?.allowCrossProviderRouteFallback;
  return allow === true || (maxRetries === undefined && allow !== false);
}

describe('cross-provider rescue gate', () => {
  it('denies rescue when maxRetriesPerProvider=0 and no explicit allow flag', () => {
    expect(
      crossProviderRescueAllowed({ maxRetriesPerProvider: 0 }),
    ).toBe(false);
  });

  it('denies rescue when maxRetriesPerProvider=0 and allow=false', () => {
    expect(
      crossProviderRescueAllowed({
        maxRetriesPerProvider: 0,
        allowCrossProviderRouteFallback: false,
      }),
    ).toBe(false);
  });

  it('allows rescue when caller explicitly opts in even with 0 retries', () => {
    expect(
      crossProviderRescueAllowed({
        maxRetriesPerProvider: 0,
        allowCrossProviderRouteFallback: true,
      }),
    ).toBe(true);
  });

  it('preserves legacy behavior when no eval block is present (back-compat)', () => {
    expect(crossProviderRescueAllowed(undefined)).toBe(true);
    expect(crossProviderRescueAllowed({})).toBe(true);
  });

  it('denies rescue when maxRetries>0 but caller explicitly disables route fallback', () => {
    expect(
      crossProviderRescueAllowed({
        maxRetriesPerProvider: 3,
        allowCrossProviderRouteFallback: false,
      }),
    ).toBe(false);
  });

  it('denies rescue when maxRetries>0 without explicit allow flag', () => {
    // Per the 01C.1B-E policy, a positive retry budget means "retry N
    // times on the SAME provider". It does NOT authorize cross-provider
    // rescue — that requires an explicit `allowCrossProviderRouteFallback`
    // opt-in. The legacy unconditional rescue path is gone.
    expect(
      crossProviderRescueAllowed({ maxRetriesPerProvider: 3 }),
    ).toBe(false);
  });

  it('allows rescue when maxRetries>0 AND explicit allow=true', () => {
    expect(
      crossProviderRescueAllowed({
        maxRetriesPerProvider: 3,
        allowCrossProviderRouteFallback: true,
      }),
    ).toBe(true);
  });
});
