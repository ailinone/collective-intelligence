// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GAP-A12 — discovery → capability-assertion emitter.
 *
 * Two things are pinned here:
 *
 *  1. **The ablation contract.** `deriveDiscoverySignals` recovers per-capability
 *     provenance by re-running the real inference engine with narrowed inputs
 *     (see the module header). These tests are what stop that from silently
 *     degrading into "everything is name-regex" if someone changes which
 *     metadata keys the engine reads — the emitter's `MODALITY_METADATA_KEYS` /
 *     `PARAMETER_METADATA_KEYS` lists would go stale and these cases fail.
 *
 *  2. **Fail-soft.** The emit runs INSIDE the discovery write path, so a DB
 *     error, an unseeded ontology, or a kill-switch must degrade to "no
 *     assertions" and never to "no discovery".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  deriveDiscoverySignals,
  emitDiscoveryAssertions,
  isDiscoveryAssertionsEnabled,
  __resetOntologyUriCacheForTests,
} from '../discovery-emitter';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';

function sourceOf(
  signals: ReturnType<typeof deriveDiscoverySignals>,
  capability: string
): string | undefined {
  return signals.find((s) => s.capability === capability)?.source;
}

describe('deriveDiscoverySignals — provenance by ablation', () => {
  it('attributes capabilities the provider really declared to provider-declared', () => {
    // `metadata.capabilities` is written by the hub fetcher ONLY from genuinely
    // declared response fields — that is the corroboration.
    const signals = deriveDiscoverySignals({
      modelId: 'gpt-4o',
      finalCapabilities: ['chat', 'vision'],
      declaredCapabilities: ['chat', 'vision'],
      metadata: { capabilities: ['chat', 'vision'] },
    });

    expect(signals).toHaveLength(2);
    expect(sourceOf(signals, 'chat')).toBe('provider-declared');
    expect(sourceOf(signals, 'vision')).toBe('provider-declared');
  });

  it('trusts the catalog pinned path only when it says operator-declared', () => {
    const operator = deriveDiscoverySignals({
      modelId: 'pinned/model',
      finalCapabilities: ['embedding'],
      declaredCapabilities: ['embedding'],
      metadata: { capabilitySource: 'operator-declared' },
    });
    expect(sourceOf(operator, 'embedding')).toBe('provider-declared');

    // Same path, but the catalog row was a bare id string — it tags itself
    // 'name-regex', and we must not launder that into a declaration.
    const guessed = deriveDiscoverySignals({
      modelId: 'pinned/model',
      finalCapabilities: ['embedding'],
      declaredCapabilities: ['embedding'],
      metadata: { capabilitySource: 'name-regex' },
    });
    expect(sourceOf(guessed, 'embedding')).toBe('name-regex');
  });

  it('does NOT promote an uncorroborated fetcher capability list to provider-declared', () => {
    // Regression guard for a real defect found during the GAP-A12 live run.
    // OpenAICompatibleHubModelFetcher fills its `capabilities` field from three
    // places — declared vendor fields, `inferCapabilitiesFromModelId()` name
    // heuristics, and a bare ['chat','text_generation'] default for anything in
    // /v1/models. Treating the field itself as evidence stamped confidence 1.0
    // on guesses (fused P ≈ 0.95), which is fabricated confidence.
    const signals = deriveDiscoverySignals({
      modelId: 'vendor/opaque-model-name',
      finalCapabilities: ['chat', 'text_generation'],
      declaredCapabilities: ['chat', 'text_generation'],
      metadata: { source: 'catalog-someprovider' }, // no corroborating marker
    });

    expect(sourceOf(signals, 'chat')).not.toBe('provider-declared');
    expect(sourceOf(signals, 'text_generation')).not.toBe('provider-declared');
  });

  it('attributes modality-array-implied capabilities to modality-derived', () => {
    const signals = deriveDiscoverySignals({
      modelId: 'some-opaque-model',
      finalCapabilities: ['vision', 'multimodal', 'chat'],
      declaredCapabilities: [],
      metadata: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    });

    expect(sourceOf(signals, 'vision')).toBe('modality-derived');
    expect(sourceOf(signals, 'multimodal')).toBe('modality-derived');
    expect(sourceOf(signals, 'chat')).toBe('modality-derived');
  });

  it('reads modalities nested under `architecture` (OpenRouter/Poe shape)', () => {
    const signals = deriveDiscoverySignals({
      modelId: 'x',
      finalCapabilities: ['vision'],
      declaredCapabilities: [],
      metadata: { architecture: { input_modalities: ['text', 'image'] } },
    });

    expect(sourceOf(signals, 'vision')).toBe('modality-derived');
  });

  it('attributes supported_parameters-implied capabilities to parameter-derived', () => {
    const signals = deriveDiscoverySignals({
      modelId: 'zzz-opaque',
      finalCapabilities: ['function_calling', 'json_mode'],
      declaredCapabilities: [],
      metadata: { supported_parameters: ['tools', 'response_format'] },
    });

    expect(sourceOf(signals, 'function_calling')).toBe('parameter-derived');
    expect(sourceOf(signals, 'json_mode')).toBe('parameter-derived');
  });

  it('falls back to name-regex only when no stronger evidence explains the capability', () => {
    const signals = deriveDiscoverySignals({
      modelId: 'deepseek-coder-v2',
      finalCapabilities: ['coding', 'code_generation'],
      declaredCapabilities: [],
      metadata: {},
    });

    expect(sourceOf(signals, 'coding')).toBe('name-regex');
    expect(sourceOf(signals, 'code_generation')).toBe('name-regex');
  });

  it('mixes sources within one model, strongest evidence wins per capability', () => {
    const signals = deriveDiscoverySignals({
      modelId: 'claude-3-5-sonnet',
      finalCapabilities: ['chat', 'vision', 'reasoning'],
      declaredCapabilities: ['chat'],
      metadata: { capabilities: ['chat'], input_modalities: ['text', 'image'] },
    });

    expect(sourceOf(signals, 'chat')).toBe('provider-declared');
    expect(sourceOf(signals, 'vision')).toBe('modality-derived');
    // 'reasoning' is only explicable from the model NAME — no declaration, no
    // modality, no parameter — so it must stay weak.
    expect(sourceOf(signals, 'reasoning')).toBe('name-regex');
  });

  it('emits exactly one signal per persisted capability, deduplicated', () => {
    const signals = deriveDiscoverySignals({
      modelId: 'm',
      finalCapabilities: ['chat', 'chat', 'vision'],
      declaredCapabilities: ['chat'],
      metadata: {},
    });

    expect(signals.map((s) => s.capability).sort()).toEqual(['chat', 'vision']);
  });

  it('returns nothing for a model with no capabilities', () => {
    expect(deriveDiscoverySignals({ modelId: 'm', finalCapabilities: [], metadata: {} })).toEqual(
      []
    );
  });

  it('does NOT set an explicit confidence — the writer owns the calibrated defaults', () => {
    // Duplicating the per-source confidence table here would let the two copies
    // drift; DEFAULT_TTL/confidence live in writer.ts alone.
    const signals = deriveDiscoverySignals({
      modelId: 'gpt-4o',
      finalCapabilities: ['chat'],
      declaredCapabilities: ['chat'],
    });
    expect(signals[0]?.confidence).toBeUndefined();
  });

  it('records the evidence class in source_detail for the audit trail', () => {
    const signals = deriveDiscoverySignals({
      modelId: 'gpt-4o',
      finalCapabilities: ['chat'],
      declaredCapabilities: ['chat'],
      metadata: { capabilities: ['chat'] },
    });
    expect(signals[0]?.detail).toMatchObject({
      source_field: 'discovery:declared-capabilities',
      modelId: 'gpt-4o',
    });
  });

  it('only emits capabilities that have a legacy→URI mapping downstream', () => {
    // Not a filter in this function (the writer drops unmapped slugs and warns),
    // but the mapping must cover what discovery routinely produces, otherwise
    // GAP-A12 would close on paper and drop rows in practice.
    const signals = deriveDiscoverySignals({
      modelId: 'claude-3-5-sonnet',
      finalCapabilities: ['chat', 'vision', 'reasoning', 'function_calling', 'streaming'],
      declaredCapabilities: ['chat'],
      metadata: { input_modalities: ['text', 'image'] },
    });
    for (const s of signals) {
      expect(LEGACY_CAPABILITY_TO_URI[s.capability]).toBeDefined();
    }
  });
});

describe('emitDiscoveryAssertions — fail-soft contract', () => {
  const originalFlag = process.env.HCRA_DISCOVERY_ASSERTIONS_DISABLED;

  beforeEach(() => {
    __resetOntologyUriCacheForTests();
    delete process.env.HCRA_DISCOVERY_ASSERTIONS_DISABLED;
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.HCRA_DISCOVERY_ASSERTIONS_DISABLED;
    else process.env.HCRA_DISCOVERY_ASSERTIONS_DISABLED = originalFlag;
    __resetOntologyUriCacheForTests();
  });

  const model = {
    modelUid: 'uid-1',
    signal: {
      modelId: 'gpt-4o',
      finalCapabilities: ['chat'],
      declaredCapabilities: ['chat'],
      metadata: {},
    },
  };

  it('is enabled by default and disabled by the kill switch', () => {
    expect(isDiscoveryAssertionsEnabled()).toBe(true);
    process.env.HCRA_DISCOVERY_ASSERTIONS_DISABLED = 'true';
    expect(isDiscoveryAssertionsEnabled()).toBe(false);
  });

  it('touches the database not at all when disabled', async () => {
    process.env.HCRA_DISCOVERY_ASSERTIONS_DISABLED = 'true';
    const runner = {
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    };

    const stats = await emitDiscoveryAssertions([model], {
      sourceName: 's',
      providerId: 'p',
      runner: runner as never,
    });

    expect(stats.skipped).toBe('disabled');
    expect(runner.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(runner.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('short-circuits an empty batch without a query', async () => {
    const runner = { $executeRawUnsafe: vi.fn(), $queryRawUnsafe: vi.fn() };
    const stats = await emitDiscoveryAssertions([], {
      sourceName: 's',
      providerId: 'p',
      runner: runner as never,
    });
    expect(stats.skipped).toBe('empty');
    expect(runner.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('drops signals whose URI is absent from capability_ontology instead of aborting the batch', async () => {
    // capability_uri FKs onto capability_ontology; one unknown URI would fail
    // the whole single-statement INSERT and lose the rest of the batch.
    const runner = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]), // empty ontology
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    };

    const stats = await emitDiscoveryAssertions([model], {
      sourceName: 's',
      providerId: 'p',
      runner: runner as never,
    });

    expect(stats.signalsDroppedUnknownUri).toBe(1);
    expect(stats.rowsInserted).toBe(0);
    // No write attempted at all — nothing survived the guard.
    expect(runner.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('writes the surviving signals when the ontology knows their URIs', async () => {
    const chatUri = LEGACY_CAPABILITY_TO_URI.chat;
    const runner = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ uri: chatUri }]),
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    };

    const stats = await emitDiscoveryAssertions([model], {
      sourceName: 'catalog-openai',
      providerId: 'openai',
      runner: runner as never,
    });

    expect(stats.signalsDroppedUnknownUri).toBe(0);
    // supersede + insert
    expect(runner.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    // The supersedence key must be the discovery SOURCE, so two sources that
    // both see a model contribute independent evidence instead of clobbering
    // each other. (Param position 1, not 2 — writer.ts's idempotency fix
    // reordered the supersede UPDATE to filter on (model_uid, capability_uri,
    // source) triples, so origin moved ahead of the row-key arrays.)
    expect(runner.$executeRawUnsafe.mock.calls[0]?.[1]).toBe('discovery:catalog-openai@v1');
  });

  it('swallows a database failure — discovery must not fail because assertions did', async () => {
    const runner = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error('connection terminated')),
      $executeRawUnsafe: vi.fn(),
    };

    await expect(
      emitDiscoveryAssertions([model], {
        sourceName: 's',
        providerId: 'p',
        runner: runner as never,
      })
    ).resolves.toMatchObject({ rowsInserted: 0, modelsTouched: 0 });
  });

  it('caches the ontology allowlist rather than re-reading it per batch', async () => {
    const runner = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ uri: LEGACY_CAPABILITY_TO_URI.chat }]),
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    };
    const opts = { sourceName: 's', providerId: 'p', runner: runner as never };

    await emitDiscoveryAssertions([model], opts);
    await emitDiscoveryAssertions([model], opts);

    // Scoped to the ontology-allowlist query specifically: writer.ts's
    // idempotency fix added its own $queryRawUnsafe call (fetching each
    // batch's currently-active assertions), which is necessarily per-call
    // and shares the same generic mock method — it's a different query for
    // a different, non-cacheable reason, so it's excluded here rather than
    // asserting a single total count across both.
    const ontologyCalls = runner.$queryRawUnsafe.mock.calls.filter((call) =>
      String(call[0]).includes('capability_ontology')
    );
    expect(ontologyCalls).toHaveLength(1);
  });
});
