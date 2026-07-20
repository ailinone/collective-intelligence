// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Resolver resilience under partial provider failure.
 *
 * Spec 01C.0.1 §17: providers in no_credits / auth_failed / rate_limited
 * must be SKIPPED (rejected with a reason), not fatal — as long as at
 * least one usable candidate exists, the resolver finds it.
 *
 * Together with `aggregator-fallback` and `stale-credit-state` files
 * below, this pins the "don't stop at the first error" contract.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '../model-role-resolver';
import { makeCandidate, makeModel } from './role-resolver.fixtures';
import type { ModelCapability } from '@/types';

describe('Resolver — provider credit resilience', () => {
  it('skips no_credits providers and picks the one with credits', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [
        makeCandidate({
          id: 'broke-1',
          hasCredits: false,
          model: makeModel({ id: 'broke-1', provider: 'p-broke' }),
        }),
        makeCandidate({
          id: 'broke-2',
          hasCredits: false,
          model: makeModel({ id: 'broke-2', provider: 'p-broke' }),
        }),
        makeCandidate({
          id: 'works',
          hasCredits: true,
          model: makeModel({ id: 'works', provider: 'p-works' }),
        }),
      ],
      constraints: {},
    });
    expect(r.selected[0]?.model.id).toBe('works');
    expect(r.rejected.filter((rej) => rej.reason === 'no_credits').length).toBe(2);
    expect(r.trace.notes).not.toContain('no_candidate_satisfies_constraints');
  });

  it('skips auth_failed (unhealthy) providers and continues', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [
        makeCandidate({
          id: 'auth-failed-1',
          providerHealthy: false,
          model: makeModel({ id: 'auth-failed-1', provider: 'p-auth' }),
        }),
        makeCandidate({
          id: 'rate-limited-1',
          rateLimited: true,
          model: makeModel({ id: 'rate-limited-1', provider: 'p-rate' }),
        }),
        makeCandidate({
          id: 'works',
          model: makeModel({ id: 'works', provider: 'p-works' }),
        }),
      ],
      constraints: {},
    });
    expect(r.selected[0]?.model.id).toBe('works');
    const reasons = new Set(r.rejected.map((rej) => rej.reason));
    expect(reasons.has('provider_unhealthy')).toBe(true);
    expect(reasons.has('rate_limited')).toBe(true);
  });

  it('participant role with one broken provider still produces 3 voters across distinct providers', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: [
        makeCandidate({
          id: 'broken',
          hasCredits: false,
          model: makeModel({ id: 'broken', provider: 'p-broken' }),
        }),
        makeCandidate({ id: 'a', model: makeModel({ id: 'a', provider: 'p-a' }) }),
        makeCandidate({ id: 'b', model: makeModel({ id: 'b', provider: 'p-b' }) }),
        makeCandidate({ id: 'c', model: makeModel({ id: 'c', provider: 'p-c' }) }),
      ],
      constraints: {},
    });
    expect(r.selected.length).toBe(3);
    expect(r.selected.some((c) => c.model.id === 'broken')).toBe(false);
    expect(new Set(r.selected.map((c) => c.providerId)).size).toBe(3);
  });

  it('judge falls through participant exclusions when an independent JSON-capable model has credits', async () => {
    const resolver = new ModelRoleResolver();
    const participantIds = ['part-a', 'part-b', 'part-c'];
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: [
        makeCandidate({
          id: 'part-a',
          model: makeModel({
            id: 'part-a',
            provider: 'p-a',
            capabilities: ['chat', 'json_mode'] as ModelCapability[],
          }),
        }),
        makeCandidate({
          id: 'broke-judge',
          hasCredits: false,
          model: makeModel({
            id: 'broke-judge',
            provider: 'p-broke',
            capabilities: ['chat', 'json_mode'] as ModelCapability[],
          }),
        }),
        makeCandidate({
          id: 'fresh-judge',
          model: makeModel({
            id: 'fresh-judge',
            provider: 'p-fresh',
            capabilities: ['chat', 'json_mode', 'function_calling'] as ModelCapability[],
          }),
        }),
      ],
      constraints: { requireJsonOutput: true, excludeModelIds: participantIds },
    });
    expect(r.selected[0]?.model.id).toBe('fresh-judge');
  });

  it('only fully fails (empty selection + note) when EVERY candidate is broken', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: [
        makeCandidate({
          id: 'a',
          hasCredits: false,
          model: makeModel({ id: 'a', provider: 'p-a' }),
        }),
        makeCandidate({
          id: 'b',
          providerHealthy: false,
          model: makeModel({ id: 'b', provider: 'p-b' }),
        }),
        makeCandidate({
          id: 'c',
          rateLimited: true,
          model: makeModel({ id: 'c', provider: 'p-c' }),
        }),
      ],
      constraints: {},
    });
    expect(r.selected.length).toBe(0);
    expect(r.trace.notes).toContain('no_candidate_satisfies_constraints');
    // breakdown: at least one of each reason in rejected[]
    const reasons = new Set(r.rejected.map((rej) => rej.reason));
    expect(reasons.size).toBeGreaterThanOrEqual(2);
  });
});

describe('Resolver — aggregator / router / local fallback', () => {
  it('picks an aggregator (cloud) when primary providers all broken', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [
        makeCandidate({
          id: 'primary-1',
          hasCredits: false,
          model: makeModel({ id: 'primary-1', provider: 'p-primary-1' }),
        }),
        makeCandidate({
          id: 'primary-2',
          hasCredits: false,
          model: makeModel({ id: 'primary-2', provider: 'p-primary-2' }),
        }),
        makeCandidate({
          id: 'aggregator-route',
          model: makeModel({ id: 'aggregator-route', provider: 'aihubmix' }),
        }),
      ],
      constraints: {},
    });
    expect(r.selected[0]?.model.id).toBe('aggregator-route');
  });

  it('picks a local/Ollama candidate when all cloud providers have no credits', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [
        makeCandidate({
          id: 'cloud-1',
          hasCredits: false,
          model: makeModel({ id: 'cloud-1', provider: 'cloud-a' }),
        }),
        makeCandidate({
          id: 'cloud-2',
          hasCredits: false,
          model: makeModel({ id: 'cloud-2', provider: 'cloud-b' }),
        }),
        makeCandidate({
          id: 'local-x',
          isLocal: true,
          model: makeModel({
            id: 'local-x',
            provider: 'ollama',
            contextWindow: 32000,
          }),
        }),
      ],
      constraints: {},
    });
    expect(r.selected[0]?.model.id).toBe('local-x');
  });
});
