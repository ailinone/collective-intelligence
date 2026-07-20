// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * canonical-resolution-confidence.test.ts — MVP 4
 *
 * Proves the precedence + confidence rules:
 *   - manual_override > declared_alias > provider_metadata >
 *     exact_normalized_name > heuristic_family_version >
 *     model_equivalence_service > fallback_provider_model_id.
 *   - confidence < 0.7 NEVER yields an auto-merge.
 *   - fallback_provider_model_id has confidence 0.
 *   - pickHigherAuthority is deterministic.
 */

import { describe, expect, it } from 'vitest';
import {
  canAutoMerge,
  pickHigherAuthority,
  resolveCanonicalConfidence,
} from '../canonical-resolution-confidence';
import {
  CANONICAL_SOURCE_AUTHORITY,
  FALLBACK_RESOLUTION_CONFIDENCE,
  MIN_CONFIDENCE_FOR_AUTO_MERGE,
} from '../canonical-resolution-types';

describe('resolveCanonicalConfidence — precedence', () => {
  it('manual_override wins over everything else', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'gpt-4o',
      servingProviderId: 'openai',
      manualOverride: { canonicalModelId: 'forced:id', operator: 'alice' },
      declaredAlias: { canonicalModelId: 'should-lose' },
      providerMetadata: { canonicalModelId: 'also-lose', confidence: 0.95 },
      exactNormalizedName: { canonicalModelId: 'also-lose' },
      heuristicFamilyVersion: { canonicalModelId: 'also-lose', confidence: 0.9 },
    });
    expect(out.source).toBe('manual_override');
    expect(out.canonicalModelId).toBe('forced:id');
    expect(out.confidence).toBe(1.0);
    expect(out.reason).toContain('alice');
  });

  it('declared_alias wins over provider_metadata + heuristic', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'gpt-4o',
      servingProviderId: 'openai',
      declaredAlias: { canonicalModelId: 'declared:winner' },
      providerMetadata: { canonicalModelId: 'lose', confidence: 0.95 },
      heuristicFamilyVersion: { canonicalModelId: 'lose', confidence: 0.9 },
    });
    expect(out.source).toBe('declared_alias');
    expect(out.canonicalModelId).toBe('declared:winner');
    expect(out.confidence).toBe(1.0);
  });

  it('provider_metadata wins over exact_normalized_name when confidence ≥ 0.85', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'gpt-4o',
      servingProviderId: 'openai',
      providerMetadata: { canonicalModelId: 'provider:winner', confidence: 0.95 },
      exactNormalizedName: { canonicalModelId: 'lose' },
    });
    expect(out.source).toBe('provider_metadata');
    expect(out.canonicalModelId).toBe('provider:winner');
    expect(out.confidence).toBe(0.95);
  });

  it('provider_metadata is IGNORED when confidence < 0.85 → falls through', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'gpt-4o',
      servingProviderId: 'openai',
      providerMetadata: { canonicalModelId: 'unsure', confidence: 0.5 },
      exactNormalizedName: { canonicalModelId: 'exact:winner' },
    });
    expect(out.source).toBe('exact_normalized_name');
    expect(out.canonicalModelId).toBe('exact:winner');
  });

  it('exact_normalized_name has fixed confidence of 0.85', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'gpt-4o',
      servingProviderId: 'openai',
      exactNormalizedName: { canonicalModelId: 'exact:winner' },
    });
    expect(out.source).toBe('exact_normalized_name');
    expect(out.confidence).toBe(0.85);
  });

  it('heuristic_family_version is used only after exactNormalizedName absent', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'gpt-4o',
      servingProviderId: 'openai',
      heuristicFamilyVersion: { canonicalModelId: 'heur:winner', confidence: 0.75 },
    });
    expect(out.source).toBe('heuristic_family_version');
    expect(out.confidence).toBe(0.75);
  });

  it('model_equivalence_service is used last before fallback', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'gpt-4o',
      servingProviderId: 'openai',
      modelEquivalenceService: { canonicalModelId: 'eq:winner', confidence: 0.6 },
    });
    expect(out.source).toBe('model_equivalence_service');
    expect(out.confidence).toBe(0.6);
  });

  it('fallback_provider_model_id when nothing matches', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'unknown-x',
      servingProviderId: 'unknown-provider',
    });
    expect(out.source).toBe('fallback_provider_model_id');
    expect(out.confidence).toBe(FALLBACK_RESOLUTION_CONFIDENCE);
    expect(out.canonicalModelId).toBe('unknown-provider:unknown-x');
  });

  it('clamps confidence to [0, 1]', () => {
    const high = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'z', confidence: 99 },
    });
    expect(high.confidence).toBe(1);

    const low = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'z', confidence: -5 },
    });
    expect(low.confidence).toBe(0);
  });
});

describe('canAutoMerge — gate at 0.7', () => {
  it('returns true when confidence >= 0.7', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'z', confidence: 0.7 },
    });
    expect(canAutoMerge(out)).toBe(true);
  });

  it('returns false when confidence < 0.7', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'z', confidence: 0.69 },
    });
    expect(canAutoMerge(out)).toBe(false);
  });

  it('fallback NEVER auto-merges', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
    });
    expect(canAutoMerge(out)).toBe(false);
  });

  it('low-confidence equivalence service NEVER auto-merges', () => {
    const out = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      modelEquivalenceService: { canonicalModelId: 'z', confidence: 0.6 },
    });
    expect(canAutoMerge(out)).toBe(false);
  });

  it('threshold constant equals 0.7', () => {
    expect(MIN_CONFIDENCE_FOR_AUTO_MERGE).toBe(0.7);
  });
});

describe('pickHigherAuthority — deterministic conflict resolution', () => {
  it('higher source authority wins over lower', () => {
    const declared = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      declaredAlias: { canonicalModelId: 'declared' },
    });
    const heuristic = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'heur', confidence: 0.9 },
    });
    expect(pickHigherAuthority(declared, heuristic).source).toBe('declared_alias');
    expect(pickHigherAuthority(heuristic, declared).source).toBe('declared_alias');
  });

  it('equal authority → higher confidence wins', () => {
    const a = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'a', confidence: 0.8 },
    });
    const b = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'b', confidence: 0.6 },
    });
    expect(pickHigherAuthority(a, b).canonicalModelId).toBe('a');
  });

  it('equal authority + confidence → LEFT wins (deterministic)', () => {
    const a = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'a', confidence: 0.8 },
    });
    const b = resolveCanonicalConfidence({
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'b', confidence: 0.8 },
    });
    expect(pickHigherAuthority(a, b).canonicalModelId).toBe('a');
    expect(pickHigherAuthority(b, a).canonicalModelId).toBe('b');
  });

  it('source authority table is monotonic and unique per source', () => {
    const values = Object.values(CANONICAL_SOURCE_AUTHORITY);
    const set = new Set(values);
    expect(set.size).toBe(values.length); // unique
    // manual_override has the highest value.
    expect(CANONICAL_SOURCE_AUTHORITY.manual_override).toBeGreaterThan(
      CANONICAL_SOURCE_AUTHORITY.declared_alias,
    );
    expect(CANONICAL_SOURCE_AUTHORITY.declared_alias).toBeGreaterThan(
      CANONICAL_SOURCE_AUTHORITY.heuristic_family_version,
    );
    expect(CANONICAL_SOURCE_AUTHORITY.fallback_provider_model_id).toBe(0);
  });
});

describe('resolver purity', () => {
  it('does NOT mutate input', () => {
    const input = {
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'z', confidence: 0.8 },
    };
    const copy = JSON.parse(JSON.stringify(input));
    resolveCanonicalConfidence(input);
    expect(input).toEqual(copy);
  });

  it('produces identical output on repeated calls (deterministic)', () => {
    const input = {
      providerModelId: 'x',
      servingProviderId: 'y',
      heuristicFamilyVersion: { canonicalModelId: 'z', confidence: 0.8 },
    };
    const out1 = resolveCanonicalConfidence(input);
    const out2 = resolveCanonicalConfidence(input);
    expect(out1).toEqual(out2);
  });
});
