// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4D §12 — Judge eligibility restoration integration tests.
 *
 * Tests the FULL resolver path with the R4D judge eligibility policy
 * enabled, using fixture catalogs that mirror the production live-ready
 * state (models advertise only `chat`/`text_generation` capabilities,
 * with structured-output evidence supplied via the backfill artifact).
 *
 * Scope: resolver-level (not full planner). The planner-level expansion
 * is covered separately. These tests prove the structured-output
 * normalization works end-to-end inside `resolver.resolve(...)`.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '@/core/orchestration/model-selection/model-role-resolver';
import type { StructuredOutputBackfillEntry } from '@/core/orchestration/model-selection/structured-output-capability';
import { makeCandidate, makeModel } from './role-resolver.fixtures';
import type { ModelCandidate, TaskProfile } from '../model-role-types';

const taskProfile: TaskProfile = {
  taskType: 'analysis',
  complexity: 'medium',
  expectedFormat: 'json',
};

function buildJudgeFixturePool(): readonly ModelCandidate[] {
  return [
    makeCandidate({
      id: 'opaque/json-explicit',
      model: makeModel({
        id: 'opaque/json-explicit',
        providerId: 'fixture-a',
        provider: 'fixture-a',
        // capability INCLUDES json_output directly.
        capabilities: ['chat', 'text_generation', 'json_output'] as never,
        contextWindow: 200000,
      }),
      providerId: 'fixture-a',
      estimatedCostPerCallUsd: 0.001,
    }),
    makeCandidate({
      id: 'opaque/tooluse-only',
      model: makeModel({
        id: 'opaque/tooluse-only',
        providerId: 'fixture-b',
        provider: 'fixture-b',
        capabilities: ['chat', 'tool_use'] as never,
        contextWindow: 200000,
      }),
      providerId: 'fixture-b',
      estimatedCostPerCallUsd: 0.001,
    }),
    makeCandidate({
      id: 'opaque/no-capability-but-backfilled',
      model: makeModel({
        id: 'opaque/no-capability-but-backfilled',
        providerId: 'fixture-c',
        provider: 'fixture-c',
        // catalog only knows chat — but a backfill entry exists.
        capabilities: ['chat', 'text_generation'] as never,
        contextWindow: 200000,
      }),
      providerId: 'fixture-c',
      estimatedCostPerCallUsd: 0.001,
    }),
    makeCandidate({
      id: 'opaque/no-evidence',
      model: makeModel({
        id: 'opaque/no-evidence',
        providerId: 'fixture-d',
        provider: 'fixture-d',
        capabilities: ['chat', 'text_generation'] as never,
        contextWindow: 200000,
      }),
      providerId: 'fixture-d',
      estimatedCostPerCallUsd: 0.001,
    }),
    makeCandidate({
      id: 'opaque/weak-only',
      model: makeModel({
        id: 'opaque/weak-only',
        providerId: 'fixture-e',
        provider: 'fixture-e',
        capabilities: ['chat', 'instruction_json'] as never,
        contextWindow: 200000,
      }),
      providerId: 'fixture-e',
      estimatedCostPerCallUsd: 0.001,
    }),
  ];
}

const backfillForC: StructuredOutputBackfillEntry[] = [
  {
    providerId: 'fixture-c',
    modelId: 'opaque/no-capability-but-backfilled',
    support: 'strong',
    reason: 'family supports response_format=json_object',
    confidence: 'high',
    source: 'docs',
  },
];

describe('01C.1B-J1D-R4D — judge eligibility restoration (resolver path)', () => {
  const resolver = new ModelRoleResolver();

  it('legacy: requireJsonOutput=true rejects backfill-only candidate without R4D policy', async () => {
    const pool = buildJudgeFixturePool();
    const result = await resolver.resolve({
      taskProfile,
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: pool,
      constraints: { requireJsonOutput: true, count: 1 },
      // No judgeEligibilityPolicy → legacy narrow filter.
    });
    // Legacy filter accepts json_output OR tool_use → both fixture-a and
    // fixture-b qualify; fixture-c (backfill-only) is rejected; fixture-d
    // (no evidence) is rejected; fixture-e (weak) is rejected.
    expect(result.selected.length).toBe(1);
    expect(result.rejected.map((r) => r.modelId)).toContain(
      'opaque/no-capability-but-backfilled',
    );
    expect(result.rejected.map((r) => r.modelId)).toContain('opaque/no-evidence');
    expect(result.rejected.map((r) => r.modelId)).toContain('opaque/weak-only');
  });

  it('R4D: structured-output normalization accepts backfill-provided strong evidence', async () => {
    const pool = buildJudgeFixturePool();
    const result = await resolver.resolve({
      taskProfile,
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: pool,
      constraints: { requireJsonOutput: true, count: 1 },
      judgeEligibilityPolicy: {
        enabled: true,
        useJudgeStructuredOutputNormalization: true,
        allowWeakStructuredOutputForJudge: false,
        structuredOutputBackfill: backfillForC,
        includeTrace: true,
      },
    });
    // With R4D: a, b (medium tool_use), c (backfill) all qualify.
    // d (none) and e (weak) still rejected.
    expect(result.selected.length).toBe(1);
    // d and e MUST be rejected for json_output (none / weak disallowed).
    const dRejection = result.rejected.find((r) => r.modelId === 'opaque/no-evidence');
    const eRejection = result.rejected.find((r) => r.modelId === 'opaque/weak-only');
    expect(dRejection?.reason).toBe('json_output_not_supported');
    expect(eRejection?.reason).toMatch(/json_output_weak|json_output_not_supported/);
    // c MUST NOT be rejected for any json_output reason. (It may be
    // unselected if ranking puts it behind a or b, but that doesn't
    // mean rejection — `rejected` only carries filter failures.)
    const cRejection = result.rejected.find(
      (r) => r.modelId === 'opaque/no-capability-but-backfilled',
    );
    if (cRejection) {
      expect(cRejection.reason).not.toMatch(/json_output/);
    }
    // The 3 strong+medium candidates (a, b, c) must NOT be rejected for
    // structured-output reasons — only d and e get json_output rejections.
    const jsonRejections = result.rejected.filter((r) => /json_output/.test(r.reason));
    expect(jsonRejections.map((r) => r.modelId).sort()).toEqual(
      ['opaque/no-evidence', 'opaque/weak-only'].sort(),
    );
  });

  it('R4D weak-allowed: judge accepts weak when allowWeakStructuredOutputForJudge=true', async () => {
    const pool = buildJudgeFixturePool();
    const result = await resolver.resolve({
      taskProfile,
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: pool,
      constraints: { requireJsonOutput: true, count: 1 },
      judgeEligibilityPolicy: {
        enabled: true,
        useJudgeStructuredOutputNormalization: true,
        allowWeakStructuredOutputForJudge: true,
      },
    });
    // With weak allowed, fixture-e is NOT rejected for json_output reasons.
    // It may either be selected or rejected for another reason (e.g. cost).
    const eRejection = result.rejected.find((r) => r.modelId === 'opaque/weak-only');
    if (eRejection) {
      expect(eRejection.reason).not.toMatch(/json_output/);
    }
    // assert e was at least eligible going into ranking (no json filter rejection).
    expect(eRejection?.reason ?? '').not.toMatch(/json_output/);
  });

  it('R4D does NOT affect participant role', async () => {
    const pool = buildJudgeFixturePool();
    const result = await resolver.resolve({
      taskProfile,
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: pool,
      constraints: { count: 3 }, // no requireJsonOutput
      judgeEligibilityPolicy: {
        enabled: true,
        useJudgeStructuredOutputNormalization: true,
      },
    });
    // role=participant means the role_specific stage is a no-op. All
    // 5 fixture candidates pass.
    expect(result.selected.length).toBe(3);
  });

  it('R4D does NOT affect synthesizer role', async () => {
    const pool = buildJudgeFixturePool();
    const result = await resolver.resolve({
      taskProfile,
      strategyName: 'consensus',
      role: 'synthesizer',
      candidatePool: pool,
      constraints: { count: 1 },
      judgeEligibilityPolicy: {
        enabled: true,
        useJudgeStructuredOutputNormalization: true,
      },
    });
    expect(result.selected.length).toBe(1);
  });

  it('R4D backfill cannot override a "none" candidate when source is "weak"', async () => {
    const pool = buildJudgeFixturePool();
    const weakBackfill: StructuredOutputBackfillEntry[] = [
      {
        providerId: 'fixture-d',
        modelId: 'opaque/no-evidence',
        support: 'weak',
        reason: 'override',
        confidence: 'low',
        source: 'manual',
      },
    ];
    const result = await resolver.resolve({
      taskProfile,
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: pool,
      constraints: { requireJsonOutput: true, count: 1 },
      judgeEligibilityPolicy: {
        enabled: true,
        useJudgeStructuredOutputNormalization: true,
        allowWeakStructuredOutputForJudge: false,
        structuredOutputBackfill: weakBackfill,
      },
    });
    // d has weak backfill but weak is disallowed → still rejected.
    const dRejection = result.rejected.find((r) => r.modelId === 'opaque/no-evidence');
    expect(dRejection?.reason).toMatch(/json_output/);
  });

  it('R4D off: useJudgeStructuredOutputNormalization=false preserves legacy behavior', async () => {
    const pool = buildJudgeFixturePool();
    const result = await resolver.resolve({
      taskProfile,
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: pool,
      constraints: { requireJsonOutput: true, count: 1 },
      judgeEligibilityPolicy: {
        enabled: true,
        useJudgeStructuredOutputNormalization: false,
        structuredOutputBackfill: backfillForC,
      },
    });
    // With normalization OFF: backfill is ignored, only legacy capabilities count.
    const cRejection = result.rejected.find(
      (r) => r.modelId === 'opaque/no-capability-but-backfilled',
    );
    expect(cRejection?.reason).toBe('json_output_not_supported');
  });

  it('R4D never selects on hardcoded id — selection is policy-driven', async () => {
    // Build a pool with model ids that intentionally don't match any
    // known model family or hardcoded list. With the R4D normalization +
    // backfill, selection succeeds purely from the structured-output
    // policy.
    const pool: readonly ModelCandidate[] = [
      makeCandidate({
        id: 'random-id-xyz',
        model: makeModel({
          id: 'random-id-xyz',
          capabilities: ['chat', 'structured_output'] as never,
        }),
        providerId: 'p',
        estimatedCostPerCallUsd: 0.001,
      }),
    ];
    const result = await resolver.resolve({
      taskProfile,
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: pool,
      constraints: { requireJsonOutput: true, count: 1 },
      judgeEligibilityPolicy: {
        enabled: true,
        useJudgeStructuredOutputNormalization: true,
      },
    });
    expect(result.selected.length).toBe(1);
    expect(result.selected[0]!.model.id).toBe('random-id-xyz');
  });
});
