// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-SCOPE-DESIGN-R3 §1 — Strategy scope contract.
 *
 * R3 (Full Provider Expansion): eligibility gate changed from quality-score
 * to provider chat-ready + chat capability. Candidate pool expands from 10
 * to 934 known models. Main thesis added as typed contract constant.
 *
 * ABSOLUTE PROHIBITIONS:
 *   - This test does NOT execute C3
 *   - This test does NOT execute dryRun=false
 *   - This test does NOT call any LLM provider
 */

import { describe, it, expect } from 'vitest';
import {
  C3_ELIGIBLE_STRATEGIES,
  C3_EXCLUDED_ALIASES,
  C3_PROXY_ENDPOINTS,
  C3_BASELINES,
  FAST_STRATEGY_DECISION,
  C3_STRATEGY_STEP_COUNTS,
  C3_SCOPE_POLICY_VERSION,
  SM_R6_DECISION,
  J2C_HARDEN_DECISION,
  J1D_R4B_DECISION,
  J1D_R4D_DECISION,
  SEMANTIC_PLAN_VERSION_C3,
  C3_MATRIX_STRATEGY_CELLS,
  C3_MATRIX_BASELINE_CELLS,
  C3_MATRIX_TOTAL_CELLS,
  C3_SCOPE_DESIGN_PROHIBITIONS,
  C3_THESIS_PRIMARY,
  C3_THESIS_EFFICIENCY_METRIC,
  C3_THESIS_SUCCESS_CRITERIA,
  C3_PARTICIPANT_SAMPLE_SIZES,
  C3_R3_VS_R2,
} from '@/core/experiment/c3-scope-design-contract';
import { resolveExecutionStrategy } from '@/core/orchestration/strategy-contract';
import { buildPlanOnlyResult } from '@/core/orchestration/dry-run/strategy-plan-only-adapter';
import type { OrchestrationContext } from '@/types';

const CTX: OrchestrationContext = {
  requestId: 'c3-scope-design-strategy-scope-r3-001',
  taskType: 'general',
  qualityTarget: 0.85,
  preferSpeed: false,
  models: [
    { id: 'model-a', provider: 'openai' } as OrchestrationContext['models'][0],
    { id: 'model-b', provider: 'anthropic' } as OrchestrationContext['models'][0],
  ],
};
const REQ = {
  model: 'auto',
  messages: [{ role: 'user' as const, content: 'scope design test' }],
  dryRun: true as const,
};

describe('01C.1B-C3-SCOPE-DESIGN-R3 §1 — strategy scope contract', () => {

  describe('policy version', () => {
    it('C3_SCOPE_POLICY_VERSION is 01C.1B-C3-SCOPE-DESIGN-R4-v1 (R4 integrity lock)', () => {
      expect(C3_SCOPE_POLICY_VERSION).toBe('01C.1B-C3-SCOPE-DESIGN-R4-v1');
    });

    it('SEMANTIC_PLAN_VERSION_C3 is 01c1b-sm-r6-v1', () => {
      expect(SEMANTIC_PLAN_VERSION_C3).toBe('01c1b-sm-r6-v1');
    });
  });

  describe('source decisions', () => {
    it('SM_R6_DECISION is the correct phrase', () => {
      expect(SM_R6_DECISION).toBe('CONSENSUS_01C_1B_SM_R6_STRATEGY_SEMANTIC_PLAN_DEPTH_COMPLETE');
    });

    it('J2C_HARDEN_DECISION is the correct phrase', () => {
      expect(J2C_HARDEN_DECISION).toBe('CONSENSUS_01C_1B_J2C_R6_HARDEN_C3_BLOCKED_BY_MEDIUM_CONFIDENCE_MODELS');
    });

    it('J1D_R4B_DECISION is the correct phrase (was inventory sample, not full universe)', () => {
      expect(J1D_R4B_DECISION).toBe('CONSENSUS_01C_1B_J1D_R4B_INVENTORY_READY_FOR_CONTEXT_WINDOW_AND_DIVERSITY_FIX');
    });

    it('J1D_R4D_DECISION is the correct phrase', () => {
      expect(J1D_R4D_DECISION).toBe('CONSENSUS_01C_1B_J1D_R4D_STRICT_EXECUTABLE_READY_FOR_QUALITY_COVERAGE');
    });
  });

  describe('main thesis (R3: explicit contract)', () => {
    it('C3_THESIS_PRIMARY is the quality/cost thesis statement', () => {
      expect(C3_THESIS_PRIMARY).toContain('equal_or_better_quality');
      expect(C3_THESIS_PRIMARY).toContain('lower_total_cost');
    });

    it('C3_THESIS_EFFICIENCY_METRIC is quality_per_dollar', () => {
      expect(C3_THESIS_EFFICIENCY_METRIC).toBe('quality_per_dollar');
    });

    it('C3_THESIS_SUCCESS_CRITERIA is the 90% efficiency threshold', () => {
      expect(C3_THESIS_SUCCESS_CRITERIA).toContain('90pct');
    });
  });

  describe('R3 vs R2 delta markers', () => {
    it('R3 candidate pool is 934 (was 10 in R2)', () => {
      expect(C3_R3_VS_R2.candidatePool.r3).toBe(934);
      expect(C3_R3_VS_R2.candidatePool.r2).toBe(10);
    });

    it('R3 chat-ready providers is 17 (was 4 in R2)', () => {
      expect(C3_R3_VS_R2.chatReadyProviders.r3).toBe(17);
      expect(C3_R3_VS_R2.chatReadyProviders.r2).toBe(4);
    });

    it('R3 eligibility gate is chat_ready_provider_and_capability (not quality_score)', () => {
      expect(C3_R3_VS_R2.eligibilityGate.r3).toBe('chat_ready_provider_and_capability');
      expect(C3_R3_VS_R2.eligibilityGate.r2).toBe('quality_score_required');
    });

    it('R3 thesis is explicit (was false in R2)', () => {
      expect(C3_R3_VS_R2.thesisExplicit.r3).toBe(true);
      expect(C3_R3_VS_R2.thesisExplicit.r2).toBe(false);
    });
  });

  describe('C3 eligible strategies: count and membership', () => {
    it('C3_ELIGIBLE_STRATEGIES has exactly 7 entries', () => {
      expect(C3_ELIGIBLE_STRATEGIES.length).toBe(7);
    });

    it('contains single', () => expect(C3_ELIGIBLE_STRATEGIES).toContain('single'));
    it('contains consensus', () => expect(C3_ELIGIBLE_STRATEGIES).toContain('consensus'));
    it('contains debate', () => expect(C3_ELIGIBLE_STRATEGIES).toContain('debate'));
    it('contains expert-panel', () => expect(C3_ELIGIBLE_STRATEGIES).toContain('expert-panel'));
    it('contains cost-cascade', () => expect(C3_ELIGIBLE_STRATEGIES).toContain('cost-cascade'));
    it('contains critique-repair', () => expect(C3_ELIGIBLE_STRATEGIES).toContain('critique-repair'));
    it('contains quality-multipass', () => expect(C3_ELIGIBLE_STRATEGIES).toContain('quality-multipass'));
    it('does NOT contain fast', () => {
      const eligible: readonly string[] = C3_ELIGIBLE_STRATEGIES;
      expect(eligible.includes('fast')).toBe(false);
    });
    it('does NOT contain sensitivity-consensus', () => {
      const eligible: readonly string[] = C3_ELIGIBLE_STRATEGIES;
      expect(eligible.includes('sensitivity-consensus')).toBe(false);
    });
  });

  describe('step counts per C3 eligible strategy (SM-R6 contract)', () => {
    it('single has 1 step', () => expect(C3_STRATEGY_STEP_COUNTS['single']).toBe(1));
    it('consensus has 2 steps', () => expect(C3_STRATEGY_STEP_COUNTS['consensus']).toBe(2));
    it('debate has 2 steps', () => expect(C3_STRATEGY_STEP_COUNTS['debate']).toBe(2));
    it('expert-panel has 2 steps', () => expect(C3_STRATEGY_STEP_COUNTS['expert-panel']).toBe(2));
    it('cost-cascade has 4 steps', () => expect(C3_STRATEGY_STEP_COUNTS['cost-cascade']).toBe(4));
    it('critique-repair has 3 steps', () => expect(C3_STRATEGY_STEP_COUNTS['critique-repair']).toBe(3));
    it('quality-multipass has 4 steps', () => expect(C3_STRATEGY_STEP_COUNTS['quality-multipass']).toBe(4));
  });

  describe('participant sample sizes per strategy (R3: sampling from 934-model pool)', () => {
    it('all 7 strategies have a defined sample size', () => {
      for (const strategy of C3_ELIGIBLE_STRATEGIES) {
        expect(C3_PARTICIPANT_SAMPLE_SIZES[strategy]).toBeDefined();
        expect(typeof C3_PARTICIPANT_SAMPLE_SIZES[strategy]).toBe('number');
      }
    });

    it('single uses 1 participant', () => expect(C3_PARTICIPANT_SAMPLE_SIZES['single']).toBe(1));
    it('consensus uses 5 participants (tier-diverse sample)', () => expect(C3_PARTICIPANT_SAMPLE_SIZES['consensus']).toBe(5));
    it('debate uses 2 participants', () => expect(C3_PARTICIPANT_SAMPLE_SIZES['debate']).toBe(2));
    it('expert-panel uses 3 participants', () => expect(C3_PARTICIPANT_SAMPLE_SIZES['expert-panel']).toBe(3));
    it('cost-cascade uses 3 participants (economy-tier preferred)', () => expect(C3_PARTICIPANT_SAMPLE_SIZES['cost-cascade']).toBe(3));
    it('critique-repair uses 2 participants', () => expect(C3_PARTICIPANT_SAMPLE_SIZES['critique-repair']).toBe(2));
    it('quality-multipass uses 3 participants', () => expect(C3_PARTICIPANT_SAMPLE_SIZES['quality-multipass']).toBe(3));

    it('all sample sizes are positive integers', () => {
      for (const strategy of C3_ELIGIBLE_STRATEGIES) {
        const size = C3_PARTICIPANT_SAMPLE_SIZES[strategy];
        expect(size).toBeGreaterThan(0);
        expect(Number.isInteger(size)).toBe(true);
      }
    });

    it('consensus has the most participants (tier diversity requirement)', () => {
      const consensusSize = C3_PARTICIPANT_SAMPLE_SIZES['consensus'];
      for (const strategy of C3_ELIGIBLE_STRATEGIES) {
        if (strategy !== 'consensus') {
          expect(C3_PARTICIPANT_SAMPLE_SIZES[strategy]).toBeLessThanOrEqual(consensusSize);
        }
      }
    });
  });

  describe('step counts match dry-run plan output', () => {
    for (const strategy of C3_ELIGIBLE_STRATEGIES) {
      it(`${strategy}: dry-run plan matches C3_STRATEGY_STEP_COUNTS`, () => {
        const result = buildPlanOnlyResult(
          strategy, 'explicit', 'request-flag', REQ, CTX, null, 0.85, { registered: true },
        );
        const meta = result.metadata as Record<string, unknown>;
        const plan = meta['executionPlan'] as { steps: unknown[] };
        expect(plan.steps.length).toBe(C3_STRATEGY_STEP_COUNTS[strategy]);
      });
    }
  });

  describe('excluded aliases and proxy endpoints', () => {
    it('C3_EXCLUDED_ALIASES has exactly 1 entry (fast)', () => {
      expect(C3_EXCLUDED_ALIASES.length).toBe(1);
      expect(C3_EXCLUDED_ALIASES).toContain('fast');
    });

    it('FAST_STRATEGY_DECISION is proxy_alias_excluded_from_c3', () => {
      expect(FAST_STRATEGY_DECISION).toBe('proxy_alias_excluded_from_c3');
    });

    it('fast resolves to sensitivity-consensus (not its own engine)', () => {
      expect(resolveExecutionStrategy('fast')).toBe('sensitivity-consensus');
    });

    it('C3_PROXY_ENDPOINTS contains sensitivity-consensus', () => {
      expect(C3_PROXY_ENDPOINTS).toContain('sensitivity-consensus');
    });
  });

  describe('baselines (4 — anchored to high-tier synthesizer candidates)', () => {
    it('C3_BASELINES has exactly 4 entries', () => {
      expect(C3_BASELINES.length).toBe(4);
    });

    it('contains baseline-single-best (synthesizer: claude-opus-4-7)', () => {
      expect(C3_BASELINES).toContain('baseline-single-best');
    });

    it('contains baseline-single-secondary (second-best high-tier)', () => {
      expect(C3_BASELINES).toContain('baseline-single-secondary');
    });

    it('contains baseline-single-third (third-best high-tier)', () => {
      expect(C3_BASELINES).toContain('baseline-single-third');
    });

    it('contains baseline-no-synthesis (consensus without synthesis step)', () => {
      expect(C3_BASELINES).toContain('baseline-no-synthesis');
    });
  });

  describe('experiment matrix dimensions (R3: same 88 cells, expanded pool depth)', () => {
    it('C3_MATRIX_STRATEGY_CELLS === 56 (8 tasks × 7 strategies)', () => {
      expect(C3_MATRIX_STRATEGY_CELLS).toBe(56);
    });

    it('C3_MATRIX_BASELINE_CELLS === 32 (8 tasks × 4 baselines)', () => {
      expect(C3_MATRIX_BASELINE_CELLS).toBe(32);
    });

    it('C3_MATRIX_TOTAL_CELLS === 88', () => {
      expect(C3_MATRIX_TOTAL_CELLS).toBe(88);
    });

    it('strategy + baseline cells sum to total', () => {
      expect(C3_MATRIX_STRATEGY_CELLS + C3_MATRIX_BASELINE_CELLS).toBe(C3_MATRIX_TOTAL_CELLS);
    });
  });

  describe('absolute prohibitions', () => {
    it('c3Executed is false', () => expect(C3_SCOPE_DESIGN_PROHIBITIONS.c3Executed).toBe(false));
    it('dryRunFalseExecuted is false', () => expect(C3_SCOPE_DESIGN_PROHIBITIONS.dryRunFalseExecuted).toBe(false));
    it('providerCallsMade is false', () => expect(C3_SCOPE_DESIGN_PROHIBITIONS.providerCallsMade).toBe(false));
    it('billableCostUsd is 0', () => expect(C3_SCOPE_DESIGN_PROHIBITIONS.billableCostUsd).toBe(0));
    it('secretsLeaked is 0', () => expect(C3_SCOPE_DESIGN_PROHIBITIONS.secretsLeaked).toBe(0));
  });
});
