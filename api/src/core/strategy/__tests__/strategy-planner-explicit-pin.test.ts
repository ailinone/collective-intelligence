// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-planner-explicit-pin.test.ts — MVP 5B
 *
 * Explicit Model Pin Invariant at the planner layer:
 *   - With pin, only the pinned candidate is planned.
 *   - allowFallbackForExplicitPin=true still does NOT substitute in MVP 5B.
 *   - No candidate matches pin → no_viable_strategy.
 */

import { describe, expect, it } from 'vitest';
import { planStrategy } from '../strategy-planner';
import { HIGH_RISK_CONTEXT, makeResult, STANDARD_CONTEXT } from './fixtures/strategy-fixtures';

describe('planStrategy — explicit pin by routeId', () => {
  it('matches → single_best on pinned route, no alternative selected', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-pinned' }),
        makeResult({ routeId: 'r-alt-1', totalScore: 0.95 }),
        makeResult({ routeId: 'r-alt-2', totalScore: 0.85 }),
      ],
      context: {
        ...STANDARD_CONTEXT,
        explicitModelPin: {
          source: 'request_modelPin',
          routeId: 'r-pinned',
          allowSubstitution: false,
        },
      },
    });
    expect(result.plan.strategy).toBe('single_best');
    expect(result.plan.selectedRouteIds).toEqual(['r-pinned']);
    expect(result.plan.fallbackRouteIds).toEqual([]); // policy.allowFallbackForExplicitPin = false default
    expect(result.plan.reasons).toContain('explicit_pin_present');
    expect(result.plan.constraintsApplied).toContain('explicit_pin');
  });

  it('non-matching pin → no_viable_strategy', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1' }),
        makeResult({ routeId: 'r-2' }),
      ],
      context: {
        ...STANDARD_CONTEXT,
        explicitModelPin: {
          source: 'request_modelPin',
          routeId: 'r-does-not-exist',
          allowSubstitution: false,
        },
      },
    });
    expect(result.plan.strategy).toBe('no_viable_strategy');
    expect(result.plan.reasons).toContain('pin_set_but_no_candidate_matches');
  });
});

describe('planStrategy — explicit pin by offeringId', () => {
  it('matches by offeringId', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1', offeringId: 'off-1' }),
        makeResult({ routeId: 'r-2', offeringId: 'off-2' }),
      ],
      context: {
        ...STANDARD_CONTEXT,
        explicitModelPin: {
          source: 'experiment_pin',
          offeringId: 'off-2',
          allowSubstitution: false,
        },
      },
    });
    expect(result.plan.selectedRouteIds).toEqual(['r-2']);
  });
});

describe('planStrategy — explicit pin by canonicalModelId', () => {
  it('matches by canonicalModelId', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1', canonicalModelId: 'c-1' }),
        makeResult({ routeId: 'r-2', canonicalModelId: 'c-2' }),
      ],
      context: {
        ...STANDARD_CONTEXT,
        explicitModelPin: {
          source: 'internal_pin',
          canonicalModelId: 'c-2',
          allowSubstitution: false,
        },
      },
    });
    expect(result.plan.selectedRouteIds).toEqual(['r-2']);
  });
});

describe('planStrategy — pin overrides high-risk collective strategy', () => {
  it('high risk + 3 candidates + pin → single_best on pin (NOT consensus)', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-pinned' }),
        makeResult({ routeId: 'r-2' }),
        makeResult({ routeId: 'r-3' }),
      ],
      context: {
        ...HIGH_RISK_CONTEXT,
        explicitModelPin: {
          source: 'request_modelPin',
          routeId: 'r-pinned',
          allowSubstitution: false,
        },
      },
    });
    expect(result.plan.strategy).toBe('single_best');
    expect(result.plan.selectedRouteIds).toEqual(['r-pinned']);
  });
});

describe('planStrategy — allowFallbackForExplicitPin true does NOT substitute', () => {
  it('policy allows fallback BUT MVP 5B planner records intent without substituting', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-pinned' }),
        makeResult({ routeId: 'r-alt-healthy' }),
      ],
      context: {
        ...STANDARD_CONTEXT,
        explicitModelPin: {
          source: 'request_modelPin',
          routeId: 'r-pinned',
          allowSubstitution: true,
          authorizingPolicy: 'experiment.allowSubstitution',
        },
      },
      policy: { allowFallbackForExplicitPin: true },
    });
    expect(result.plan.strategy).toBe('single_best');
    expect(result.plan.selectedRouteIds).toEqual(['r-pinned']);
    // The reason captures the future-policy hint without actually substituting.
    expect(result.plan.reasons).toContain(
      'policy_allows_fallback_but_mvp_5b_does_not_substitute',
    );
  });
});
