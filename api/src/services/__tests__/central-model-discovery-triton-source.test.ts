// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Triton discovery-source registration (2026-09-10 gap closure).
 *
 * WHY THIS EXISTS
 * ────────────────
 * `triton` is catalogued with `integrationClass: 'self-hosted-native'` and
 * `integrationMode: 'discovery+execution'`, and has a working `TritonAdapter`
 * (KServe v2 protocol) — but the catalog-bridge's generic
 * `OpenAICompatibleHubModelFetcher` only auto-wires discovery for
 * `self-hosted-oai-compat` entries (vllm/lm-studio/xinference). Because
 * Triton speaks the KServe v2 tensor-in/tensor-out protocol instead of an
 * OpenAI-compatible REST surface, it fell through that auto-wiring and NEVER
 * had an explicit discovery source registered in
 * central-model-discovery-service.ts, despite `TritonAdapter.getModels()`
 * already implementing the correct listing call (`POST /v2/repository/index`,
 * the KServe v2 model-repository extension — see
 * triton-adapter.ts's class-level doc comment and triton-adapter.test.ts for
 * the protocol-level test coverage).
 *
 * These tests cover the NEW glue registered in `addAggregatorSources()`
 * (same shape-mismatch rationale as bytez-native/cloudflare-workers-ai-native
 * above it) — not the KServe protocol itself, which is already covered by
 * triton-adapter.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CentralModelDiscoveryService, type DiscoverySource } from '@/services/central-model-discovery-service';

interface DiscoveryServiceInternals {
  addAggregatorSources: () => Promise<void>;
  discoverySources: Map<string, DiscoverySource>;
}

function getInternals(): DiscoveryServiceInternals {
  return new CentralModelDiscoveryService() as unknown as DiscoveryServiceInternals;
}

function kserveIndexResponse(models: Array<{ name: string; version?: string; state?: string; reason?: string }>) {
  return new Response(JSON.stringify(models), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('central-model-discovery-service: triton-native aggregator source', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TRITON_DISCOVERY_DISABLED;
    delete process.env.TRITON_BASE_URL;
    delete process.env.TRITON_API_KEY;
  });

  it('registers a triton-native aggregator source scoped to the triton provider', async () => {
    const internals = getInternals();
    await internals.addAggregatorSources();

    const source = internals.discoverySources.get('triton-native');
    expect(source).toBeDefined();
    expect(source?.type).toBe('aggregator');
    expect(source?.providers).toEqual(['triton']);
  });

  it('can be killed via TRITON_DISCOVERY_DISABLED like the other aggregator sources', async () => {
    process.env.TRITON_DISCOVERY_DISABLED = 'true';

    const internals = getInternals();
    await internals.addAggregatorSources();

    expect(internals.discoverySources.get('triton-native')).toBeUndefined();
  });

  it('the fetcher calls POST /v2/repository/index against TRITON_BASE_URL and maps only READY models into DiscoveredModel shape', async () => {
    process.env.TRITON_BASE_URL = 'http://test-triton:8000';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      kserveIndexResponse([
        { name: 'bge-base-en', version: '1', state: 'READY', reason: '' },
        { name: 'unloaded-model', version: '1', state: 'UNAVAILABLE', reason: 'not loaded' },
      ])
    );

    const internals = getInternals();
    await internals.addAggregatorSources();
    const source = internals.discoverySources.get('triton-native');
    const models = await source!.fetcher();

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://test-triton:8000/v2/repository/index',
      expect.objectContaining({ method: 'POST' })
    );
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(
      expect.objectContaining({
        id: 'bge-base-en',
        name: 'bge-base-en',
        capabilities: ['embeddings'],
        metadata: { provider: 'triton' },
      })
    );
  });

  it('falls back to the localhost default when TRITON_BASE_URL is unset, and returns empty (not throw) when unreachable', async () => {
    // No operator has a real Triton server running against this SaaS today —
    // this must fail closed exactly like every other self-hosted source
    // (ollama/vllm/lm-studio) does when unconfigured, not throw and break the
    // discovery cycle for every other provider.
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const internals = getInternals();
    await internals.addAggregatorSources();
    const source = internals.discoverySources.get('triton-native');
    const models = await source!.fetcher();

    expect(models).toEqual([]);
  });
});
