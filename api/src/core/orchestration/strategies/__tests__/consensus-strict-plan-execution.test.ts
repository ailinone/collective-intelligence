// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — strict plan execution mode.
 *
 * When `CONSENSUS_STRICT_PLAN_EXECUTION=true`:
 *   - any planExecutionDegraded => the strategy throws
 *     `consensus_strict_plan_execution_blocked` BEFORE returning
 *
 * When the flag is absent (default):
 *   - the strategy completes normally and reports the divergence
 *     via planParity (backward-compat with 01C.0.2)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

async function buildPlan(): Promise<ConsensusExecutionPlan> {
  return new ConsensusExecutionPlanner(new ModelRoleResolver()).plan({
    taskProfile: { taskType: 'analysis' },
    candidatePool: fullConsensusPool(),
  });
}

describe('ConsensusStrategy — strict plan execution', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CONSENSUS_STRICT_PLAN_EXECUTION;
  });

  afterEach(() => {
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('strict mode + degraded execution → throws with code consensus_strict_plan_execution_blocked', async () => {
    process.env.CONSENSUS_STRICT_PLAN_EXECUTION = 'true';
    const plan = await buildPlan();
    const plannedModels = plan.participants.map((p) => p.model);
    // First voter fails with 402 → planExecutionDegraded should fire.
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
    await expect(strategy.execute(request, makeContext(plannedModels))).rejects.toThrow(
      /consensus_strict_plan_execution|plan_diverged|insufficient_successful_participants/,
    );
  });

  it('strict mode + happy path (all planned succeed) → no throw, normal return', async () => {
    process.env.CONSENSUS_STRICT_PLAN_EXECUTION = 'true';
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
    expect(a.planParity.planExecutionDegraded).toBe(false);
    expect(a.strategyName).toBe('consensus');
  });

  it('NON-strict mode + degraded execution → returns result with planParity.planExecutionDegraded=true (backward compat)', async () => {
    // CONSENSUS_STRICT_PLAN_EXECUTION not set
    const plan = await buildPlan();
    const plannedModels = plan.participants.map((p) => p.model);
    const responses = Object.fromEntries(
      plannedModels.map((m, i) => [
        m.id,
        i === 0
          ? { content: '', success: false, error: 'HTTP 402' }
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
    expect(a.planParity.planExecutionDegraded).toBe(true);
    expect(a.planParity.planExecutionDegradationReason).toBe('insufficient_successful_participants');
    // Result IS returned — strategy completes.
    expect(a.strategyName).toBe('consensus');
  });

  it('non-strict mode + happy path → no degradation, no throw', async () => {
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
    expect(a.planParity.planExecutionDegraded).toBe(false);
  });
});
