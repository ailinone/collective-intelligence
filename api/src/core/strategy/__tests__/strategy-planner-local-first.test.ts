// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-planner-local-first.test.ts — MVP 5B
 *
 * Privacy mode handling.
 */

import { describe, expect, it } from 'vitest';
import { planStrategy } from '../strategy-planner';
import {
  LOCAL_PREFERRED_CONTEXT,
  LOCAL_REQUIRED_CONTEXT,
  STANDARD_CONTEXT,
  makeResult,
  makeRoutesInfo,
} from './fixtures/strategy-fixtures';

describe('planStrategy — privacy local_required', () => {
  it('with local candidate available → single_best on local', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-local',
          breakdownOverrides: { localPreference: 1 },
        }),
      ],
      context: LOCAL_REQUIRED_CONTEXT,
    });
    expect(result.plan.selectedRouteIds).toEqual(['r-local']);
  });

  it('with NO local candidate (only cloud) → no_viable_strategy', () => {
    // localPreference=0 with privacy_local_required ⇒ not classified as local.
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-cloud',
          breakdownOverrides: { localPreference: 0 },
        }),
      ],
      context: LOCAL_REQUIRED_CONTEXT,
    });
    expect(result.plan.strategy).toBe('no_viable_strategy');
    expect(result.plan.reasons).toContain('privacy_local_required_no_local_candidate');
  });

  it('with routesInfo carrying routeKind: external routes ignored', () => {
    const result = planStrategy({
      candidates: [
        makeResult({ routeId: 'r-cloud' }), // no localPreference
        makeResult({
          routeId: 'r-local-vllm',
          breakdownOverrides: { localPreference: 1 },
        }),
      ],
      context: LOCAL_REQUIRED_CONTEXT,
      routesInfo: makeRoutesInfo([
        { routeId: 'r-cloud', routeKind: 'native' },
        { routeId: 'r-local-vllm', routeKind: 'self_hosted' },
      ]),
    });
    expect(result.plan.selectedRouteIds).toEqual(['r-local-vllm']);
  });
});

describe('planStrategy — privacy local_preferred', () => {
  it('competitive local (score ratio >= 0.7) → local_first', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-cloud',
          totalScore: 0.9,
          breakdownOverrides: { localPreference: 0 },
        }),
        makeResult({
          routeId: 'r-local',
          totalScore: 0.7, // 0.7 / 0.9 = 0.778, above ratio
          breakdownOverrides: { localPreference: 1 },
        }),
      ],
      context: LOCAL_PREFERRED_CONTEXT,
    });
    expect(result.plan.strategy).toBe('local_first');
    expect(result.plan.selectedRouteIds).toEqual(['r-local']);
  });

  it('non-competitive local (ratio < 0.7) → falls through to default', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-cloud',
          totalScore: 0.95,
          breakdownOverrides: { localPreference: 0 },
        }),
        makeResult({
          routeId: 'r-local-weak',
          totalScore: 0.3, // 0.3 / 0.95 = 0.316, below ratio
          breakdownOverrides: { localPreference: 1 },
        }),
      ],
      context: LOCAL_PREFERRED_CONTEXT,
    });
    expect(result.plan.strategy).not.toBe('local_first');
    // local_first is in rejectedStrategies with reason.
    const rejection = result.rejectedStrategies.find((r) => r.strategy === 'local_first');
    expect(rejection).toBeDefined();
    expect(rejection?.reason).toBe('local_score_below_competitive_ratio');
  });

  it('no local candidate → local_first rejected with reason no_local_candidates', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-cloud',
          breakdownOverrides: { localPreference: 0 },
        }),
      ],
      context: LOCAL_PREFERRED_CONTEXT,
    });
    expect(result.plan.strategy).not.toBe('local_first');
    const rejection = result.rejectedStrategies.find((r) => r.strategy === 'local_first');
    expect(rejection?.reason).toBe('no_local_candidates');
  });
});

describe('planStrategy — privacy standard', () => {
  it('local candidates receive NO special preference; default rules apply', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-cloud-top',
          totalScore: 0.95,
        }),
        makeResult({
          routeId: 'r-local',
          totalScore: 0.6,
          // localPreference=0 because mode is 'standard'.
          breakdownOverrides: { localPreference: 0 },
        }),
      ],
      context: STANDARD_CONTEXT,
    });
    expect(result.plan.strategy).toBe('single_best');
    expect(result.plan.selectedRouteIds).toEqual(['r-cloud-top']);
  });
});

describe('planStrategy — local_required with routesInfo', () => {
  it('cloud routes in fallback are NOT introduced (only local in result)', () => {
    const result = planStrategy({
      candidates: [
        makeResult({
          routeId: 'r-local-a',
          totalScore: 0.7,
          breakdownOverrides: { localPreference: 1 },
        }),
        makeResult({
          routeId: 'r-local-b',
          totalScore: 0.6,
          breakdownOverrides: { localPreference: 1 },
        }),
        makeResult({
          routeId: 'r-cloud',
          totalScore: 0.9,
          breakdownOverrides: { localPreference: 0 },
        }),
      ],
      context: LOCAL_REQUIRED_CONTEXT,
      routesInfo: makeRoutesInfo([
        { routeId: 'r-local-a', routeKind: 'local' },
        { routeId: 'r-local-b', routeKind: 'local' },
        { routeId: 'r-cloud', routeKind: 'native' },
      ]),
    });
    // r-cloud must NOT appear in selectedRouteIds or fallbackRouteIds.
    expect(result.plan.selectedRouteIds).not.toContain('r-cloud');
    expect(result.plan.fallbackRouteIds).not.toContain('r-cloud');
  });
});
