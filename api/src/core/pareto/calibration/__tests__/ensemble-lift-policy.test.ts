// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-lift-policy.test.ts — MVP 8B.7
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENSEMBLE_LIFT_POLICY,
  resolveEnsembleLiftPolicy,
} from '../ensemble-lift-policy';

describe('DEFAULT_ENSEMBLE_LIFT_POLICY', () => {
  it('is strict by default', () => {
    const p = DEFAULT_ENSEMBLE_LIFT_POLICY;
    expect(p.minNonFallbackRate).toBe(0.5);
    expect(p.minExpectedJudgeRatioVsSingle).toBe(1.0);
    expect(p.maxCostRatioVsSingle).toBe(1.0);
    expect(p.allowTaskTypeApprovalWithFallbackOnly).toBe(false);
    expect(p.maxTotalLift).toBe(0.2);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_ENSEMBLE_LIFT_POLICY)).toBe(true);
  });
});

describe('resolveEnsembleLiftPolicy', () => {
  it('returns defaults without override', () => {
    expect(resolveEnsembleLiftPolicy()).toBe(DEFAULT_ENSEMBLE_LIFT_POLICY);
  });

  it('merges override on top of defaults', () => {
    const p = resolveEnsembleLiftPolicy({ maxTotalLift: 0.4, minNonFallbackRate: 0.3 });
    expect(p.maxTotalLift).toBe(0.4);
    expect(p.minNonFallbackRate).toBe(0.3);
    expect(p.maxCostRatioVsSingle).toBe(1.0);
  });

  it('frozen output', () => {
    const p = resolveEnsembleLiftPolicy({ maxTotalLift: 0.4 });
    expect(Object.isFrozen(p)).toBe(true);
  });
});
