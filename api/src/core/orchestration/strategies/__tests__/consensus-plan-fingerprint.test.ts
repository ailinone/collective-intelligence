// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-P — Plan fingerprint determinism + diff tests.
 *
 * Pins:
 *   - same plan input → same fingerprint
 *   - any role-level change → different fingerprint
 *   - budget / strict changes → different fingerprint
 *   - diff payload structure matches `PlanFingerprintDiff` contract
 *   - executionPlanId is fresh per call (random uuid)
 *   - sanitized snapshot contains no secrets
 */
import { describe, it, expect } from 'vitest';
import {
  computePlanFingerprint,
  diffPlanFingerprints,
  buildSanitizedPlanSnapshot,
  PLANNER_VERSION,
} from '../consensus-plan-fingerprint';
import type { ConsensusExecutionPlan } from '../consensus-execution-planner';
import { makeCandidate, makeModel } from '../../model-selection/__tests__/role-resolver.fixtures';

function makePlan(overrides: Partial<ConsensusExecutionPlan> = {}): ConsensusExecutionPlan {
  return {
    strategyName: 'consensus',
    taskProfile: { taskType: 'general', approximateInputTokens: 800 },
    participants: overrides.participants ?? [
      makeCandidate({ id: 'voter-a', model: makeModel({ id: 'voter-a', provider: 'prov-a' }) }),
      makeCandidate({ id: 'voter-b', model: makeModel({ id: 'voter-b', provider: 'prov-b' }) }),
      makeCandidate({ id: 'voter-c', model: makeModel({ id: 'voter-c', provider: 'prov-c' }) }),
    ],
    synthesizer:
      overrides.synthesizer ??
      makeCandidate({ id: 'synth-1', model: makeModel({ id: 'synth-1', provider: 'prov-synth' }) }),
    judge:
      overrides.judge ??
      makeCandidate({ id: 'judge-1', model: makeModel({ id: 'judge-1', provider: 'prov-judge' }) }),
    fallbackSingle:
      overrides.fallbackSingle ??
      makeCandidate({ id: 'fb-1', model: makeModel({ id: 'fb-1', provider: 'prov-fb' }) }),
    roleSelectionTrace: [],
    executable: true,
    blockers: [],
    hardcodedModelUsed: false,
    selectionSource: 'dynamic',
    ...overrides,
  };
}

describe('computePlanFingerprint', () => {
  it('produces a stable hash for the same plan content', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
    // executionPlanId is fresh
    expect(f1.executionPlanId).not.toBe(f2.executionPlanId);
    // executionPlanId is a uuid-ish string
    expect(f1.executionPlanId).toMatch(/^[0-9a-f-]{30,}$/);
  });

  it('changes the fingerprint when judge changes', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    const plan2 = makePlan({
      judge: makeCandidate({ id: 'judge-2', model: makeModel({ id: 'judge-2', provider: 'prov-judge-x' }) }),
    });
    const f2 = computePlanFingerprint({ plan: plan2, strict: true, roleSpecificRetrieval: true });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('changes the fingerprint when participants order changes', () => {
    const plan1 = makePlan();
    const plan2 = makePlan({
      participants: [
        makeCandidate({ id: 'voter-c', model: makeModel({ id: 'voter-c', provider: 'prov-c' }) }),
        makeCandidate({ id: 'voter-b', model: makeModel({ id: 'voter-b', provider: 'prov-b' }) }),
        makeCandidate({ id: 'voter-a', model: makeModel({ id: 'voter-a', provider: 'prov-a' }) }),
      ],
    });
    const f1 = computePlanFingerprint({ plan: plan1, strict: true, roleSpecificRetrieval: true });
    const f2 = computePlanFingerprint({ plan: plan2, strict: true, roleSpecificRetrieval: true });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('changes the fingerprint when budget changes', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan,
      strict: true,
      roleSpecificRetrieval: true,
      budget: { maxTotalCostUsd: 1.0 },
    });
    const f2 = computePlanFingerprint({
      plan,
      strict: true,
      roleSpecificRetrieval: true,
      budget: { maxTotalCostUsd: 2.0 },
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('changes the fingerprint when strict flag flips', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    const f2 = computePlanFingerprint({ plan, strict: false, roleSpecificRetrieval: true });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('snapshot is sanitized — no prompt CONTENT, no secrets', () => {
    const plan = makePlan();
    const snap = buildSanitizedPlanSnapshot({ plan, strict: true, roleSpecificRetrieval: true });
    // Spot-check: NO messages, NO max_tokens, NO API keys leaked
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toMatch(/messages/i);
    expect(serialized).not.toMatch(/bearer/i);
    expect(serialized).not.toMatch(/api[_-]?key/i);
    // 01C.1B-G4 — `promptFingerprints` field name is legitimate (it carries
    // SHA-256 hashes, never raw prompt text). We still must NOT leak prompt
    // BODIES — verify by checking that no field looks like raw content.
    // Per-role projection only has: role, promptTemplateId, promptVersion,
    // promptFingerprint (hex). No `body`, `text`, `content`, or `messagesShape.content`.
    expect(serialized).not.toMatch(/"body"|"text"|"rawPrompt"|"promptBody"/);
    expect(serialized).not.toMatch(/You are an expert/i);  // canonical wording from sota-system-prompts
    expect(serialized).not.toMatch(/Critical guidelines/i);
    expect(snap.plannerVersion).toBe(PLANNER_VERSION);
    expect(snap.registryScope).toBe('full_system_registry');
    expect(snap.probeScope).toBe('auxiliary');
    // 01C.1B-G4 — promptFingerprints field is present with empty defaults
    // when no traces passed in.
    expect(snap.promptFingerprints).toBeDefined();
    expect(snap.promptFingerprints.aggregate).toBe('');
    expect(snap.promptFingerprints.perRole).toEqual([]);
    expect(snap.promptFingerprints.includedInPlanFingerprint).toBe(false);
  });

  it('records planSource correctly', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint(
      { plan, strict: true, roleSpecificRetrieval: true },
      { planSource: 'dry_run' },
    );
    expect(f1.planSource).toBe('dry_run');
    const f2 = computePlanFingerprint(
      { plan, strict: true, roleSpecificRetrieval: true },
      { planSource: 'runtime_planner' },
    );
    expect(f2.planSource).toBe('runtime_planner');
  });
});

describe('diffPlanFingerprints', () => {
  it('returns matched=true and empty mismatches when fingerprints align', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    const diff = diffPlanFingerprints(
      { fingerprint: f1.planFingerprint, snapshot: f1.snapshot },
      { fingerprint: f1.planFingerprint, snapshot: f1.snapshot },
    );
    expect(diff.matched).toBe(true);
    expect(Object.keys(diff.mismatches)).toHaveLength(0);
  });

  it('isolates the judge-mismatch into the diff', () => {
    const planA = makePlan();
    const planB = makePlan({
      judge: makeCandidate({ id: 'judge-other', model: makeModel({ id: 'judge-other', provider: 'prov-other' }) }),
    });
    const fA = computePlanFingerprint({ plan: planA, strict: true, roleSpecificRetrieval: true });
    const fB = computePlanFingerprint({ plan: planB, strict: true, roleSpecificRetrieval: true });
    const diff = diffPlanFingerprints(
      { fingerprint: fA.planFingerprint, snapshot: fA.snapshot },
      { fingerprint: fB.planFingerprint, snapshot: fB.snapshot },
    );
    expect(diff.matched).toBe(false);
    expect(diff.mismatches.judge).toEqual({
      approved: 'judge-1',
      wouldExecute: 'judge-other',
    });
    // Other roles unchanged → no mismatch entries for them
    expect(diff.mismatches.synthesizer).toBeUndefined();
    expect(diff.mismatches.participants).toBeUndefined();
    expect(diff.mismatches.fallback).toBeUndefined();
  });

  it('isolates participants-order mismatch', () => {
    const planA = makePlan();
    const planB = makePlan({
      participants: [
        makeCandidate({ id: 'voter-c', model: makeModel({ id: 'voter-c', provider: 'prov-c' }) }),
        makeCandidate({ id: 'voter-b', model: makeModel({ id: 'voter-b', provider: 'prov-b' }) }),
        makeCandidate({ id: 'voter-a', model: makeModel({ id: 'voter-a', provider: 'prov-a' }) }),
      ],
    });
    const fA = computePlanFingerprint({ plan: planA, strict: true, roleSpecificRetrieval: true });
    const fB = computePlanFingerprint({ plan: planB, strict: true, roleSpecificRetrieval: true });
    const diff = diffPlanFingerprints(
      { fingerprint: fA.planFingerprint, snapshot: fA.snapshot },
      { fingerprint: fB.planFingerprint, snapshot: fB.snapshot },
    );
    expect(diff.matched).toBe(false);
    expect(diff.mismatches.participants).toBeDefined();
    expect(diff.mismatches.participants?.approved).toEqual(['voter-a', 'voter-b', 'voter-c']);
    expect(diff.mismatches.participants?.wouldExecute).toEqual(['voter-c', 'voter-b', 'voter-a']);
  });
});
