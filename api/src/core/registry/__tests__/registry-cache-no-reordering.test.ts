// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * registry-cache-no-reordering.test.ts — MVP 2
 *
 * Proves that `RuntimeModelRegistry` does NOT reorder the legacy
 * snapshots. If the legacy pipeline (`base-strategy.getEligibleModels`
 * + `pool-builder.sortByQualityThenCost`) wants a specific order, it
 * must apply its own sort on the registry output — the registry itself
 * preserves the input order verbatim.
 *
 * Strategy: take a fixture, then SHUFFLE it deterministically using
 * different orderings, and assert each shuffle is preserved.
 */

import { describe, it, expect } from 'vitest';
import { buildRuntimeModelRegistry } from '../registry-builder';
import {
  LEGACY_MODELS_FIXTURE,
} from './fixtures/legacy-models.fixture';
import type { LegacyModelSnapshot } from '../legacy-model-snapshot';

/**
 * Deterministic shuffle: re-orders `arr` using a seeded Fisher-Yates
 * variant. Different seeds give different orderings; same seed gives
 * the same ordering. No use of Math.random (which would be non-deterministic).
 */
function shuffleDeterministic<T>(arr: ReadonlyArray<T>, seed: number): T[] {
  const out = arr.slice();
  // Simple linear-congruential generator — sufficient for test shuffles.
  let s = seed >>> 0;
  const next = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function fingerprint(arr: ReadonlyArray<LegacyModelSnapshot>): string {
  return arr.map((m) => `${m.providerId}:${m.id}`).join('|');
}

describe('registry_cache no-reordering — input order is preserved', () => {
  it('preserves the fixture order exactly', () => {
    const { registry } = buildRuntimeModelRegistry({
      models: LEGACY_MODELS_FIXTURE,
      source: 'fixture',
    });
    expect(fingerprint(registry.getModelSnapshots())).toBe(
      fingerprint(LEGACY_MODELS_FIXTURE),
    );
  });

  it('preserves a reverse-sorted-by-id ordering', () => {
    const reversed = LEGACY_MODELS_FIXTURE.slice().sort((a, b) =>
      b.id.localeCompare(a.id),
    );
    const { registry } = buildRuntimeModelRegistry({ models: reversed });
    expect(fingerprint(registry.getModelSnapshots())).toBe(fingerprint(reversed));
  });

  it('preserves a shuffled ordering (seed=42)', () => {
    const shuffled = shuffleDeterministic(LEGACY_MODELS_FIXTURE, 42);
    const { registry } = buildRuntimeModelRegistry({ models: shuffled });
    expect(fingerprint(registry.getModelSnapshots())).toBe(fingerprint(shuffled));
  });

  it('preserves a shuffled ordering (seed=7)', () => {
    const shuffled = shuffleDeterministic(LEGACY_MODELS_FIXTURE, 7);
    const { registry } = buildRuntimeModelRegistry({ models: shuffled });
    expect(fingerprint(registry.getModelSnapshots())).toBe(fingerprint(shuffled));
  });

  it('does NOT sort by cost', () => {
    // Build an input where cost is INVERSE of input order; if the
    // registry sorted by cost, output order would differ from input.
    const sorted = LEGACY_MODELS_FIXTURE.slice().sort((a, b) => {
      const ca = (a.inputCostPer1k ?? 0);
      const cb = (b.inputCostPer1k ?? 0);
      return cb - ca; // descending — expensive first
    });
    const { registry } = buildRuntimeModelRegistry({ models: sorted });
    expect(fingerprint(registry.getModelSnapshots())).toBe(fingerprint(sorted));
  });

  it('does NOT sort by contextWindow', () => {
    const sorted = LEGACY_MODELS_FIXTURE.slice().sort(
      (a, b) => (a.contextWindow ?? 0) - (b.contextWindow ?? 0),
    );
    const { registry } = buildRuntimeModelRegistry({ models: sorted });
    expect(fingerprint(registry.getModelSnapshots())).toBe(fingerprint(sorted));
  });

  it('does NOT group by providerId implicitly', () => {
    // Inputs alternate providers to create the "worst case" for any
    // implicit grouping logic. If the registry grouped by provider,
    // the output would have provider runs; assert it doesn't.
    const interleaved: LegacyModelSnapshot[] = [];
    const anthropic = LEGACY_MODELS_FIXTURE.filter((m) => m.providerId === 'anthropic');
    const openai = LEGACY_MODELS_FIXTURE.filter((m) => m.providerId === 'openai');
    const ollama = LEGACY_MODELS_FIXTURE.filter((m) => m.providerId === 'ollama');
    const maxLen = Math.max(anthropic.length, openai.length, ollama.length);
    for (let i = 0; i < maxLen; i += 1) {
      if (anthropic[i]) interleaved.push(anthropic[i]);
      if (openai[i]) interleaved.push(openai[i]);
      if (ollama[i]) interleaved.push(ollama[i]);
    }
    const { registry } = buildRuntimeModelRegistry({ models: interleaved });
    expect(fingerprint(registry.getModelSnapshots())).toBe(fingerprint(interleaved));
  });
});
