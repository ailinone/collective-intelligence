// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * participant role — selection uses capabilities, cost, health.
 * NOT model names.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '../model-role-resolver';
import { diversePool, makeCandidate, makeModel } from './role-resolver.fixtures';
import type { ModelCapability } from '@/types';

describe('ModelRoleResolver — participant', () => {
  it('selects 3 distinct providers when diversity is required', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: diversePool(),
      constraints: {},
    });
    expect(r.selected.length).toBe(3);
    const providers = new Set(r.selected.map((c) => c.providerId));
    expect(providers.size).toBe(3);
  });

  it('rejects providers without credits', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: diversePool(),
      constraints: {},
    });
    const rejectedNoCreds = r.rejected.filter((rej) => rej.reason === 'no_credits');
    expect(rejectedNoCreds.length).toBeGreaterThanOrEqual(1);
    expect(r.selected.find((c) => c.providerId === 'provider-broken')).toBeUndefined();
  });

  it('rejects rate-limited providers', async () => {
    const resolver = new ModelRoleResolver();
    const pool = [
      ...diversePool(),
      makeCandidate({ id: 'rate-limited', rateLimited: true }),
    ];
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: pool,
      constraints: {},
    });
    expect(r.rejected.some((rej) => rej.modelId === 'rate-limited' && rej.reason === 'rate_limited')).toBe(true);
  });

  it('rejects unhealthy providers', async () => {
    const resolver = new ModelRoleResolver();
    const pool = [
      ...diversePool(),
      makeCandidate({ id: 'unhealthy', providerHealthy: false }),
    ];
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: pool,
      constraints: {},
    });
    expect(r.rejected.some((rej) => rej.modelId === 'unhealthy' && rej.reason === 'provider_unhealthy')).toBe(true);
  });

  it('honors maxCostUsd by rejecting expensive candidates', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: [
        makeCandidate({ id: 'cheap', estimatedCostPerCallUsd: 0.001 }),
        makeCandidate({ id: 'mid', estimatedCostPerCallUsd: 0.005 }),
        makeCandidate({ id: 'expensive', estimatedCostPerCallUsd: 0.5 }),
      ],
      constraints: { maxCostUsd: 0.01 },
    });
    expect(r.selected.find((c) => c.model.id === 'expensive')).toBeUndefined();
    expect(r.rejected.some((rej) => rej.modelId === 'expensive' && rej.reason === 'cost_over_budget')).toBe(true);
  });

  it('selectionSource is "dynamic" — no explicit override', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: diversePool(),
      constraints: {},
    });
    expect(r.trace.selectionSource).toBe('dynamic');
    expect(r.trace.hardcodedModelUsed).toBe(false);
  });

  it('trace records every filter stage', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: diversePool(),
      constraints: { maxCostUsd: 0.01 },
    });
    expect(r.trace.stageCounts.capability).toBeGreaterThanOrEqual(0);
    expect(r.trace.stageCounts.health).toBeGreaterThanOrEqual(0);
    expect(r.trace.stageCounts.credits).toBeGreaterThanOrEqual(0);
    expect(r.trace.stageCounts.rate_limit).toBeGreaterThanOrEqual(0);
    expect(r.trace.stageCounts.cost).toBeGreaterThanOrEqual(0);
    expect(r.trace.stageCounts.context_window).toBeGreaterThanOrEqual(0);
  });

  it('applies code_generation preference for code-generation tasks (rank, not filter)', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'code-generation' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: [
        makeCandidate({
          id: 'code-capable',
          model: makeModel({
            id: 'code-capable',
            provider: 'p1',
            capabilities: ['chat', 'text_generation', 'code_generation', 'reasoning'] as ModelCapability[],
            performance: { latencyMs: 1000, throughput: 100, quality: 0.8, reliability: 0.92 },
          }),
        }),
        makeCandidate({
          id: 'chat-only',
          model: makeModel({
            id: 'chat-only',
            provider: 'p2',
            capabilities: ['chat', 'text_generation'] as ModelCapability[],
            performance: { latencyMs: 1000, throughput: 100, quality: 0.8, reliability: 0.92 },
          }),
        }),
        makeCandidate({
          id: 'plain-c',
          model: makeModel({
            id: 'plain-c',
            provider: 'p3',
            capabilities: ['chat', 'text_generation'] as ModelCapability[],
            performance: { latencyMs: 1000, throughput: 100, quality: 0.8, reliability: 0.92 },
          }),
        }),
      ],
      constraints: {},
    });
    // code-capable should rank first thanks to preferredCapBoost
    expect(r.selected[0].model.id).toBe('code-capable');
  });
});
