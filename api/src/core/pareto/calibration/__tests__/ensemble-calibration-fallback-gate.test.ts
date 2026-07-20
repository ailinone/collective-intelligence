// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ensemble-calibration-fallback-gate.test.ts — MVP 8B.7
 *
 * Dedicated test for the central regression: a task type CANNOT be
 * approved when `fallback_rate=1.0` or `non_fallback_rate < minNonFallbackRate`.
 */

import { describe, expect, it } from 'vitest';
import { decideTaskTypeApproval } from '../tasktype-ensemble-approval';
import { resolveEnsembleLiftPolicy } from '../ensemble-lift-policy';

describe('fallback gate — closes the MVP 8B.6 gap', () => {
  it('default policy: fallback_rate=1.0 always blocks regardless of other metrics', () => {
    const policy = resolveEnsembleLiftPolicy();
    const r = decideTaskTypeApproval({
      taskType: 'code-generation',
      trainSamples: 1000,
      holdoutSamples: 500,
      expectedVsObservedJudgeError: 0.01, // perfect
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

  it('non_fallback_rate=0.49 blocks under default minNonFallbackRate=0.50', () => {
    const policy = resolveEnsembleLiftPolicy();
    const r = decideTaskTypeApproval({
      taskType: 'code-generation',
      trainSamples: 100,
      holdoutSamples: 50,
      expectedVsObservedJudgeError: 0.18,
      qualityAndCostSuccessRate: 0.9,
      costLeSingleRate: 0.9,
      qualityGeSingleRate: 0.9,
      nonFallbackRate: 0.49,
      fallbackRate: 0.51,
      policy,
    });
    expect(r.approved).toBe(false);
    expect(r.status).toBe('blocked_fallback_only');
  });

  it('non_fallback_rate=0.50 just barely passes the fallback gate', () => {
    const policy = resolveEnsembleLiftPolicy();
    const r = decideTaskTypeApproval({
      taskType: 'code-generation',
      trainSamples: 100,
      holdoutSamples: 50,
      expectedVsObservedJudgeError: 0.18,
      qualityAndCostSuccessRate: 0.9,
      costLeSingleRate: 0.9,
      qualityGeSingleRate: 0.9,
      nonFallbackRate: 0.5,
      fallbackRate: 0.5,
      policy,
    });
    expect(r.approved).toBe(true);
  });

  it('allowTaskTypeApprovalWithFallbackOnly=true permits fallback approval (exception)', () => {
    const policy = resolveEnsembleLiftPolicy({
      allowTaskTypeApprovalWithFallbackOnly: true,
    });
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
    expect(r.approved).toBe(true);
  });

  it('reasons array surfaces the fallback gate violation', () => {
    const policy = resolveEnsembleLiftPolicy();
    const r = decideTaskTypeApproval({
      taskType: 'code-generation',
      trainSamples: 100,
      holdoutSamples: 50,
      expectedVsObservedJudgeError: 0.18,
      qualityAndCostSuccessRate: 1.0,
      costLeSingleRate: 1.0,
      qualityGeSingleRate: 1.0,
      nonFallbackRate: 0.1,
      fallbackRate: 0.9,
      policy,
    });
    expect(r.reasons.some((s) => s.indexOf('nonFallbackRate') !== -1)).toBe(true);
  });
});
