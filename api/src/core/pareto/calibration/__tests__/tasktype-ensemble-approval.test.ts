// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * tasktype-ensemble-approval.test.ts — MVP 8B.7
 */

import { describe, expect, it } from 'vitest';
import { decideTaskTypeApproval } from '../tasktype-ensemble-approval';
import { DEFAULT_ENSEMBLE_LIFT_POLICY } from '../ensemble-lift-policy';

const policy = DEFAULT_ENSEMBLE_LIFT_POLICY;

describe('decideTaskTypeApproval', () => {
  it('approves code-generation with low error + good non-fallback rate', () => {
    const r = decideTaskTypeApproval({
      taskType: 'code-generation',
      trainSamples: 100,
      holdoutSamples: 50,
      expectedVsObservedJudgeError: 0.18,
      qualityAndCostSuccessRate: 0.9,
      costLeSingleRate: 0.95,
      qualityGeSingleRate: 0.9,
      nonFallbackRate: 0.7,
      fallbackRate: 0.3,
      policy,
    });
    expect(r.approved).toBe(true);
    expect(r.status).toBe('approved');
  });

  it('blocks code-generation when judge error > 0.25', () => {
    const r = decideTaskTypeApproval({
      taskType: 'code-generation',
      trainSamples: 100,
      holdoutSamples: 50,
      expectedVsObservedJudgeError: 0.4,
      qualityAndCostSuccessRate: 0.9,
      costLeSingleRate: 0.95,
      qualityGeSingleRate: 0.9,
      nonFallbackRate: 0.7,
      fallbackRate: 0.3,
      policy,
    });
    expect(r.approved).toBe(false);
    expect(r.status).toBe('blocked_high_error');
  });

  it('blocks when nonFallbackRate < policy.minNonFallbackRate', () => {
    const r = decideTaskTypeApproval({
      taskType: 'code-generation',
      trainSamples: 100,
      holdoutSamples: 50,
      expectedVsObservedJudgeError: 0.18,
      qualityAndCostSuccessRate: 1.0,
      costLeSingleRate: 1.0,
      qualityGeSingleRate: 1.0,
      nonFallbackRate: 0.2,
      fallbackRate: 0.8,
      policy,
    });
    expect(r.approved).toBe(false);
    expect(r.status).toBe('blocked_fallback_only');
  });

  it('NEVER approves when fallback_rate = 1.0 (the MVP 8B.6 bug)', () => {
    const r = decideTaskTypeApproval({
      taskType: 'code-generation',
      trainSamples: 100,
      holdoutSamples: 50,
      expectedVsObservedJudgeError: 0.18,
      qualityAndCostSuccessRate: 1.0,
      costLeSingleRate: 1.0,
      qualityGeSingleRate: 1.0,
      nonFallbackRate: 0.0,
      fallbackRate: 1.0,
      policy,
    });
    expect(r.approved).toBe(false);
    expect(r.status).toBe('blocked_fallback_only');
  });

  it('blocks insufficient_data when train/holdout below thresholds', () => {
    const r = decideTaskTypeApproval({
      taskType: 'reasoning',
      trainSamples: 5,
      holdoutSamples: 3,
      expectedVsObservedJudgeError: 0.18,
      qualityAndCostSuccessRate: 1.0,
      costLeSingleRate: 1.0,
      qualityGeSingleRate: 1.0,
      nonFallbackRate: 0.7,
      fallbackRate: 0.3,
      policy,
    });
    expect(r.approved).toBe(false);
    expect(r.status).toBe('blocked_insufficient_data');
  });

  it('blocks_cost when cost_le_single_rate < 0.85', () => {
    const r = decideTaskTypeApproval({
      taskType: 'analysis',
      trainSamples: 100,
      holdoutSamples: 50,
      expectedVsObservedJudgeError: 0.2,
      qualityAndCostSuccessRate: 0.5,
      costLeSingleRate: 0.5,
      qualityGeSingleRate: 0.95,
      nonFallbackRate: 0.8,
      fallbackRate: 0.2,
      policy,
    });
    expect(r.approved).toBe(false);
    expect(r.status).toBe('blocked_cost');
  });

  it('blocks_quality when quality_ge_single_rate < 0.85', () => {
    const r = decideTaskTypeApproval({
      taskType: 'analysis',
      trainSamples: 100,
      holdoutSamples: 50,
      expectedVsObservedJudgeError: 0.2,
      qualityAndCostSuccessRate: 0.5,
      costLeSingleRate: 0.95,
      qualityGeSingleRate: 0.5,
      nonFallbackRate: 0.8,
      fallbackRate: 0.2,
      policy,
    });
    expect(r.approved).toBe(false);
    expect(r.status).toBe('blocked_quality');
  });

  it('output is frozen', () => {
    const r = decideTaskTypeApproval({
      taskType: 'code-generation',
      trainSamples: 100,
      holdoutSamples: 50,
      expectedVsObservedJudgeError: 0.18,
      qualityAndCostSuccessRate: 0.9,
      costLeSingleRate: 0.95,
      qualityGeSingleRate: 0.9,
      nonFallbackRate: 0.7,
      fallbackRate: 0.3,
      policy,
    });
    expect(Object.isFrozen(r)).toBe(true);
  });
});
