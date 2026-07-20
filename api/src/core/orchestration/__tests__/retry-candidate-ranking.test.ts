// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pins the cross-provider retry sort contract:
 *   1. tier (native_api → cloud_hub → router → aggregator) is primary
 *   2. bandit-sampled score (descending) is the within-tier tiebreaker
 *   3. sourcePriority (ascending) is the final fallback
 *
 * Why these tests exist: the bandit's `selectProvider()` is unit-tested on its
 * own. What's specific to *this* file is how we compose the bandit's ranking
 * with the structural source-type preference — the comparator. If a future
 * change accidentally lets the bandit override tier ordering (regression: the
 * bandit's score for an aggregator beats a native arm's), the test below will
 * catch it.
 */
import { describe, it, expect } from 'vitest';
import {
  rankRetryCandidates,
  computeOperabilityRanks,
  SOURCE_TYPE_ORDER,
  UNKNOWN_TIER_RANK,
  DEFAULT_SOURCE_PRIORITY,
  type RankableCandidate,
} from '../retry-candidate-ranking';

function entry(provider: string, sourceType: string, sourcePriority?: number): RankableCandidate {
  return {
    provider,
    metadata: { sourceType, ...(sourcePriority !== undefined ? { sourcePriority } : {}) },
  };
}

describe('rankRetryCandidates', () => {
  it('orders by source-type tier first, regardless of bandit score', () => {
    // Aggregator has the highest bandit score, but native_api still wins by tier.
    const candidates: RankableCandidate[] = [
      entry('aggA', 'aggregator'),
      entry('routerA', 'router'),
      entry('cloudA', 'cloud_hub'),
      entry('nativeA', 'native_api'),
    ];
    const banditScores = new Map<string, number>([
      ['aggA', 0.99],
      ['routerA', 0.5],
      ['cloudA', 0.3],
      ['nativeA', 0.01],
    ]);

    const sorted = rankRetryCandidates(candidates, banditScores);
    expect(sorted.map((c) => c.provider)).toEqual([
      'nativeA',
      'cloudA',
      'routerA',
      'aggA',
    ]);
  });

  it('uses bandit-sampled score (desc) as tiebreaker WITHIN the same tier', () => {
    const candidates: RankableCandidate[] = [
      entry('nativeLow', 'native_api'),
      entry('nativeHigh', 'native_api'),
      entry('nativeMid', 'native_api'),
    ];
    const banditScores = new Map<string, number>([
      ['nativelow', 0.1],
      ['nativehigh', 0.9],
      ['nativemid', 0.5],
    ]);

    const sorted = rankRetryCandidates(candidates, banditScores);
    expect(sorted.map((c) => c.provider)).toEqual([
      'nativeHigh',
      'nativeMid',
      'nativeLow',
    ]);
  });

  it('falls back to sourcePriority when bandit scores are equal (cold arms)', () => {
    // Cold arms simulated as equal scores. sourcePriority decides — lower wins.
    // Values must stay in [1,10] (ModelMetadataSchema's range), otherwise
    // safeMetadata strips the row and the tier read also fails.
    const candidates: RankableCandidate[] = [
      entry('p2', 'native_api', 5),
      entry('p1', 'native_api', 2),
      entry('p3', 'native_api', 9),
    ];
    const banditScores = new Map<string, number>([
      ['p1', 0.5],
      ['p2', 0.5],
      ['p3', 0.5],
    ]);

    const sorted = rankRetryCandidates(candidates, banditScores);
    expect(sorted.map((c) => c.provider)).toEqual(['p1', 'p2', 'p3']);
  });

  it('tier order matches the documented (native_api → cloud_hub → router → aggregator) constants', () => {
    // Self-check: a regression in the constant table (e.g., swapping cloud_hub
    // and router) would silently change retry priority. Pin the values.
    expect(SOURCE_TYPE_ORDER.native_api).toBeLessThan(SOURCE_TYPE_ORDER.cloud_hub);
    expect(SOURCE_TYPE_ORDER.cloud_hub).toBeLessThan(SOURCE_TYPE_ORDER.router);
    expect(SOURCE_TYPE_ORDER.router).toBeLessThan(SOURCE_TYPE_ORDER.aggregator);
    expect(UNKNOWN_TIER_RANK).toBeGreaterThan(SOURCE_TYPE_ORDER.aggregator);
  });

  it('places unknown sourceTypes after every documented tier', () => {
    const candidates: RankableCandidate[] = [
      entry('weird', 'made_up_tier'),
      entry('agg', 'aggregator'),
      entry('native', 'native_api'),
    ];
    const banditScores = new Map<string, number>([
      ['weird', 0.99], // even an extremely high score doesn't rescue an unknown tier
      ['agg', 0.01],
      ['native', 0.01],
    ]);

    const sorted = rankRetryCandidates(candidates, banditScores);
    expect(sorted.map((c) => c.provider)).toEqual(['native', 'agg', 'weird']);
  });

  it('treats missing bandit score as 0 (deprioritized within tier)', () => {
    const candidates: RankableCandidate[] = [
      entry('hasScore', 'native_api'),
      entry('noScore', 'native_api'),
    ];
    // noScore is absent from the map — defaults to 0.
    const banditScores = new Map<string, number>([['hasscore', 0.4]]);

    const sorted = rankRetryCandidates(candidates, banditScores);
    expect(sorted.map((c) => c.provider)).toEqual(['hasScore', 'noScore']);
  });

  it('treats missing sourcePriority as DEFAULT_SOURCE_PRIORITY', () => {
    // ModelMetadataSchema constrains sourcePriority to [1,10]. The DEFAULT
    // (99) is intentionally out-of-band so a schema-clean entry's explicit
    // priority always wins against the missing-field fallback. We use a
    // schema-valid value (5) for the explicit entry; the implicit one
    // omits the field entirely → comparator reads `undefined` → applies
    // DEFAULT_SOURCE_PRIORITY (99).
    expect(DEFAULT_SOURCE_PRIORITY).toBeGreaterThan(10);
    const candidates: RankableCandidate[] = [
      entry('explicit', 'native_api', 5),
      entry('implicit', 'native_api'),
    ];
    const banditScores = new Map<string, number>([
      ['explicit', 0.5],
      ['implicit', 0.5],
    ]);

    const sorted = rankRetryCandidates(candidates, banditScores);
    expect(sorted.map((c) => c.provider)).toEqual(['explicit', 'implicit']);
  });

  it('handles null/empty provider strings safely', () => {
    const candidates: RankableCandidate[] = [
      { provider: null, metadata: { sourceType: 'native_api' } },
      { provider: '', metadata: { sourceType: 'aggregator' } },
      entry('real', 'native_api'),
    ];
    const banditScores = new Map<string, number>([['real', 0.7]]);

    const sorted = rankRetryCandidates(candidates, banditScores);
    // 'real' (native, score 0.7) > null-provider (native, score 0) > '' (aggregator)
    expect(sorted.map((c) => c.provider)).toEqual(['real', null, '']);
  });

  it('lowercases provider before bandit-score lookup', () => {
    const candidates: RankableCandidate[] = [
      entry('OpenAI', 'native_api'),
      entry('Anthropic', 'native_api'),
    ];
    // The orchestration code lowercases keys when building the score map.
    // The comparator must lowercase on lookup to match.
    const banditScores = new Map<string, number>([
      ['anthropic', 0.9],
      ['openai', 0.1],
    ]);

    const sorted = rankRetryCandidates(candidates, banditScores);
    expect(sorted.map((c) => c.provider)).toEqual(['Anthropic', 'OpenAI']);
  });
});

describe('rankRetryCandidates — operability/hot ranking (determinism)', () => {
  it('sinks proven-bad and lifts hot, overriding tier + bandit', () => {
    const candidates: RankableCandidate[] = [
      entry('badNative', 'native_api'), // would win on tier, but proven-bad
      entry('hotAgg', 'aggregator'), // worst tier, but HOT
      entry('okHub', 'cloud_hub'), // operable
    ];
    const bandit = new Map<string, number>([['badnative', 0.99]]);
    const op = new Map<string, number>([
      ['badnative', 0], // proven-bad → sinks
      ['hotagg', 3], // hot → rises
      ['okhub', 2], // operable
    ]);
    const sorted = rankRetryCandidates(candidates, bandit, op);
    expect(sorted.map((c) => c.provider)).toEqual(['hotAgg', 'okHub', 'badNative']);
  });

  it('preserves tier ordering when no operability map is given', () => {
    const candidates: RankableCandidate[] = [entry('agg', 'aggregator'), entry('native', 'native_api')];
    const sorted = rankRetryCandidates(candidates, new Map());
    expect(sorted.map((c) => c.provider)).toEqual(['native', 'agg']);
  });
});

describe('computeOperabilityRanks', () => {
  const stateByProvider: Record<string, string> = {
    phala: 'auth_failed',
    broke: 'no_credits',
    good: 'healthy',
    warm: 'healthy',
    fresh: 'unknown',
  };
  const hub = {
    getRouteState: (p: string) => ({ operabilityState: stateByProvider[p] ?? 'unknown' }),
    isRouteHot: (p: string) => p === 'warm',
  };

  it('maps route states to ranks (bad=0, hot=3, operable=2, unknown=1)', () => {
    const cands: RankableCandidate[] = [
      { provider: 'phala' },
      { provider: 'broke' },
      { provider: 'good' },
      { provider: 'warm' },
      { provider: 'fresh' },
    ];
    const ranks = computeOperabilityRanks(cands, 'org/model', hub);
    expect(ranks.get('phala')).toBe(0);
    expect(ranks.get('broke')).toBe(0);
    expect(ranks.get('good')).toBe(2);
    expect(ranks.get('warm')).toBe(3);
    expect(ranks.get('fresh')).toBe(1);
  });
});
