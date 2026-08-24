// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Behavioral contract — dead-candidate skip at strategy selection time.
 *
 * Incident (2026-08-21, probe vWE9qwU3_0J_cPk_W7eJw): quality-multipass
 * (alias `ailin-best`) re-selected `openrouter/qwen3-next-80b:free`
 * (circuit OPEN) as the primary of EVERY pass → empty_response_after_fallback.
 * Collective strategies selected purely by static catalog fields; runtime
 * operability was only consulted AFTER selection (resilience layer, ~60-100ms
 * per wasted attempt).
 *
 * The fix gates the SHARED eligible pool (base-strategy.getEligibleModels)
 * through skipDeadCandidates(). These tests lock the gate's semantics:
 *   - proven-bad operability (no_credits / auth_failed) ⇒ dead
 *   - circuit OPEN ⇒ dead
 *   - unknown / healthy ⇒ live
 *   - NEVER-EMPTY: all-dead pools are returned unchanged
 */

import { describe, it, expect } from 'vitest';
import {
  isDeadCandidateProvider,
  skipDeadCandidates,
  runtimeHealthRank,
  rankByRuntimeHealth,
} from '../dead-candidate-skip';
import { getProviderOperabilityHub } from '@/core/provider-operability-hub';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';

const hub = getProviderOperabilityHub();
const future = (): number => Date.now() + 60_000;

interface FakeModel {
  id: string;
  provider?: string;
}

describe('isDeadCandidateProvider', () => {
  it('a provider with a fresh runtime no_credits (single 402) is dead', () => {
    hub.setPersistedOverlayForTesting('deadskip-nocr', 'no_credits', 'runtime_credit_error', future());
    expect(isDeadCandidateProvider('deadskip-nocr', 'some/model')).toBe(true);
    // case-insensitive provider
    expect(isDeadCandidateProvider('DeadSkip-NoCr', 'some/model')).toBe(true);
  });

  it('a provider with auth_failed is dead', () => {
    hub.setPersistedOverlayForTesting('deadskip-auth', 'auth_failed', 'runtime_auth_error', future());
    expect(isDeadCandidateProvider('deadskip-auth', 'some/model')).toBe(true);
  });

  it('a provider with an OPEN circuit is dead', async () => {
    const circuit = 'deadskip-open-api';
    distributedCircuitBreakerManager.getBreaker(circuit);
    await distributedCircuitBreakerManager.openCircuit(circuit);
    try {
      expect(isDeadCandidateProvider('deadskip-open', 'some/model')).toBe(true);
    } finally {
      await distributedCircuitBreakerManager.closeCircuit(circuit);
    }
  });

  it('unknown / healthy providers and empty provider strings are live', () => {
    expect(isDeadCandidateProvider('deadskip-never-seen', 'some/model')).toBe(false);
    hub.setPersistedOverlayForTesting('deadskip-ok', 'healthy', 'operational', future());
    expect(isDeadCandidateProvider('deadskip-ok', 'some/model')).toBe(false);
    expect(isDeadCandidateProvider('', 'some/model')).toBe(false);
    expect(isDeadCandidateProvider(undefined, 'some/model')).toBe(false);
  });

  it('a route marked dead (model-not-found / model-not-supported) is dead, provider stays live', () => {
    // Live evidence (2026-08-21, inworld): HTTP 400 "model ... currently not
    // supported" classified UNKNOWN before the classifier fix, so the route
    // was re-picked on every pass. recordRouteExecution(404) is the canonical
    // path that flips a provider:family route to 'dead'.
    hub.recordRouteExecution('deadskip-route', 'anthropic/claude-3-5-sonnet', false, 404, 'model not found');
    expect(isDeadCandidateProvider('deadskip-route', 'anthropic/claude-3-5-sonnet')).toBe(true);
    // A DIFFERENT model on the same provider must stay live (route-level scope)
    expect(isDeadCandidateProvider('deadskip-route', 'other/model')).toBe(false);
  });
});

describe('skipDeadCandidates (the eligible-pool gate)', () => {
  const live: FakeModel = { id: 'live/model', provider: 'deadskip-live' };
  const deadNoCredits: FakeModel = {
    id: 'deadnc/model',
    provider: 'deadskip-pool-nc',
  };
  const deadAuth: FakeModel = { id: 'deadauth/model', provider: 'deadskip-pool-auth' };

  it('drops dead providers and keeps live ones (collective primary can no longer be circuit-OPEN)', () => {
    hub.setPersistedOverlayForTesting('deadskip-pool-nc', 'no_credits', 'runtime_credit_error', future());
    hub.setPersistedOverlayForTesting('deadskip-pool-auth', 'auth_failed', 'runtime_auth_error', future());
    const out = skipDeadCandidates([deadNoCredits, live, deadAuth]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('live/model');
  });

  it('NEVER-EMPTY: an all-dead pool is returned unchanged (degrade to least-bad, never instant failure)', () => {
    hub.setPersistedOverlayForTesting('deadskip-pool-nc', 'no_credits', 'runtime_credit_error', future());
    hub.setPersistedOverlayForTesting('deadskip-pool-auth', 'auth_failed', 'runtime_auth_error', future());
    const out = skipDeadCandidates([deadNoCredits, deadAuth]);
    expect(out).toHaveLength(2);
  });

  it('empty input passes through', () => {
    expect(skipDeadCandidates([])).toEqual([]);
  });
});

describe('runtime-health ranking (pool recovery)', () => {
  it('healthy routes rank before unknown, unknown before proven-bad', () => {
    
    hub.setPersistedOverlayForTesting('rank-healthy', 'healthy', 'operational', future());
    hub.setPersistedOverlayForTesting('rank-dead', 'no_credits', 'runtime_credit_error', future());
    const h = runtimeHealthRank('rank-healthy', 'm');
    const u = runtimeHealthRank('rank-never-seen', 'm');
    const d = runtimeHealthRank('rank-dead', 'm');
    expect(h).toBeLessThan(u);
    expect(u).toBeLessThan(d);
  });

  it('rankByRuntimeHealth: healthy first, dead last, stable within rank', () => {
    
    hub.setPersistedOverlayForTesting('rank-a', 'healthy', 'operational', future());
    hub.setPersistedOverlayForTesting('rank-z', 'auth_failed', 'runtime_auth_error', future());
    const pool = [
      { id: 'dead-one', provider: 'rank-z' },
      { id: 'unknown-one', provider: 'rank-never-seen' },
      { id: 'dead-two', provider: 'rank-z' },
      { id: 'healthy-one', provider: 'rank-a' },
    ];
    const ranked = rankByRuntimeHealth(pool);
    expect(ranked[0].id).toBe('healthy-one');
    expect(ranked[1].id).toBe('unknown-one');
    expect(ranked.slice(2).map((m) => m.id)).toEqual(['dead-one', 'dead-two']);
    // never-empty preserved: ranking never drops entries
    expect(ranked).toHaveLength(4);
  });

  it('rankByRuntimeHealth with preferFunctionCalling: declared-FC leads', () => {
    
    const pool = [
      { id: 'no-fc', provider: 'rank-never-seen', capabilities: ['chat'] },
      { id: 'has-fc', provider: 'rank-never-seen', capabilities: ['chat', 'function_calling'] },
    ];
    const ranked = rankByRuntimeHealth(pool, true);
    expect(ranked[0].id).toBe('has-fc');
  });
});
