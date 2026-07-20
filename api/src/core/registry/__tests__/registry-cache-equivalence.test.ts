// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * registry-cache-equivalence.test.ts — MVP 2
 *
 * Proves that `RuntimeModelRegistry.getModelSnapshots()` returns the
 * legacy snapshots VERBATIM:
 *   - same length
 *   - same order
 *   - same identity per index (providerId, id, costs, contextWindow, status)
 *
 * The registry_cache mode replaces the DB read with an in-memory cache.
 * Its ONLY job is to be invisible to the legacy filter/sort pipeline.
 * If any of these assertions fail, registry_cache cannot ship — it would
 * silently change behaviour.
 */

import { describe, it, expect } from 'vitest';
import { buildRuntimeModelRegistry } from '../registry-builder';
import {
  LEGACY_MODELS_FIXTURE,
  FIXTURE_ROUTE_KIND_BY_PROVIDER,
} from './fixtures/legacy-models.fixture';

describe('registry_cache equivalence — snapshots preserved verbatim', () => {
  it('getModelSnapshots length equals the input length', () => {
    const { registry } = buildRuntimeModelRegistry({
      models: LEGACY_MODELS_FIXTURE,
      routeKindByProvider: FIXTURE_ROUTE_KIND_BY_PROVIDER,
      source: 'fixture',
    });
    expect(registry.getModelSnapshots().length).toBe(LEGACY_MODELS_FIXTURE.length);
  });

  it('getModelSnapshots preserves the (providerId, id) sequence', () => {
    const { registry } = buildRuntimeModelRegistry({
      models: LEGACY_MODELS_FIXTURE,
      source: 'fixture',
    });
    const got = registry.getModelSnapshots();
    for (let i = 0; i < LEGACY_MODELS_FIXTURE.length; i += 1) {
      expect(got[i].providerId).toBe(LEGACY_MODELS_FIXTURE[i].providerId);
      expect(got[i].id).toBe(LEGACY_MODELS_FIXTURE[i].id);
    }
  });

  it('preserves pricing fields (inputCostPer1k, outputCostPer1k) unchanged', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    for (let i = 0; i < LEGACY_MODELS_FIXTURE.length; i += 1) {
      expect(got[i].inputCostPer1k).toBe(LEGACY_MODELS_FIXTURE[i].inputCostPer1k);
      expect(got[i].outputCostPer1k).toBe(LEGACY_MODELS_FIXTURE[i].outputCostPer1k);
    }
  });

  it('preserves contextWindow and maxOutputTokens unchanged', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    for (let i = 0; i < LEGACY_MODELS_FIXTURE.length; i += 1) {
      expect(got[i].contextWindow).toBe(LEGACY_MODELS_FIXTURE[i].contextWindow);
      expect(got[i].maxOutputTokens).toBe(LEGACY_MODELS_FIXTURE[i].maxOutputTokens);
    }
  });

  it('preserves status (active/inactive/deprecated) unchanged', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    for (let i = 0; i < LEGACY_MODELS_FIXTURE.length; i += 1) {
      expect(got[i].status).toBe(LEGACY_MODELS_FIXTURE[i].status);
    }
  });

  it('preserves capabilityUris / capabilities raw shape unchanged', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    for (let i = 0; i < LEGACY_MODELS_FIXTURE.length; i += 1) {
      expect(got[i].capabilityUris).toEqual(LEGACY_MODELS_FIXTURE[i].capabilityUris);
      expect(got[i].capabilities).toEqual(LEGACY_MODELS_FIXTURE[i].capabilities);
    }
  });

  it('empty input produces empty getModelSnapshots', () => {
    const { registry, diagnostics } = buildRuntimeModelRegistry({ models: [] });
    expect(registry.getModelSnapshots()).toEqual([]);
    expect(diagnostics.inputModelCount).toBe(0);
    expect(diagnostics.canonicalModelCount).toBe(0);
    expect(diagnostics.offeringCount).toBe(0);
    expect(diagnostics.routeCount).toBe(0);
    expect(diagnostics.skippedCount).toBe(0);
  });

  it('three-layer counts are consistent with input (MVP 2: 1:1:1)', () => {
    const { diagnostics } = buildRuntimeModelRegistry({
      models: LEGACY_MODELS_FIXTURE,
      source: 'fixture',
    });
    // MVP 2 derivation: 1 row → 1 offering → 1 route.
    expect(diagnostics.offeringCount).toBe(LEGACY_MODELS_FIXTURE.length);
    expect(diagnostics.routeCount).toBe(LEGACY_MODELS_FIXTURE.length);
    // CanonicalModel count equals UNIQUE `${providerId}:${id}` tuples.
    // Two Azure deployment rows share `id=gpt-4o` but have different
    // providerIds (prod-chat vs prod-fallback), so they are distinct
    // canonicals in MVP 2's strictly-structural resolution.
    const uniqueCanonical = new Set(
      LEGACY_MODELS_FIXTURE.map((m) => `${m.providerId}:${m.id}`),
    );
    expect(diagnostics.canonicalModelCount).toBe(uniqueCanonical.size);
  });

  it('diagnostics.source surfaces caller intent', () => {
    const fixtureResult = buildRuntimeModelRegistry({
      models: LEGACY_MODELS_FIXTURE,
      source: 'fixture',
    });
    expect(fixtureResult.diagnostics.source).toBe('fixture');

    const testResult = buildRuntimeModelRegistry({
      models: [],
      source: 'test',
    });
    expect(testResult.diagnostics.source).toBe('test');

    const defaultResult = buildRuntimeModelRegistry({ models: [] });
    expect(defaultResult.diagnostics.source).toBe('unknown');
  });

  it('returns a new RuntimeModelRegistry instance every call (no global state)', () => {
    const a = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const b = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    expect(a.registry).not.toBe(b.registry);
    // …but produces equivalent legacy-snapshot output.
    expect(a.registry.getModelSnapshots().length).toBe(
      b.registry.getModelSnapshots().length,
    );
  });
});
