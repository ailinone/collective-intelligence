// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G4 §8 — Tests for prompt fingerprint inclusion in plan fingerprint.
 *
 * The contract:
 *   - When `promptFingerprints` is provided to `computePlanFingerprint`,
 *     the resulting `planFingerprint` deterministically depends on the
 *     aggregate prompt hash.
 *   - Changing ANY role's prompt fingerprint changes the planFingerprint.
 *   - When omitted, the snapshot's `promptFingerprints.includedInPlanFingerprint`
 *     is `false` AND the `aggregate` is the empty string — operators see
 *     the absence honestly.
 */
import { describe, it, expect } from 'vitest';
import {
  computePlanFingerprint,
  buildSanitizedPlanSnapshot,
  type PromptFingerprintsSnapshot,
} from '../strategies/consensus-plan-fingerprint';
import type { ConsensusExecutionPlan } from '../strategies/consensus-execution-planner';
import type { Model } from '@/types';

function makeModel(id: string, providerId: string): Model {
  return {
    id,
    name: id,
    provider: providerId,
    capabilities: ['chat'],
    contextWindow: 8000,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    description: 'test',
  } as Model;
}

function makePlan(): ConsensusExecutionPlan {
  const m1 = makeModel('alpha-1', 'providerA');
  const m2 = makeModel('beta-1', 'providerB');
  const m3 = makeModel('gamma-1', 'providerC');
  return {
    participants: [
      { model: m1, providerId: 'providerA', taskFitScore: 0.9, selectionSource: 'dynamic' } as never,
      { model: m2, providerId: 'providerB', taskFitScore: 0.8, selectionSource: 'dynamic' } as never,
      { model: m3, providerId: 'providerC', taskFitScore: 0.85, selectionSource: 'dynamic' } as never,
    ],
    synthesizer: { model: m1, providerId: 'providerA', taskFitScore: 0.9, selectionSource: 'dynamic' } as never,
    judge: { model: m2, providerId: 'providerB', taskFitScore: 0.8, selectionSource: 'dynamic' } as never,
    fallbackSingle: { model: m3, providerId: 'providerC', taskFitScore: 0.85, selectionSource: 'dynamic' } as never,
    selectionSource: 'dynamic',
  } as ConsensusExecutionPlan;
}

function makePromptFingerprints(aggregate: string, includedInPlanFingerprint = true): PromptFingerprintsSnapshot {
  return {
    aggregate,
    perRole: [
      { role: 'participant', promptTemplateId: 'consensusVoter', promptVersion: 'v1', promptFingerprint: 'aaaa' },
      { role: 'synthesizer', promptTemplateId: 'consensusSynthesizer', promptVersion: 'v1', promptFingerprint: 'bbbb' },
    ],
    includedInPlanFingerprint,
  };
}

describe('promptFingerprint inclusion in planFingerprint', () => {
  it('default snapshot has empty promptFingerprints + includedInPlanFingerprint=false', () => {
    const snap = buildSanitizedPlanSnapshot({
      plan: makePlan(),
      strict: true,
      roleSpecificRetrieval: true,
    });
    expect(snap.promptFingerprints.aggregate).toBe('');
    expect(snap.promptFingerprints.perRole).toEqual([]);
    expect(snap.promptFingerprints.includedInPlanFingerprint).toBe(false);
  });

  it('passing promptFingerprints to buildSanitizedPlanSnapshot propagates to snapshot', () => {
    const pf = makePromptFingerprints('agg-X');
    const snap = buildSanitizedPlanSnapshot({
      plan: makePlan(),
      strict: true,
      roleSpecificRetrieval: true,
      promptFingerprints: pf,
    });
    expect(snap.promptFingerprints.aggregate).toBe('agg-X');
    expect(snap.promptFingerprints.includedInPlanFingerprint).toBe(true);
  });

  it('different aggregate prompt fingerprint → different planFingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan,
      strict: true,
      roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-1'),
    });
    const f2 = computePlanFingerprint({
      plan,
      strict: true,
      roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-2'),
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('same aggregate prompt fingerprint → same planFingerprint (deterministic)', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan,
      strict: true,
      roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-stable'),
    });
    const f2 = computePlanFingerprint({
      plan,
      strict: true,
      roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-stable'),
    });
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
  });

  it('per-role fingerprint change (different perRole entry) → planFingerprint change', () => {
    const plan = makePlan();
    const pf1 = makePromptFingerprints('agg-same');
    const pf2: PromptFingerprintsSnapshot = {
      aggregate: 'agg-same',
      perRole: [
        { role: 'participant', promptTemplateId: 'consensusVoter', promptVersion: 'v2', promptFingerprint: 'AAAA' },
        { role: 'synthesizer', promptTemplateId: 'consensusSynthesizer', promptVersion: 'v1', promptFingerprint: 'bbbb' },
      ],
      includedInPlanFingerprint: true,
    };
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, promptFingerprints: pf1 });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true, promptFingerprints: pf2 });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('flipping includedInPlanFingerprint changes the planFingerprint', () => {
    // The flag is part of the snapshot, so it participates in fingerprint.
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan,
      strict: true,
      roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-X', true),
    });
    const f2 = computePlanFingerprint({
      plan,
      strict: true,
      roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-X', false),
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('omitting promptFingerprints does NOT crash and produces a stable fingerprint', () => {
    // Regression guard: legacy callers that don't pass `promptFingerprints`
    // must keep working; the snapshot just records empty defaults.
    const plan = makePlan();
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
    expect(f1.snapshot.promptFingerprints.includedInPlanFingerprint).toBe(false);
  });

  it('snapshot is sanitized — promptFingerprints does NOT leak prompt content', () => {
    const plan = makePlan();
    const pf = makePromptFingerprints('agg-sec');
    const snap = buildSanitizedPlanSnapshot({
      plan,
      strict: true,
      roleSpecificRetrieval: true,
      promptFingerprints: pf,
    });
    const serialized = JSON.stringify(snap);
    // Only hashes + template IDs allowed; no raw prompt content / messages.
    expect(serialized).not.toContain('You are');
    expect(serialized).not.toContain('Critical guidelines');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('api_key');
    // Hashes ARE allowed (`aaaa` placeholder is fine).
    expect(serialized).toContain('aaaa');
  });
});
