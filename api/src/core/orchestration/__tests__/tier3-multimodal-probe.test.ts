// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tier-3 multimodal probe — behavioral contract.
 *
 * Two things this pins hardest:
 *   1. The GATE (`isTier3EligibleByDeclaredModality`) only fires for models
 *      whose OWN `capability_uris` already declares a probeable modality —
 *      never for a model with no declared multimodal input, which is the
 *      whole reason this tier averages ~0.15 calls/model instead of 1.
 *   2. The probe only ever UPGRADES an existing positive to `runtime-probe`
 *      evidence or leaves it alone — it never asserts a capability the
 *      model didn't already have declared.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';

const recordProbeAssertions = vi.fn().mockResolvedValue('written');
vi.mock('@/capability/assertions/probe-emitter', () => ({
  recordProbeAssertions: (...args: unknown[]) => recordProbeAssertions(...args),
}));

const {
  isTier3EligibleByDeclaredModality,
  runTier3MultimodalProbe,
  resetTier3ProbeForTesting,
  getTier3ProbeStats,
} = await import('../tier3-multimodal-probe');

const VISION_URI = LEGACY_CAPABILITY_TO_URI['vision'];
const AUDIO_URI = LEGACY_CAPABILITY_TO_URI['audio_input'];

function fakeAdapter(
  behavior: 'accepts' | 'rejects-modality' | 'billing' | 'throws'
): ProviderAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    getName: () => 'probe-test',
    async chatCompletion() {
      adapter.calls++;
      if (behavior === 'accepts') {
        return {
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: 'm',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'The image appears mostly transparent.' }, finish_reason: 'stop' },
          ],
        };
      }
      if (behavior === 'rejects-modality') {
        throw new Error('I do not have the ability to see images.');
      }
      if (behavior === 'billing') {
        throw new Error('HTTP 402 insufficient credits');
      }
      throw new Error('unexpected failure shape');
    },
  };
  return adapter as unknown as ProviderAdapter & { calls: number };
}

describe('isTier3EligibleByDeclaredModality', () => {
  it('is ineligible when capability_uris is empty/absent', () => {
    expect(isTier3EligibleByDeclaredModality([]).eligible).toBe(false);
    expect(isTier3EligibleByDeclaredModality(null).eligible).toBe(false);
    expect(isTier3EligibleByDeclaredModality(undefined).eligible).toBe(false);
  });

  it('is ineligible for a model with only non-modality capabilities declared', () => {
    const uris = [LEGACY_CAPABILITY_TO_URI['chat'], LEGACY_CAPABILITY_TO_URI['code_generation']].filter(
      Boolean
    ) as string[];
    expect(isTier3EligibleByDeclaredModality(uris).eligible).toBe(false);
  });

  it('is eligible and reports "vision" when the vision URI is declared', () => {
    const result = isTier3EligibleByDeclaredModality([VISION_URI!]);
    expect(result.eligible).toBe(true);
    expect(result.declaredCapability).toBe('vision');
  });

  it('is eligible and reports "audio_input" when only audio is declared', () => {
    const result = isTier3EligibleByDeclaredModality([AUDIO_URI!]);
    expect(result.eligible).toBe(true);
    expect(result.declaredCapability).toBe('audio_input');
  });
});

describe('runTier3MultimodalProbe', () => {
  beforeEach(() => {
    resetTier3ProbeForTesting();
    recordProbeAssertions.mockClear();
  });

  it('confirms and persists an upgrade when the provider accepts the vision-shaped request', async () => {
    const adapter = fakeAdapter('accepts');
    const outcome = await runTier3MultimodalProbe(adapter, 'probe-test', 'model-a', 'vision');

    expect(outcome.status).toBe('confirmed');
    expect(adapter.calls).toBe(1);
    expect(recordProbeAssertions).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'probe-test',
        modelId: 'model-a',
        origin: 'tier3-multimodal-probe@v1',
        signals: [{ capability: 'vision' }],
      })
    );
  });

  it('rejects (and persists nothing) on an explicit modality-unsupported rejection', async () => {
    const adapter = fakeAdapter('rejects-modality');
    const outcome = await runTier3MultimodalProbe(adapter, 'probe-test', 'model-b', 'vision');

    expect(outcome.status).toBe('rejected');
    expect(recordProbeAssertions).not.toHaveBeenCalled();
  });

  it('classifies a billing/credit failure as provider-dead, not a capability verdict', async () => {
    const adapter = fakeAdapter('billing');
    const outcome = await runTier3MultimodalProbe(adapter, 'probe-test', 'model-c', 'vision');

    expect(outcome.status).toBe('provider-dead');
    expect(recordProbeAssertions).not.toHaveBeenCalled();
  });

  it('classifies an unrecognized error as inconclusive', async () => {
    const adapter = fakeAdapter('throws');
    const outcome = await runTier3MultimodalProbe(adapter, 'probe-test', 'model-d', 'vision');

    expect(outcome.status).toBe('inconclusive');
  });

  it('only actually executes a real probe call for "vision" today — other declared modalities report not-probeable without calling the adapter', async () => {
    const adapter = fakeAdapter('accepts');
    const outcome = await runTier3MultimodalProbe(adapter, 'probe-test', 'model-e', 'audio_input');

    expect(outcome.status).toBe('not-probeable');
    expect(adapter.calls).toBe(0);
    expect(recordProbeAssertions).not.toHaveBeenCalled();
  });

  it('enforces the per-process probe budget', async () => {
    vi.resetModules();
    process.env.TIER3_PROBE_MAX_PROBES = '1';
    try {
      const fresh = await import('../tier3-multimodal-probe');
      const adapter = fakeAdapter('accepts');
      const first = await fresh.runTier3MultimodalProbe(adapter, 'probe-test', 'model-f', 'vision');
      const second = await fresh.runTier3MultimodalProbe(adapter, 'probe-test', 'model-g', 'vision');

      expect(first.status).toBe('confirmed');
      expect(second.status).toBe('budget-exhausted');
      expect(fresh.getTier3ProbeStats().started).toBe(1);
    } finally {
      delete process.env.TIER3_PROBE_MAX_PROBES;
      vi.resetModules();
    }
  });
});
