// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1G-R0 §10.2 — No duplicate-scorer invariant.
 *
 * The hybrid synthesizer scorer must be invoked EXACTLY ONCE per
 * `resolve()` call when `role === 'synthesizer'`. A regression that
 * accidentally calls it twice (e.g., once in `rankPoolForSynthesizer`
 * and again in `buildSynthesizerSelectionSummary`) would double the
 * scoring cost on every synthesizer selection — and could even produce
 * subtly different scores if the policy were instantiated twice with
 * non-deterministic state.
 *
 * Strategy: wrap `scoreSynthesizerCandidate` with a spy and assert call
 * count == pool.length for ONE resolve() invocation. Also assert the
 * SynthesizerSelectionSummary attached to the result references the
 * SAME breakdown the scorer computed (no re-derivation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as synthPolicy from '@/core/orchestration/role-selection/synthesizer-role-policy';
import { ModelRoleResolver } from '@/core/orchestration/model-selection/model-role-resolver';
import type { ModelCandidate } from '@/core/orchestration/model-selection/model-role-types';

function makeCandidate(opts: {
  id: string;
  providerId: string;
  quality?: number;
}): ModelCandidate {
  return {
    model: {
      id: opts.id,
      provider: opts.providerId,
      name: opts.id,
      displayName: opts.id,
      contextWindow: 128000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.003,
      capabilities: ['chat', 'reasoning', 'instruction_following'] as never,
      status: 'active',
      performance: {
        latencyMs: 800, throughput: 100,
        quality: opts.quality ?? 0.8, reliability: 0.9,
      },
      metadata: {},
      providerName: opts.providerId,
      providerStatus: 'active',
    } as never,
    providerId: opts.providerId,
    estimatedCostPerCallUsd: 0.005,
    hasCredits: true,
    providerHealthy: true,
    rateLimited: false,
    isLocal: false,
    score: 0,
  };
}

describe('01C.1B-J1G-R0 §10.2 — no duplicate-scorer invariant', () => {
  let scoreSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scoreSpy = vi.spyOn(synthPolicy, 'scoreSynthesizerCandidate');
    scoreSpy.mockClear();
  });

  it('scoreSynthesizerCandidate is called EXACTLY pool.length times per synthesizer resolve()', async () => {
    const pool = [
      makeCandidate({ id: 'm1', providerId: 'p1' }),
      makeCandidate({ id: 'm2', providerId: 'p2' }),
      makeCandidate({ id: 'm3', providerId: 'p3' }),
      makeCandidate({ id: 'm4', providerId: 'p4' }),
      makeCandidate({ id: 'm5', providerId: 'p5' }),
    ];
    const resolver = new ModelRoleResolver({});
    await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
    });
    expect(scoreSpy).toHaveBeenCalledTimes(pool.length);
  });

  it('scoreSynthesizerCandidate is NOT called for non-synthesizer roles', async () => {
    const pool = [
      makeCandidate({ id: 'm1', providerId: 'p1' }),
      makeCandidate({ id: 'm2', providerId: 'p2' }),
    ];
    const resolver = new ModelRoleResolver({});
    await resolver.resolve({
      strategyName: 'consensus',
      role: 'participant',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: { count: 1 },
      candidatePool: pool,
    });
    expect(scoreSpy).toHaveBeenCalledTimes(0);
  });

  it('synthesizerSelectionSummary is attached ONLY for synthesizer role', async () => {
    const pool = [
      makeCandidate({ id: 'm1', providerId: 'p1' }),
      makeCandidate({ id: 'm2', providerId: 'p2' }),
    ];
    const resolver = new ModelRoleResolver({});

    const synth = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
    });
    expect(synth.synthesizerSelectionSummary).toBeDefined();
    expect(synth.synthesizerSelectionSummary!.policyVersion).toMatch(/01C.1B-J1G/);

    const part = await resolver.resolve({
      strategyName: 'consensus',
      role: 'participant',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: { count: 1 },
      candidatePool: pool,
    });
    expect(part.synthesizerSelectionSummary).toBeUndefined();
  });

  it('summary winner matches the picked candidate (no scorer re-derivation)', async () => {
    const pool = [
      makeCandidate({ id: 'high-q', providerId: 'p1', quality: 0.9 }),
      makeCandidate({ id: 'low-q', providerId: 'p2', quality: 0.7 }),
    ];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
    });
    const summary = result.synthesizerSelectionSummary!;
    expect(summary.winner).not.toBeNull();
    expect(summary.winner!.modelId).toBe(result.selected[0]?.model.id);
    expect(summary.winner!.providerId).toBe(result.selected[0]?.providerId);
  });

  it('candidatePoolHash is stable across multiple resolve() calls with same pool', async () => {
    const pool = [
      makeCandidate({ id: 'a', providerId: 'p1' }),
      makeCandidate({ id: 'b', providerId: 'p2' }),
      makeCandidate({ id: 'c', providerId: 'p3' }),
    ];
    const resolver = new ModelRoleResolver({});
    const r1 = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
    });
    const r2 = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
    });
    expect(r1.synthesizerSelectionSummary!.candidatePoolHash).toBe(
      r2.synthesizerSelectionSummary!.candidatePoolHash,
    );
    // And not the zero hash
    expect(r1.synthesizerSelectionSummary!.candidatePoolHash).not.toBe('00000000');
  });

  it('candidatePoolHash CHANGES when pool composition changes', async () => {
    const pool1 = [makeCandidate({ id: 'a', providerId: 'p1' })];
    const pool2 = [
      makeCandidate({ id: 'a', providerId: 'p1' }),
      makeCandidate({ id: 'b', providerId: 'p2' }),
    ];
    const resolver = new ModelRoleResolver({});
    const r1 = await resolver.resolve({
      strategyName: 'consensus', role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {}, candidatePool: pool1,
    });
    const r2 = await resolver.resolve({
      strategyName: 'consensus', role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {}, candidatePool: pool2,
    });
    expect(r1.synthesizerSelectionSummary!.candidatePoolHash).not.toBe(
      r2.synthesizerSelectionSummary!.candidatePoolHash,
    );
  });
});
