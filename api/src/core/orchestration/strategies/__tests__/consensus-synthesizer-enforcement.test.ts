// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.2 Part B — synthesizer enforcement.
 *
 * Pins that the plan-driven synthesizer flows to
 * `aggregator.aggregate(..., { forceCoordinatorModelId })` and that
 * the strategy's parity check uses the aggregator's echoed
 * `metadata.coordinatorModelId` (or `forceCoordinatorModelId` as
 * fallback when the aggregator didn't echo).
 *
 * Doesn't exercise a real provider — the global setup mock for
 * `@/core/aggregation/response-aggregator` returns a synthetic
 * AggregatedResponse whose metadata we can shape via the override
 * machinery in `consensus-validation.setup.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import type { ConsensusExecutionPlan } from '../consensus-execution-planner';
import { ConsensusExecutionPlanner } from '../consensus-execution-planner';
import { ModelRoleResolver } from '../../model-selection/model-role-resolver';
import { fullConsensusPool } from '../../model-selection/__tests__/role-resolver.fixtures';
import {
  makeContext,
  makeRequest,
  wireStrategy,
} from './consensus-strategy.fixtures';
import type { ChatRequest } from '@/types';

async function planFor(): Promise<ConsensusExecutionPlan> {
  return new ConsensusExecutionPlanner(new ModelRoleResolver()).plan({
    taskProfile: { taskType: 'analysis' },
    candidatePool: fullConsensusPool(),
  });
}

describe('ConsensusStrategy — synthesizer enforcement', () => {
  it('records executedSynthesizerModelId matching plannedSynthesizerModelId on the parity artifact', async () => {
    const plan = await planFor();
    const plannedModels = plan.participants.map((p) => p.model);
    const responses = Object.fromEntries(
      plannedModels.map((m) => [m.id, { content: `output ${m.id} `.repeat(8) }]),
    );
    const { strategy } = wireStrategy({
      responses,
      eligibleModels: plannedModels,
    });
    const request = makeRequest() as ChatRequest & { consensusPlan?: ConsensusExecutionPlan };
    request.consensusPlan = plan;
    const r = await strategy.execute(request, makeContext(plannedModels));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;

    // The mocked aggregator in `consensus-validation.setup.ts` returns
    // model='mock-coordinator'. Since the strategy's parity check uses
    // `aggregated.metadata.coordinatorModelId ?? plannedSynthesizerModelId`,
    // when the mock doesn't emit `coordinatorModelId` the fallback ensures
    // executed = planned, which makes `synthesizerSelectionSource` = 'dynamic_role_resolver'.
    expect(a.planParity.plannedSynthesizerModelId).toBe(plan.synthesizer?.model.id);
    expect(a.planParity.executedSynthesizerModelId).toBe(plan.synthesizer?.model.id);
    expect(a.planParity.synthesizerMatchesPlan).toBe(true);
    expect(a.planParity.synthesizerSelectionSource).toBe('dynamic_role_resolver');
  });

  it('synthesizerSelectionSource="unavailable" on degraded path (no synthesis run)', async () => {
    const plan = await planFor();
    const plannedModels = plan.participants.map((p) => p.model);
    // Mark two voters as empty → only one valid voter → degraded.
    const responses = {
      [plannedModels[0].id]: { content: 'A'.repeat(120) },
      [plannedModels[1].id]: { content: '' },
      [plannedModels[2].id]: { content: '' },
    };
    const { strategy } = wireStrategy({
      responses,
      eligibleModels: plannedModels,
    });
    const request = makeRequest() as ChatRequest & { consensusPlan?: ConsensusExecutionPlan };
    request.consensusPlan = plan;
    const r = await strategy.execute(request, makeContext(plannedModels));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.effectiveStrategyId).toBe('consensus_degraded_best_individual');
    expect(a.planParity.synthesizerSelectionSource).toBe('unavailable');
  });
});
