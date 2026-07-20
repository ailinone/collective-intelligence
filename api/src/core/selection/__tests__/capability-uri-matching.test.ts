// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the URI-vs-legacy capability matching policy in the
 * dynamic-model-selector hot path.
 *
 * Why a dedicated test file instead of folding into a selector E2E test:
 *   The end-to-end selector pulls in Prisma, the provider registry, the
 *   capability validator, the performance tracker, and ~6 other services
 *   via DI. The matching policy itself is a small, deterministic function
 *   over an in-memory `Model[]` — it's worth pinning here so a future
 *   refactor of the full selector can preserve the policy without re-
 *   instantiating the entire DI graph.
 *
 * The tests reproduce the production filter's logic locally rather than
 * importing it (the filter is currently inline in dynamic-model-selector.ts
 * after the Prisma fetch). The test acts as a behaviour spec for that inline
 * block; if the production code drifts, the spec drifts here too — both
 * surfaces are reviewed together at PR time.
 *
 * Three invariants:
 *
 * 1. URI-track preferred when populated. A model with capability_uris
 *    populated is matched against URI-translated requirements; the legacy
 *    `capabilities` array is ignored on that row even if non-empty.
 *
 * 2. Legacy fallback when URIs empty. A row with empty capability_uris
 *    falls through to legacy-array matching.
 *
 * 3. ALL-of semantics preserved. Both tracks reject a model that's missing
 *    any one required capability (no partial match, no any-of fallback).
 */

import { describe, expect, it } from 'vitest';
import type { Model, ModelCapability } from '@/types';
import { legacyArrayToUriArray } from '@/capability/legacy-capability-uri';

/**
 * Mirror of the inline filter in dynamic-model-selector.ts (~line 388).
 * Kept in sync at PR review time.
 */
function filterByRequiredCapabilities(
  models: readonly Model[],
  requiredCapabilities: readonly ModelCapability[],
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

function makeModel(overrides: Partial<Model>): Model {
  return {
    id: 'm1',
    providerId: 'p1',
    provider: 'openai',
    name: 'gpt-fake',
    displayName: 'GPT Fake',
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    capabilities: [],
    performance: { latencyMs: 100, throughput: 50, quality: 0.8, reliability: 0.99 },
    status: 'active',
    ...overrides,
  };
}

describe('dynamic-model-selector capability-uri matching policy', () => {
  describe('Invariant 1: URI track preferred when populated', () => {
    it('matches via capabilityUris and IGNORES legacy capabilities array', () => {
      // The legacy array is empty (would fail under legacy-track), but
      // capabilityUris has the URIs — should pass via URI track.
      const model = makeModel({
        capabilities: [], // empty — would fail legacy-track
        capabilityUris: [
          'http://ailin.dev/cap/v1/chat',
          'http://ailin.dev/cap/v1/vision',
        ],
      });
      const result = filterByRequiredCapabilities([model], ['chat', 'vision']);
      expect(result).toHaveLength(1);
    });

    it('rejects via URI track even when legacy array would have passed', () => {
      // Legacy array has all required caps, but capabilityUris is missing
      // 'vision'. URI track is preferred and rejects.
      const model = makeModel({
        capabilities: ['chat', 'vision'],
        capabilityUris: ['http://ailin.dev/cap/v1/chat'], // missing vision
      });
      const result = filterByRequiredCapabilities([model], ['chat', 'vision']);
      expect(result).toHaveLength(0);
    });
  });

  describe('Invariant 2: legacy fallback when URIs empty', () => {
    it('falls back to legacy when capabilityUris is undefined', () => {
      const model = makeModel({
        capabilities: ['chat', 'vision'],
        capabilityUris: undefined,
      });
      const result = filterByRequiredCapabilities([model], ['chat', 'vision']);
      expect(result).toHaveLength(1);
    });

    it('falls back to legacy when capabilityUris is empty array', () => {
      const model = makeModel({
        capabilities: ['chat'],
        capabilityUris: [],
      });
      const result = filterByRequiredCapabilities([model], ['chat']);
      expect(result).toHaveLength(1);
    });

    it('rejects via legacy track when required cap is missing', () => {
      const model = makeModel({
        capabilities: ['chat'], // missing vision
      });
      const result = filterByRequiredCapabilities([model], ['chat', 'vision']);
      expect(result).toHaveLength(0);
    });
  });

  describe('Invariant 3: ALL-of semantics on both tracks', () => {
    it('URI track rejects on any missing required cap', () => {
      const model = makeModel({
        capabilityUris: [
          'http://ailin.dev/cap/v1/chat',
          'http://ailin.dev/cap/v1/streaming',
        ],
      });
      // Requires 3 caps; model has 2 → reject.
      const result = filterByRequiredCapabilities(
        [model],
        ['chat', 'streaming', 'vision'],
      );
      expect(result).toHaveLength(0);
    });

    it('legacy track rejects on any missing required cap', () => {
      const model = makeModel({
        capabilities: ['chat', 'streaming'],
      });
      const result = filterByRequiredCapabilities(
        [model],
        ['chat', 'streaming', 'vision'],
      );
      expect(result).toHaveLength(0);
    });

    it('passes through unfiltered when no required capabilities', () => {
      const m1 = makeModel({ id: 'm1', capabilities: [] });
      const m2 = makeModel({ id: 'm2', capabilityUris: ['http://ailin.dev/cap/v1/chat'] });
      const result = filterByRequiredCapabilities([m1, m2], []);
      expect(result).toHaveLength(2);
    });
  });

  describe('Mixed populations — backfill in progress', () => {
    /**
     * Real-world case: half the rows have capabilityUris populated (post-
     * HCRA-backfill), half don't. The filter must work correctly across
     * both tracks in the same call without leaking matching semantics
     * between rows.
     */
    it('correctly classifies a mixed population with the same query', () => {
      const backfilled = makeModel({
        id: 'backfilled',
        capabilities: [], // empty legacy — backfill replaced it
        capabilityUris: [
          'http://ailin.dev/cap/v1/chat',
          'http://ailin.dev/cap/v1/vision',
        ],
      });
      const legacy = makeModel({
        id: 'legacy',
        capabilities: ['chat', 'vision'],
      });
      const partial = makeModel({
        id: 'partial',
        capabilities: ['chat', 'vision'],
        capabilityUris: ['http://ailin.dev/cap/v1/chat'], // backfilled but missing 'vision'
      });

      const result = filterByRequiredCapabilities(
        [backfilled, legacy, partial],
        ['chat', 'vision'],
      );

      const ids = result.map((m) => m.id).sort();
      expect(ids).toEqual(['backfilled', 'legacy']); // partial rejected by URI track
    });
  });
});
