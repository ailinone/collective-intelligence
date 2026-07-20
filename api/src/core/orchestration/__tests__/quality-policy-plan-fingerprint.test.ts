// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R5 §11 — qualityPolicy × planFingerprint tests.
 */
import { describe, it, expect } from 'vitest';
import {
  computePlanFingerprint,
  type ConsensusExecutionPlan,
  type RoleSelectionPolicySnapshot,
} from '@/core/orchestration/strategies/consensus-plan-fingerprint';

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

const baselineMinimal: RoleSelectionPolicySnapshot = {
  synthesizerPolicyVersion: '01C.1B-J1G-R2',
  synthesizerCandidatePoolHash: 'pool-hash-stub',
  synthesizerQualityFloor: 0.5,
  includedInPlanFingerprint: true,
  qualitySnapshotVersion: '1.0.0-merged-2026-05-19',
  qualitySnapshotHash: '8d66ae9713984a94f6eb5dac053a33131c3035f239f9a52fafe7ecee8949e1ea',
  qualitySnapshotEntryCount: 6,
};

const qualityPolicy: RoleSelectionPolicySnapshot = {
  ...baselineMinimal,
  qualityPolicyEnabled: true,
  qualityPolicyVersion: '01C.1B-J2-C-R5-v1',
  qualitySnapshotHashFromR5: '5d6f0a353d1394e1d08abeb7edeef89931db4ee428dd677352d1833dc46755d4',
  qualityIdentityResolverEnabled: true,
  qualityRequireNoCatalogFallbackForSelected: true,
  qualityAllowFamilyInferenceForSelected: true,
  qualitySelectedCoverage: [
    {
      role: 'judge',
      runtimeModelId: 'accounts/fireworks/models/deepseek-v4-pro',
      qualityCanonicalId: 'deepseek-v4-pro',
      matchKind: 'provider_unwrapped_alias',
      confidence: 'high',
      qualityScoreSource: 'external_benchmark',
      familyInferenceUsed: false,
      catalogFallbackUsed: false,
    },
    {
      role: 'participant',
      runtimeModelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507',
      qualityCanonicalId: 'qwen/qwen3-235b-a22b-thinking-2507',
      matchKind: 'normalized_alias',
      confidence: 'medium',
      qualityScoreSource: 'inferred_family_default',
      familyInferenceUsed: true,
      catalogFallbackUsed: false,
    },
  ],
};

describe('01C.1B-J2-C-R5 — qualityPolicy × planFingerprint', () => {
  it('baseline disabled: fingerprint stable', () => {
    const f1 = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: baselineMinimal },
      { planSource: 'dry_run' },
    );
    const f2 = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: baselineMinimal },
      { planSource: 'dry_run' },
    );
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
  });

  it('enabling qualityPolicy CHANGES the fingerprint', () => {
    const off = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: baselineMinimal },
      { planSource: 'dry_run' },
    );
    const on = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: qualityPolicy },
      { planSource: 'dry_run' },
    );
    expect(off.planFingerprint).not.toBe(on.planFingerprint);
  });

  it('changing qualitySnapshotHashFromR5 CHANGES the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...qualityPolicy, qualitySnapshotHashFromR5: 'aaa' },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...qualityPolicy, qualitySnapshotHashFromR5: 'bbb' },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('changing requireNoCatalogFallback CHANGES the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...qualityPolicy, qualityRequireNoCatalogFallbackForSelected: false },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...qualityPolicy, qualityRequireNoCatalogFallbackForSelected: true },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('changing per-selected matchKind CHANGES the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: qualityPolicy,
      },
      { planSource: 'dry_run' },
    );
    const variantCoverage = qualityPolicy.qualitySelectedCoverage!.map((c, i) =>
      i === 0 ? { ...c, matchKind: 'exact_model_id' } : c,
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...qualityPolicy, qualitySelectedCoverage: variantCoverage },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('changing catalogFallbackUsed CHANGES the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: qualityPolicy,
      },
      { planSource: 'dry_run' },
    );
    const variantCoverage = qualityPolicy.qualitySelectedCoverage!.map((c, i) =>
      i === 1 ? { ...c, catalogFallbackUsed: true } : c,
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...qualityPolicy, qualitySelectedCoverage: variantCoverage },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('sanitized snapshot does NOT contain raw prompt or secrets', () => {
    const f = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: qualityPolicy,
      },
      { planSource: 'dry_run' },
    );
    const s = JSON.stringify(f.snapshot);
    expect(s).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(s).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
    expect(s).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(s).not.toMatch(/Implemente em TypeScript/);
  });
});
