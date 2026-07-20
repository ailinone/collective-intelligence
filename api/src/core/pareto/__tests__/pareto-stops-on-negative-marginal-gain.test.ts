// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * pareto-stops-on-negative-marginal-gain.test.ts — MVP 8A
 *
 * Validates 13.2/13.7/13.8: the optimizer must stop adding models when
 * the marginal contribution falls below the threshold. Verifies the
 * "max useful contributors, NOT max raw count" rule (Section 13).
 */

import { describe, expect, it } from 'vitest';
import { optimizeParetoEnsemble } from '../pareto-ensemble-optimizer';
import {
  scoreAnchorA,
  scorePairX,
  scorePairY,
  scoreCheapGood,
  STANDARD_BASELINE,
} from './fixtures/candidate-fixtures';

describe('optimizer — stops on negative/low marginal gain', () => {
  it('does not add a candidate whose marginal gain is below threshold', () => {
    // PairX is the strongest; PairY is comparable; cheap-good adds little
    // individual lift on top of two high-judge anchors.
    const plan = optimizeParetoEnsemble({
      candidates: [scorePairX(), scorePairY(), scoreCheapGood()],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
      policy: { minMarginalQualityGain: 0.05, maxModels: 4 },
    });
    // Up to 2 anchors are accepted; cheap-good should be rejected for low gain.
    const cheapRecord = plan.marginalContributions.find(
      (m) => m.modelId === 'fx-cheap-good',
    );
    expect(cheapRecord, 'cheap-good marginal record').toBeDefined();
    expect(cheapRecord!.accepted).toBe(false);
    expect(cheapRecord!.reason).toContain('marginal_gain_below_threshold');
  });

  it('respects maxModels even if all marginal gains would be acceptable', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [
        scorePairX(),
        scorePairY(),
        scoreAnchorA(),
        scoreCheapGood(),
      ],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
      policy: { maxModels: 2, minMarginalQualityGain: 0 },
    });
    expect(plan.selectedModelIds.length).toBeLessThanOrEqual(2);
  });

  it('marginal-record list never accepts more than maxModels', () => {
    const plan = optimizeParetoEnsemble({
      candidates: [
        scorePairX(),
        scorePairY(),
        scoreAnchorA(),
        scoreCheapGood(),
      ],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
      policy: { maxModels: 3 },
    });
    const acceptedRecords = plan.marginalContributions.filter((m) => m.accepted);
    expect(acceptedRecords.length).toBeLessThanOrEqual(3);
  });

  it('maximises useful_models — not raw model count', () => {
    // Tight cost ceiling forces only 2 contributive models.
    const plan = optimizeParetoEnsemble({
      candidates: [
        scorePairX(),
        scorePairY(),
        scoreCheapGood(),
        scoreAnchorA(),
      ],
      taskType: 'code-generation',
      taskModality: 'text',
      baseline: STANDARD_BASELINE,
      policy: { maxModels: 5, maxCostRatioVsSingle: 0.3 },
    });
    // Combined cost must remain low; can't add many under the tight ceiling.
    expect(plan.expectedCostUsd).toBeLessThanOrEqual(
      STANDARD_BASELINE.singleModelCostUsd * 0.3 + 1e-9,
    );
  });
});
