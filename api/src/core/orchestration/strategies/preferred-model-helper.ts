// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Preferred Model Helper — canonical pattern for honoring user-specified
 * models inside multi-model strategies.
 *
 * Caminho-C Q2 closure scaled out (2026-04-29)
 * ────────────────────────────────────────────
 * The Q2 fix in HybridStrategy (commit 689c198) showed how a strategy
 * should honor `context.preferredModelIds[0]` when picking executors:
 *
 *   1. If the user pinned a model AND it's in the operational pool,
 *      include it as the FIRST executor.
 *   2. If the user pinned a model but it's NOT in the pool (filtered
 *      for health/balance/capability gates, typo, namespace mismatch,
 *      already-picked-as-analyzer, etc.), log a warn and fall through
 *      to legacy quality-sort selection so the user still gets an
 *      answer instead of a 404.
 *   3. If the user didn't pin anything, walk the legacy quality-sort
 *      path. Zero behavior change for unpinned requests.
 *
 * This helper extracts that logic so every multi-model strategy can
 * apply it consistently. Strategies that already read `request.model`
 * directly (SingleModelStrategy and the four currently in the
 * `getUserSpecifiedModelFlag` allowlist) honor the user pin via a
 * different path and are exempt from this helper — but the wiring
 * test `preferred-model-honor-coverage.test.ts` enforces that any
 * strategy NOT in either allowlist either uses this helper OR has an
 * explicit reason recorded in the test's PENDING list.
 *
 * Why a helper instead of a BaseStrategy method
 * ─────────────────────────────────────────────
 * BaseStrategy is already large (~2k lines) and most strategies don't
 * need this logic at all (single-model, sequential, single-pass). A
 * pure function with no `this` binding is trivially testable, and
 * strategies opt in by importing — keeps the contract surface narrow.
 *
 * Failure modes the helper protects against
 * ─────────────────────────────────────────
 *   - Pinned model collides with another pick (e.g. analyzer in
 *     HybridStrategy). The `excludeIds` parameter handles this.
 *   - Pinned model is filtered upstream for health/balance. The fall-
 *     through path proceeds with `pinnedExecutor: undefined` so the
 *     strategy never crashes; the warn log surfaces the substitution.
 *   - Strategy needs ≥2 executors but only the pinned one is left.
 *     The fallback pool is returned alongside so callers can fill the
 *     remaining slots from quality-sorted candidates.
 */

import type { Model, OrchestrationContext } from '@/types';

/**
 * Resolution result. The strategy uses these fields to assemble its
 * final executor list.
 *
 *   - `pinnedExecutor`: the user's preferred model if it survived all
 *      filters AND wasn't in `excludeIds`. `undefined` means the legacy
 *      path applies.
 *   - `fallbackPool`: the operational pool minus `excludeIds` AND minus
 *      the pinned executor (so callers can `.slice(0, N - 1)` and
 *      concatenate without duplicates).
 *   - `pinReason`: reason the pin was honored or skipped. Useful for
 *      strategy-level audit logs and the observer SSE feed.
 *   - `requestedId`: the raw `context.preferredModelIds[0]` value, even
 *      if the pin was skipped. Lets the caller log the requested id in
 *      its own warn message without re-reading the context.
 */
export interface PreferredModelResolution {
  readonly pinnedExecutor: Model | undefined;
  readonly fallbackPool: readonly Model[];
  readonly pinReason:
    | 'no-preference'           // context.preferredModelIds was empty
    | 'pinned'                  // pin honored, pinnedExecutor is the user's model
    | 'pin-collision-excluded'  // pin matched but was in excludeIds (e.g. is the analyzer)
    | 'pin-not-in-pool';        // pin specified but not found in models — fall through
  readonly requestedId: string | undefined;
}

/**
 * Canonical resolver. Pure function — no logging side effects so the
 * caller can decide log severity (warn vs info) and include strategy-
 * specific context in the log payload.
 *
 * @param models       Operational pool from `context.models` after all
 *                     upstream filters (health, balance, capability).
 * @param context      OrchestrationContext for `preferredModelIds[0]`.
 * @param excludeIds   Model ids the caller has already picked (e.g.
 *                     HybridStrategy's analyzer). The pin is treated as
 *                     "collision" if it's in this set; the fallback
 *                     pool excludes them too.
 *
 * @returns A `PreferredModelResolution`. Strategies typically:
 *   ```ts
 *   const { pinnedExecutor, fallbackPool, pinReason, requestedId } =
 *     resolvePreferredExecutor(context.models, context, [analyzer.id]);
 *   if (pinReason === 'pin-not-in-pool' || pinReason === 'pin-collision-excluded') {
 *     this.log.warn({ requestId, requestedId, pinReason }, '...');
 *   }
 *   const executors = pinnedExecutor
 *     ? [pinnedExecutor, ...sortByQuality(fallbackPool).slice(0, N - 1)]
 *     : sortByQuality(fallbackPool).slice(0, N);
 *   ```
 */
export function resolvePreferredExecutor(
  models: readonly Model[],
  context: OrchestrationContext,
  excludeIds: readonly string[] = [],
): PreferredModelResolution {
  const requestedId = context.preferredModelIds?.[0];
  const excludeSet = new Set(excludeIds);

  // Empty pool — degenerate case, but we still return a coherent shape.
  // Strategies handle empty `fallbackPool` separately; surfacing
  // `no-preference` here keeps the reason stable across pool states.
  if (!requestedId) {
    return {
      pinnedExecutor: undefined,
      fallbackPool: models.filter((m) => !excludeSet.has(m.id)),
      pinReason: 'no-preference',
      requestedId: undefined,
    };
  }

  // Look for the pinned model in the operational pool.
  const pinnedCandidate = models.find((m) => m.id === requestedId);

  if (!pinnedCandidate) {
    // The user pinned a model but it isn't in the operational pool —
    // could be: filtered for health/balance/capability gates, typo,
    // wrong namespace. Caller should warn and fall through.
    return {
      pinnedExecutor: undefined,
      fallbackPool: models.filter((m) => !excludeSet.has(m.id)),
      pinReason: 'pin-not-in-pool',
      requestedId,
    };
  }

  if (excludeSet.has(pinnedCandidate.id)) {
    // The pinned model collides with an already-picked role (e.g. the
    // HybridStrategy analyzer). The user's intent is preserved at the
    // analyzer slot, but the strategy may want to know this didn't
    // apply at the executor slot — caller decides whether to log.
    return {
      pinnedExecutor: undefined,
      fallbackPool: models.filter((m) => !excludeSet.has(m.id)),
      pinReason: 'pin-collision-excluded',
      requestedId,
    };
  }

  // Happy path: pin honored, fallback pool excludes both the pinned
  // model and the caller's exclusions.
  return {
    pinnedExecutor: pinnedCandidate,
    fallbackPool: models.filter(
      (m) => !excludeSet.has(m.id) && m.id !== pinnedCandidate.id,
    ),
    pinReason: 'pinned',
    requestedId,
  };
}

/**
 * Convenience: assemble a final executor list of size `count` from a
 * resolution result, sorting fallback candidates by a comparator.
 *
 * The pinned executor is always at index 0 if present. If the strategy
 * needs more than `fallbackPool.length + (pinnedExecutor ? 1 : 0)`
 * executors, the result has fewer than `count` entries — caller's
 * problem (typically: degrade gracefully).
 *
 * Example:
 *   ```ts
 *   const executors = assembleExecutors(resolution, 2,
 *     (a, b) => b.performance.quality - a.performance.quality);
 *   ```
 */
export function assembleExecutors(
  resolution: PreferredModelResolution,
  count: number,
  comparator: (a: Model, b: Model) => number,
): Model[] {
  if (count <= 0) return [];

  const sortedFallback = [...resolution.fallbackPool].sort(comparator);

  if (resolution.pinnedExecutor) {
    return [resolution.pinnedExecutor, ...sortedFallback.slice(0, count - 1)];
  }

  return sortedFallback.slice(0, count);
}

/**
 * Apply pin honor to an arbitrary Model[] selection result.
 *
 * Strategies with custom selection logic — provider-diversity round-robin
 * (Consensus), capability-filter (ParallelRace), role-based picking
 * (ExpertPanel coordinator/expert split), participant wrappers (Debate) —
 * cannot use `assembleExecutors` because their selection function isn't a
 * simple comparator. The migration pattern for those is:
 *
 *   ```ts
 *   const preference = resolvePreferredExecutor(models, context, []);
 *   const customSelection = strategySpecificSelection(
 *     preference.fallbackPool,
 *     preference.pinnedExecutor ? count - 1 : count,
 *   );
 *   const finalSelection = withPreferredFirst(preference, customSelection);
 *   ```
 *
 * Semantics:
 *   - If `pinnedExecutor` is undefined, the input is returned as-is.
 *   - If the pinned executor is already in the input (custom logic
 *     happened to include it), it is moved to index 0 and de-duplicated.
 *   - If the pinned executor is NOT in the input, it is prepended at
 *     index 0 — making the final length one greater than the custom
 *     selection's length. Callers that need exactly `count` items should
 *     pass `count - 1` to their custom selection when `pinnedExecutor` is
 *     present (see example above).
 *
 * The function is generic over `T extends Model` so strategies that
 * augment Model with extra fields (e.g. DebateParticipant wrappers,
 * ExpertPanel role tags) can call it before wrapping. The generic
 * preserves the input type — the pinned executor is cast to `T` on the
 * assumption that the caller passed a homogeneous selection of the same
 * augmented type. (Only valid because `pinnedExecutor` came from the
 * same `models: readonly Model[]` pool; callers must not mix pre/post-
 * wrap items in the same selection.)
 */
export function withPreferredFirst<T extends Model>(
  resolution: PreferredModelResolution,
  selection: readonly T[],
): T[] {
  if (!resolution.pinnedExecutor) return [...selection];
  const pinId = resolution.pinnedExecutor.id;
  const filtered = selection.filter((m) => m.id !== pinId);
  return [resolution.pinnedExecutor as T, ...filtered];
}
