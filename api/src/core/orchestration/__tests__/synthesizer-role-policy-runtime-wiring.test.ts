// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1G-R0 §10.1 — Runtime wiring proof.
 *
 * The hybrid synthesizer policy is now invoked by model-role-resolver.ts
 * when role === 'synthesizer'. These tests prove the integration —
 * specifically that the runtime selection diverges from the legacy
 * scorer when the legacy would pick a low-coverage high-quality model
 * but the hybrid prefers a higher-coverage one.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '@/core/orchestration/model-selection/model-role-resolver';
import type { ModelCandidate } from '@/core/orchestration/model-selection/model-role-types';

function makeCandidate(opts: {
  id: string;
  providerId: string;
  quality: number;
  contextWindow?: number;
  costPerCall?: number;
  capabilities?: string[];
}): ModelCandidate {
  return {
    model: {
      id: opts.id,
      provider: opts.providerId,
      name: opts.id,
      displayName: opts.id,
      contextWindow: opts.contextWindow ?? 128000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.003,
      capabilities: (opts.capabilities ?? ['chat', 'reasoning', 'instruction_following']) as never,
      status: 'active',
      performance: { latencyMs: 800, throughput: 100, quality: opts.quality, reliability: 0.9 },
      metadata: {},
      providerName: opts.providerId,
      providerStatus: 'active',
    } as never,
    providerId: opts.providerId,
    estimatedCostPerCallUsd: opts.costPerCall ?? 0.005,
    hasCredits: true,
    providerHealthy: true,
    rateLimited: false,
    isLocal: false,
    score: 0,
  };
}

describe('01C.1B-J1G-R0 §10.1 — synthesizer runtime wiring', () => {
  it('uses hybrid scorer when role=synthesizer (low-coverage high-quality loses to high-coverage acceptable-quality)', async () => {
    // Two candidates from different families — old: single provider, high quality;
    // new: multi-provider, slightly lower quality.
    const oldHighQ = makeCandidate({ id: 'claude-3.7-sonnet-stale', providerId: 'anthropic', quality: 0.9 });
    const newMultiP = [
      makeCandidate({ id: 'claude-opus-4', providerId: 'anthropic' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'openrouter' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'aiml' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'cometapi' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'vercel-ai-gateway' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'edenai' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'orqai' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'heliconeai' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'aihubmix' }),
      makeCandidate({ id: 'claude-opus-4', providerId: 'requesty' }),
    ].map((c) => ({ ...c, model: { ...c.model, performance: { ...c.model.performance, quality: 0.8 } } as never }));
    const pool = [oldHighQ, ...newMultiP];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: pool,
    });
    // With hybrid scoring, claude-opus-4 (high coverage) MUST beat the single-provider stale model
    expect(result.selected[0]?.model.id).toBe('claude-opus-4');
    expect(result.selected[0]?.model.id).not.toBe('claude-3.7-sonnet-stale');
  });

  it('legacy scorer still used for non-synthesizer roles (participant)', async () => {
    const oldHighQ = makeCandidate({ id: 'claude-3.7-sonnet-stale', providerId: 'anthropic', quality: 0.9 });
    const newMultiP = makeCandidate({ id: 'gpt-4o', providerId: 'openai', quality: 0.8 });
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'participant',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: { count: 1 },
      candidatePool: [oldHighQ, newMultiP],
    });
    // Participant role: legacy scorer; high quality wins on quality * 1.2
    expect(result.selected[0]?.model.id).toBe('claude-3.7-sonnet-stale');
  });

  it('hybrid scorer rejects candidates below quality floor (0.6)', async () => {
    const lowQ = makeCandidate({ id: 'low-quality-model', providerId: 'p1', quality: 0.4 });
    const goodQ = makeCandidate({ id: 'good-quality-model', providerId: 'p2', quality: 0.85 });
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [lowQ, goodQ],
    });
    // Quality floor HARD-rejects 0.4; goodQ wins
    expect(result.selected[0]?.model.id).toBe('good-quality-model');
  });

  it('multi-provider beats single-provider equivalent when quality gap is small (positive coverage bonus, J1G-R2)', async () => {
    const singleP = makeCandidate({ id: 'sonnet-alpha', providerId: 'p1', quality: 0.85 });
    const multiP = [
      makeCandidate({ id: 'sonnet-beta', providerId: 'p1', quality: 0.82 }),
      makeCandidate({ id: 'sonnet-beta', providerId: 'p2', quality: 0.82 }),
      makeCandidate({ id: 'sonnet-beta', providerId: 'p3', quality: 0.82 }),
      makeCandidate({ id: 'sonnet-beta', providerId: 'p4', quality: 0.82 }),
      makeCandidate({ id: 'sonnet-beta', providerId: 'p5', quality: 0.82 }),
      makeCandidate({ id: 'sonnet-beta', providerId: 'p6', quality: 0.82 }),
    ];
    const resolver = new ModelRoleResolver({});
    const result = await resolver.resolve({
      strategyName: 'consensus',
      role: 'synthesizer',
      taskProfile: { taskType: 'general', expectedFormat: 'text', userMessageExcerpt: '' },
      constraints: {},
      candidatePool: [singleP, ...multiP],
    });
    // 01C.1B-J1G-R2 — multi-provider wins via POSITIVE coverage bonus only
    // (no more penalties). With quality delta of just +0.012 (0.03 × 0.40),
    // the coverage delta of +0.082 still dominates. But the gap is narrower
    // than under R0, so a larger quality advantage CAN flip the result.
    expect(result.selected[0]?.model.id).toBe('sonnet-beta');
  });
});
