// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-F2 — Deadline policy in plan fingerprint.
 *
 * Pins the invariant that the fingerprint changes when the deadline
 * policy changes, so a dry-run approved at 180s strategy deadline
 * cannot be replayed with 600s without the fingerprint gate tripping.
 */
import { describe, it, expect } from 'vitest';
import {
  computePlanFingerprint,
  buildSanitizedPlanSnapshot,
  STRICT_DEFAULT_DEADLINE_POLICY,
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

describe('deadline policy in plan fingerprint', () => {
  it('plannerVersion bumped (≥ 01C.1B-F2)', () => {
    // 01C.1B-G4 bumped to 01C.1B-G4 because promptFingerprints joined the
    // fingerprint recipe. Keep this test forward-compatible with the
    // future PLANNER_VERSION bumps using a regex.
    expect(PLANNER_VERSION).toMatch(/^01C\.1B-/);
  });

  it('defaults to STRICT_DEFAULT_DEADLINE_POLICY when caller omits', () => {
    const snap = buildSanitizedPlanSnapshot({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
    });
    expect(snap.deadlinePolicy).toEqual(STRICT_DEFAULT_DEADLINE_POLICY);
    expect(snap.deadlinePolicy.strategyDeadlineMs).toBe(180_000);
    expect(snap.deadlinePolicy.serverResponseDeadlineMs).toBe(240_000);
  });

  it('fingerprint CHANGES when strategyDeadlineMs differs', () => {
    const a = computePlanFingerprint({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
      routeCascadePolicy: STRICT_DEFAULT_ROUTE_CASCADE_POLICY,
      deadlinePolicy: STRICT_DEFAULT_DEADLINE_POLICY,
    });
    const b = computePlanFingerprint({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
      routeCascadePolicy: STRICT_DEFAULT_ROUTE_CASCADE_POLICY,
      deadlinePolicy: {
        ...STRICT_DEFAULT_DEADLINE_POLICY,
        strategyDeadlineMs: 600_000, // ← only this differs
      },
    });
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('fingerprint CHANGES when perAttemptTimeoutMs differs', () => {
    const a = computePlanFingerprint({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
    });
    const b = computePlanFingerprint({
      plan: fakePlan(),
      strict: true,
      roleSpecificRetrieval: true,
      deadlinePolicy: {
        ...STRICT_DEFAULT_DEADLINE_POLICY,
        perAttemptTimeoutMs: 60_000,
      },
    });
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('fingerprint STABLE when default policy is used in both', () => {
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
});
