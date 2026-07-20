// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-E — Route cascade policy in plan fingerprint.
 *
 * Pins the invariant that the fingerprint changes when
 * `routeCascadePolicy` changes. The 01C.1B-P2 real-branch gate uses
 * fingerprint equality to authorize provider calls — so cascade policy
 * MUST be part of the fingerprint, otherwise a dry-run approved with
 * `maxRetriesPerProvider=0` could be replayed by an executor that
 * silently uses `maxRetriesPerProvider=3` without the fingerprint
 * tripping.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSanitizedPlanSnapshot,
  computePlanFingerprint,
  STRICT_DEFAULT_ROUTE_CASCADE_POLICY,
  PLANNER_VERSION,
} from '../consensus-plan-fingerprint';
import type { ConsensusExecutionPlan } from '../consensus-execution-planner';
import type { ModelCandidate } from '../../model-selection/model-role-types';

function fakeCandidate(modelId: string, providerId: string): ModelCandidate {
  return {
    model: {
      id: modelId,
      provider: providerId,
      providerId,
      name: modelId,
      capabilities: ['chat'] as never[],
      contextWindow: 8000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.002,
      performance: { latencyMs: 500, throughput: 100, quality: 0.85, reliability: 0.95 },
      status: 'active' as never,
      balanceStatus: 'has-credits' as never,
    } as ModelCandidate['model'],
    providerId,
    providerHealthy: true,
    hasCredits: true,
    rateLimited: false,
    isLocal: false,
    estimatedCostPerCallUsd: 0.001,
  };
}

function fakePlan(): ConsensusExecutionPlan {
  return {
    strategyName: 'consensus',
    taskProfile: { taskType: 'general', approximateInputTokens: 0 },
    participants: [
      fakeCandidate('p-a', 'prov-a'),
      fakeCandidate('p-b', 'prov-b'),
      fakeCandidate('p-c', 'prov-c'),
    ],
    synthesizer: fakeCandidate('s-1', 'prov-s'),
    judge: fakeCandidate('j-1', 'prov-j'),
    fallbackSingle: fakeCandidate('f-1', 'prov-f'),
    roleSelectionTrace: [],
    executable: true,
    blockers: [],
    hardcodedModelUsed: false,
    selectionSource: 'dynamic',
  };
}

describe('route cascade policy fingerprint coverage', () => {
  it('defaults to strict policy when caller omits routeCascadePolicy', () => {
    const snapshot = buildSanitizedPlanSnapshot({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
    });
    expect(snapshot.routeCascadePolicy).toEqual(STRICT_DEFAULT_ROUTE_CASCADE_POLICY);
    expect(snapshot.routeCascadePolicy.maxRetriesPerProvider).toBe(0);
    expect(snapshot.routeCascadePolicy.allowRouteFallback).toBe(false);
    expect(snapshot.routeCascadePolicy.maxRouteAttempts).toBe(1);
  });

  it('uses caller-provided policy when present', () => {
    const snapshot = buildSanitizedPlanSnapshot({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
      routeCascadePolicy: {
        allowRouteFallback: true,
        maxRouteAttempts: 3,
        maxRetriesPerProvider: 1,
      },
    });
    expect(snapshot.routeCascadePolicy.allowRouteFallback).toBe(true);
    expect(snapshot.routeCascadePolicy.maxRouteAttempts).toBe(3);
    expect(snapshot.routeCascadePolicy.maxRetriesPerProvider).toBe(1);
  });

  it('fingerprint CHANGES when maxRetriesPerProvider changes', () => {
    const a = computePlanFingerprint({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
      routeCascadePolicy: {
        allowRouteFallback: false,
        maxRouteAttempts: 1,
        maxRetriesPerProvider: 0,
      },
    });
    const b = computePlanFingerprint({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
      routeCascadePolicy: {
        allowRouteFallback: false,
        maxRouteAttempts: 1,
        maxRetriesPerProvider: 3, // ← only this differs
      },
    });
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('fingerprint CHANGES when allowRouteFallback flips', () => {
    const a = computePlanFingerprint({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
      routeCascadePolicy: STRICT_DEFAULT_ROUTE_CASCADE_POLICY,
    });
    const b = computePlanFingerprint({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
      routeCascadePolicy: {
        ...STRICT_DEFAULT_ROUTE_CASCADE_POLICY,
        allowRouteFallback: true,
      },
    });
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('fingerprint STABLE when same input is passed twice', () => {
    const a = computePlanFingerprint({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
    });
    const b = computePlanFingerprint({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
    });
    expect(a.planFingerprint).toBe(b.planFingerprint);
  });

  it('plannerVersion bumped (≥ 01C.1B-E)', () => {
    expect(PLANNER_VERSION).toMatch(/^01C\.1B-/);
  });
});
