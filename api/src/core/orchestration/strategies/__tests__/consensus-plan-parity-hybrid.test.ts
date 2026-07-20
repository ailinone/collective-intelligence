// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.2 — Hybrid parity contract.
 *
 * Pins: paridade-de-chamada (participantModelsMatchPlan) is INDEPENDENT
 * of execução-bem-sucedida (plannedParticipantExecutionSuccess). When
 * the planned voters were CALLED but some FAILED, parity stays true
 * but `planExecutionDegraded` becomes true and the failed voters are
 * classified by reason.
 */
import { describe, it, expect } from 'vitest';
import type { ConsensusStrategyArtifacts } from '../consensus/consensus-artifacts';
import {
  buildPlanParityArtifact,
  classifyParticipantFailure,
  computeHybridParityForPlan,
} from '../consensus-strategy';
import {
  fullConsensusPool,
} from '../../model-selection/__tests__/role-resolver.fixtures';
import { ConsensusExecutionPlanner } from '../consensus-execution-planner';
import { ModelRoleResolver } from '../../model-selection/model-role-resolver';
import {
  makeContext,
  makeRequest,
  wireStrategy,
} from './consensus-strategy.fixtures';
import type { ChatRequest } from '@/types';
import type { ConsensusExecutionPlan } from '../consensus-execution-planner';

async function buildPlan(): Promise<ConsensusExecutionPlan> {
  const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
  return planner.plan({
    taskProfile: { taskType: 'analysis' },
    candidatePool: fullConsensusPool(),
  });
}

describe('classifyParticipantFailure', () => {
  it('maps 402 / "no credit" / "insufficient" to no_credits', () => {
    expect(
      classifyParticipantFailure({ executionSuccess: false, executionError: 'HTTP 402 Payment Required', outlier: false }),
    ).toBe('no_credits');
    expect(
      classifyParticipantFailure({ executionSuccess: false, executionError: 'insufficient_balance', outlier: false }),
    ).toBe('no_credits');
  });

  it('maps 401 / auth to auth_failed', () => {
    expect(
      classifyParticipantFailure({ executionSuccess: false, executionError: 'HTTP 401 Unauthorized', outlier: false }),
    ).toBe('auth_failed');
  });

  it('maps 429 / rate / quota to rate_limited', () => {
    expect(
      classifyParticipantFailure({ executionSuccess: false, executionError: 'rate limit exceeded', outlier: false }),
    ).toBe('rate_limited');
  });

  it('maps timeout / 404 / unsupported correctly', () => {
    expect(
      classifyParticipantFailure({ executionSuccess: false, executionError: 'request timeout', outlier: false }),
    ).toBe('timeout');
    expect(
      classifyParticipantFailure({ executionSuccess: false, executionError: 'model not found', outlier: false }),
    ).toBe('model_not_found');
    expect(
      classifyParticipantFailure({ executionSuccess: false, executionError: 'unsupported model', outlier: false }),
    ).toBe('unsupported_model');
  });

  it('maps outlier success → outlier_rejected (with empty_output / invalid_response specializations)', () => {
    expect(
      classifyParticipantFailure({ executionSuccess: true, outlier: true, outlierReason: 'empty_output' }),
    ).toBe('empty_response');
    expect(
      classifyParticipantFailure({ executionSuccess: true, outlier: true, outlierReason: 'invalid_json' }),
    ).toBe('invalid_response');
    expect(
      classifyParticipantFailure({ executionSuccess: true, outlier: true, outlierReason: 'output_too_short' }),
    ).toBe('outlier_rejected');
  });

  it('returns undefined when execution succeeded and not outlier', () => {
    expect(
      classifyParticipantFailure({ executionSuccess: true, outlier: false }),
    ).toBeUndefined();
  });
});

describe('computeHybridParityForPlan', () => {
  it('returns empty arrays when planSource is not dynamic', () => {
    const r = computeHybridParityForPlan({
      plannedParticipantModelIds: ['a', 'b', 'c'],
      evaluated: [],
      planSource: 'none',
    });
    expect(r.successFlags).toEqual([]);
    expect(r.failureReasons).toEqual([]);
  });

  it('aligns success flags 1:1 with planned ids in order', () => {
    const r = computeHybridParityForPlan({
      plannedParticipantModelIds: ['a', 'b', 'c'],
      evaluated: [
        { execution: { modelId: 'a', success: true }, outlierDetection: { outlier: false } },
        { execution: { modelId: 'b', success: false, error: '402' }, outlierDetection: { outlier: false } },
        { execution: { modelId: 'c', success: true }, outlierDetection: { outlier: true, outlierReason: 'empty_output' } },
      ],
      planSource: 'dynamic_role_resolver',
    });
    expect(r.successFlags).toEqual([true, false, false]);
    expect(r.failureReasons).toEqual([undefined, 'no_credits', 'empty_response']);
  });

  it('marks missing-from-evaluated as failure with reason unknown', () => {
    const r = computeHybridParityForPlan({
      plannedParticipantModelIds: ['a', 'missing'],
      evaluated: [
        { execution: { modelId: 'a', success: true }, outlierDetection: { outlier: false } },
      ],
      planSource: 'dynamic_role_resolver',
    });
    expect(r.successFlags).toEqual([true, false]);
    expect(r.failureReasons).toEqual([undefined, 'unknown']);
  });
});

describe('buildPlanParityArtifact — planExecutionDegraded gate', () => {
  it('degraded=false when all planned voters succeed and synthesizer/judge match', () => {
    const a = buildPlanParityArtifact({
      planSource: 'dynamic_role_resolver',
      plannedParticipantModelIds: ['a', 'b', 'c'],
      executedParticipantModelIds: ['a', 'b', 'c'],
      plannedParticipantExecutionSuccess: [true, true, true],
      plannedParticipantFailureReasons: [undefined, undefined, undefined],
      effectiveParticipantCount: 3,
      plannedJudgeModelId: 'judge-x',
      executedJudgeModelId: 'judge-x',
      plannedSynthesizerModelId: 'synth-x',
      executedSynthesizerModelId: 'synth-x',
      plannedFallbackModelId: 'a',
      executedFallbackModelId: 'a',
      evaluatorMode: 'mock',
    });
    expect(a.planExecutionDegraded).toBe(false);
    expect(a.successfulParticipantCount).toBe(3);
    expect(a.failedParticipantCount).toBe(0);
    expect(a.synthesizerSelectionSource).toBe('dynamic_role_resolver');
  });

  it('degraded=true when successfulParticipantCount < minRequired', () => {
    const a = buildPlanParityArtifact({
      planSource: 'dynamic_role_resolver',
      plannedParticipantModelIds: ['a', 'b', 'c'],
      executedParticipantModelIds: ['a', 'b', 'c'],
      plannedParticipantExecutionSuccess: [true, false, false],
      plannedParticipantFailureReasons: [undefined, 'no_credits', 'rate_limited'],
      effectiveParticipantCount: 1,
      evaluatorMode: 'mock',
      minRequiredParticipants: 3,
    });
    expect(a.planExecutionDegraded).toBe(true);
    expect(a.planExecutionDegradationReason).toBe('insufficient_successful_participants');
    expect(a.successfulParticipantCount).toBe(1);
    expect(a.failedParticipantCount).toBe(2);
    expect(a.participantModelsMatchPlan).toBe(true); // STILL TRUE — call-time parity holds
  });

  it('degraded=true when synthesizer mismatches plan', () => {
    const a = buildPlanParityArtifact({
      planSource: 'dynamic_role_resolver',
      plannedParticipantModelIds: ['a', 'b', 'c'],
      executedParticipantModelIds: ['a', 'b', 'c'],
      plannedParticipantExecutionSuccess: [true, true, true],
      effectiveParticipantCount: 3,
      plannedSynthesizerModelId: 'synth-planned',
      executedSynthesizerModelId: 'synth-other',
      evaluatorMode: 'mock',
    });
    expect(a.planExecutionDegraded).toBe(true);
    expect(a.planExecutionDegradationReason).toBe('synthesizer_mismatch');
    expect(a.synthesizerMatchesPlan).toBe(false);
    expect(a.synthesizerSelectionSource).toBe('mismatch');
  });

  it('degraded=true when judge mismatches plan', () => {
    const a = buildPlanParityArtifact({
      planSource: 'dynamic_role_resolver',
      plannedParticipantModelIds: ['a', 'b', 'c'],
      executedParticipantModelIds: ['a', 'b', 'c'],
      plannedParticipantExecutionSuccess: [true, true, true],
      effectiveParticipantCount: 3,
      plannedJudgeModelId: 'judge-x',
      executedJudgeModelId: 'judge-y',
      evaluatorMode: 'mock',
    });
    expect(a.planExecutionDegraded).toBe(true);
    expect(a.planExecutionDegradationReason).toBe('judge_mismatch');
  });

  it('legacy/no-plan: degraded=false (vacuous match)', () => {
    const a = buildPlanParityArtifact({
      planSource: 'none',
      plannedParticipantModelIds: [],
      executedParticipantModelIds: ['legacy-1', 'legacy-2', 'legacy-3'],
      evaluatorMode: 'mock',
    });
    expect(a.planExecutionDegraded).toBe(false);
    expect(a.participantModelsMatchPlan).toBe(true);
  });
});

describe('Strategy integration — Hybrid parity emitted on real execute()', () => {
  it('artifact carries successfulParticipantCount + planExecutionDegraded fields', async () => {
    const plan = await buildPlan();
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
    expect(a.planParity.successfulParticipantCount).toBe(3);
    expect(a.planParity.failedParticipantCount).toBe(0);
    expect(a.planParity.planExecutionDegraded).toBe(false);
    expect(a.planParity.plannedParticipantExecutionSuccess).toEqual([true, true, true]);
  });

  it('one planned voter fails → planExecutionDegraded=true, classified reason', async () => {
    const plan = await buildPlan();
    const plannedModels = plan.participants.map((p) => p.model);
    const failingId = plannedModels[0].id;
    const responses = Object.fromEntries(
      plannedModels.map((m, i) => [
        m.id,
        i === 0
          ? { content: '', success: false, error: 'HTTP 402 Payment Required' }
          : { content: `output ${m.id} `.repeat(8) },
      ]),
    );
    const { strategy } = wireStrategy({
      responses,
      eligibleModels: plannedModels,
    });
    const request = makeRequest() as ChatRequest & { consensusPlan?: ConsensusExecutionPlan };
    request.consensusPlan = plan;
    const r = await strategy.execute(request, makeContext(plannedModels));
    const a = r.metadata?.consensusArtifacts as ConsensusStrategyArtifacts;
    expect(a.planParity.successfulParticipantCount).toBe(2);
    expect(a.planParity.failedParticipantCount).toBe(1);
    const idx = a.planParity.plannedParticipantModelIds.indexOf(failingId);
    expect(a.planParity.plannedParticipantExecutionSuccess[idx]).toBe(false);
    expect(a.planParity.plannedParticipantFailureReasons[idx]).toBe('no_credits');
    expect(a.planParity.planExecutionDegraded).toBe(true);
    expect(a.planParity.planExecutionDegradationReason).toBe('insufficient_successful_participants');
  });
});
