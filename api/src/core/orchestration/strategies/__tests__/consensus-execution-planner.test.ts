// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ConsensusExecutionPlanner — fills participant + synthesizer + judge
 * + fallbackSingle from a single pool. Independence enforced where
 * possible.
 */
import { describe, it, expect } from 'vitest';
import { ConsensusExecutionPlanner } from '../consensus-execution-planner';
import { ModelRoleResolver } from '../../model-selection/model-role-resolver';
import {
  diversePool,
  fullConsensusPool,
  makeCandidate,
  makeModel,
} from '../../model-selection/__tests__/role-resolver.fixtures';
import type { ModelCapability } from '@/types';

describe('ConsensusExecutionPlanner', () => {
  it('produces a plan with 3 participants, synthesizer, judge, and fallbackSingle', async () => {
    const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
    const plan = await planner.plan({
      taskProfile: { taskType: 'analysis' },
      candidatePool: fullConsensusPool(),
    });
    expect(plan.strategyName).toBe('consensus');
    expect(plan.participants.length).toBe(3);
    expect(plan.synthesizer).toBeDefined();
    expect(plan.judge).toBeDefined();
    expect(plan.fallbackSingle).toBeDefined();
    expect(plan.hardcodedModelUsed).toBe(false);
    expect(plan.selectionSource).toBe('dynamic');
  });

  it('participants have distinct providers (diversity)', async () => {
    const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
    const plan = await planner.plan({
      taskProfile: { taskType: 'analysis' },
      candidatePool: fullConsensusPool(),
    });
    const providers = new Set(plan.participants.map((p) => p.providerId));
    expect(providers.size).toBe(plan.participants.length);
  });

  it('judge is independent from participants and synthesizer when possible', async () => {
    const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
    const plan = await planner.plan({
      taskProfile: { taskType: 'analysis' },
      candidatePool: fullConsensusPool(),
    });
    const participantIds = new Set(plan.participants.map((p) => p.model.id));
    expect(plan.judge).toBeDefined();
    if (plan.judge) {
      expect(participantIds.has(plan.judge.model.id)).toBe(false);
      if (plan.synthesizer) {
        expect(plan.judge.model.id).not.toBe(plan.synthesizer.model.id);
      }
    }
  });

  it('records blockers when participant count cannot reach 3', async () => {
    const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
    const plan = await planner.plan({
      taskProfile: { taskType: 'analysis' },
      candidatePool: [
        makeCandidate({ id: 'a', model: makeModel({ id: 'a', provider: 'p1' }) }),
        makeCandidate({ id: 'b', model: makeModel({ id: 'b', provider: 'p2' }) }),
      ],
    });
    expect(plan.executable).toBe(false);
    expect(plan.blockers.some((b) => b.startsWith('insufficient_participants'))).toBe(true);
  });

  it('records blocker when no JSON-capable judge exists', async () => {
    const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
    const noJudgePool = [
      makeCandidate({ id: 'p1', model: makeModel({ id: 'p1', provider: 'p1', capabilities: ['chat', 'text_generation'] as ModelCapability[], contextWindow: 128000 }) }),
      makeCandidate({ id: 'p2', model: makeModel({ id: 'p2', provider: 'p2', capabilities: ['chat', 'text_generation'] as ModelCapability[], contextWindow: 128000 }) }),
      makeCandidate({ id: 'p3', model: makeModel({ id: 'p3', provider: 'p3', capabilities: ['chat', 'text_generation'] as ModelCapability[], contextWindow: 128000 }) }),
    ];
    const plan = await planner.plan({
      taskProfile: { taskType: 'analysis' },
      candidatePool: noJudgePool,
    });
    expect(plan.blockers).toContain('no_eligible_judge');
    expect(plan.executable).toBe(false);
  });

  it('trace contains a result per resolved role', async () => {
    const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
    const plan = await planner.plan({
      taskProfile: { taskType: 'analysis' },
      candidatePool: fullConsensusPool(),
    });
    const roles = plan.roleSelectionTrace.map((t) => t.role);
    expect(roles).toContain('participant');
    expect(roles).toContain('synthesizer');
    expect(roles).toContain('judge');
    expect(roles).toContain('fallback_single');
  });
});
