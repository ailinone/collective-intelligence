// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Topaz catalog ↔ adapter agreement — LOTE AP (2026-09-05).
 *
 * Topaz exposes no `/models` endpoint, so the catalog's `pinnedFallback` list
 * IS the inventory of record: it is what discovery materializes, what
 * `ImagesOrchestrationService.enhanceImage` selects from, and what ends up in
 * `imageEdit(model, …)`. The adapter then hard-rejects any id outside its own
 * `ENHANCE_MODELS` allowlist.
 *
 * Those two lists disagreed completely — the catalog pinned `standard` /
 * `high-fidelity`, the adapter accepted `standard_v2` / `high_fidelity_v2` /
 * `art_and_cg` / `low_resolution`. Zero overlap. The contradiction was
 * invisible for as long as no executor existed for `image_upscale`; the first
 * real enhancement request would have died on
 * `topaz: unknown model standard`.
 *
 * This suite is the guard. Any provider whose inventory lives in the catalog
 * rather than behind a discovery endpoint needs one.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../../catalog/providers.catalog';
import { TopazAdapter } from '../topaz-adapter';
import { MODEL_CAPABILITIES, type ModelCapability } from '@/types';

const topaz = PROVIDER_CATALOG.find((entry) => entry.providerId === 'topaz');

describe('topaz — catalog inventory agrees with the adapter allowlist', () => {
  it('has a catalog entry with a pinned inventory', () => {
    expect(topaz).toBeDefined();
    expect(topaz?.pinnedFallback?.models?.length).toBeGreaterThan(0);
    // If Topaz ever ships a /models endpoint this test's premise changes.
    expect(topaz?.pinnedFallback?.reason).toBe('no-list-endpoint');
  });

  it('every pinned model id is accepted by the adapter', () => {
    const rejected = (topaz?.pinnedFallback?.models ?? [])
      .map((model) => model.id)
      .filter((id) => !TopazAdapter.isTopazModel(id));

    // A non-empty list here means `enhanceImage` can select a model that
    // `imageEdit` will throw on — a 100% failure rate for the capability.
    expect(rejected).toEqual([]);
  });

  it('every capability the pinned models declare is a real ModelCapability', () => {
    const known = new Set<string>(MODEL_CAPABILITIES);
    const unknown = (topaz?.pinnedFallback?.models ?? [])
      .flatMap((model) => model.capabilities ?? [])
      .filter((capability) => !known.has(capability));

    expect(unknown).toEqual([]);
  });

  it('the adapter advertises only real ModelCapability members', async () => {
    const adapter = new TopazAdapter({
      name: 'topaz',
      enabled: true,
      apiKey: 'test-key',
    });
    const known = new Set<string>(MODEL_CAPABILITIES);
    const models = await adapter.getModels();

    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      const unknown = (model.capabilities ?? []).filter(
        (capability: ModelCapability) => !known.has(capability)
      );
      // `image_enhance` lived here and matched nothing anywhere — it survived
      // only because the model object goes through `narrowAs`.
      expect(unknown).toEqual([]);
    }
  });

  it('the enhancement capabilities the catalog declares are also advertised by the adapter', async () => {
    const adapter = new TopazAdapter({
      name: 'topaz',
      enabled: true,
      apiKey: 'test-key',
    });
    const advertised = new Set(
      (await adapter.getModels()).flatMap((model) => model.capabilities ?? [])
    );

    expect(advertised.has('image_upscale' as ModelCapability)).toBe(true);
    // The catalog declares denoise for the general pipelines and
    // `noise_reduction` is a real form field — the adapter must say so too,
    // or catalog-sourced and adapter-sourced rows disagree about it.
    expect(advertised.has('image_denoise' as ModelCapability)).toBe(true);
  });
});
