// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OperationalCandidatePool — pool of execution-eligible (provider, model) tuples.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyProviderError } from '../error-classification';
import {
  getOperationalCandidatePool,
  resetOperationalCandidatePoolForTesting,
} from '../operational-candidate-pool';
import {
  getProviderHealthRegistry,
  resetProviderHealthRegistryForTesting,
} from '../provider-health-registry';
import {
  resetHealthSyncBusForTesting,
} from '../health-sync-bus';
import type { ProviderDiscoverySnapshot } from '../types';

function buildSnapshot(
  results: Array<{
    providerId: string;
    available: boolean;
    models?: Array<{ modelId: string; family?: string; contextWindow?: number }>;
  }>,
): ProviderDiscoverySnapshot {
  const map = new Map<string, ReturnType<typeof makeResult>>();
  for (const r of results) {
    map.set(r.providerId, makeResult(r));
  }
  return {
    generatedAt: new Date().toISOString(),
    durationMs: 100,
    totalConfigured: results.length,
    totalAvailable: results.filter((r) => r.available).length,
    totalUnavailable: results.filter((r) => !r.available).length,
    results: map,
  };
}

function makeResult(r: { providerId: string; available: boolean; models?: Array<{ modelId: string; family?: string; contextWindow?: number }> }) {
  return {
    providerId: r.providerId,
    status: r.available ? ('available' as const) : ('unavailable' as const),
    healthState: r.available ? ('healthy' as const) : ('auth_failed' as const),
    discoveryConfidence: 'verified' as const,
    models: r.models ?? [],
    includeInOperationalPool: r.available,
    discoveredAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    probeLatencyMs: 50,
  };
}

describe('OperationalCandidatePool', () => {
  beforeEach(() => {
    resetOperationalCandidatePoolForTesting();
    resetProviderHealthRegistryForTesting();
    resetHealthSyncBusForTesting();
  });

  it('rebuilds from a discovery snapshot', () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnapshot([
        {
          providerId: 'aihubmix',
          available: true,
          models: [
            { modelId: 'gpt-4o-mini', family: 'openai' },
            { modelId: 'claude-haiku-4-5', family: 'anthropic' },
          ],
        },
      ]),
    });
    expect(pool.size()).toBe(2);
    expect(pool.get('aihubmix', 'gpt-4o-mini')?.providerTier).toBe('aggregator');
  });

  it('skips providers marked unavailable', () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnapshot([
        { providerId: 'aihubmix', available: false, models: [{ modelId: 'whatever' }] },
        { providerId: 'openai', available: true, models: [{ modelId: 'gpt-4o' }] },
      ]),
    });
    expect(pool.size()).toBe(1);
    expect(pool.get('openai', 'gpt-4o')).toBeDefined();
    expect(pool.get('aihubmix', 'whatever')).toBeUndefined();
  });

  it('uses fallback models when discovery did not enumerate (e.g. native-anthropic)', () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnapshot([{ providerId: 'anthropic', available: true, models: [] }]),
      fallbackModelsByProvider: {
        anthropic: [{ modelId: 'claude-haiku-4-5', family: 'anthropic' }],
      },
      integrationClassByProvider: { anthropic: 'native-anthropic' },
    });
    expect(pool.size()).toBe(1);
    const c = pool.get('anthropic', 'claude-haiku-4-5');
    expect(c?.providerTier).toBe('native');
    expect(c?.source).toBe('configured_alias');
  });

  it('classifies tier from integration class', () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnapshot([
        { providerId: 'openai', available: true, models: [{ modelId: 'gpt-4o' }] },
        { providerId: 'aihubmix', available: true, models: [{ modelId: 'm1' }] },
        { providerId: 'ollama-gpu-0', available: true, models: [{ modelId: 'llama3' }] },
      ]),
      integrationClassByProvider: {
        openai: 'native-openai',
        aihubmix: 'aggregator-with-billing',
        'ollama-gpu-0': 'self-hosted-oai-compat',
      },
    });
    expect(pool.get('openai', 'gpt-4o')?.providerTier).toBe('native');
    expect(pool.get('aihubmix', 'm1')?.providerTier).toBe('aggregator');
    expect(pool.get('ollama-gpu-0', 'llama3')?.providerTier).toBe('local');
  });

  it('query filters by tier', () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnapshot([
        { providerId: 'openai', available: true, models: [{ modelId: 'gpt-4o' }] },
        { providerId: 'aihubmix', available: true, models: [{ modelId: 'm1' }, { modelId: 'm2' }] },
      ]),
      integrationClassByProvider: {
        openai: 'native-openai',
        aihubmix: 'aggregator-with-billing',
      },
    });
    const native = pool.query({ providerTier: 'native' });
    expect(native).toHaveLength(1);
    const agg = pool.query({ providerTier: 'aggregator' });
    expect(agg).toHaveLength(2);
  });

  it('healthyOnly excludes candidates with fatal health state', () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnapshot([
        { providerId: 'openai', available: true, models: [{ modelId: 'gpt-4o' }] },
        { providerId: 'aihubmix', available: true, models: [{ modelId: 'm1' }] },
      ]),
    });
    // Mark aihubmix as auth_failed in registry
    getProviderHealthRegistry().recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });
    const healthy = pool.query({ healthyOnly: true });
    expect(healthy).toHaveLength(1);
    expect(healthy[0].providerId).toBe('openai');
    // healthyOnly=false returns all
    expect(pool.query({ healthyOnly: false })).toHaveLength(2);
  });

  it('healthyOnly with excludeWithinCooldown=false allows post-cooldown reprobe', () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnapshot([
        { providerId: 'openai', available: true, models: [{ modelId: 'gpt-4o' }] },
      ]),
    });
    // Mark with very short cooldown via classification mocking
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'openai' },
      success: false,
      classification: { ...classifyProviderError({ status: 503 }), cooldownMs: 1 },
    });
    // Wait for cooldown to elapse
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // After cooldown, healthy=true (within cooldown only excludes if excludeWithinCooldown=true)
        const result = pool.query({ healthyOnly: true, excludeWithinCooldown: true });
        expect(result).toHaveLength(1);
        resolve();
      }, 5);
    });
  });

  it('addCandidatesByProvider merges without overwriting', () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnapshot([
        { providerId: 'foo', available: true, models: [{ modelId: 'a' }] },
      ]),
    });
    pool.addCandidatesByProvider('foo', [
      { modelId: 'a' },  // already exists, should not duplicate
      { modelId: 'b' },
    ]);
    expect(pool.size()).toBe(2);
    expect(pool.get('foo', 'a')?.source).toBe('discovery_listed'); // discovery wins
    expect(pool.get('foo', 'b')?.source).toBe('configured_alias');
  });

  it('snapshot returns frozen view of current pool', () => {
    const pool = getOperationalCandidatePool();
    pool.rebuild({
      snapshot: buildSnapshot([
        { providerId: 'foo', available: true, models: [{ modelId: 'a' }, { modelId: 'b' }] },
      ]),
    });
    const snap = pool.snapshot();
    expect(snap).toHaveLength(2);
  });

  it('builtAtMs reflects last rebuild', () => {
    const pool = getOperationalCandidatePool();
    expect(pool.builtAtMs()).toBe(0);
    pool.rebuild({
      snapshot: buildSnapshot([{ providerId: 'foo', available: true, models: [{ modelId: 'a' }] }]),
    });
    expect(pool.builtAtMs()).toBeGreaterThan(0);
  });
});
