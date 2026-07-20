// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * registry-cache-no-filter-drift.test.ts — MVP 2
 *
 * Proves that `RuntimeModelRegistry` does NOT introduce filters of its
 * own. Filtering is the responsibility of the legacy pipeline
 * (`pool-builder.filterByModality / filterByStatus / filterByOperability
 *  / filterByCredits / filterByQuality / excludeSelfHosted`).
 *
 * The registry, in `registry_cache` mode, must keep ALL the rows it
 * received — including inactive, deprecated, embeddings-only,
 * image-only, local, aggregator — so the legacy pipeline downstream
 * sees the exact same input it would have read from the DB.
 *
 * Strategy: take a fixture that contains explicit "drop candidates"
 * (inactive, deprecated, non-chat) and verify they all remain in
 * `getModelSnapshots()`.
 */

import { describe, it, expect } from 'vitest';
import { buildRuntimeModelRegistry } from '../registry-builder';
import { LEGACY_MODELS_FIXTURE } from './fixtures/legacy-models.fixture';

describe('registry_cache no-filter-drift — every input row survives', () => {
  it('inactive rows are NOT dropped', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    const inactiveInput = LEGACY_MODELS_FIXTURE.filter((m) => m.status === 'inactive');
    const inactiveOutput = got.filter((m) => m.status === 'inactive');
    expect(inactiveInput.length).toBeGreaterThan(0); // fixture invariant
    expect(inactiveOutput.length).toBe(inactiveInput.length);
  });

  it('deprecated rows are NOT dropped', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    const deprecatedInput = LEGACY_MODELS_FIXTURE.filter(
      (m) => m.status === 'deprecated' || m.lifecycleStatus === 'deprecated',
    );
    const deprecatedOutput = got.filter(
      (m) => m.status === 'deprecated' || m.lifecycleStatus === 'deprecated',
    );
    expect(deprecatedInput.length).toBeGreaterThan(0);
    expect(deprecatedOutput.length).toBe(deprecatedInput.length);
  });

  it('local / self-hosted rows are NOT dropped', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    const localInput = LEGACY_MODELS_FIXTURE.filter(
      (m) => m.providerId === 'ollama' || m.providerId === 'vllm',
    );
    const localOutput = got.filter(
      (m) => m.providerId === 'ollama' || m.providerId === 'vllm',
    );
    expect(localInput.length).toBeGreaterThan(0);
    expect(localOutput.length).toBe(localInput.length);
  });

  it('aggregator rows are NOT dropped', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    const aggInput = LEGACY_MODELS_FIXTURE.filter(
      (m) =>
        m.providerId === 'aihubmix' ||
        m.providerId === 'openrouter' ||
        m.providerId === 'cometapi',
    );
    const aggOutput = got.filter(
      (m) =>
        m.providerId === 'aihubmix' ||
        m.providerId === 'openrouter' ||
        m.providerId === 'cometapi',
    );
    expect(aggInput.length).toBeGreaterThan(0);
    expect(aggOutput.length).toBe(aggInput.length);
  });

  it('non-chat (embedding / image) rows are NOT dropped', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    const nonChatInput = LEGACY_MODELS_FIXTURE.filter(
      (m) =>
        (m.capabilityUris ?? []).some(
          (c) => c === 'embedding' || c === 'image_generation',
        ),
    );
    const nonChatOutput = got.filter(
      (m) =>
        (m.capabilityUris ?? []).some(
          (c) => c === 'embedding' || c === 'image_generation',
        ),
    );
    expect(nonChatInput.length).toBeGreaterThan(0);
    expect(nonChatOutput.length).toBe(nonChatInput.length);
  });

  it('rows without ANY capability declared are NOT dropped', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    const noCapsInput = LEGACY_MODELS_FIXTURE.filter(
      (m) => !m.capabilityUris && !m.capabilities,
    );
    const noCapsOutput = got.filter(
      (m) => !m.capabilityUris && !m.capabilities,
    );
    expect(noCapsInput.length).toBeGreaterThan(0);
    expect(noCapsOutput.length).toBe(noCapsInput.length);
  });

  it('rows with null pricing are NOT dropped', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    const noPriceInput = LEGACY_MODELS_FIXTURE.filter(
      (m) =>
        (m.inputCostPer1k === null || m.inputCostPer1k === undefined) &&
        (m.outputCostPer1k === null || m.outputCostPer1k === undefined),
    );
    const noPriceOutput = got.filter(
      (m) =>
        (m.inputCostPer1k === null || m.inputCostPer1k === undefined) &&
        (m.outputCostPer1k === null || m.outputCostPer1k === undefined),
    );
    expect(noPriceInput.length).toBeGreaterThan(0);
    expect(noPriceOutput.length).toBe(noPriceInput.length);
  });

  it('preview lifecycle rows are NOT dropped', () => {
    const { registry } = buildRuntimeModelRegistry({ models: LEGACY_MODELS_FIXTURE });
    const got = registry.getModelSnapshots();
    const previewInput = LEGACY_MODELS_FIXTURE.filter(
      (m) => m.lifecycleStatus === 'preview',
    );
    const previewOutput = got.filter((m) => m.lifecycleStatus === 'preview');
    expect(previewInput.length).toBeGreaterThan(0);
    expect(previewOutput.length).toBe(previewInput.length);
  });

  it('the ONLY rows dropped are those missing identity (id or providerId)', () => {
    // Add 2 invalid rows to the fixture to verify that the builder
    // drops them and counts them in diagnostics — but DOESN'T drop
    // anything else.
    const augmented = [
      ...LEGACY_MODELS_FIXTURE,
      // missing id
      {
        id: '' as unknown as string,
        providerId: 'someone',
        status: 'active',
      },
      // missing providerId
      {
        id: 'some-model',
        providerId: '' as unknown as string,
        status: 'active',
      },
    ];

    const { registry, diagnostics } = buildRuntimeModelRegistry({
      models: augmented,
    });

    // VERBATIM array (including invalid rows) goes through getModelSnapshots
    // — getModelSnapshots is the legacy mirror, it should NOT be
    // filtered. Diagnostics report the drops separately.
    expect(registry.getModelSnapshots().length).toBe(augmented.length);

    // Builder drops invalid rows from the canonical/offering/route
    // layers — but ONLY by structural-identity invalidity.
    expect(diagnostics.skippedCount).toBe(2);
    expect(diagnostics.skippedReasons['missing_id']).toBe(1);
    expect(diagnostics.skippedReasons['missing_provider_id']).toBe(1);
    // No other reasons should appear.
    expect(Object.keys(diagnostics.skippedReasons).sort()).toEqual([
      'missing_id',
      'missing_provider_id',
    ]);
  });
});
