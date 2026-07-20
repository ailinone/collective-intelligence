// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Phase 4.2 — embedding pipeline.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildCandidateText,
  rebuildEmbeddingIndex,
  resetEmbeddingPipelineForTesting,
  embedSingleCandidate,
} from '../embedding-pipeline';
import {
  getOperationalCandidatePool,
  resetOperationalCandidatePoolForTesting,
} from '../operational-candidate-pool';
import {
  getSemanticIndex,
  resetSemanticIndexForTesting,
} from '../semantic-index';
import { resetTEIClientForTesting } from '../tei-client';
import { resetEmbeddingCacheForTesting } from '../embedding-cache';
import { resetProviderHealthRegistryForTesting } from '../provider-health-registry';
import { resetHealthSyncBusForTesting } from '../health-sync-bus';
import type { ProviderDiscoverySnapshot } from '../types';

function buildSnap(rows: Array<{ providerId: string; modelId: string }>): ProviderDiscoverySnapshot {
  const map = new Map();
  const grouped = new Map<string, string[]>();
  for (const r of rows) {
    const arr = grouped.get(r.providerId) ?? [];
    arr.push(r.modelId);
    grouped.set(r.providerId, arr);
  }
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

describe('buildCandidateText', () => {
  it('produces a structured representation with key fields', () => {
    const text = buildCandidateText({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      modelFamily: 'openai',
      providerTier: 'native',
      contextWindow: 128000,
      capabilities: ['chat', 'tools', 'vision'],
      source: 'discovery_listed',
      addedAt: '2026-01-01',
    });
    expect(text).toContain('provider:openai');
    expect(text).toContain('model:gpt-4o-mini');
    expect(text).toContain('family:openai');
    expect(text).toContain('tier:native');
    expect(text).toContain('context:128000');
    expect(text).toContain('capabilities:chat,tools,vision');
  });

  it('handles missing optional fields', () => {
    const text = buildCandidateText({
      providerId: 'foo',
      modelId: 'bar',
      providerTier: 'aggregator',
      source: 'discovery_listed',
      addedAt: '2026-01-01',
    });
    expect(text).toContain('provider:foo');
    expect(text).toContain('model:bar');
    expect(text).toContain('tier:aggregator');
    expect(text).not.toContain('family:');
    expect(text).not.toContain('context:');
  });

  it('sorts capabilities for determinism', () => {
    const a = buildCandidateText({
      providerId: 'p',
      modelId: 'm',
      providerTier: 'native',
      capabilities: ['z', 'a', 'm'],
      source: 'discovery_listed',
      addedAt: '2026-01-01',
    });
    expect(a).toContain('capabilities:a,m,z');
  });
});

describe('rebuildEmbeddingIndex', () => {
  beforeEach(() => {
    resetEmbeddingPipelineForTesting();
    resetSemanticIndexForTesting();
    resetTEIClientForTesting();
    resetEmbeddingCacheForTesting();
    resetOperationalCandidatePoolForTesting();
    resetProviderHealthRegistryForTesting();
    resetHealthSyncBusForTesting();
  });

  it('returns 0 when pool is empty', async () => {
    const fakeTei = {
      embed: vi.fn(async () => Float32Array.from([1, 0])),
      embedBatch: vi.fn(async () => []),
      isHealthy: vi.fn(async () => true),
    };
    const count = await rebuildEmbeddingIndex({ tei: fakeTei as never });
    expect(count).toBe(0);
    expect(getSemanticIndex().size()).toBe(0);
  });

  it('skips when TEI is unhealthy', async () => {
    getOperationalCandidatePool().rebuild({
      snapshot: buildSnap([{ providerId: 'a', modelId: 'b' }]),
    });
    const fakeTei = {
      embed: vi.fn(),
      embedBatch: vi.fn(),
      isHealthy: vi.fn(async () => false),
    };
    const count = await rebuildEmbeddingIndex({ tei: fakeTei as never });
    expect(count).toBe(0);
    expect(fakeTei.embedBatch).not.toHaveBeenCalled();
  });

  it('embeds all candidates and populates the index', async () => {
    getOperationalCandidatePool().rebuild({
      snapshot: buildSnap([
        { providerId: 'openai', modelId: 'gpt-4o' },
        { providerId: 'anthropic', modelId: 'claude' },
        { providerId: 'groq', modelId: 'llama-3' },
      ]),
    });
    const fakeTei = {
      embed: vi.fn(),
      embedBatch: vi.fn(async (texts: readonly string[]) =>
        texts.map((_, i) => Float32Array.from([i, 0, 0])),
      ),
      isHealthy: vi.fn(async () => true),
    };
    const count = await rebuildEmbeddingIndex({ tei: fakeTei as never, batchSize: 10 });
    expect(count).toBe(3);
    expect(getSemanticIndex().size()).toBe(3);
  });

  it('respects batchSize', async () => {
    getOperationalCandidatePool().rebuild({
      snapshot: buildSnap([
        { providerId: 'a', modelId: 'm' },
        { providerId: 'b', modelId: 'm' },
        { providerId: 'c', modelId: 'm' },
        { providerId: 'd', modelId: 'm' },
        { providerId: 'e', modelId: 'm' },
      ]),
    });
    const fakeTei = {
      embed: vi.fn(),
      embedBatch: vi.fn(async (texts: readonly string[]) =>
        texts.map(() => Float32Array.from([1, 2])),
      ),
      isHealthy: vi.fn(async () => true),
    };
    await rebuildEmbeddingIndex({ tei: fakeTei as never, batchSize: 2 });
    // 5 candidates / batchSize=2 → 3 batches (2+2+1)
    expect(fakeTei.embedBatch).toHaveBeenCalledTimes(3);
  });

  it('continues when one batch fails', async () => {
    getOperationalCandidatePool().rebuild({
      snapshot: buildSnap([
        { providerId: 'a', modelId: 'm' },
        { providerId: 'b', modelId: 'm' },
        { providerId: 'c', modelId: 'm' },
        { providerId: 'd', modelId: 'm' },
      ]),
    });
    let callCount = 0;
    const fakeTei = {
      embed: vi.fn(),
      embedBatch: vi.fn(async (texts: readonly string[]) => {
        callCount++;
        if (callCount === 1) throw new Error('TEI batch failed');
        return texts.map(() => Float32Array.from([1, 2]));
      }),
      isHealthy: vi.fn(async () => true),
    };
    const count = await rebuildEmbeddingIndex({ tei: fakeTei as never, batchSize: 2 });
    // 4 candidates / batchSize=2 → 2 batches; first fails, second produces 2 entries
    expect(count).toBe(2);
  });

  it('embedSingleCandidate produces an indexable entry', async () => {
    const fakeTei = {
      embed: vi.fn(async () => Float32Array.from([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(),
      isHealthy: vi.fn(),
    };
    const entry = await embedSingleCandidate(
      {
        providerId: 'foo',
        modelId: 'bar',
        providerTier: 'native',
        source: 'discovery_listed',
        addedAt: '2026-01-01',
      },
      fakeTei as never,
    );
    expect(entry.id).toBe('foo::bar');
    expect(entry.embedding).toBeInstanceOf(Float32Array);
    expect(entry.meta?.providerId).toBe('foo');
  });
});
