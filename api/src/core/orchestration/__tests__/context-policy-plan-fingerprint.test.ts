// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4C §11 — contextPolicy × planFingerprint tests.
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

const basePolicy: RoleSelectionPolicySnapshot = {
  synthesizerPolicyVersion: '01C.1B-J1G-R2',
  synthesizerCandidatePoolHash: 'pool-hash-stub',
  synthesizerQualityFloor: 0.5,
  includedInPlanFingerprint: true,
  qualitySnapshotVersion: '1.0.0-merged-2026-05-19',
  qualitySnapshotHash: '8d66ae9713984a94f6eb5dac053a33131c3035f239f9a52fafe7ecee8949e1ea',
  qualitySnapshotEntryCount: 6,
};

const contextPolicyOn: RoleSelectionPolicySnapshot = {
  ...basePolicy,
  contextPolicyEnabled: true,
  contextPolicyFormulaVersion: '01C.1B-J1D-R4C-v1',
  contextPolicySafetyMarginRatio: 0.2,
  contextPolicyAbsoluteSafetyMarginTokens: 1024,
  contextPolicyParticipantCount: 3,
  contextPolicyParticipantMaxOutputTokens: 4096,
  contextPolicySynthesizerMaxOutputTokens: 4096,
  contextPolicyJudgeMaxOutputTokens: 4096,
  contextPolicyBackfillHash: 'backfill-v1',
  contextPolicyByRole: [
    { role: 'judge', minContextWindow: 25000, requiredInputTokens: 20000, safetyMarginTokens: 5000 },
    { role: 'participant', minContextWindow: 3000, requiredInputTokens: 1500, safetyMarginTokens: 1500 },
    { role: 'synthesizer', minContextWindow: 20000, requiredInputTokens: 16000, safetyMarginTokens: 4000 },
  ],
  contextPolicyAppliedOverrides: [
    {
      providerId: 'deepinfra',
      apiModelId: 'anthropic/claude-opus-4-7',
      canonicalModelId: 'anthropic/claude-opus-4-7',
      effectiveContextWindow: 200000,
      effectiveMaxOutputTokens: 8192,
      source: 'conservative_inference',
      confidence: 'medium',
    },
  ],
};

describe('01C.1B-J1D-R4C — context policy × planFingerprint', () => {
  it('disabled (baseline): no contextPolicy fields → fingerprint stable', () => {
    const f1 = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: basePolicy,
      },
      { planSource: 'dry_run' },
    );
    const f2 = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: basePolicy,
      },
      { planSource: 'dry_run' },
    );
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
  });

  it('enabling contextPolicy CHANGES the fingerprint', () => {
    const fOff = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: basePolicy,
      },
      { planSource: 'dry_run' },
    );
    const fOn = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: contextPolicyOn,
      },
      { planSource: 'dry_run' },
    );
    expect(fOff.planFingerprint).not.toBe(fOn.planFingerprint);
  });

  it('changing formulaVersion changes the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...contextPolicyOn, contextPolicyFormulaVersion: '01C.1B-J1D-R4C-v1' },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...contextPolicyOn, contextPolicyFormulaVersion: '01C.1B-J1D-R4D-v2' },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('changing safetyMarginRatio changes the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...contextPolicyOn, contextPolicySafetyMarginRatio: 0.2 },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...contextPolicyOn, contextPolicySafetyMarginRatio: 0.3 },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('changing participantCount changes the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...contextPolicyOn, contextPolicyParticipantCount: 3 },
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: { ...contextPolicyOn, contextPolicyParticipantCount: 5 },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('changing applied override (effectiveContextWindow) changes the fingerprint', () => {
    const a = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: contextPolicyOn,
      },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: {
          ...contextPolicyOn,
          contextPolicyAppliedOverrides: [
            {
              providerId: 'deepinfra',
              apiModelId: 'anthropic/claude-opus-4-7',
              canonicalModelId: 'anthropic/claude-opus-4-7',
              effectiveContextWindow: 250000, // changed from 200000
              effectiveMaxOutputTokens: 8192,
              source: 'conservative_inference',
              confidence: 'medium',
            },
          ],
        },
      },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).not.toBe(b.planFingerprint);
  });

  it('canonical sort makes byRole order irrelevant when caller sorts before passing', () => {
    const policySorted: RoleSelectionPolicySnapshot = {
      ...contextPolicyOn,
      contextPolicyByRole: [
        { role: 'judge', minContextWindow: 25000, requiredInputTokens: 20000, safetyMarginTokens: 5000 },
        { role: 'participant', minContextWindow: 3000, requiredInputTokens: 1500, safetyMarginTokens: 1500 },
        { role: 'synthesizer', minContextWindow: 20000, requiredInputTokens: 16000, safetyMarginTokens: 4000 },
      ],
    };
    const a = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: policySorted },
      { planSource: 'dry_run' },
    );
    const b = computePlanFingerprint(
      { plan: makePlan(), strict: true, roleSpecificRetrieval: true, roleSelectionPolicy: policySorted },
      { planSource: 'dry_run' },
    );
    expect(a.planFingerprint).toBe(b.planFingerprint);
  });

  it('sanitized snapshot does NOT contain raw prompt or secret patterns', () => {
    const f = computePlanFingerprint(
      {
        plan: makePlan(),
        strict: true,
        roleSpecificRetrieval: true,
        roleSelectionPolicy: contextPolicyOn,
      },
      { planSource: 'dry_run' },
    );
    const s = JSON.stringify(f.snapshot);
    expect(s).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(s).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
    expect(s).not.toMatch(/BEGIN PRIVATE KEY/);
  });
});
