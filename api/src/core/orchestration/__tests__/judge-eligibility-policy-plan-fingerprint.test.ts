// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4D §11 — judgeEligibilityPolicy × planFingerprint tests.
 *
 * Goals:
 *   1. Adding judgeEligibilityPolicy to the snapshot CHANGES the hash.
 *   2. Changing policy version CHANGES the hash.
 *   3. Changing weakAllowed CHANGES the hash.
 *   4. Changing fullRegistryExpansionEnabled CHANGES the hash.
 *   5. Changing the backfill hash CHANGES the hash.
 *   6. Identical inputs → identical hash (stability).
 *   7. The snapshot does NOT contain raw prompts or secret patterns.
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

const judgePolicy: RoleSelectionPolicySnapshot = {
  ...baselineMinimal,
  judgeEligibilityPolicyEnabled: true,
  judgeEligibilityPolicyVersion: '01C.1B-J1D-R4D-v1',
  judgeStructuredOutputStrong: [
    'json_output',
    'json_mode',
    'structured_output',
    'response_format_json',
    'response_format_json_object',
    'response_format_json_schema',
  ],
  judgeStructuredOutputMedium: [
    'function_calling',
    'function_call',
    'tool_use',
    'tool_calling',
    'tools',
    'supports_tools',
  ],
  judgeStructuredOutputWeakAllowed: false,
  judgeFullRegistryExpansionEnabled: true,
  judgeExpansionSource: 'full_registry_role_specific',
  judgeStructuredOutputBackfillHash: 'so-backfill-v1',
  judgeRequireLiveReadyEvidence: true,
  judgeRequireDynamicContextBudget: true,
};

describe('01C.1B-J1D-R4D — judgeEligibilityPolicy × planFingerprint', () => {
  it('baseline disabled (no judge policy fields): fingerprint stable', () => {
    const f1 = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: baselineMinimal,
      },
      { planSource: 'dry_run' },
    );
    const f2 = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: baselineMinimal,
      },
      { planSource: 'dry_run' },
    );
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
  });

  it('enabling judgeEligibilityPolicy CHANGES the fingerprint', () => {
    const off = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: baselineMinimal,
      },
      { planSource: 'dry_run' },
    );
    const on = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: judgePolicy,
      },
      { planSource: 'dry_run' },
    );
    expect(off.planFingerprint).not.toBe(on.planFingerprint);
  });

  it('changing judgeEligibilityPolicyVersion CHANGES the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...judgePolicy, judgeEligibilityPolicyVersion: '01C.1B-J1D-R4D-v1' },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...judgePolicy, judgeEligibilityPolicyVersion: '01C.1B-J1D-R4D-v2' },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('changing weakAllowed CHANGES the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...judgePolicy, judgeStructuredOutputWeakAllowed: false },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...judgePolicy, judgeStructuredOutputWeakAllowed: true },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('changing fullRegistryExpansionEnabled CHANGES the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...judgePolicy, judgeFullRegistryExpansionEnabled: false },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...judgePolicy, judgeFullRegistryExpansionEnabled: true },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('changing structured-output backfill hash CHANGES the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...judgePolicy, judgeStructuredOutputBackfillHash: 'so-v1' },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...judgePolicy, judgeStructuredOutputBackfillHash: 'so-v2' },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('sanitized snapshot does NOT contain raw prompts or secret patterns', () => {
    const f = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: judgePolicy,
      },
      { planSource: 'dry_run' },
    );
    const s = JSON.stringify(f.snapshot);
    expect(s).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(s).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
    expect(s).not.toMatch(/BEGIN PRIVATE KEY/);
    // Should not contain a user prompt body either.
    expect(s).not.toMatch(/Implemente em TypeScript/);
  });
});
