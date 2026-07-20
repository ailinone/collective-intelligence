// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1G §17.5 — Collective cost-benefit estimate.
 */
import { describe, it, expect } from 'vitest';
import { estimateCollectiveCostBenefit } from '@/core/orchestration/role-selection/synthesizer-role-policy';

describe('01C.1B-J1G §17.5 — collective cost-benefit', () => {
  it('passes when collective cost <= baseline cost', () => {
    const r = estimateCollectiveCostBenefit({
      synthesizerCost: 0.005,
      participantCosts: [0.001, 0.001, 0.001],
      judgeCost: 0.002,
      baselineSingleModelId: 'claude-opus-4-7',
      baselineSingleModelCostUsd: 0.015,
    });
    expect(r.pass).toBe(true);
    expect(r.reason).toBe('collective_cost_within_baseline');
    expect(r.costRatioVsBaseline).toBeLessThanOrEqual(1.0);
  });

  it('passes when collective > baseline IF quality gain >= 1.2', () => {
    const r = estimateCollectiveCostBenefit({
      synthesizerCost: 0.020,
      participantCosts: [0.005, 0.005, 0.005],
      judgeCost: 0.005,
      baselineSingleModelId: 'gpt-4o',
      baselineSingleModelCostUsd: 0.015,
      expectedQualityGainScore: 1.3,
    });
    expect(r.pass).toBe(true);
    expect(r.reason).toContain('quality_gain_justifies');
  });

  it('fails when collective > baseline AND no quality gain', () => {
    const r = estimateCollectiveCostBenefit({
      synthesizerCost: 0.020,
      participantCosts: [0.005, 0.005, 0.005],
      judgeCost: 0.005,
      baselineSingleModelId: 'gpt-4o',
      baselineSingleModelCostUsd: 0.015,
      // no expectedQualityGainScore — defaults to 1.0 (no advantage)
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('exceeds_baseline_without_quality_premium');
  });

  it('handles fallback cost', () => {
    const r = estimateCollectiveCostBenefit({
      synthesizerCost: 0.005,
      participantCosts: [0.001, 0.001, 0.001],
      judgeCost: 0.002,
      fallbackCost: 0.003,
      baselineSingleModelId: 'baseline',
      baselineSingleModelCostUsd: 0.020,
    });
    expect(r.estimatedCollectiveCostUsd).toBeCloseTo(0.013);
    expect(r.pass).toBe(true);
  });

  it('emits cost ratio for transparency', () => {
    const r = estimateCollectiveCostBenefit({
      synthesizerCost: 0.010,
      participantCosts: [0.002, 0.002, 0.002],
      judgeCost: 0.001,
      baselineSingleModelId: 'b',
      baselineSingleModelCostUsd: 0.020,
    });
    expect(r.costRatioVsBaseline).toBeCloseTo(0.85, 2);
  });
});
