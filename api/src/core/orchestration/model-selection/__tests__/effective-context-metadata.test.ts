// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4C §7 — effective-context-metadata tests.
 *
 * Pure: no I/O, no DB, no fetch.
 */
import { describe, it, expect } from 'vitest';
import {
  buildContextMetadataKey,
  resolveEffectiveContextMetadata,
  type ContextMetadataOverride,
} from '@/core/orchestration/model-selection/effective-context-metadata';

const baseQuery = {
  providerId: 'deepinfra',
  routeId: 'deepinfra::anthropic/claude-opus-4-7',
  apiModelId: 'anthropic/claude-opus-4-7',
  canonicalModelId: 'anthropic/claude-opus-4-7',
};

function mkOverride(o: Partial<ContextMetadataOverride>): ContextMetadataOverride {
  return {
    effectiveContextWindow: 200000,
    source: 'conservative_inference',
    confidence: 'medium',
    reason: 'test override',
    stage: '01C.1B-J1D-R4C',
    ...o,
  };
}

describe('01C.1B-J1D-R4C §7 — buildContextMetadataKey', () => {
  it('builds deterministic key, lowercased', () => {
    const k1 = buildContextMetadataKey(baseQuery);
    const k2 = buildContextMetadataKey({
      providerId: 'DeepInfra',
      routeId: 'DeepInfra::Anthropic/Claude-Opus-4-7',
      apiModelId: 'Anthropic/Claude-Opus-4-7',
      canonicalModelId: 'Anthropic/Claude-Opus-4-7',
    });
    expect(k1).toBe(k2);
  });

  it('empty inputs produce stable empty key', () => {
    const k = buildContextMetadataKey({});
    expect(k).toBe('|||');
  });
});

describe('01C.1B-J1D-R4C §7 — resolveEffectiveContextMetadata', () => {
  it('uses catalog value when no override matches', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 8192,
      overrides: [],
    });
    expect(r.effectiveContextWindow).toBe(8192);
    expect(r.source).toBe('catalog');
    expect(r.overrideApplied).toBe(false);
    expect(r.matchKind).toBe('catalog');
  });

  it('applies override on canonicalModelId match', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 8192,
      overrides: [
        mkOverride({ canonicalModelId: 'anthropic/claude-opus-4-7', effectiveContextWindow: 200000 }),
      ],
    });
    expect(r.effectiveContextWindow).toBe(200000);
    expect(r.overrideApplied).toBe(true);
    expect(r.matchKind).toBe('canonical');
  });

  it('route+provider+apiModelId beats canonical-only', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 8192,
      overrides: [
        mkOverride({ canonicalModelId: 'anthropic/claude-opus-4-7', effectiveContextWindow: 100000 }),
        mkOverride({
          providerId: 'deepinfra',
          routeId: 'deepinfra::anthropic/claude-opus-4-7',
          apiModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 250000,
        }),
      ],
    });
    expect(r.effectiveContextWindow).toBe(250000);
    expect(r.matchKind).toBe('route_provider_api');
  });

  it('provider+apiModelId beats provider+canonical', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 8192,
      overrides: [
        mkOverride({
          providerId: 'deepinfra',
          canonicalModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 100000,
        }),
        mkOverride({
          providerId: 'deepinfra',
          apiModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 150000,
        }),
      ],
    });
    expect(r.effectiveContextWindow).toBe(150000);
    expect(r.matchKind).toBe('provider_api');
  });

  it('low-confidence override CANNOT reduce a LARGER catalog value', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 200000,
      overrides: [
        mkOverride({
          canonicalModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 16000,
          confidence: 'low',
        }),
      ],
    });
    expect(r.effectiveContextWindow).toBe(200000);
    expect(r.confidence).toBe('low'); // confidence still reflects override source
  });

  it('medium-confidence override CAN adjust downward', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 200000,
      overrides: [
        mkOverride({
          canonicalModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 100000,
          confidence: 'medium',
        }),
      ],
    });
    expect(r.effectiveContextWindow).toBe(100000);
  });

  it('high-confidence override CAN adjust downward', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 200000,
      overrides: [
        mkOverride({
          canonicalModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 50000,
          confidence: 'high',
        }),
      ],
    });
    expect(r.effectiveContextWindow).toBe(50000);
  });

  it('falls back to conservative default when catalog is invalid + no override', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 0,
      overrides: [],
      conservativeFallbackContextWindow: 4096,
    });
    expect(r.effectiveContextWindow).toBe(4096);
    expect(r.source).toBe('conservative_inference');
    expect(r.matchKind).toBe('conservative_fallback');
  });

  it('rejects override with invalid effectiveContextWindow', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 8192,
      overrides: [
        mkOverride({
          canonicalModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 100,
        }),
      ],
    });
    expect(r.effectiveContextWindow).toBe(8192);
    expect(r.matchKind).toBe('catalog');
  });

  it('deterministic — same inputs → same output', () => {
    const args = {
      ...baseQuery,
      catalogContextWindow: 8192,
      overrides: [
        mkOverride({ canonicalModelId: 'anthropic/claude-opus-4-7', effectiveContextWindow: 200000 }),
      ],
    };
    const r1 = resolveEffectiveContextMetadata(args);
    const r2 = resolveEffectiveContextMetadata(args);
    expect(r1).toEqual(r2);
  });

  it('serialized result does NOT leak secret patterns', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 8192,
      overrides: [
        mkOverride({ canonicalModelId: 'anthropic/claude-opus-4-7', effectiveContextWindow: 200000 }),
      ],
    });
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(s).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });

  it('respects maxOutputTokens override + safety rule', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 8192,
      catalogMaxOutputTokens: 4096,
      overrides: [
        mkOverride({
          canonicalModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 200000,
          effectiveMaxOutputTokens: 8192,
        }),
      ],
    });
    expect(r.effectiveMaxOutputTokens).toBe(8192);
  });

  it('overrides without matching provider/route/api/canonical are skipped', () => {
    const r = resolveEffectiveContextMetadata({
      ...baseQuery,
      catalogContextWindow: 8192,
      overrides: [
        mkOverride({
          providerId: 'huggingface', // doesn't match deepinfra
          apiModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 200000,
        }),
      ],
    });
    expect(r.effectiveContextWindow).toBe(8192);
    expect(r.matchKind).toBe('catalog');
  });

  it('most-specific override wins even when canonical also matches', () => {
    const r = resolveEffectiveContextMetadata({
      providerId: 'deepinfra',
      routeId: 'deepinfra',
      apiModelId: 'anthropic/claude-opus-4-7',
      canonicalModelId: 'anthropic/claude-opus-4-7',
      catalogContextWindow: 8192,
      overrides: [
        mkOverride({
          canonicalModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 100000,
          confidence: 'high',
        }),
        mkOverride({
          providerId: 'deepinfra',
          routeId: 'deepinfra',
          apiModelId: 'anthropic/claude-opus-4-7',
          effectiveContextWindow: 250000,
          confidence: 'medium',
        }),
      ],
    });
    expect(r.effectiveContextWindow).toBe(250000);
    expect(r.matchKind).toBe('route_provider_api');
  });
});
