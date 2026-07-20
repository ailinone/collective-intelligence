// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * registry-cache-snapshot-vs-db-parity.test.ts — MVP 2
 *
 * Proves the field-level mapping from a `LegacyModelSnapshot` (whose
 * shape mirrors the DB `Model` row) into the three derived layers:
 *   - ModelProviderOffering
 *   - ProviderModelRoute
 *   - CanonicalModel
 *
 * Critical mappings under test:
 *   - cost-per-1k × 1000 = cost-per-1M (route-level)
 *   - capabilityUris → providerReportedCapabilities (offering)
 *   - capabilityUris → supportsJson/tools/vision/streaming (route, derived)
 *   - capabilities (legacy JSON) → providerReportedCapabilities (offering)
 *   - contextWindow / maxOutputTokens copied to BOTH offering and route
 *   - lifecycleStatus → CanonicalModel.lifecycle (mapped)
 *   - status → ModelProviderOffering.lifecycle (mapped)
 *   - buildRouteId determinism (no creds/region → simple form)
 *   - aggregator providerId (routeKindByProvider) → route.routeKind='aggregator'
 *   - local providerId (routeKindByProvider) → route.routeKind='local'
 *   - Azure deployments with same id but distinct providerId → distinct
 *     CanonicalModel ids (MVP 2 conservative resolver)
 */

import { describe, it, expect } from 'vitest';
import { buildRuntimeModelRegistry } from '../registry-builder';
import {
  LEGACY_MODELS_FIXTURE,
  FIXTURE_ROUTE_KIND_BY_PROVIDER,
} from './fixtures/legacy-models.fixture';
import type { LegacyModelSnapshot } from '../legacy-model-snapshot';

function buildWithFixture() {
  return buildRuntimeModelRegistry({
    models: LEGACY_MODELS_FIXTURE,
    routeKindByProvider: FIXTURE_ROUTE_KIND_BY_PROVIDER,
    source: 'fixture',
    now: '2026-05-12T00:00:00Z',
  });
}

function findSnapshot(predicate: (m: LegacyModelSnapshot) => boolean): LegacyModelSnapshot {
  const found = LEGACY_MODELS_FIXTURE.find(predicate);
  if (!found) throw new Error('test invariant: snapshot not found in fixture');
  return found;
}

describe('parity — pricing cost-per-1k × 1000 = cost-per-1M', () => {
  it('Anthropic claude-opus-4-7: 0.015 per 1k → 15.0 per 1M (input)', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'anthropic' && m.id === 'claude-opus-4-7',
    );
    const routes = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`);
    expect(routes).toHaveLength(1);
    const r = routes[0];
    expect(r.inputCostPer1M).toBe(15.0);
    expect(r.outputCostPer1M).toBe(75.0);
  });

  it('OpenAI gpt-5.5-pro: 0.005 → 5.0; 0.020 → 20.0', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'openai' && m.id === 'gpt-5.5-pro',
    );
    const routes = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`);
    const r = routes[0];
    expect(r.inputCostPer1M).toBe(5.0);
    expect(r.outputCostPer1M).toBe(20.0);
  });

  it('Ollama local llama: 0 → 0', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'ollama' && m.id === 'llama-3.3-70b',
    );
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.inputCostPer1M).toBe(0);
    expect(r.outputCostPer1M).toBe(0);
  });

  it('null cost → 0 (route never carries null pricing — explicit 0)', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'experimental-lab' && m.id === 'unknown-experimental-x',
    );
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.inputCostPer1M).toBe(0);
    expect(r.outputCostPer1M).toBe(0);
  });
});

describe('parity — capabilities (URI preferred, legacy JSON fallback)', () => {
  it('capabilityUris is copied verbatim into Offering.providerReportedCapabilities', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'anthropic' && m.id === 'claude-opus-4-7',
    );
    const offering = registry.lookupOffering(
      snap.uid ?? `${snap.providerId}:${snap.id}`,
    );
    expect(offering?.providerReportedCapabilities).toEqual([
      'chat',
      'tools',
      'json_mode',
      'streaming',
      'vision',
    ]);
  });

  it('legacy capabilities[] is normalised into Offering.providerReportedCapabilities', () => {
    const { registry } = buildWithFixture();
    // openrouter row #7 uses legacy `capabilities: ['chat', 'tools']`
    const snap = findSnapshot(
      (m) => m.providerId === 'openrouter' && m.id === 'anthropic/claude-opus-4-7',
    );
    const offering = registry.lookupOffering(
      snap.uid ?? `${snap.providerId}:${snap.id}`,
    );
    expect(offering?.providerReportedCapabilities).toEqual(['chat', 'tools']);
  });

  it('legacy capabilities record is normalised (only true keys retained)', () => {
    const { registry } = buildWithFixture();
    // mistral mixtral-8x22b uses `{ chat: true, tools: true, vision: false, streaming: true }`
    const snap = findSnapshot(
      (m) => m.providerId === 'mistral' && m.id === 'mixtral-8x22b',
    );
    const offering = registry.lookupOffering(
      snap.uid ?? `${snap.providerId}:${snap.id}`,
    );
    const caps = offering?.providerReportedCapabilities ?? [];
    expect(caps).toContain('chat');
    expect(caps).toContain('tools');
    expect(caps).toContain('streaming');
    expect(caps).not.toContain('vision'); // false → excluded
  });

  it('no capabilities at all → empty array', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'experimental-lab' && m.id === 'unknown-experimental-x',
    );
    const offering = registry.lookupOffering(
      snap.uid ?? `${snap.providerId}:${snap.id}`,
    );
    expect(offering?.providerReportedCapabilities).toEqual([]);
  });
});

describe('parity — route-level supports* flags derived from capabilities', () => {
  it('chat+tools+json_mode+streaming+vision sets all flags correctly', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'openai' && m.id === 'gpt-5.5-pro',
    );
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.supportsStreaming).toBe(true);
    expect(r.supportsJson).toBe(true);
    expect(r.supportsTools).toBe(true);
    expect(r.supportsVision).toBe(true);
    expect(r.supportsImages).toBe(false);
    expect(r.supportsAudio).toBe(false);
  });

  it('image_generation-only model sets supportsImages true, others false', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'replicate' && m.id === 'flux-pro-1.1',
    );
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.supportsImages).toBe(true);
    expect(r.supportsStreaming).toBe(false);
    expect(r.supportsTools).toBe(false);
    expect(r.supportsVision).toBe(false);
  });

  it('audio_generation sets supportsAudio true', () => {
    const { registry } = buildWithFixture();
    // gemini-2.5-pro #5 has audio_generation
    const snap = findSnapshot(
      (m) => m.providerId === 'google' && m.id === 'gemini-2.5-pro',
    );
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.supportsAudio).toBe(true);
    expect(r.supportsVision).toBe(true);
  });

  it('no capabilities → all flags false', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'experimental-lab' && m.id === 'unknown-experimental-x',
    );
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.supportsStreaming).toBe(false);
    expect(r.supportsJson).toBe(false);
    expect(r.supportsTools).toBe(false);
    expect(r.supportsVision).toBe(false);
    expect(r.supportsImages).toBe(false);
    expect(r.supportsAudio).toBe(false);
  });
});

describe('parity — contextWindow + maxOutputTokens propagate', () => {
  it('contextWindow propagates to BOTH offering and route', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'anthropic' && m.id === 'claude-opus-4-7',
    );
    const o = registry.lookupOffering(snap.uid ?? `${snap.providerId}:${snap.id}`);
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(o?.providerReportedContextWindow).toBe(200_000);
    expect(r.contextWindow).toBe(200_000);
  });

  it('1M context window preserved', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'google' && m.id === 'gemini-2.5-pro-1m',
    );
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.contextWindow).toBe(1_000_000);
  });

  it('null contextWindow defaults to 0', () => {
    const explicit = [
      {
        id: 'no-ctx-model',
        providerId: 'someone',
        status: 'active',
        contextWindow: null,
        maxOutputTokens: null,
      },
    ];
    const { registry } = buildRuntimeModelRegistry({ models: explicit });
    const r = registry.routesForOffering('someone:no-ctx-model')[0];
    expect(r.contextWindow).toBe(0);
    expect(r.maxOutputTokens).toBe(0);
  });
});

describe('parity — routeId determinism', () => {
  it('without creds/region, routeId = `${offeringId}::${providerId}`', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'openai' && m.id === 'gpt-5.5-pro',
    );
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.routeId).toBe(`${snap.uid ?? `${snap.providerId}:${snap.id}`}::openai`);
  });

  it('two Azure deployments share id="gpt-4o" but produce DISTINCT routeIds', () => {
    const { registry } = buildWithFixture();
    const prodChat = findSnapshot(
      (m) =>
        m.providerId === 'azure-openai-prod-chat' && m.id === 'gpt-4o',
    );
    const prodFallback = findSnapshot(
      (m) =>
        m.providerId === 'azure-openai-prod-fallback' && m.id === 'gpt-4o',
    );
    const r1 = registry.routesForOffering(
      prodChat.uid ?? `${prodChat.providerId}:${prodChat.id}`,
    )[0];
    const r2 = registry.routesForOffering(
      prodFallback.uid ?? `${prodFallback.providerId}:${prodFallback.id}`,
    )[0];
    expect(r1.routeId).not.toBe(r2.routeId);
    // And their pricing is independent.
    expect(r1.inputCostPer1M).not.toBe(r2.inputCostPer1M);
  });
});

describe('parity — routeKindByProvider drives ProviderModelRoute.routeKind', () => {
  it('aihubmix → aggregator', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot((m) => m.providerId === 'aihubmix');
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.routeKind).toBe('aggregator');
  });

  it('openrouter → aggregator', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot((m) => m.providerId === 'openrouter');
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.routeKind).toBe('aggregator');
  });

  it('ollama → local', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot((m) => m.providerId === 'ollama');
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.routeKind).toBe('local');
  });

  it('vllm → self_hosted', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot((m) => m.providerId === 'vllm');
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.routeKind).toBe('self_hosted');
  });

  it('default (provider not in map) → native', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot((m) => m.providerId === 'anthropic');
    const r = registry.routesForOffering(snap.uid ?? `${snap.providerId}:${snap.id}`)[0];
    expect(r.routeKind).toBe('native');
  });
});

describe('parity — lifecycle mapping', () => {
  it('canonical lifecycle maps preview correctly', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'openai' && m.id === 'o3-mini-preview',
    );
    const c = registry.lookupCanonicalModel(`${snap.providerId}:${snap.id}`);
    expect(c?.lifecycle).toBe('preview');
  });

  it('canonical lifecycle maps deprecated correctly', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) =>
        m.providerId === 'anthropic' &&
        m.id === 'claude-3-5-sonnet-20240620',
    );
    const c = registry.lookupCanonicalModel(`${snap.providerId}:${snap.id}`);
    expect(c?.lifecycle).toBe('deprecated');
  });

  it('offering lifecycle maps inactive → retired', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'openai' && m.id === 'gpt-4-0314' && m.status === 'inactive',
    );
    const o = registry.lookupOffering(snap.uid ?? `${snap.providerId}:${snap.id}`);
    expect(o?.lifecycle).toBe('retired');
  });

  it('offering lifecycle maps deprecated → sunset', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.status === 'deprecated',
    );
    const o = registry.lookupOffering(snap.uid ?? `${snap.providerId}:${snap.id}`);
    expect(o?.lifecycle).toBe('sunset');
  });
});

describe('parity — canonical model identity (MVP 2 conservative)', () => {
  it('canonicalModelId = `${providerId}:${id}` (no heuristic merging yet)', () => {
    const { registry } = buildWithFixture();
    // gpt-5.5-pro on openai
    const a = registry.lookupCanonicalModel('openai:gpt-5.5-pro');
    expect(a).toBeDefined();
    expect(a?.owner).toBe('openai');
    // openai/gpt-5.5-pro on aihubmix — distinct canonical until heuristic merger lands
    const b = registry.lookupCanonicalModel('aihubmix:openai/gpt-5.5-pro');
    expect(b).toBeDefined();
    expect(b?.canonicalModelId).not.toBe(a?.canonicalModelId);
  });

  it('Offering FK points back to the correct CanonicalModel', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'mistral' && m.id === 'mistral-large-2',
    );
    const o = registry.lookupOffering(snap.uid ?? `${snap.providerId}:${snap.id}`);
    expect(o?.canonicalModelId).toBe('mistral:mistral-large-2');
    const c = registry.lookupCanonicalModel(o!.canonicalModelId);
    expect(c).toBeDefined();
  });

  it('Route FK points back to the correct CanonicalModel and Offering', () => {
    const { registry } = buildWithFixture();
    const snap = findSnapshot(
      (m) => m.providerId === 'cohere' && m.id === 'command-a',
    );
    const offeringId = snap.uid ?? `${snap.providerId}:${snap.id}`;
    const r = registry.routesForOffering(offeringId)[0];
    expect(r.canonicalModelId).toBe('cohere:command-a');
    expect(r.offeringId).toBe(offeringId);
    expect(r.accessProviderId).toBe('cohere');
  });
});

describe('parity — defaults for runtime state (MVP 2: no hub coupling)', () => {
  it('healthState defaults to "unknown"', () => {
    const { registry } = buildWithFixture();
    const r = registry.routesForOffering('uid-anthropic-claude-opus-4-7')[0];
    expect(r.healthState).toBe('unknown');
  });

  it('creditStatus defaults to "unknown"', () => {
    const { registry } = buildWithFixture();
    const r = registry.routesForOffering('uid-anthropic-claude-opus-4-7')[0];
    expect(r.creditStatus).toBe('unknown');
  });

  it('minimalChatStatus defaults to "untested"', () => {
    const { registry } = buildWithFixture();
    const r = registry.routesForOffering('uid-anthropic-claude-opus-4-7')[0];
    expect(r.minimalChatStatus).toBe('untested');
  });

  it('latency/ttft/success/error are null or zero (no observed runs)', () => {
    const { registry } = buildWithFixture();
    const r = registry.routesForOffering('uid-anthropic-claude-opus-4-7')[0];
    expect(r.latencyP50Ms).toBeNull();
    expect(r.latencyP95Ms).toBeNull();
    expect(r.ttftP50Ms).toBeNull();
    expect(r.ttftP95Ms).toBeNull();
    expect(r.successRateWindow).toBe(0);
    expect(r.errorRateWindow).toBe(0);
  });
});

describe('parity — builder purity', () => {
  it('does not mutate the input array', () => {
    const before = LEGACY_MODELS_FIXTURE.slice();
    buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    expect(LEGACY_MODELS_FIXTURE).toEqual(before);
  });

  it('produces identical canonical/offering/route ids on repeated calls', () => {
    const a = buildWithFixture();
    const b = buildWithFixture();
    expect(a.diagnostics.canonicalModelCount).toBe(b.diagnostics.canonicalModelCount);
    expect(a.diagnostics.offeringCount).toBe(b.diagnostics.offeringCount);
    expect(a.diagnostics.routeCount).toBe(b.diagnostics.routeCount);

    // routeId determinism: pick any snapshot and check both calls yield same id
    const r1 = a.registry.routesForOffering('uid-anthropic-claude-opus-4-7')[0];
    const r2 = b.registry.routesForOffering('uid-anthropic-claude-opus-4-7')[0];
    expect(r1.routeId).toBe(r2.routeId);
  });
});
