// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-retriever.ts — pure structural candidate retrieval.
 *
 * MVP 5A invariants:
 *   - Pure function. No I/O. No DB. No provider. No TEI. No HNSW.
 *   - Operates on injected `RuntimeModelRegistry` only.
 *   - Filters apply BEFORE scoring (cheap structural drops first).
 *   - ModelScorer (from MVP 4) computes final scores on survivors.
 *   - Output is deterministically ordered via `sortCandidates`.
 *   - DOES NOT mutate the registry. DOES NOT mutate inputs.
 *   - Explicit pin invariant: when set, only the matching candidate
 *     is considered; substitution is NEVER performed at this layer.
 *
 * MVP 5A NON-SCOPE (intentionally absent):
 *   - No semantic embedding. No TEI call.
 *   - No HNSW / ANN index lookup.
 *   - No TaskProfiler heuristics — the request carries categorical
 *     hints already.
 */

import type { CanonicalModel } from '../registry/canonical-model';
import type { ModelProviderOffering } from '../registry/model-offering';
import type { ProviderModelRoute } from '../registry/model-route';
import type { RuntimeModelRegistry } from '../registry/runtime-model-registry';
import {
  scoreModelCandidate,
  type ModelScoreResult,
  type ModelScoringCandidate,
  type ModelScoringContext,
} from '../scoring/model-scorer';
import {
  filterByCapability,
  filterByContextWindow,
  filterByExplicitPin,
  filterByLifecycle,
  filterByPrivacy,
  filterByReadiness,
  type FilterCandidate,
  type FilterVerdict,
} from './candidate-filters';
import { sortCandidates } from './candidate-sorter';
import {
  RETRIEVAL_STAGES,
  type CandidateRejection,
  type CandidateRetrievalRequest,
  type CandidateRetrievalResult,
} from './candidate-retrieval-types';

// ─── Retriever ──────────────────────────────────────────────────────────

export interface CandidateRetrieverDeps {
  readonly registry: RuntimeModelRegistry;
}

/**
 * Builds the candidate list, applies deterministic filters, scores the
 * survivors with `ModelScorer`, sorts deterministically, and returns
 * up to `maxCandidates` results.
 */
export function retrieveCandidates(
  request: CandidateRetrievalRequest,
  deps: CandidateRetrieverDeps,
): CandidateRetrievalResult {
  const allRoutes = collectAllRoutes(deps.registry);
  const rejectedByStage: CandidateRejection[] = [];
  const countsByStage: Record<string, number> = {
    [RETRIEVAL_STAGES.INITIAL]: allRoutes.length,
  };

  // ─── Stage 1: filters ────────────────────────────────────────────────
  const candidates: FilterCandidate[] = [];
  for (const route of allRoutes) {
    const candidate = buildFilterCandidate(deps.registry, route);
    if (!candidate) {
      rejectedByStage.push({
        routeId: route.routeId,
        stage: RETRIEVAL_STAGES.INITIAL,
        reason: 'incomplete_registry_record',
      });
      continue;
    }
    const verdict = applyFilters(candidate, request);
    if (!verdict.pass) {
      rejectedByStage.push({
        routeId: route.routeId,
        stage: verdict.stage,
        reason: verdict.reason,
      });
      continue;
    }
    candidates.push(candidate);
  }
  countsByStage[RETRIEVAL_STAGES.AFTER_FILTERS] = candidates.length;

  // ─── Stage 2: scoring ────────────────────────────────────────────────
  const scoringContext: ModelScoringContext = {
    requiredCapabilities: request.requiredCapabilities,
    minContextWindow: request.minContextWindow,
    costSensitivity: request.costSensitivity,
    latencySensitivity: request.latencySensitivity,
    privacyMode: request.privacyMode,
    explicitModelPin: request.explicitModelPin ?? null,
    policy: request.scoringPolicy,
  };

  const scored: ModelScoreResult[] = [];
  for (const c of candidates) {
    const scoringCandidate: ModelScoringCandidate = {
      canonicalModel: c.canonical,
      offering: c.offering,
      route: c.route,
    };
    const result = scoreModelCandidate(scoringCandidate, scoringContext);
    if (result.rejected) {
      const reason = result.rejectionReasons.join(',') || 'scorer_rejection';
      rejectedByStage.push({
        routeId: result.routeId,
        stage: RETRIEVAL_STAGES.SCORER,
        reason,
      });
      continue;
    }
    scored.push(result);
  }
  countsByStage[RETRIEVAL_STAGES.AFTER_SCORE] = scored.length;

  // ─── Stage 3: sort + slice ───────────────────────────────────────────
  const sorted = sortCandidates(scored);
  const max =
    typeof request.maxCandidates === 'number' && request.maxCandidates >= 0
      ? request.maxCandidates
      : sorted.length;
  const sliced = sorted.slice(0, max);
  countsByStage[RETRIEVAL_STAGES.RETURNED] = sliced.length;

  return {
    candidates: sliced,
    rejectedByStage: Object.freeze(rejectedByStage),
    countsByStage: Object.freeze(countsByStage),
  };
}

// ─── Internals ──────────────────────────────────────────────────────────

/**
 * Filters are applied in priority order. Each returns a verdict; the
 * first non-passing verdict short-circuits.
 */
function applyFilters(
  c: FilterCandidate,
  req: CandidateRetrievalRequest,
): FilterVerdict {
  const pin = filterByExplicitPin(c, req.explicitModelPin);
  if (!pin.pass) return pin;

  const privacy = filterByPrivacy(c, req.privacyMode);
  if (!privacy.pass) return privacy;

  const lifecycle = filterByLifecycle(c, {
    allowPreview: req.scoringPolicy?.freshness.allowPreview,
    allowDeprecated: req.scoringPolicy?.freshness.allowDeprecated,
  });
  if (!lifecycle.pass) return lifecycle;

  const capability = filterByCapability(c, req.requiredCapabilities);
  if (!capability.pass) return capability;

  const ctx = filterByContextWindow(c, req.minContextWindow);
  if (!ctx.pass) return ctx;

  const readiness = filterByReadiness(c);
  if (!readiness.pass) return readiness;

  return { pass: true, stage: '', reason: '' };
}

/**
 * Walks the registry's legacy snapshots to enumerate every route. This
 * mirrors the dry-run handler's iterator from MVP 3 and avoids modifying
 * the MVP 1 registry to add a public `allRoutes()` API.
 */
function collectAllRoutes(
  registry: RuntimeModelRegistry,
): ReadonlyArray<ProviderModelRoute> {
  const out: ProviderModelRoute[] = [];
  const seen = new Set<string>();
  for (const snap of registry.getModelSnapshots()) {
    if (!snap.id || !snap.providerId) continue;
    const canonicalId = `${snap.providerId}:${snap.id}`;
    if (seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    for (const route of registry.routesForCanonical(canonicalId)) {
      out.push(route);
    }
  }
  return out;
}

/**
 * Builds a `FilterCandidate` by joining the route to its canonical +
 * offering via lookup. Returns `null` when the registry is missing one
 * of the joined records (defensive — never throws).
 */
function buildFilterCandidate(
  registry: RuntimeModelRegistry,
  route: ProviderModelRoute,
): FilterCandidate | null {
  const canonical: CanonicalModel | undefined = registry.lookupCanonicalModel(
    route.canonicalModelId,
  );
  const offering: ModelProviderOffering | undefined = registry.lookupOffering(
    route.offeringId,
  );
  if (!canonical || !offering) return null;
  return { canonical, offering, route };
}
