// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the HCRA confidence-aware ranking added to
 * `dynamic-model-selector.calculateCapabilityConfidenceScore` (Caminho-C
 * Stage 3).
 *
 * Why a dedicated test file:
 *   - Same rationale as `capability-uri-matching.test.ts` — the production
 *     method is private inside DynamicModelSelector and exercising it
 *     end-to-end requires Prisma + provider registry + perf tracker + the
 *     ~6-service DI graph. The scoring policy itself is small and pure.
 *
 * The tests reproduce the production scoring locally rather than importing
 * the private method. Both surfaces (production + this spec) are reviewed
 * together at PR time so drift is caught.
 *
 * Three invariants this suite locks down:
 *
 *   1. **Neutral cases**: returns 1.0 when no required capabilities, and
 *      0.5 when the model has no confidence map (HCRA backfill in
 *      progress — must neither penalize nor reward unmigrated rows).
 *
 *   2. **Geometric-mean ranking**: a model with one weak capability
 *      ([1.0, 0.1]) ranks below one with balanced moderate confidence
 *      ([0.6, 0.6]) even though arithmetic means tie. This enforces the
 *      ALL-of semantic the upstream filter uses — a strong score on one
 *      cap shouldn't compensate for weakness on another.
 *
 *   3. **Defence in depth**: a missing URI in the confidence map degrades
 *      smoothly (clamped at 0.01) instead of zero-ing the score. The
 *      upstream filter normally prevents this case, but if a future
 *      refactor bypasses the filter the optimizer's weighted sum stays
 *      finite.
 */

import { describe, expect, it } from 'vitest';
import type { ModelCapability } from '@/types';
import { legacyArrayToUriArray } from '@/capability/legacy-capability-uri';

/**
 * Mirror of `calculateCapabilityConfidenceScore` from
 * dynamic-model-selector.ts. Kept in sync at PR review time.
 */
function calculateCapabilityConfidenceScore(
  confidence: Record<string, number> | undefined,
  requiredCapabilities: readonly ModelCapability[] | undefined,
): number {
  if (!requiredCapabilities || requiredCapabilities.length === 0) {
    return 1.0;
  }
  if (!confidence || Object.keys(confidence).length === 0) {
    return 0.5;
  }
  const requiredUris = legacyArrayToUriArray(requiredCapabilities);
  let logSum = 0;
  for (const uri of requiredUris) {
    const c = confidence[uri];
    const clamped = Math.max(0.01, Math.min(1, typeof c === 'number' ? c : 0.01));
    logSum += Math.log(clamped);
  }
  return Math.exp(logSum / requiredUris.length);
}

const URI = (slug: string) => `http://ailin.dev/cap/v1/${slug}`;

describe('HCRA capability-confidence ranking', () => {
  describe('Invariant 1: neutral cases', () => {
    it('returns 1.0 when there are no required capabilities', () => {
      const score = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 0.5 },
        [],
      );
      expect(score).toBe(1.0);
    });

    it('returns 1.0 when requiredCapabilities is undefined', () => {
      const score = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 0.5 },
        undefined,
      );
      expect(score).toBe(1.0);
    });

    it('returns 0.5 when the model has no confidence map (backfill in progress)', () => {
      // Critical: during the HCRA backfill window, ~half the catalog has
      // no capabilityConfidence yet. Penalizing those rows would hide
      // working providers from the selector.
      expect(calculateCapabilityConfidenceScore(undefined, ['chat'])).toBe(0.5);
      expect(calculateCapabilityConfidenceScore({}, ['chat'])).toBe(0.5);
    });

    it('returns ~1.0 when confidence is perfect across all required URIs', () => {
      const score = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 1.0, [URI('vision')]: 1.0 },
        ['chat', 'vision'],
      );
      expect(score).toBeCloseTo(1.0, 5);
    });
  });

  describe('Invariant 2: geometric-mean penalizes the weak link', () => {
    it('ranks [0.6, 0.6] above [1.0, 0.1] despite equal arithmetic means', () => {
      const balanced = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 0.6, [URI('vision')]: 0.6 },
        ['chat', 'vision'],
      );
      const skewed = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 1.0, [URI('vision')]: 0.1 },
        ['chat', 'vision'],
      );
      // Both have arithmetic mean 0.55, but geometric mean of [0.6, 0.6]
      // is 0.6 vs sqrt(1.0 * 0.1) ≈ 0.316.
      expect(balanced).toBeGreaterThan(skewed);
      expect(balanced).toBeCloseTo(0.6, 2);
      expect(skewed).toBeCloseTo(Math.sqrt(0.1), 2);
    });

    it('higher uniform confidence ranks strictly above lower uniform confidence', () => {
      const high = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 0.9, [URI('streaming')]: 0.9 },
        ['chat', 'streaming'],
      );
      const low = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 0.4, [URI('streaming')]: 0.4 },
        ['chat', 'streaming'],
      );
      expect(high).toBeGreaterThan(low);
    });

    it('a single missing URI dominates the score (geometric mean property)', () => {
      // If one of three URIs is missing (treated as 0.01), the geometric
      // mean is bounded by 0.01^(1/3) ≈ 0.215 even if the other two are
      // perfect. This is the desired behaviour: a model that doesn't
      // confidently support a required capability should rank low.
      const partial = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 1.0, [URI('vision')]: 1.0 },
        ['chat', 'vision', 'tool_use'],
      );
      expect(partial).toBeLessThan(0.3);
    });
  });

  describe('Invariant 3: defence in depth', () => {
    it('missing URI in confidence map degrades smoothly, not to zero', () => {
      const score = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 1.0 },
        ['chat', 'vision'], // vision is missing from confidence
      );
      // sqrt(1.0 * 0.01) = 0.1 — small but finite.
      expect(score).toBeCloseTo(0.1, 2);
      expect(score).toBeGreaterThan(0);
    });

    it('non-numeric confidence value is treated as missing', () => {
      const score = calculateCapabilityConfidenceScore(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { [URI('chat')]: 'high' as any, [URI('vision')]: 0.8 },
        ['chat', 'vision'],
      );
      // chat clamps to 0.01, vision is 0.8 → sqrt(0.008) ≈ 0.0894.
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(0.2);
    });

    it('out-of-range numeric values are clamped to [0.01, 1]', () => {
      const score = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 5, [URI('vision')]: -1 },
        ['chat', 'vision'],
      );
      // chat clamps to 1, vision clamps to 0.01 → sqrt(0.01) = 0.1.
      expect(score).toBeCloseTo(0.1, 2);
    });
  });

  describe('Comparative ranking — what the selector sees', () => {
    /**
     * Realistic scenario: two surviving models passed the upstream
     * URI/legacy filter (both technically support 'chat' + 'vision'),
     * but their HCRA confidence differs because one was provider-asserted
     * and behaviorally validated, the other only doc-parsed. The new
     * scoring should rank the high-confidence row first.
     */
    it('high-confidence model outranks low-confidence model with identical capabilities', () => {
      const highConfidence = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 0.95, [URI('vision')]: 0.92 },
        ['chat', 'vision'],
      );
      const lowConfidence = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 0.55, [URI('vision')]: 0.5 },
        ['chat', 'vision'],
      );
      expect(highConfidence).toBeGreaterThan(lowConfidence);
    });

    it('migrated row (with confidence) and legacy row (without) tie-break correctly', () => {
      // A row with low but real confidence (0.4 across the board) should
      // rank below a legacy row (neutral 0.5) — so during backfill we
      // prefer "no signal" over "weak negative signal". This is by
      // design: legacy rows are the proven default; HCRA is additive
      // and only useful when it surfaces strong positive evidence.
      const legacyNeutral = calculateCapabilityConfidenceScore(undefined, ['chat']);
      const lowMigrated = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 0.4 },
        ['chat'],
      );
      expect(legacyNeutral).toBeGreaterThan(lowMigrated);
    });

    it('migrated row with strong confidence outranks legacy neutral', () => {
      const legacyNeutral = calculateCapabilityConfidenceScore(undefined, ['chat']);
      const highMigrated = calculateCapabilityConfidenceScore(
        { [URI('chat')]: 0.9 },
        ['chat'],
      );
      expect(highMigrated).toBeGreaterThan(legacyNeutral);
    });
  });
});
