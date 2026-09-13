// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Semantic model-search functional evaluations (SOTA §25, 2026-09-03).
 *
 * These are PROPERTY-BASED evaluations of the capability-matching policy
 * that backs semantic model search and routing. Per the mission contract:
 *
 *   Expected outputs must validate capabilities and constraints rather
 *   than pinning one specific model ID. Assert properties:
 *     expect(result.capabilities).toContain('tools')
 *   NEVER:
 *     expect(result.model).toBe('some-specific-model-id')
 *
 * Every fixture model id in this file is generated at runtime
 * (`model-id-generated-during-test-<random>`), so these evaluations can
 * never decay into a hardcoded commercial-model catalog — the exact
 * anti-pattern the zero-hardcode guard forbids.
 *
 * The required-capability filter mirrors the production inline filter in
 * dynamic-model-selector.ts (same precedent as
 * capability-uri-matching.test.ts — the mirror is reviewed with the
 * production block at PR time). Context-window eligibility mirrors the
 * criteria validator's floor semantics.
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import type { Model, ModelCapability } from '@/types';
import { legacyArrayToUriArray } from '@/capability/legacy-capability-uri';

function randomModelId(): string {
  return `model-id-generated-during-test-${randomBytes(6).toString('hex')}`;
}

function filterByRequiredCapabilities(
  models: readonly Model[],
  requiredCapabilities: readonly ModelCapability[]
): Model[] {
  if (requiredCapabilities.length === 0) return [...models];
  const requiredUris = legacyArrayToUriArray(requiredCapabilities);
  return models.filter((model) => {
    if (model.capabilityUris && model.capabilityUris.length > 0) {
      return requiredUris.every((uri) => model.capabilityUris!.includes(uri));
    }
    const modelCaps = model.capabilities || [];
    return requiredCapabilities.every((cap) => modelCaps.includes(cap));
  });
}

function filterByContextFloor(models: readonly Model[], minContext: number): Model[] {
  return models.filter((m) => (m.contextWindow ?? 0) >= minContext);
}

function makeModel(overrides: Partial<Model> & Pick<Model, 'id'>): Model {
  return {
    providerId: 'provider-stub',
    provider: 'provider-stub',
    name: overrides.id,
    displayName: overrides.id,
    contextWindow: 8192,
    maxTokens: 4096,
    capabilities: ['chat'],
    capabilityUris: [],
    pricing: { inputCostPer1M: 0, outputCostPer1M: 0 },
    ...overrides,
  } as unknown as Model;
}

describe('semantic search evaluations — capability-property assertions', () => {
  it('"best model supporting tools and JSON" selects only fixtures declaring BOTH (ALL-of semantics)', () => {
    const toolsJson = makeModel({
      id: randomModelId(),
      capabilities: ['chat', 'tool_use', 'function_calling', 'json_mode'],
    });
    const toolsOnly = makeModel({
      id: randomModelId(),
      capabilities: ['chat', 'tool_use', 'function_calling'],
    });
    const neither = makeModel({ id: randomModelId(), capabilities: ['chat'] });

    const eligible = filterByRequiredCapabilities(
      [toolsJson, toolsOnly, neither],
      ['tool_use', 'json_mode']
    );

    // Property assertions — never a pinned model id
    expect(eligible).toHaveLength(1);
    expect(eligible[0].capabilities).toContain('tool_use');
    expect(eligible[0].capabilities).toContain('json_mode');
    expect(eligible.map((m) => m.id)).not.toContain(toolsOnly.id);
    expect(eligible.map((m) => m.id)).not.toContain(neither.id);
  });

  it('"vision model with long context" applies BOTH the capability and the context floor', () => {
    const longContextVision = makeModel({
      id: randomModelId(),
      contextWindow: 200_000,
      capabilities: ['chat', 'vision', 'image_understanding'],
    });
    const shortContextVision = makeModel({
      id: randomModelId(),
      contextWindow: 8_192,
      capabilities: ['chat', 'vision', 'image_understanding'],
    });
    const longContextBlind = makeModel({
      id: randomModelId(),
      contextWindow: 200_000,
      capabilities: ['chat'],
    });

    const eligible = filterByContextFloor(
      filterByRequiredCapabilities(
        [longContextVision, shortContextVision, longContextBlind],
        ['vision']
      ),
      100_000
    );

    expect(eligible).toHaveLength(1);
    expect(eligible[0].capabilities).toContain('vision');
    expect(eligible[0].contextWindow ?? 0).toBeGreaterThanOrEqual(100_000);
  });

  it('"reasoning model with streaming" requires both declared capabilities', () => {
    const reasonStream = makeModel({
      id: randomModelId(),
      capabilities: ['chat', 'reasoning', 'streaming'],
    });
    const reasonOnly = makeModel({
      id: randomModelId(),
      capabilities: ['chat', 'reasoning'],
    });

    const eligible = filterByRequiredCapabilities(
      [reasonStream, reasonOnly],
      ['reasoning', 'streaming']
    );

    expect(eligible).toHaveLength(1);
    expect(eligible[0].capabilities).toContain('reasoning');
    expect(eligible[0].capabilities).toContain('streaming');
  });

  it('"embedding model optimized for retrieval" filters by embedding capability', () => {
    const embedder = makeModel({
      id: randomModelId(),
      capabilities: ['embedding', 'retrieval_optimized'],
    });
    const chat = makeModel({ id: randomModelId(), capabilities: ['chat'] });

    const eligible = filterByRequiredCapabilities([embedder, chat], ['embedding']);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].capabilities).toContain('embedding');
  });

  it('"reranking-capable model" filters by rerank capability', () => {
    const reranker = makeModel({ id: randomModelId(), capabilities: ['rerank'] });
    const chat = makeModel({ id: randomModelId(), capabilities: ['chat'] });

    const eligible = filterByRequiredCapabilities([reranker, chat], ['rerank']);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].capabilities).toContain('rerank');
  });

  it('unknown capability NEVER passes as supported (fail-closed under requirements)', () => {
    const unknown = makeModel({ id: randomModelId(), capabilities: [] });
    const capabilityUrisUnknown = makeModel({
      id: randomModelId(),
      capabilities: ['chat'],
      capabilityUris: [],
    });

    // With requirements present, models without the required capability
    // are excluded — unknown is never silently assumed true.
    const eligible = filterByRequiredCapabilities(
      [unknown, capabilityUrisUnknown],
      ['tool_use']
    );
    expect(eligible).toEqual([]);

    // With NO requirements, the same models remain eligible — unknown is
    // not translated into `false` for discovery; it only gates routing.
    const openPool = filterByRequiredCapabilities([unknown, capabilityUrisUnknown], []);
    expect(openPool).toHaveLength(2);
  });

  it('URI-track rows match via translated URIs, ignoring the legacy array on the same row', () => {
    const id = randomModelId();
    const uriTrack = makeModel({
      id,
      // legacy array LACKS tool_use on purpose — the URI track is the
      // declared source of truth when populated
      capabilities: ['chat'],
      capabilityUris: legacyArrayToUriArray(['chat', 'tool_use']),
    });

    const eligible = filterByRequiredCapabilities([uriTrack], ['tool_use']);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe(id);
  });

  it('the same upstream model id behind two providers can have different capability profiles (gateway reality)', () => {
    const sharedUpstreamId = randomModelId();
    const viaGateway = makeModel({
      id: sharedUpstreamId,
      providerId: 'gateway-stub',
      provider: 'gateway-stub',
      capabilities: ['chat', 'tool_use'], // gateway strips vision
    });
    const viaFirstParty = makeModel({
      id: sharedUpstreamId,
      providerId: 'firstparty-stub',
      provider: 'firstparty-stub',
      capabilities: ['chat', 'tool_use', 'vision'],
    });

    const visionEligible = filterByRequiredCapabilities(
      [viaGateway, viaFirstParty],
      ['vision']
    );
    expect(visionEligible).toHaveLength(1);
    expect(visionEligible[0].providerId).toBe('firstparty-stub');
  });
});
