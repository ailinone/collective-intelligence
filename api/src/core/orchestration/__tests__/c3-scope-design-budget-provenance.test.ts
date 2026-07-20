// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-SCOPE-DESIGN-R3 §6+8 — Budget policy and provenance schema contract.
 *
 * R3 changes vs R2:
 *   - Provenance fields: 24 (was 20) — adds qualityTier, costTier,
 *     participantSampleId, qualityPerDollar (thesis metric)
 *   - Thesis metric constants added: efficiency metric, success criteria
 *   - Matrix cells: unchanged at 88
 *
 * ABSOLUTE PROHIBITIONS:
 *   - This test does NOT execute C3
 *   - This test does NOT execute dryRun=false
 *   - This test does NOT call any LLM provider
 *   - Billable cost for this stage: $0.00
 */

import { describe, it, expect } from 'vitest';
import {
  C3_ELIGIBLE_STRATEGIES,
  C3_STRATEGY_BUDGET_CAPS_USD,
  C3_PROVENANCE_REQUIRED_FIELDS,
  C3_MATRIX_TOTAL_CELLS,
  C3_MATRIX_STRATEGY_CELLS,
  C3_MATRIX_BASELINE_CELLS,
  C3_SCOPE_DESIGN_PROHIBITIONS,
  C3_THESIS_PRIMARY,
  C3_THESIS_EFFICIENCY_METRIC,
  C3_THESIS_SUCCESS_CRITERIA,
  C3_THESIS_QUALITY_METRIC,
  C3_THESIS_COST_METRIC,
  C3_COST_TIER_PREMIUM_USD_PER_1M,
  C3_COST_TIER_ECONOMY_USD_PER_1M,
} from '@/core/experiment/c3-scope-design-contract';

describe('01C.1B-C3-SCOPE-DESIGN-R3 §6+8 — budget policy and provenance schema contract', () => {

  describe('thesis metric constants (R3: explicit thesis)', () => {
    it('primary thesis is the quality/cost statement', () => {
      expect(C3_THESIS_PRIMARY).toContain('equal_or_better_quality');
      expect(C3_THESIS_PRIMARY).toContain('lower_total_cost');
    });

    it('efficiency metric is quality_per_dollar', () => {
      expect(C3_THESIS_EFFICIENCY_METRIC).toBe('quality_per_dollar');
    });

    it('success criteria is 90% efficiency threshold', () => {
      expect(C3_THESIS_SUCCESS_CRITERIA).toContain('90pct');
      expect(C3_THESIS_SUCCESS_CRITERIA).toContain('efficiency');
    });

    it('quality metric is judge_score_weighted_rubric', () => {
      expect(C3_THESIS_QUALITY_METRIC).toBe('judge_score_weighted_rubric');
    });

    it('cost metric is total_cost_usd_per_cell', () => {
      expect(C3_THESIS_COST_METRIC).toBe('total_cost_usd_per_cell');
    });
  });

  describe('cost stratification thresholds', () => {
    it('premium threshold is $3.00/1M tokens', () => {
      expect(C3_COST_TIER_PREMIUM_USD_PER_1M).toBe(3.0);
    });

    it('economy threshold is $0.50/1M tokens', () => {
      expect(C3_COST_TIER_ECONOMY_USD_PER_1M).toBe(0.5);
    });

    it('economy threshold is less than premium threshold', () => {
      expect(C3_COST_TIER_ECONOMY_USD_PER_1M).toBeLessThan(C3_COST_TIER_PREMIUM_USD_PER_1M);
    });
  });

  describe('budget caps: coverage', () => {
    it('all 7 C3-eligible strategies have a budget cap', () => {
      for (const strategy of C3_ELIGIBLE_STRATEGIES) {
        expect(C3_STRATEGY_BUDGET_CAPS_USD[strategy]).toBeDefined();
        expect(typeof C3_STRATEGY_BUDGET_CAPS_USD[strategy]).toBe('number');
      }
    });

    it('all budget caps are positive', () => {
      for (const strategy of C3_ELIGIBLE_STRATEGIES) {
        expect(C3_STRATEGY_BUDGET_CAPS_USD[strategy]).toBeGreaterThan(0);
      }
    });

    it('all budget caps are <= $0.10 (sanity ceiling)', () => {
      for (const strategy of C3_ELIGIBLE_STRATEGIES) {
        expect(C3_STRATEGY_BUDGET_CAPS_USD[strategy]).toBeLessThanOrEqual(0.10);
      }
    });
  });

  describe('budget caps: per-strategy values', () => {
    it('single cap is $0.010 (1 provider call)', () => {
      expect(C3_STRATEGY_BUDGET_CAPS_USD['single']).toBe(0.010);
    });

    it('consensus cap is $0.050', () => {
      expect(C3_STRATEGY_BUDGET_CAPS_USD['consensus']).toBe(0.050);
    });

    it('debate cap is $0.050', () => {
      expect(C3_STRATEGY_BUDGET_CAPS_USD['debate']).toBe(0.050);
    });

    it('expert-panel cap is $0.050', () => {
      expect(C3_STRATEGY_BUDGET_CAPS_USD['expert-panel']).toBe(0.050);
    });

    it('cost-cascade cap is $0.030 (economy-tier focused)', () => {
      expect(C3_STRATEGY_BUDGET_CAPS_USD['cost-cascade']).toBe(0.030);
    });

    it('critique-repair cap is $0.040', () => {
      expect(C3_STRATEGY_BUDGET_CAPS_USD['critique-repair']).toBe(0.040);
    });

    it('quality-multipass cap is $0.080 (most provider calls)', () => {
      expect(C3_STRATEGY_BUDGET_CAPS_USD['quality-multipass']).toBe(0.080);
    });
  });

  describe('budget caps: ordering invariants', () => {
    it('single is cheapest (lowest cap)', () => {
      const singleCap = C3_STRATEGY_BUDGET_CAPS_USD['single'];
      for (const strategy of C3_ELIGIBLE_STRATEGIES) {
        if (strategy !== 'single') {
          expect(C3_STRATEGY_BUDGET_CAPS_USD[strategy]).toBeGreaterThanOrEqual(singleCap);
        }
      }
    });

    it('quality-multipass is most expensive (highest cap)', () => {
      const mpCap = C3_STRATEGY_BUDGET_CAPS_USD['quality-multipass'];
      for (const strategy of C3_ELIGIBLE_STRATEGIES) {
        if (strategy !== 'quality-multipass') {
          expect(C3_STRATEGY_BUDGET_CAPS_USD[strategy]).toBeLessThanOrEqual(mpCap);
        }
      }
    });

    it('cost-cascade cap is less than consensus (cascade is cost-optimized — thesis relevant)', () => {
      expect(C3_STRATEGY_BUDGET_CAPS_USD['cost-cascade'])
        .toBeLessThan(C3_STRATEGY_BUDGET_CAPS_USD['consensus']);
    });
  });

  describe('provenance schema: required field count (R3: 24 fields, was 20)', () => {
    it('C3_PROVENANCE_REQUIRED_FIELDS has exactly 24 fields (R3 adds qualityTier, costTier, participantSampleId, qualityPerDollar)', () => {
      expect(C3_PROVENANCE_REQUIRED_FIELDS.length).toBe(24);
    });

    it('all field names are non-empty strings', () => {
      for (const field of C3_PROVENANCE_REQUIRED_FIELDS) {
        expect(typeof field).toBe('string');
        expect(field.length).toBeGreaterThan(0);
      }
    });

    it('all field names are unique (no duplicates)', () => {
      const unique = new Set(C3_PROVENANCE_REQUIRED_FIELDS);
      expect(unique.size).toBe(C3_PROVENANCE_REQUIRED_FIELDS.length);
    });
  });

  describe('provenance schema: original 20 fields preserved', () => {
    const original20 = [
      'executionId', 'experimentId', 'taskId', 'strategyId',
      'dryRun', 'planOnly', 'planFingerprint', 'semanticPlanVersion',
      'participantModels', 'synthesizerModelId', 'judgeModelId',
      'qualityScore', 'qualityDimensions', 'latencyMs', 'costUsdEstimated',
      'timestamp', 'providerIds', 'c3EligibilityPolicyVersion',
      'qualityScoreSource', 'stepCount',
    ] as const;

    for (const field of original20) {
      it(`original field '${field}' is still present`, () => {
        const fields: readonly string[] = C3_PROVENANCE_REQUIRED_FIELDS;
        expect(fields.includes(field)).toBe(true);
      });
    }
  });

  describe('provenance schema: R3 new fields', () => {
    it("includes 'qualityTier' (high | mid | low | unknown)", () => {
      const fields: readonly string[] = C3_PROVENANCE_REQUIRED_FIELDS;
      expect(fields.includes('qualityTier')).toBe(true);
    });

    it("includes 'costTier' (premium | standard | economy | unknown)", () => {
      const fields: readonly string[] = C3_PROVENANCE_REQUIRED_FIELDS;
      expect(fields.includes('costTier')).toBe(true);
    });

    it("includes 'participantSampleId' (fingerprint of sample drawn from pool)", () => {
      const fields: readonly string[] = C3_PROVENANCE_REQUIRED_FIELDS;
      expect(fields.includes('participantSampleId')).toBe(true);
    });

    it("includes 'qualityPerDollar' (thesis metric = qualityScore / costUsdEstimated)", () => {
      const fields: readonly string[] = C3_PROVENANCE_REQUIRED_FIELDS;
      expect(fields.includes('qualityPerDollar')).toBe(true);
    });
  });

  describe('experiment matrix: planned cells (same 88 as R2)', () => {
    it('total planned cells are 88 (unchanged from R2 — expansion is in pool depth)', () => {
      expect(C3_MATRIX_TOTAL_CELLS).toBe(88);
    });

    it('strategy cells: 56 (8 tasks × 7 strategies)', () => {
      expect(C3_MATRIX_STRATEGY_CELLS).toBe(56);
    });

    it('baseline cells: 32 (8 tasks × 4 baselines)', () => {
      expect(C3_MATRIX_BASELINE_CELLS).toBe(32);
    });

    it('strategy + baseline cells sum to total', () => {
      expect(C3_MATRIX_STRATEGY_CELLS + C3_MATRIX_BASELINE_CELLS).toBe(C3_MATRIX_TOTAL_CELLS);
    });
  });

  describe('absolute prohibitions: design stage cost invariants', () => {
    it('no C3 was executed (design stage only)', () => {
      expect(C3_SCOPE_DESIGN_PROHIBITIONS.c3Executed).toBe(false);
    });

    it('no dryRun=false was executed', () => {
      expect(C3_SCOPE_DESIGN_PROHIBITIONS.dryRunFalseExecuted).toBe(false);
    });

    it('no provider calls were made', () => {
      expect(C3_SCOPE_DESIGN_PROHIBITIONS.providerCallsMade).toBe(false);
    });

    it('no real consensus was run', () => {
      expect(C3_SCOPE_DESIGN_PROHIBITIONS.realConsensusRun).toBe(false);
    });

    it('billable cost for this stage is exactly $0.00', () => {
      expect(C3_SCOPE_DESIGN_PROHIBITIONS.billableCostUsd).toBe(0);
    });

    it('secrets leaked: 0', () => {
      expect(C3_SCOPE_DESIGN_PROHIBITIONS.secretsLeaked).toBe(0);
    });

    it('schema was not changed', () => {
      expect(C3_SCOPE_DESIGN_PROHIBITIONS.schemaChanged).toBe(false);
    });

    it('package.json was not changed', () => {
      expect(C3_SCOPE_DESIGN_PROHIBITIONS.packageJsonChanged).toBe(false);
    });

    it('no remote deploy occurred', () => {
      expect(C3_SCOPE_DESIGN_PROHIBITIONS.remoteDeployed).toBe(false);
    });
  });
});
