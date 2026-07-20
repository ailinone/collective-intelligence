// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.1 — plan-to-execution parity.
 *
 * Pins the contract: when a `ConsensusExecutionPlan` is attached to
 * the request, ConsensusStrategy.execute() honors:
 *   - plan.participants → as voter set (exactly)
 *   - plan.judge.model.id → as judgeModelOverride into the evaluator
 *   - plan.fallbackSingle.model.id → as planned fallback baseline
 *
 * Artifacts record planned-vs-executed booleans on every role.
 * `planSource='dynamic_role_resolver'` when the plan is consumed,
 * `'legacy_selection'` when the strategy ignored the plan (e.g.,
 * plan had <3 participants), `'none'` when no plan was attached.
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
  threeHealthyModels,
  wireStrategy,
} from './consensus-strategy.fixtures';
import type { ChatRequest } from '@/types';

async function buildPlan(): Promise<ConsensusExecutionPlan> {
  const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
  return planner.plan({
    taskProfile: { taskType: 'analysis' },
    candidatePool: fullConsensusPool(),
  });
}

describe('ConsensusStrategy — plan-to-execution parity', () => {
  it('honors plan.participants as voters when plan is attached', async () => {
    const plan = await buildPlan();
    const plannedModels = plan.participants.map((p) => p.model);
    const responses = Object.fromEntries(
      plannedModels.map((m) => [m.id, { content: `output from ${m.id} `.repeat(8) }]),
    );
    const { strategy } = wireStrategy({
      responses,
      eligibleModels: plannedModels,
    });
    const request = makeRequest('parity probe') as ChatRequest & { consensusPlan?: ConsensusExecutionPlan };
    request.consensusPlan = plan;
    const r = await strategy.execute(request, makeContext(plannedModels));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;

    expect(a.planParity.planSource).toBe('dynamic_role_resolver');
    expect(a.planParity.plannedParticipantModelIds).toEqual(
      plan.participants.map((p) => p.model.id),
    );
    expect(new Set(a.planParity.executedParticipantModelIds)).toEqual(
      new Set(a.planParity.plannedParticipantModelIds),
    );
    expect(a.planParity.participantModelsMatchPlan).toBe(true);
  });

  it('records planned judge id and judgeSelectionSource=dynamic_role_resolver', async () => {
    const plan = await buildPlan();
    const plannedModels = plan.participants.map((p) => p.model);
    const responses = Object.fromEntries(
      plannedModels.map((m) => [m.id, { content: `output from ${m.id} `.repeat(8) }]),
    );
    const { strategy } = wireStrategy({
      responses,
      eligibleModels: plannedModels,
    });
    const request = makeRequest('parity judge') as ChatRequest & { consensusPlan?: ConsensusExecutionPlan };
    request.consensusPlan = plan;
    const r = await strategy.execute(request, makeContext(plannedModels));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;

    expect(a.planParity.plannedJudgeModelId).toBe(plan.judge?.model.id);
    expect(a.planParity.judgeSelectionSource).toBe('dynamic_role_resolver');
    expect(a.planParity.judgeModelMatchesPlan).toBe(true);
  });

  it('records planned fallbackSingle id', async () => {
    const plan = await buildPlan();
    const plannedModels = plan.participants.map((p) => p.model);
    const responses = Object.fromEntries(
      plannedModels.map((m) => [m.id, { content: `output from ${m.id} `.repeat(8) }]),
    );
    const { strategy } = wireStrategy({
      responses,
      eligibleModels: plannedModels,
    });
    const request = makeRequest('fallback id') as ChatRequest & { consensusPlan?: ConsensusExecutionPlan };
    request.consensusPlan = plan;
    const r = await strategy.execute(request, makeContext(plannedModels));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;

    expect(a.planParity.plannedFallbackModelId).toBe(plan.fallbackSingle?.model.id);
  });

  it('without a plan attached, planSource is "none" and matchesPlan is true (legacy path is not a divergence)', async () => {
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.planParity.planSource).toBe('none');
    expect(a.planParity.participantModelsMatchPlan).toBe(true); // vacuous match when no plan
    // MockEvaluator is wired by default in wireStrategy — that's not
    // 'unavailable' mode, so the helper classifies as env_fallback when
    // no plan judge id is set.
    expect(a.planParity.judgeSelectionSource).toBe('env_fallback');
  });

  it('mock evaluator without plannedJudgeModelId → judgeSelectionSource="env_fallback"', async () => {
    // The mock evaluator's mode is 'mock' (not 'unavailable'), so the
    // helper classifies as env_fallback when no plan judge id is set.
    const models = threeHealthyModels();
    const { strategy } = wireStrategy({
      responses: {
        'voter-a': { content: 'A'.repeat(120) },
        'voter-b': { content: 'B'.repeat(120) },
        'voter-c': { content: 'C'.repeat(120) },
      },
      eligibleModels: models,
    });
    const r = await strategy.execute(makeRequest(), makeContext(models));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(['env_fallback', 'unavailable']).toContain(a.planParity.judgeSelectionSource);
  });
});
