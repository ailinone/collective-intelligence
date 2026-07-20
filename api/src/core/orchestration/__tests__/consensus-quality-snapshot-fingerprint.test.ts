// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2 §17.2 — Quality snapshot fingerprint integration.
 *
 * Proves the snapshot hash + version flow into planFingerprint, and
 * mutating either changes the fingerprint. This is the parity gate
 * that prevents an approved plan from being silently re-executed
 * against a different snapshot.
 */
import { describe, it, expect } from 'vitest';
import {
  computePlanFingerprint,
  buildSanitizedPlanSnapshot,
  type RoleSelectionPolicySnapshot,
  PLANNER_VERSION,
} from '@/core/orchestration/strategies/consensus-plan-fingerprint';
import { makeCandidate, makeModel } from '@/core/orchestration/model-selection/__tests__/role-resolver.fixtures';
import type { ConsensusExecutionPlan } from '@/core/orchestration/strategies/consensus-execution-planner';

function makePlan(): ConsensusExecutionPlan {
  return {
    strategyName: 'consensus',
    taskProfile: { taskType: 'general', approximateInputTokens: 800 },
    participants: [
      makeCandidate({ id: 'a', model: makeModel({ id: 'a', provider: 'p1' }) }),
      makeCandidate({ id: 'b', model: makeModel({ id: 'b', provider: 'p2' }) }),
    ],
    synthesizer: makeCandidate({ id: 'synth', model: makeModel({ id: 'synth', provider: 'p3' }) }),
    judge: makeCandidate({ id: 'judge', model: makeModel({ id: 'judge', provider: 'p4' }) }),
    fallbackSingle: makeCandidate({ id: 'fb', model: makeModel({ id: 'fb', provider: 'p5' }) }),
    roleSelectionTrace: [],
    executable: true,
    blockers: [],
    hardcodedModelUsed: false,
    selectionSource: 'dynamic',
  };
}

const basePolicy: RoleSelectionPolicySnapshot = {
  synthesizerPolicyVersion: '01C.1B-J1G-R2:DEFAULT_HYBRID_SYNTHESIZER_POLICY',
  synthesizerCandidatePoolHash: 'pool123',
  synthesizerQualityFloor: 0.6,
  includedInPlanFingerprint: true,
  qualitySnapshotVersion: '1.0.0',
  qualitySnapshotHash: 'snap_abc123def456',
  qualitySnapshotEntryCount: 16,
};

describe('01C.1B-J2 §17.2 — quality snapshot in planFingerprint', () => {
  it('PLANNER_VERSION is bumped to 01C.1B-J2-C-R4 (multi-source + task-aware)', () => {
    expect(PLANNER_VERSION).toBe('01C.1B-J2-C-R4');
  });

  it('same snapshot hash → same fingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: basePolicy,
    });
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: basePolicy,
    });
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
  });

  it('different qualitySnapshotHash → DIFFERENT fingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: basePolicy,
    });
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: { ...basePolicy, qualitySnapshotHash: 'different_hash_value' },
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('different qualitySnapshotVersion → DIFFERENT fingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: basePolicy,
    });
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: { ...basePolicy, qualitySnapshotVersion: '2.0.0' },
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('different qualitySnapshotEntryCount → DIFFERENT fingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: basePolicy,
    });
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: { ...basePolicy, qualitySnapshotEntryCount: 32 },
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('omitted snapshot fields → empty defaults in snapshot', () => {
    const plan = makePlan();
    const snap = buildSanitizedPlanSnapshot({
      plan, strict: true, roleSpecificRetrieval: true,
      // No roleSelectionPolicy at all
    });
    expect(snap.roleSelectionPolicy.qualitySnapshotVersion).toBe('');
    expect(snap.roleSelectionPolicy.qualitySnapshotHash).toBe('');
    expect(snap.roleSelectionPolicy.qualitySnapshotEntryCount).toBe(0);
  });

  it('snapshot fields included in canonical JSON used for hashing', () => {
    const plan = makePlan();
    const snap = buildSanitizedPlanSnapshot({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: basePolicy,
    });
    // All 7 keys present in roleSelectionPolicy
    const keys = Object.keys(snap.roleSelectionPolicy).sort();
    expect(keys).toContain('qualitySnapshotVersion');
    expect(keys).toContain('qualitySnapshotHash');
    expect(keys).toContain('qualitySnapshotEntryCount');
  });

  it('plannerVersion in fingerprint result is 01C.1B-J2-C-R4', () => {
    const plan = makePlan();
    const f = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: basePolicy,
    });
    expect(f.plannerVersion).toBe('01C.1B-J2-C-R4');
  });
});
