// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-I3A §10 — Tests for runtime wiring of promptFingerprints +
 * routeCandidates into planFingerprint.
 *
 * These tests focus on the pure fingerprint computation contract — that
 * passing the projections from the dry-run plan changes the fingerprint
 * deterministically. The CALLER-level wiring (chat-request-processor
 * extracting fields from the plan + passing to computePlanFingerprint)
 * is also exercised end-to-end via the dry-run service runtime tests.
 */
import { describe, it, expect } from 'vitest';
import {
  computePlanFingerprint,
  buildSanitizedPlanSnapshot,
  type RouteCandidatesSnapshot,
  type PromptFingerprintsSnapshot,
} from '../strategies/consensus-plan-fingerprint';
import type { ConsensusExecutionPlan } from '../strategies/consensus-execution-planner';
import type { Model } from '@/types';

function makeModel(id: string, providerId: string): Model {
  return {
    id, name: id, provider: providerId,
    capabilities: ['chat'], contextWindow: 8000,
    inputCostPer1k: 0.001, outputCostPer1k: 0.002,
    description: 'test',
  } as Model;
}

function makePlan(): ConsensusExecutionPlan {
  const m = makeModel('gpt-4o', 'openai');
  return {
    participants: [{ model: m, providerId: 'openai', taskFitScore: 0.9, selectionSource: 'dynamic' } as never],
    synthesizer: { model: m, providerId: 'openai', taskFitScore: 0.9, selectionSource: 'dynamic' } as never,
    judge: { model: m, providerId: 'openai', taskFitScore: 0.9, selectionSource: 'dynamic' } as never,
    fallbackSingle: { model: m, providerId: 'openai', taskFitScore: 0.9, selectionSource: 'dynamic' } as never,
    selectionSource: 'dynamic',
  } as ConsensusExecutionPlan;
}

function makePromptFingerprints(aggregate: string): PromptFingerprintsSnapshot {
  return {
    aggregate,
    perRole: [
      { role: 'participant', promptTemplateId: 'consensusVoter', promptVersion: 'v1', promptFingerprint: 'aaaa' },
    ],
    includedInPlanFingerprint: true,
  };
}

function makeRouteCandidates(apiModelId: string): RouteCandidatesSnapshot {
  return {
    perRole: [{
      role: 'participant',
      logicalModelId: 'gpt-4o',
      candidates: [{
        routeId: 'openai::' + apiModelId + '::oai',
        logicalModelId: 'gpt-4o',
        apiModelId,
        providerId: 'openai',
        adapterKind: 'oai',
        endpointKind: 'chat',
        equivalenceKind: 'exact_same_model',
      }],
    }],
    policy: {
      orderBy: ['liveReady'],
      maxRouteAttempts: 3,
      allowOutOfPlanRoutes: false,
      allowModelFallback: false,
      allowRouterFallback: true,
      requireLiveReadyForCriticalRoles: true,
    },
    includedInPlanFingerprint: true,
  };
}

describe('I3A — promptFingerprints + routeCandidates in runtime fingerprint', () => {
  it('caller passing both snapshots produces deterministic fingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-x'),
      routeCandidates: makeRouteCandidates('gpt-4o'),
    });
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-x'),
      routeCandidates: makeRouteCandidates('gpt-4o'),
    });
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
  });

  it('changing promptFingerprint aggregate changes planFingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-a'),
      routeCandidates: makeRouteCandidates('gpt-4o'),
    });
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-b'),
      routeCandidates: makeRouteCandidates('gpt-4o'),
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('changing routeCandidates apiModelId changes planFingerprint', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-a'),
      routeCandidates: makeRouteCandidates('gpt-4o'),
    });
    const f2 = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-a'),
      routeCandidates: makeRouteCandidates('gpt-4o-mini'),
    });
    expect(f1.planFingerprint).not.toBe(f2.planFingerprint);
  });

  it('omitting both produces stable legacy fingerprint (bit-exact)', () => {
    const plan = makePlan();
    const f1 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    const f2 = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    expect(f1.planFingerprint).toBe(f2.planFingerprint);
    // Snapshot defaults to empty for legacy path.
    expect(f1.snapshot.promptFingerprints.includedInPlanFingerprint).toBe(false);
    expect(f1.snapshot.routeCandidates.includedInPlanFingerprint).toBe(false);
  });

  it('passing routeCandidates without promptFingerprints still changes fingerprint vs no-args', () => {
    const plan = makePlan();
    const fLegacy = computePlanFingerprint({ plan, strict: true, roleSpecificRetrieval: true });
    const fWithRoutes = computePlanFingerprint({
      plan, strict: true, roleSpecificRetrieval: true,
      routeCandidates: makeRouteCandidates('gpt-4o'),
    });
    expect(fLegacy.planFingerprint).not.toBe(fWithRoutes.planFingerprint);
  });

  it('snapshot via buildSanitizedPlanSnapshot does NOT leak secrets when both fields passed', () => {
    const snap = buildSanitizedPlanSnapshot({
      plan: makePlan(),
      strict: true,
      roleSpecificRetrieval: true,
      promptFingerprints: makePromptFingerprints('agg-sec'),
      routeCandidates: makeRouteCandidates('gpt-4o'),
    });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(serialized).not.toMatch(/api[_-]?key=/i);
    // Snapshot is allowed to mention prompt template IDs (consensusVoter is a public name).
  });
});
