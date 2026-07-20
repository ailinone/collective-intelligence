// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phase 5 — feature-flagged semantic retry re-ranking.
 *
 * Verifies that when OPERABILITY_SEMANTIC_RETRY=true AND the
 * SemanticIndex is populated, cross-provider retry candidates are
 * re-ordered by semantic similarity to the user query.
 *
 * Note: this test exercises only the resolver layer (the part Phase 5
 * adds). The base-strategy.ts integration is too coupled to the
 * orchestrator for a unit test — integration coverage is via the
 * existing 394-test orchestration suite continuing to pass.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getSemanticIndex,
  resetSemanticIndexForTesting,
} from '../semantic-index';
import {
  getEmbeddingCache,
  resetEmbeddingCacheForTesting,
} from '../embedding-cache';
import { resetTEIClientForTesting } from '../tei-client';
import { resolveSemanticCandidates } from '../semantic-resolver';
import {
  getOperationalCandidatePool,
  resetOperationalCandidatePoolForTesting,
} from '../operational-candidate-pool';
import {
  getProviderHealthRegistry,
  resetProviderHealthRegistryForTesting,
} from '../provider-health-registry';
import { resetHealthSyncBusForTesting } from '../health-sync-bus';
import { classifyProviderError } from '../error-classification';
import type { ProviderDiscoverySnapshot } from '../types';

function buildSnap(rows: Array<{ providerId: string; modelId: string }>): ProviderDiscoverySnapshot {
  const grouped = new Map<string, string[]>();
  for (const r of rows) {
    const arr = grouped.get(r.providerId) ?? [];
    arr.push(r.modelId);
    grouped.set(r.providerId, arr);
  }
  const map = new Map();
  for (const [providerId, modelIds] of grouped) {
    map.set(providerId, {
      providerId,
      status: 'available',
      healthState: 'healthy',
      discoveryConfidence: 'verified',
      models: modelIds.map((id) => ({ modelId: id })),
      includeInOperationalPool: true,
      discoveredAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      probeLatencyMs: 50,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    durationMs: 100,
    totalConfigured: grouped.size,
    totalAvailable: grouped.size,
    totalUnavailable: 0,
    results: map,
  };
}

describe('Phase 5 — semantic retry (resolver layer)', () => {
  beforeEach(() => {
    resetSemanticIndexForTesting();
    resetEmbeddingCacheForTesting();
    resetTEIClientForTesting();
    resetOperationalCandidatePoolForTesting();
    resetProviderHealthRegistryForTesting();
    resetHealthSyncBusForTesting();
  });

  it('semantic-aware retry re-orders candidates by similarity', async () => {
    // Pool has 3 alternatives for the same model
    getOperationalCandidatePool().rebuild({
      snapshot: buildSnap([
        { providerId: 'native-a', modelId: 'gpt-4o-mini' },
        { providerId: 'aggregator-b', modelId: 'gpt-4o-mini' },
        { providerId: 'aggregator-c', modelId: 'gpt-4o-mini' },
      ]),
    });

    // Index says aggregator-c is closest to the query
    const idx = getSemanticIndex();
    idx.add({ id: 'native-a::gpt-4o-mini', embedding: Float32Array.from([0.5, 0.5]) });
    idx.add({ id: 'aggregator-b::gpt-4o-mini', embedding: Float32Array.from([0.7, 0.3]) });
    idx.add({ id: 'aggregator-c::gpt-4o-mini', embedding: Float32Array.from([1, 0]) });

    // Query embedding [1, 0] → aggregator-c is closest
    const fakeTei = {
      embed: vi.fn(async () => Float32Array.from([1, 0])),
      embedBatch: vi.fn(),
      isHealthy: vi.fn(),
    };
    getEmbeddingCache(100, fakeTei as never);

    const ranked = await resolveSemanticCandidates({
      query: 'analyze this code',
      k: 3,
      filter: { modelId: 'gpt-4o-mini' },
    });

    expect(ranked).toHaveLength(3);
    // Order: aggregator-c (closest), aggregator-b, native-a
    expect(ranked[0].candidate.providerId).toBe('aggregator-c');
    expect(ranked[1].candidate.providerId).toBe('aggregator-b');
    expect(ranked[2].candidate.providerId).toBe('native-a');
    expect(ranked[0].semanticScore).toBeGreaterThan(ranked[1].semanticScore!);
  });

  it('graceful degradation: empty index → fallback to pool query', async () => {
    getOperationalCandidatePool().rebuild({
      snapshot: buildSnap([
        { providerId: 'a', modelId: 'm' },
        { providerId: 'b', modelId: 'm' },
      ]),
    });
    // Index is intentionally empty
    expect(getSemanticIndex().size()).toBe(0);

    const ranked = await resolveSemanticCandidates({ query: 'x', k: 5 });
    // Falls back to pool query, returns operational candidates without
    // semantic ranking
    expect(ranked).toHaveLength(2);
    for (const r of ranked) {
      expect(r.semanticScore).toBeUndefined();
    }
  });

  it('integrates with health filter: known-bad providers excluded after kNN', async () => {
    getOperationalCandidatePool().rebuild({
      snapshot: buildSnap([
        { providerId: 'healthy-provider', modelId: 'm' },
        { providerId: 'failed-provider', modelId: 'm' },
      ]),
    });
    // failed-provider would semantically beat healthy
    const idx = getSemanticIndex();
    idx.add({ id: 'failed-provider::m', embedding: Float32Array.from([1, 0]) });
    idx.add({ id: 'healthy-provider::m', embedding: Float32Array.from([0.5, 0.5]) });

    // Mark failed-provider as auth_failed
    getProviderHealthRegistry().recordExecution({
      key: { providerId: 'failed-provider' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });

    const fakeTei = {
      embed: vi.fn(async () => Float32Array.from([1, 0])),
      embedBatch: vi.fn(),
      isHealthy: vi.fn(),
    };
    getEmbeddingCache(100, fakeTei as never);

    const ranked = await resolveSemanticCandidates({ query: 'x', k: 5 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].candidate.providerId).toBe('healthy-provider');
  });
});
