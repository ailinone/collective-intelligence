// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R6-HARDEN §10 — c3EligibilityPolicy × planFingerprint tests.
 *
 * Verifies that the c3EligibilityPolicy fields participate in the plan
 * fingerprint. Enabling or changing the policy must change the fingerprint
 * so executionParityCheck can reject substitution.
 */
import { describe, it, expect } from 'vitest';
import {
  computePlanFingerprint,
  type ConsensusExecutionPlan,
  type RoleSelectionPolicySnapshot,
} from '@/core/orchestration/strategies/consensus-plan-fingerprint';
import { C3_ELIGIBILITY_POLICY_VERSION } from '@/core/orchestration/model-selection/external-benchmarks/c3-eligibility-policy';

function makePlan(): ConsensusExecutionPlan {
  return {
    participants: [
      {
        model: { id: 'p-1' } as never,
        providerId: 'fixture-p',
        providerHealthy: true,
        hasCredits: true,
        rateLimited: false,
        isLocal: false,
        estimatedCostPerCallUsd: 0.001,
      } as never,
    ],
    synthesizer: undefined,
    judge: undefined,
    fallbackSingle: undefined,
    executable: false,
    blockers: [],
    poolSummary: {} as never,
    notes: [],
    deadlineSummary: {} as never,
    selectionSource: 'dynamic',
    hardcodedModelUsed: false,
    routeCandidatesIncluded: false,
  } as unknown as ConsensusExecutionPlan;
}

/** Baseline policy snapshot without c3EligibilityPolicy fields. */
const baselinePolicy: RoleSelectionPolicySnapshot = {
  synthesizerPolicyVersion: '01C.1B-J1G-R2',
  synthesizerCandidatePoolHash: 'pool-hash-harden-stub',
  synthesizerQualityFloor: 0.5,
  includedInPlanFingerprint: true,
  qualitySnapshotVersion: '01C.1B-J2-C-R6-v1',
  qualitySnapshotHash: 'ff0e9b59ef9b7fde96d5bf12e56b9e91b2f6a15374b159231f113f3298cbc023',
  qualitySnapshotEntryCount: 9,
  qualityPolicyEnabled: true,
  qualityPolicyVersion: '01C.1B-J2-C-R6-v1',
  qualityRequireNoCatalogFallbackForSelected: true,
  qualityAllowFamilyInferenceForSelected: false,
};

/** Policy snapshot with c3EligibilityPolicy fields enabled (2 blocked). */
const hardenedPolicy: RoleSelectionPolicySnapshot = {
  ...baselinePolicy,
  c3EligibilityPolicyEnabled: true,
  c3EligibilityPolicyVersion: C3_ELIGIBILITY_POLICY_VERSION,
  c3EligibilityAllModelsEligible: false,
  c3EligibilityEligibleCount: 2,
  c3EligibilityBlockedCount: 2,
  c3EligibilitySelectedCoverage: [
    {
      modelId: 'anthropic/claude-opus-4-7',
      c3Eligible: true,
      status: 'C3_ELIGIBLE',
      reason: 'eligible',
      matchConfidence: 'high',
      variantEvidence: 'not_applicable',
      aaSlug: 'claude-opus-4-7',
    },
    {
      modelId: 'deepseek-ai/DeepSeek-R1-0528',
      c3Eligible: true,
      status: 'C3_ELIGIBLE',
      reason: 'eligible',
      matchConfidence: 'high',
      variantEvidence: 'not_applicable',
      aaSlug: 'deepseek-r1',
    },
    {
      modelId: 'accounts/fireworks/models/kimi-k2p5',
      c3Eligible: false,
      status: 'C3_BLOCKED',
      reason: 'blocked_variant_probable_requires_waiver',
      matchConfidence: 'high',
      variantEvidence: 'probable',
      aaSlug: 'kimi-k2-5-non-reasoning',
    },
    {
      modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      c3Eligible: false,
      status: 'C3_BLOCKED',
      reason: 'blocked_medium_confidence_requires_waiver',
      matchConfidence: 'medium',
      variantEvidence: 'probable',
      aaSlug: 'qwen3-235b-a22b-instruct-2507-reasoning',
    },
  ],
};

describe('01C.1B-J2-C-R6-HARDEN — c3EligibilityPolicy × planFingerprint', () => {
  it('baseline: fingerprint is stable across identical calls', () => {
    const f1 = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: baselinePolicy },
      { planSource: 'dry_run' },
    );
    const f2 = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: baselinePolicy },
      { planSource: 'dry_run' },
    );
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
  });

  it('enabling c3EligibilityPolicy CHANGES the fingerprint', () => {
    const off = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: baselinePolicy },
      { planSource: 'dry_run' },
    );
    const on = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: hardenedPolicy },
      { planSource: 'dry_run' },
    );
    expect(off.planFingerprint).not.toBe(on.planFingerprint);
  });

  it('changing c3EligibilityPolicyVersion CHANGES the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(), strict: true, roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...hardenedPolicy, c3EligibilityPolicyVersion: 'v1' },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(), strict: true, roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...hardenedPolicy, c3EligibilityPolicyVersion: 'v2' },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('changing c3EligibilityEligibleCount CHANGES the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(), strict: true, roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...hardenedPolicy, c3EligibilityEligibleCount: 2, c3EligibilityBlockedCount: 2 },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(), strict: true, roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...hardenedPolicy, c3EligibilityEligibleCount: 4, c3EligibilityBlockedCount: 0 },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('hardened snapshot is fingerprinted with the correct policy version constant', () => {
    const result = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: hardenedPolicy },
      { planSource: 'dry_run' },
    );
    expect(result.snapshot.roleSelectionPolicy.c3EligibilityPolicyVersion).toBe(
      C3_ELIGIBILITY_POLICY_VERSION,
    );
    expect(result.snapshot.roleSelectionPolicy.c3EligibilityBlockedCount).toBe(2);
    expect(result.snapshot.roleSelectionPolicy.c3EligibilityEligibleCount).toBe(2);
    expect(result.snapshot.roleSelectionPolicy.c3EligibilityAllModelsEligible).toBe(false);
  });
});
