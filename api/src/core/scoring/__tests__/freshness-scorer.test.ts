// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * freshness-scorer.test.ts — MVP 4
 *
 * Covers the basic mapping: lifecycle + policy → status + score. The
 * readiness-gate invariant has its own dedicated test
 * (`freshness-readiness-gate.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import { isRoutable, scoreFreshness } from '../freshness-scorer';

const HEALTHY_READINESS = {
  healthState: 'healthy',
  creditStatus: 'has_credits',
  minimalChatStatus: 'verified',
};

describe('scoreFreshness — current lifecycle, healthy route', () => {
  it('returns current_and_routable with score 1.0 when generationRank absent', () => {
    const out = scoreFreshness({
      family: 'claude',
      lifecycle: 'current',
      routeReadiness: HEALTHY_READINESS,
    });
    expect(out.status).toBe('current_and_routable');
    expect(out.score).toBe(1.0);
  });

  it('score increases monotonically with generationRank', () => {
    const ranks = [1, 2, 3, 5, 10, 20, 50];
    const scores = ranks.map((r) =>
      scoreFreshness({
        family: 'claude',
        generationRank: r,
        lifecycle: 'current',
        routeReadiness: HEALTHY_READINESS,
      }).score,
    );
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });

  it('score is bounded in [0, 1]', () => {
    for (let r = 0; r <= 100; r += 7) {
      const out = scoreFreshness({
        family: 'claude',
        generationRank: r,
        lifecycle: 'current',
        routeReadiness: HEALTHY_READINESS,
      });
      expect(out.score).toBeGreaterThanOrEqual(0);
      expect(out.score).toBeLessThanOrEqual(1);
    }
  });
});

describe('scoreFreshness — lifecycle handling', () => {
  it('preview without policy → blocked, score 0', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'preview',
      routeReadiness: HEALTHY_READINESS,
    });
    expect(out.status).toBe('preview_blocked');
    expect(out.score).toBe(0);
    expect(out.reason).toContain('preview');
  });

  it('preview with allowPreview=true → preview_allowed, score 0.7', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'preview',
      routeReadiness: HEALTHY_READINESS,
      policy: { allowPreview: true },
    });
    expect(out.status).toBe('preview_allowed');
    expect(out.score).toBeCloseTo(0.7);
  });

  it('deprecated without policy → blocked, score 0', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'deprecated',
      routeReadiness: HEALTHY_READINESS,
    });
    expect(out.status).toBe('deprecated_blocked');
    expect(out.score).toBe(0);
  });

  it('legacy without policy → blocked (same as deprecated)', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'legacy',
      routeReadiness: HEALTHY_READINESS,
    });
    expect(out.status).toBe('deprecated_blocked');
    expect(out.score).toBe(0);
  });

  it('retired without policy → blocked', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'retired',
      routeReadiness: HEALTHY_READINESS,
    });
    expect(out.status).toBe('deprecated_blocked');
  });

  it('deprecated with allowDeprecated=true → stale_but_best_routable, score 0.2', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'deprecated',
      routeReadiness: HEALTHY_READINESS,
      policy: { allowDeprecated: true },
    });
    expect(out.status).toBe('stale_but_best_routable');
    expect(out.score).toBe(0.2);
  });

  it('unknown lifecycle → stale_but_best_routable, score 0.4', () => {
    const out = scoreFreshness({
      family: 'gpt',
      lifecycle: 'unknown',
      routeReadiness: HEALTHY_READINESS,
    });
    expect(out.status).toBe('stale_but_best_routable');
    expect(out.score).toBe(0.4);
  });
});

describe('isRoutable helper', () => {
  it('is true for current_and_routable, preview_allowed, stale_but_best_routable', () => {
    expect(isRoutable('current_and_routable')).toBe(true);
    expect(isRoutable('preview_allowed')).toBe(true);
    expect(isRoutable('stale_but_best_routable')).toBe(true);
  });

  it('is false for blocked statuses', () => {
    expect(isRoutable('deprecated_blocked')).toBe(false);
    expect(isRoutable('preview_blocked')).toBe(false);
    expect(isRoutable('current_but_no_credit')).toBe(false);
    expect(isRoutable('current_but_auth_failed')).toBe(false);
    expect(isRoutable('current_but_minimal_chat_failed')).toBe(false);
    expect(isRoutable('current_but_capability_mismatch')).toBe(false);
    expect(isRoutable('unknown')).toBe(false);
  });
});

describe('scoreFreshness — purity + determinism', () => {
  it('does not mutate the input', () => {
    const input = {
      family: 'claude',
      generationRank: 5,
      lifecycle: 'current' as const,
      routeReadiness: { ...HEALTHY_READINESS },
      policy: { allowPreview: false },
    };
    const copy = JSON.parse(JSON.stringify(input));
    scoreFreshness(input);
    expect(input).toEqual(copy);
  });

  it('repeated calls yield identical output', () => {
    const out1 = scoreFreshness({
      family: 'claude',
      generationRank: 5,
      lifecycle: 'current',
      routeReadiness: HEALTHY_READINESS,
    });
    const out2 = scoreFreshness({
      family: 'claude',
      generationRank: 5,
      lifecycle: 'current',
      routeReadiness: HEALTHY_READINESS,
    });
    expect(out1).toEqual(out2);
  });
});
