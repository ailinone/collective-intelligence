// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PR3a — collective-strategy tool-call artifact passthrough.
 *
 * A voter's `ModelExecution.artifacts` (populated when a tool call during
 * that voter's execution surfaced media — see PR1 #476 / PR2 #479) must
 * reach the outgoing `OrchestrationResult.toolArtifacts` via
 * `mergeArtifacts()` (base-strategy.ts), across every one of
 * ConsensusStrategy's three `OrchestrationResult` return points:
 * synthesis-wins (buildResult()), the pre-synthesis short-circuit, and the
 * degraded (< 2 valid voters) fallback.
 */
import { describe, it, expect } from 'vitest';
import type { ArtifactRef } from '@/types';
import {
  healthyResponses,
  makeContext,
  makeMockEvaluator,
  makeRequest,
  setAggregatorOverride,
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';

const plantedArtifact: ArtifactRef = {
  type: 'image',
  url: 'https://example.test/voter-b-generated.png',
  role: 'voter',
};

describe('ConsensusStrategy — tool-call artifact passthrough', () => {
  it('synthesis-wins branch: carries a voter artifact through into toolArtifacts', async () => {
    setAggregatorOverride({
      content:
        'Synthesis answer combining all three voter perspectives into a single high-quality response well above the outlier floor.',
      confidence: 0.9,
    });
    const models = threeHealthyModels();
    const responses = healthyResponses();
    responses['voter-b'] = { ...responses['voter-b'], artifacts: [plantedArtifact] };

    const { strategy } = wireStrategy({
      responses,
      evaluator: makeMockEvaluator({
        byModelId: { 'voter-a': 0.6, 'voter-b': 0.5, 'voter-c': 0.55 },
        synthesis: 0.85,
        fallback: 0.5,
      }),
      eligibleModels: models,
    });

    const r = await strategy.execute(makeRequest(), makeContext(models));

    expect(r.toolArtifacts).toBeDefined();
    expect(r.toolArtifacts).toContainEqual(plantedArtifact);
    const voterBExecution = r.modelsUsed.find((e) => e.modelId === 'voter-b');
    expect(voterBExecution?.artifacts).toEqual([plantedArtifact]);
  });

  it('degraded (best-individual) branch: carries the surviving voter artifact through', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(150), artifacts: [plantedArtifact] },
        'voter-b': { content: '' },
        'voter-c': { content: '' },
      },
      eligibleModels: models,
    });

    const r = await strategy.execute(makeRequest(), makeContext(models));

    expect(r.metadata?.consensusArtifacts).toMatchObject({
      effectiveStrategyId: 'consensus_degraded_best_individual',
    });
    expect(r.toolArtifacts).toBeDefined();
    expect(r.toolArtifacts).toContainEqual(plantedArtifact);
    const voterAExecution = r.modelsUsed.find((e) => e.modelId === 'voter-a');
    expect(voterAExecution?.artifacts).toEqual([plantedArtifact]);
  });
});
