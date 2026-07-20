// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression: aggregator/router → provider attribution
 *
 * Bug captured here (2026-04-28):
 *   `resolveSourceExecutionProvider` previously short-circuited
 *   `type === 'aggregator'` to return 'openrouter' regardless of
 *   `source.providers`. That was correct historically when openrouter
 *   was the only aggregator, but Phase 0 added `huggingface-hub` and
 *   `bytez-native` aggregators with single-provider declarations
 *   (`['huggingface']`, `['bytez']`). The shortcut caused 58,079
 *   HuggingFace Hub models to land in the DB under
 *   `provider_id='openrouter'`.
 *
 * Invariant locked here:
 *   - Aggregators with a single concrete provider attribute to that provider.
 *   - Sources whose `name` contains 'openrouter' attribute to 'openrouter'
 *     (the openrouter router has `providers: ['*']`).
 *   - Router-style sources with `providers: ['*']` and no openrouter name
 *     fall through to per-model originalProvider resolution (return undefined).
 *   - Multi-provider aggregators pick by EXECUTION_PROVIDER_PRIORITY.
 */

import { describe, expect, it } from 'vitest';
import { CentralModelDiscoveryService, type DiscoverySource } from '@/services/central-model-discovery-service';

type ResolveFn = (source: DiscoverySource) => string | undefined;

function getResolver(): ResolveFn {
  const service = new CentralModelDiscoveryService();
  // The method is private; access via a typed bracket cast for regression coverage.
  const resolver = (service as unknown as { resolveSourceExecutionProvider: ResolveFn })
    .resolveSourceExecutionProvider.bind(service);
  return resolver;
}

function fakeSource(overrides: Partial<DiscoverySource>): DiscoverySource {
  return {
    name: overrides.name ?? 'test-source',
    type: overrides.type ?? 'aggregator',
    priority: overrides.priority ?? 5,
    providers: overrides.providers ?? [],
    fetcher: overrides.fetcher ?? (async () => []),
  };
}

describe('central-model-discovery-service: source → provider attribution', () => {
  const resolveSourceExecutionProvider = getResolver();

  it('aggregator with single provider attributes to that provider (huggingface-hub regression)', () => {
    const source = fakeSource({
      name: 'huggingface-hub',
      type: 'aggregator',
      providers: ['huggingface'],
    });
    expect(resolveSourceExecutionProvider(source)).toBe('huggingface');
  });

  it('aggregator with single provider attributes to that provider (bytez-native regression)', () => {
    const source = fakeSource({
      name: 'bytez-native',
      type: 'aggregator',
      providers: ['bytez'],
    });
    expect(resolveSourceExecutionProvider(source)).toBe('bytez');
  });

  it('source name containing "openrouter" returns "openrouter" regardless of providers', () => {
    const source = fakeSource({
      name: 'openrouter-aggregator',
      type: 'router',
      providers: ['*'],
    });
    expect(resolveSourceExecutionProvider(source)).toBe('openrouter');
  });

  it('router with providers: ["*"] and non-openrouter name returns undefined (defer to per-model)', () => {
    const source = fakeSource({
      name: 'generic-router',
      type: 'router',
      providers: ['*'],
    });
    expect(resolveSourceExecutionProvider(source)).toBeUndefined();
  });

  it('aggregator with no providers returns undefined', () => {
    const source = fakeSource({
      name: 'malformed',
      type: 'aggregator',
      providers: [],
    });
    expect(resolveSourceExecutionProvider(source)).toBeUndefined();
  });

  it('aggregator with multiple providers picks by EXECUTION_PROVIDER_PRIORITY (openrouter > others)', () => {
    const source = fakeSource({
      name: 'multi-aggregator',
      type: 'aggregator',
      providers: ['openai', 'openrouter', 'anthropic'],
    });
    // openrouter is highest in EXECUTION_PROVIDER_PRIORITY
    expect(resolveSourceExecutionProvider(source)).toBe('openrouter');
  });

  it('aggregator with multiple non-priority providers picks last as fallback', () => {
    const source = fakeSource({
      name: 'rare-pair',
      type: 'aggregator',
      providers: ['provider-x', 'provider-y'],
    });
    // Neither is in EXECUTION_PROVIDER_PRIORITY → falls through to last
    expect(resolveSourceExecutionProvider(source)).toBe('provider-y');
  });

  it('native_api source with single provider attributes to that provider', () => {
    const source = fakeSource({
      name: 'openai-native',
      type: 'native_api',
      providers: ['openai'],
    });
    expect(resolveSourceExecutionProvider(source)).toBe('openai');
  });

  it('cloud_hub source with canonical aws-bedrock provider attributes to canonical', () => {
    const source = fakeSource({
      name: 'aws-bedrock-hub',
      type: 'cloud_hub',
      providers: ['aws-bedrock'],
    });
    expect(resolveSourceExecutionProvider(source)).toBe('aws-bedrock');
  });

  it('Phase 6 Fix 5: legacy bedrock alias normalises to canonical aws-bedrock', () => {
    // Phase 6 Fix 5 (2026-04-30): PROVIDER_ID_ALIASES previously mapped
    // canonical 'aws-bedrock' INTO legacy 'bedrock' — orphaning 125 DB
    // rows. The alias direction was reversed: any legacy form
    // (bedrock / amazon / aws / bedrockruntime) now normalises INTO
    // the canonical 'aws-bedrock'. This test pins that contract.
    const source = fakeSource({
      name: 'aws-bedrock-hub',
      type: 'cloud_hub',
      providers: ['bedrock'],
    });
    expect(resolveSourceExecutionProvider(source)).toBe('aws-bedrock');
  });
});
