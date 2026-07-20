// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1G-R0 §10.4 — Role selection parity (plan fingerprint).
 *
 * Proves that swapping the synthesizer-role policy version OR the
 * candidate pool hash produces a DIFFERENT planFingerprint — so an
 * approved plan from one scorer version cannot be replayed against
 * a different one.
 *
 * Also proves the EMPTY default snapshot (when caller skipped the
 * synthesizer scorer) is included in the fingerprint deterministically
 * — preventing accidental drift between "passed empty" and "passed
 * undefined" snapshots.
 */
import { describe, it, expect } from 'vitest';
import {
  computePlanFingerprint,
  buildSanitizedPlanSnapshot,
  type RoleSelectionPolicySnapshot,
} from '@/core/orchestration/strategies/consensus-plan-fingerprint';
import type { ConsensusExecutionPlan } from '@/core/orchestration/strategies/consensus-execution-planner';
import { makeCandidate, makeModel } from '@/core/orchestration/model-selection/__tests__/role-resolver.fixtures';

function makePlan(): ConsensusExecutionPlan {
  return {
    strategyName: 'consensus',
    taskProfile: { taskType: 'general', approximateInputTokens: 800 },
    participants: [
      makeCandidate({ id: 'voter-a', model: makeModel({ id: 'voter-a', provider: 'prov-a' }) }),
      makeCandidate({ id: 'voter-b', model: makeModel({ id: 'voter-b', provider: 'prov-b' }) }),
    ],
    synthesizer: makeCandidate({ id: 'synth-1', model: makeModel({ id: 'synth-1', provider: 'prov-synth' }) }),
    judge: makeCandidate({ id: 'judge-1', model: makeModel({ id: 'judge-1', provider: 'prov-judge' }) }),
    fallbackSingle: makeCandidate({ id: 'fb-1', model: makeModel({ id: 'fb-1', provider: 'prov-fb' }) }),
    roleSelectionTrace: [],
    executable: true,
    blockers: [],
    hardcodedModelUsed: false,
    selectionSource: 'dynamic',
  };
}

const policyA: RoleSelectionPolicySnapshot = {
  synthesizerPolicyVersion: '01C.1B-J1G-R2:DEFAULT_HYBRID_SYNTHESIZER_POLICY',
  synthesizerCandidatePoolHash: 'abc12345',
  synthesizerQualityFloor: 0.6,
  includedInPlanFingerprint: true,
};

describe('01C.1B-J1G-R0 §10.4 — role-selection parity in planFingerprint', () => {
  it('same roleSelectionPolicy → same planFingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: policyA,
    });
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: policyA,
    });
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
  });

  it('different synthesizerPolicyVersion → DIFFERENT planFingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: policyA,
    });
    const policyB: RoleSelectionPolicySnapshot = { ...policyA, synthesizerPolicyVersion: '01C.1B-J1H:NEW_POLICY' };
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: policyB,
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('different synthesizerCandidatePoolHash → DIFFERENT planFingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: policyA,
    });
    const policyB: RoleSelectionPolicySnapshot = { ...policyA, synthesizerCandidatePoolHash: 'xyz98765' };
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: policyB,
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('different qualityFloor → DIFFERENT planFingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: policyA,
    });
    const policyB: RoleSelectionPolicySnapshot = { ...policyA, synthesizerQualityFloor: 0.7 };
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: policyB,
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('omitted roleSelectionPolicy → EMPTY default in snapshot (stable shape)', () => {
    const plan = makePlan();
    const snap1 = buildSanitizedPlanSnapshot({
      plan, strict: true, roleSpecificRetrieval: true,
    });
    const snap2 = buildSanitizedPlanSnapshot({
      plan, strict: true, roleSpecificRetrieval: true,
    });
    expect(snap1.roleSelectionPolicy).toEqual(snap2.roleSelectionPolicy);
    expect(snap1.roleSelectionPolicy.includedInPlanFingerprint).toBe(false);
    expect(snap1.roleSelectionPolicy.synthesizerPolicyVersion).toBe('');
    expect(snap1.roleSelectionPolicy.synthesizerCandidatePoolHash).toBe('');
  });

  it('omitted policy vs explicit empty policy → SAME planFingerprint', () => {
    const plan = makePlan();
    const fOmitted = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
    });
    const fEmpty = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: {
        synthesizerPolicyVersion: '',
        synthesizerCandidatePoolHash: '',
        synthesizerQualityFloor: 0,
        includedInPlanFingerprint: false,
        qualitySnapshotVersion: '',
        qualitySnapshotHash: '',
        qualitySnapshotEntryCount: 0,
      },
    });
    expect(fOmitted.planFingerprint).toBe(fEmpty.planFingerprint);
  });

  it('omitted vs populated → DIFFERENT planFingerprint (any populated policy must differ from default)', () => {
    const plan = makePlan();
    const fOmitted = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
    });
    const fPopulated = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: policyA,
    });
    expect(fOmitted.planFingerprint).not.toBe(fPopulated.planFingerprint);
  });

  it('snapshot field shape is stable: roleSelectionPolicy exposed exactly 7 keys (J2 added 3)', () => {
    const plan = makePlan();
    const snap = buildSanitizedPlanSnapshot({
      plan, strict: true, roleSpecificRetrieval: true,
      roleSelectionPolicy: { ...policyA, qualitySnapshotVersion: '', qualitySnapshotHash: '', qualitySnapshotEntryCount: 0 },
    });
    const keys = Object.keys(snap.roleSelectionPolicy).sort();
    expect(keys).toEqual([
      'includedInPlanFingerprint',
      'qualitySnapshotEntryCount',
      'qualitySnapshotHash',
      'qualitySnapshotVersion',
      'synthesizerCandidatePoolHash',
      'synthesizerPolicyVersion',
      'synthesizerQualityFloor',
    ]);
  });
});
