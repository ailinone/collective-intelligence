// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J — Judge eligibility against role-specific retrieval.
 *
 * Pins the architectural invariant that a model can be selected as
 * judge ONLY if it sits in the role-specific judge pool, NOT in a
 * generic top-N pool that happens to also serve participants.
 *
 * The class of regression this guards against is the 01C.1B-D / -R
 * failure: a 256-cap generic pool sampled by usage_count surfaced
 * 0/63→0/234 judge-eligible candidates, while the underlying catalog
 * (proven via SQL on the live DB) contains 677 strict-eligible models.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsensusExecutionPlanner } from '../../strategies/consensus-execution-planner';
import { ModelRoleResolver } from '../model-role-resolver';
import {
  makeCandidate,
  makeModel,
} from './role-resolver.fixtures';
import type { ModelCapability } from '@/types';

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function makeChatOnlyParticipant(id: string, providerId: string) {
  return makeCandidate({
    id,
    model: makeModel({
      id,
      provider: providerId,
      capabilities: ['chat', 'text_generation'] as ModelCapability[],
      contextWindow: 8000,
      inputCostPer1k: 0.0005,
      outputCostPer1k: 0.0015,
      performance: { latencyMs: 800, throughput: 80, quality: 0.85, reliability: 0.92 },
    }),
  });
}

function makeJudgeEligibleModel(id: string, providerId: string) {
  return makeCandidate({
    id,
    model: makeModel({
      id,
      provider: providerId,
      capabilities: [
        'chat',
        'text_generation',
        'json_mode',
        'function_calling',
        'instruction_following',
      ] as ModelCapability[],
      contextWindow: 64000,
      inputCostPer1k: 0.0001,
      outputCostPer1k: 0.0003,
      performance: { latencyMs: 500, throughput: 150, quality: 0.90, reliability: 0.95 },
    }),
  });
}

function makeSynthesizerEligibleModel(id: string, providerId: string) {
  return makeCandidate({
    id,
    model: makeModel({
      id,
      provider: providerId,
      capabilities: [
        'chat',
        'text_generation',
        'reasoning',
        'instruction_following',
      ] as ModelCapability[],
      contextWindow: 128000,
      inputCostPer1k: 0.002,
      outputCostPer1k: 0.006,
      performance: { latencyMs: 1500, throughput: 90, quality: 0.93, reliability: 0.95 },
    }),
  });
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe('Judge full-registry eligibility — role-specific retrieval', () => {
  it('finds a judge when role-specific pool is supplied even if shared pool has no judge candidates', async () => {
    // 01C.1B-D / -R repro: shared pool only has chat-only participants.
    // No model in this pool has structured-output capability OR ≥16k
    // context. Without role-specific retrieval, judge would fail with
    // no_eligible_judge.
    const sharedPool = [
      makeChatOnlyParticipant('voter-a', 'provider-a'),
      makeChatOnlyParticipant('voter-b', 'provider-b'),
      makeChatOnlyParticipant('voter-c', 'provider-c'),
    ];

    // Role-specific judge pool: distinct dedicated catalog query
    // surfaces a judge-eligible model that wasn't in the shared pool.
    const judgePool = [
      makeJudgeEligibleModel('judge-eligible-1', 'provider-judge-x'),
      makeJudgeEligibleModel('judge-eligible-2', 'provider-judge-y'),
    ];
    const synthPool = [
      makeSynthesizerEligibleModel('synth-eligible-1', 'provider-synth-z'),
    ];

    const fetchSpy = vi.fn(async () => {
      throw new Error('PROVIDER_CALL_DETECTED — planner must NOT call providers');
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
      const plan = await planner.plan({
        taskProfile: { taskType: 'general', approximateInputTokens: 800 },
        candidatePool: sharedPool,
        roleSpecificPools: {
          judge: judgePool,
          synthesizer: synthPool,
        },
        judgeConstraints: { maxCostUsd: 0.10 },
        synthesizerConstraints: { maxCostUsd: 1.0 },
      });

      // Plan should be executable now that judge has its own pool
      expect(plan.judge).toBeDefined();
      expect(['judge-eligible-1', 'judge-eligible-2']).toContain(plan.judge?.model.id);
      expect(plan.blockers).not.toContain('no_eligible_judge');
      expect(plan.hardcodedModelUsed).toBe(false);
      expect(plan.selectionSource).toBe('dynamic');

      // No fetch — planner must not call providers
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('exposes roleCandidateStats.judge with judge-specific sourceUniverseCount', async () => {
    const sharedPool = [
      makeChatOnlyParticipant('p1', 'provider-1'),
      makeChatOnlyParticipant('p2', 'provider-2'),
      makeChatOnlyParticipant('p3', 'provider-3'),
    ];
    const judgePool = [
      makeJudgeEligibleModel('j1', 'provider-jx'),
      makeJudgeEligibleModel('j2', 'provider-jy'),
      makeJudgeEligibleModel('j3', 'provider-jz'),
    ];
    const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
    const plan = await planner.plan({
      taskProfile: { taskType: 'general', approximateInputTokens: 800 },
      candidatePool: sharedPool,
      roleSpecificPools: { judge: judgePool },
      judgeConstraints: { maxCostUsd: 0.10 },
    });

    expect(plan.roleCandidateStats).toBeDefined();
    expect(plan.roleCandidateStats?.judge.sourceUniverseCount).toBe(judgePool.length);
    expect(plan.roleCandidateStats?.judge.selectedCount).toBe(1);
    expect(plan.roleCandidateStats?.judge.policyTier).toBe('strict');
    // Participant came from shared pool, NOT judgePool
    expect(plan.roleCandidateStats?.participant.sourceUniverseCount).toBe(
      sharedPool.length,
    );
  });

  it('falls back to shared pool when role-specific pool is not provided (backwards compat)', async () => {
    // Legacy path: when no roleSpecificPools is passed, every role
    // searches the shared candidatePool. This is the pre-01C.1B-J
    // behavior — kept to avoid breaking existing tests/callers.
    const allInOnePool = [
      makeChatOnlyParticipant('p1', 'provider-1'),
      makeChatOnlyParticipant('p2', 'provider-2'),
      makeChatOnlyParticipant('p3', 'provider-3'),
      makeJudgeEligibleModel('j1', 'provider-jx'),
      makeSynthesizerEligibleModel('s1', 'provider-sx'),
    ];
    const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
    const plan = await planner.plan({
      taskProfile: { taskType: 'general', approximateInputTokens: 800 },
      candidatePool: allInOnePool,
      judgeConstraints: { maxCostUsd: 0.10 },
    });

    expect(plan.judge).toBeDefined();
    expect(plan.judge?.model.id).toBe('j1');
    expect(plan.roleCandidateStats?.judge.sourceUniverseCount).toBe(
      allInOnePool.length,
    );
  });

  it('judge reuse-from-participants fallback fires when strict exclusion empties the slot', async () => {
    // Edge case: the judge pool has only ONE eligible model AND it
    // happens to also have been picked as participant. Without retry,
    // strict exclusion would empty the judge slot. With reuse, the
    // plan stays executable with degradationReason recorded.
    const j1 = makeJudgeEligibleModel('shared-j-and-p', 'provider-jx');
    const sharedPool = [
      j1, // appears in both pools
      makeChatOnlyParticipant('p2', 'provider-2'),
      makeChatOnlyParticipant('p3', 'provider-3'),
    ];
    const judgePool = [j1]; // ONLY one judge candidate, same as a participant
    const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
    const plan = await planner.plan({
      taskProfile: { taskType: 'general', approximateInputTokens: 800 },
      candidatePool: sharedPool,
      roleSpecificPools: { judge: judgePool },
      judgeConstraints: { maxCostUsd: 0.10 },
    });

    expect(plan.judge).toBeDefined();
    expect(plan.judge?.model.id).toBe('shared-j-and-p');
    expect(plan.roleCandidateStats?.judge.degradationReason).toBe(
      'judge_reused_from_participants_or_synthesizer',
    );
    // not a blocker
    expect(plan.blockers).not.toContain('no_eligible_judge');
  });

  it('still reports no_eligible_judge blocker when role-specific pool has NO viable candidate', async () => {
    // When even the role-specific pool can't satisfy judge constraints,
    // we still surface the blocker honestly.
    const sharedPool = [
      makeChatOnlyParticipant('p1', 'provider-1'),
      makeChatOnlyParticipant('p2', 'provider-2'),
      makeChatOnlyParticipant('p3', 'provider-3'),
    ];
    const planner = new ConsensusExecutionPlanner(new ModelRoleResolver());
    const plan = await planner.plan({
      taskProfile: { taskType: 'general', approximateInputTokens: 800 },
      candidatePool: sharedPool,
      // judgePool is empty intentionally
      roleSpecificPools: { judge: [] },
      judgeConstraints: { maxCostUsd: 0.10 },
    });

    expect(plan.judge).toBeUndefined();
    expect(plan.blockers).toContain('no_eligible_judge');
    expect(plan.executable).toBe(false);
    expect(plan.hardcodedModelUsed).toBe(false);
  });
});
