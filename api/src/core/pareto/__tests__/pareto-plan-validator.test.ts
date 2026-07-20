// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-plan-validator.test.ts — MVP 8A
 *
 * Direct tests for the EnsemblePlan validator. The Pareto optimizer
 * itself emits valid plans; this file verifies the validator catches
 * tampered plans.
 */

import { describe, expect, it } from 'vitest';
import { validateEnsemblePlan } from '../ensemble-plan-validator';
import { DEFAULT_COLLECTIVE_SELECTION_POLICY } from '../collective-selection-policy';
import type { EnsemblePlan } from '../ensemble-plan-types';

function basePlan(overrides: Partial<EnsemblePlan> = {}): EnsemblePlan {
  return {
    strategyId: 'parallel',
    selectedRouteIds: ['r1', 'r2'],
    selectedModelIds: ['m1', 'm2'],
    expectedJudge: 0.8,
    expectedCostUsd: 0.02,
    expectedQualityPerDollar: 40,
    baselineJudge: 0.6,
    baselineCostUsd: 0.022,
    paretoStatus: 'beats_baseline',
    marginalContributions: [
      { modelId: 'm1', marginalQualityGain: 0.7, marginalCostUsd: 0.01, accepted: true, reason: 'seed' },
      { modelId: 'm2', marginalQualityGain: 0.1, marginalCostUsd: 0.01, accepted: true, reason: 'lift' },
    ],
    rejectedCandidates: [],
    explanation: 'test',
    ...overrides,
  };
}

describe('validateEnsemblePlan', () => {
  it('valid plan passes', () => {
    const r = validateEnsemblePlan(basePlan(), DEFAULT_COLLECTIVE_SELECTION_POLICY);
    expect(r.valid).toBe(true);
    expect(r.errors.length).toBe(0);
  });

  it('mismatched route/model length errors', () => {
    const r = validateEnsemblePlan(
      basePlan({ selectedRouteIds: ['r1'], selectedModelIds: ['m1', 'm2'] }),
      DEFAULT_COLLECTIVE_SELECTION_POLICY,
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.indexOf('route_model_length_mismatch') !== -1)).toBe(true);
  });

  it('below minModels errors', () => {
    const r = validateEnsemblePlan(
      basePlan({
        selectedRouteIds: ['r1'],
        selectedModelIds: ['m1'],
        marginalContributions: [
          { modelId: 'm1', marginalQualityGain: 0.7, marginalCostUsd: 0.01, accepted: true, reason: 'seed' },
        ],
      }),
      DEFAULT_COLLECTIVE_SELECTION_POLICY,
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.indexOf('below_minModels') !== -1)).toBe(true);
  });

  it('single_fallback with N=1 passes', () => {
    const r = validateEnsemblePlan(
      basePlan({
        strategyId: 'single_fallback',
        selectedRouteIds: ['r1'],
        selectedModelIds: ['m1'],
        paretoStatus: 'single_fallback',
        marginalContributions: [
          { modelId: 'm1', marginalQualityGain: 0.7, marginalCostUsd: 0.01, accepted: true, reason: 'seed' },
        ],
      }),
      DEFAULT_COLLECTIVE_SELECTION_POLICY,
    );
    expect(r.valid).toBe(true);
  });

  it('expectedJudge out of [0..1] errors', () => {
    const r = validateEnsemblePlan(
      basePlan({ expectedJudge: 1.5 }),
      DEFAULT_COLLECTIVE_SELECTION_POLICY,
    );
    expect(r.errors.some((e) => e.indexOf('expectedJudge_out_of_range') !== -1)).toBe(true);
  });

  it('paretoStatus mismatch errors', () => {
    const r = validateEnsemblePlan(
      basePlan({ paretoStatus: 'dominated' }), // judge >= baseline AND cost <= baseline → should be beats_baseline
      DEFAULT_COLLECTIVE_SELECTION_POLICY,
    );
    expect(r.errors.some((e) => e.indexOf('paretoStatus_mismatch') !== -1)).toBe(true);
  });

  it('duplicate model id errors', () => {
    const r = validateEnsemblePlan(
      basePlan({
        selectedRouteIds: ['r1', 'r2'],
        selectedModelIds: ['m1', 'm1'],
      }),
      DEFAULT_COLLECTIVE_SELECTION_POLICY,
    );
    expect(r.errors.some((e) => e.indexOf('duplicate_model_id') !== -1)).toBe(true);
  });

  it('collective plan with empty marginalContributions errors', () => {
    const r = validateEnsemblePlan(
      basePlan({ marginalContributions: [] }),
      DEFAULT_COLLECTIVE_SELECTION_POLICY,
    );
    expect(r.errors.some((e) => e.indexOf('collective_plan_missing_marginal_records') !== -1)).toBe(true);
  });
});
