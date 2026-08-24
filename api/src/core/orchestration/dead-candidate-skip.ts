// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dead-candidate skip — shared selection-time operability gate.
 *
 * WHY (2026-08-21 incident, probe request vWE9qwU3_0J_cPk_W7eJw): a
 * `model: "ailin-best"` + tools request degraded to
 * `empty_response_after_fallback` because quality-multipass re-selected
 * `openrouter/qwen3-next-80b:free` (circuit OPEN) as the PRIMARY of every
 * pass — collective strategies picked candidates purely by static catalog
 * fields (balanceStatus/quality), never consulting runtime operability.
 * The streaming single-model fast path (chat-routes.ts) already had the
 * correct pattern (PROVEN_BAD_STATES + OPEN/HALF_OPEN circuits); this module
 * extracts it so the shared eligible-pool (base-strategy.getEligibleModels —
 * the selection input of EVERY strategy, collective or single) applies the
 * same skip.
 *
 * Semantics (mirrors the fast path exactly):
 *   - PROVEN_BAD operability states: auth_failed, no_credits, rate_limited,
 *     temporarily_unavailable (a SINGLE runtime 402/403 flips a provider to
 *     no_credits/auth_failed immediately and is persisted for 6h — see
 *     provider-operability-hub recordEvent write-through).
 *   - Circuits OPEN **and HALF_OPEN**: a permanently-dead provider oscillates
 *     OPEN→HALF_OPEN→OPEN forever, so an OPEN-only snapshot misses it whenever
 *     sampled in HALF_OPEN (RC-3 lesson).
 *   - Zero-I/O on the hot path: hub in-memory state + each breaker's local
 *     cache snapshot — no Redis/DB round trips.
 *   - NEVER-EMPTY: if every candidate is dead, `skipDeadCandidates` returns
 *     the input unchanged — the filter must not empty the pool by itself
 *     (callers degrade to "try the least-bad" instead of failing outright).
 */

import { getProviderOperabilityHub } from '@/core/provider-operability-hub';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';

export const PROVEN_BAD_OPERABILITY_STATES = new Set([
  'auth_failed',
  'no_credits',
  'rate_limited',
  'temporarily_unavailable',
  // Route-level 'dead' = 404/model-not-found (and 400 model-not-supported)
  // persisted by the hub per provider:family route key — a dead model route
  // must never be re-picked while the state holds (prove-before-admit).
  'dead',
]);

/**
 * True when the provider/model route is known-dead at selection time
 * (proven-bad operability state OR open/half-open circuit). Sync, zero-I/O,
 * never throws (unavailable subsystems simply don't vote).
 */
export function isDeadCandidateProvider(
  provider: string | undefined,
  modelId: string
): boolean {
  const normalized = (provider || '').toLowerCase();
  if (!normalized) return false;

  try {
    const hub = getProviderOperabilityHub();
    const state = hub.getRouteState(normalized, modelId).operabilityState;
    if (PROVEN_BAD_OPERABILITY_STATES.has(state)) return true;
  } catch {
    /* hub unavailable — don't vote */
  }

  try {
    const deadCircuits = distributedCircuitBreakerManager.getRecentCircuitNamesByState(
      'OPEN',
      'HALF_OPEN'
    );
    if (deadCircuits.has(`${normalized}-api`) || deadCircuits.has(normalized)) return true;
  } catch {
    /* breaker manager unavailable — don't vote */
  }

  return false;
}

/**
 * Filter dead candidates out of a selection pool. Never-empty semantics: if
 * ALL candidates are dead, the input is returned unchanged (the caller keeps
 * today's behavior — attempt the least-bad — instead of an instant failure).
 */
export function skipDeadCandidates<T extends { provider?: string; id: string }>(
  models: T[]
): T[] {
  if (models.length === 0) return models;
  const alive = models.filter((m) => !isDeadCandidateProvider(m.provider, m.id));
  return alive.length > 0 ? alive : models;
}

/**
 * Runtime-health rank for selection ordering (2026-08-21 pool-recovery):
 * lower is better. STATIC catalog fields (balanceStatus/quality) kept
 * electing dead providers as primaries; this rank surfaces live routes.
 * Zero-I/O, never throws. Classes:
 *   0 — healthy (recent success signal)
 *   1 — unknown (no data — better than known-bad)
 *   2 — degraded-but-recoverable (rate_limited / temporarily_unavailable)
 *   3 — proven-bad/dead/open-circuit (kept ONLY by never-empty semantics)
 */
export function runtimeHealthRank(provider: string | undefined, modelId: string): number {
  const normalized = (provider || '').toLowerCase();
  if (!normalized) return 1;

  try {
    const hub = getProviderOperabilityHub();
    const state = hub.getRouteState(normalized, modelId).operabilityState;
    if (state === 'healthy') return 0;
    if (state === 'unknown') return 1;
    if (
      state === 'rate_limited' ||
      state === 'temporarily_unavailable' ||
      state === 'degraded' ||
      state === 'recovering'
    ) {
      return 2;
    }
    return 3;
  } catch {
    return 1;
  }
}

/**
 * Stable health-aware ordering of a selection pool: healthy first, dead last.
 * Prefers declared function_calling when `preferFunctionCalling` is set
 * (tools requests) — declared capability beats probe-pending unknowns.
 * Stable: equal ranks keep their incoming relative order.
 */
export function rankByRuntimeHealth<T extends { provider?: string; id: string }>(
  models: T[],
  preferFunctionCalling = false
): T[] {
  // Precompute keys once (pools can reach tens of thousands of models after
  // the FC-pool relaxation — a naive comparator would re-rank per comparison).
  const decorated = models.map((m) => {
    const caps = (m as T & { capabilities?: readonly string[] }).capabilities;
    const fcRank =
      preferFunctionCalling && !(Array.isArray(caps) && caps.includes('function_calling'))
        ? 1
        : 0;
    return { m, fcRank, healthRank: runtimeHealthRank(m.provider, m.id) };
  });
  decorated.sort((a, b) => a.fcRank - b.fcRank || a.healthRank - b.healthRank);
  return decorated.map((d) => d.m);
}
