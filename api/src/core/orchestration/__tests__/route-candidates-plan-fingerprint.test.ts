// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-H §20 — Tests for routeCandidates inclusion in planFingerprint.
 *
 * The contract:
 *   - When `routeCandidates` is provided, ANY change to route order,
 *     route id, providerId, routerId, apiModelId, adapterKind,
 *     endpointKind, equivalenceKind, OR routeSelectionPolicy → different
 *     planFingerprint.
 *   - When omitted, snapshot's `routeCandidates.includedInPlanFingerprint`
 *     is `false` and the fingerprint stays compatible with legacy callers.
 *   - The snapshot never includes raw prompt content or secrets.
 */
import { describe, it, expect } from 'vitest';
import {
  computePlanFingerprint,
  buildSanitizedPlanSnapshot,
  type RouteCandidatesSnapshot,
} from '../strategies/consensus-plan-fingerprint';
import type { ConsensusExecutionPlan } from '../strategies/consensus-execution-planner';
import type { Model } from '@/types';

function makeModel(id: string, providerId: string): Model {
  return {
    id, name: id, provider: providerId,
    capabilities: ['chat'], contextWindow: 8000,
    inputCostPer1k: 0.001, outputCostPer1k: 0.002,
    description: 'test',
  } as Model;
}

function makePlan(): ConsensusExecutionPlan {
  const m = makeModel('gpt-4o', 'openai');
  return {
    participants: [{ model: m, providerId: 'openai', taskFitScore: 0.9, selectionSource: 'dynamic' } as never],
    synthesizer: { model: m, providerId: 'openai', taskFitScore: 0.9, selectionSource: 'dynamic' } as never,
    judge: { model: m, providerId: 'openai', taskFitScore: 0.9, selectionSource: 'dynamic' } as never,
    fallbackSingle: { model: m, providerId: 'openai', taskFitScore: 0.9, selectionSource: 'dynamic' } as never,
    selectionSource: 'dynamic',
  } as ConsensusExecutionPlan;
}

function makeRouteCandidates(over?: Partial<RouteCandidatesSnapshot>): RouteCandidatesSnapshot {
  return {
    perRole: [
      {
        role: 'participant',
        logicalModelId: 'gpt-4o',
        candidates: [
          {
            routeId: 'openai::gpt-4o::openai-chat',
            logicalModelId: 'gpt-4o',
            apiModelId: 'gpt-4o',
            providerId: 'openai',
            adapterKind: 'openai-chat',
            endpointKind: 'chat',
            equivalenceKind: 'exact_same_model',
          },
          {
            routeId: 'openrouter::openai/gpt-4o::openai-compatible-chat',
            logicalModelId: 'gpt-4o',
            apiModelId: 'openai/gpt-4o',
            providerId: 'openrouter',
            routerId: 'openrouter',
            upstreamProviderId: 'openai',
            adapterKind: 'openai-compatible-chat',
            endpointKind: 'chat',
            equivalenceKind: 'same_provider_model_via_router',
          },
        ],
      },
    ],
    policy: {
      orderBy: ['liveReady', 'recentSuccess', 'nativeFirst'],
      maxRouteAttempts: 3,
      allowOutOfPlanRoutes: false,
      allowModelFallback: false,
      allowRouterFallback: true,
      requireLiveReadyForCriticalRoles: true,
    },
    includedInPlanFingerprint: true,
    ...over,
  };
}

describe('routeCandidates inclusion in planFingerprint', () => {
  it('default snapshot has empty routeCandidates + includedInPlanFingerprint=false', () => {
    const snap = buildSanitizedPlanSnapshot({ plan: makePlan(), strict: true, roleSpecificRetrieval: true });
    expect(snap.routeCandidates.includedInPlanFingerprint).toBe(false);
    expect(snap.routeCandidates.perRole).toEqual([]);
  });

  it('passing routeCandidates propagates to snapshot', () => {
    const rc = makeRouteCandidates();
    const snap = buildSanitizedPlanSnapshot({
      plan: makePlan(), strict: true, roleSpecificRetrieval: true,
      routeCandidates: rc,
    });
    expect(snap.routeCandidates.includedInPlanFingerprint).toBe(true);
    expect(snap.routeCandidates.perRole).toHaveLength(1);
    expect(snap.routeCandidates.perRole[0].candidates).toHaveLength(2);
  });

  it('omitting routeCandidates does NOT crash and produces stable fingerprint (legacy path)', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
  });

  it('adding routeCandidates changes the fingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      routeCandidates: makeRouteCandidates(),
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('changing route order changes the fingerprint', () => {
    const plan = makePlan();
    const rc1 = makeRouteCandidates();
    const rc2 = makeRouteCandidates({
      perRole: [{
        ...rc1.perRole[0],
        candidates: [rc1.perRole[0].candidates[1], rc1.perRole[0].candidates[0]],  // reversed
      }],
    });
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc1 });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc2 });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('changing apiModelId changes the fingerprint', () => {
    const plan = makePlan();
    const rc1 = makeRouteCandidates();
    const rc2 = makeRouteCandidates({
      perRole: [{
        ...rc1.perRole[0],
        candidates: [{ ...rc1.perRole[0].candidates[0], apiModelId: 'gpt-4o-MODIFIED' },
                     rc1.perRole[0].candidates[1]],
      }],
    });
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc1 });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc2 });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('changing routerId / upstreamProviderId changes the fingerprint', () => {
    const plan = makePlan();
    const rc1 = makeRouteCandidates();
    const rc2 = makeRouteCandidates({
      perRole: [{
        ...rc1.perRole[0],
        candidates: [
          rc1.perRole[0].candidates[0],
          { ...rc1.perRole[0].candidates[1], routerId: 'aihubmix', providerId: 'aihubmix' },
        ],
      }],
    });
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc1 });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc2 });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('changing routeSelectionPolicy changes the fingerprint', () => {
    const plan = makePlan();
    const rc1 = makeRouteCandidates();
    const rc2 = makeRouteCandidates({
      policy: { ...rc1.policy, maxRouteAttempts: 5 },
    });
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc1 });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc2 });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('flipping orderBy changes the fingerprint', () => {
    const plan = makePlan();
    const rc1 = makeRouteCandidates();
    const rc2 = makeRouteCandidates({
      policy: { ...rc1.policy, orderBy: ['cost', 'liveReady', 'nativeFirst'] },  // reordered
    });
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc1 });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc2 });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('flipping includedInPlanFingerprint changes the fingerprint', () => {
    const plan = makePlan();
    const rc1 = makeRouteCandidates({ includedInPlanFingerprint: true });
    const rc2 = makeRouteCandidates({ includedInPlanFingerprint: false });
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc1 });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: rc2 });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('same routeCandidates → same fingerprint (determinism)', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: makeRouteCandidates() });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, routeCandidates: makeRouteCandidates() });
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
  });

  it('snapshot with routeCandidates does NOT leak secrets / prompt content', () => {
    const plan = makePlan();
    const snap = buildSanitizedPlanSnapshot({
      plan, strict: true, roleSpecificRetrieval: true,
      routeCandidates: makeRouteCandidates(),
    });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('You are');
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]/);
  });

  it('PLANNER_VERSION bumped to ≥ 01C.1B-H', async () => {
    const { PLANNER_VERSION } = await import('../strategies/consensus-plan-fingerprint');
    expect(PLANNER_VERSION).toMatch(/^01C\.1B-/);
    // The bump happened — verify it's at least at H, but tolerate future bumps.
    expect(PLANNER_VERSION >= '01C.1B-H').toBe(true);
  });
});
