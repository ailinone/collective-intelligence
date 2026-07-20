// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-F — Live Chat Operability planner filter.
 *
 * Consults `LiveChatOperabilityStore` and removes candidates whose
 * route was recently observed to fail with a non-retryable error
 * (insufficient_credits, consumer_suspended, model_not_supported,
 * invalid_auth, etc.) AND whose cooldown is still active.
 *
 * The dry-run service calls this BEFORE handing pools to the planner.
 * The resulting `rejections` array is surfaced on the plan response
 * so operators can see why a known-good provider was excluded.
 */
import type { ModelCandidate } from '../orchestration/model-selection/model-role-types';
import {
  getLiveChatOperabilityStore,
  type LiveChatOperabilityStore,
  type LiveChatOperabilityState,
} from './live-chat-operability-state';
import type { ProviderErrorKind } from '../orchestration/failures/provider-error-classifier';

export interface LiveOperabilityFilterPolicy {
  readonly requireLiveChatOperability: boolean;
  readonly allowUnknownLiveOperability: boolean;
  readonly preferRecentChatSuccess: boolean;
  readonly liveChatSuccessMaxAgeMs: number;
  /** When provided, overrides the singleton store (used for tests). */
  readonly storeOverride?: LiveChatOperabilityStore;
}

export const DEFAULT_LIVE_OPERABILITY_POLICY: LiveOperabilityFilterPolicy = {
  requireLiveChatOperability: false,
  allowUnknownLiveOperability: true,
  preferRecentChatSuccess: false,
  liveChatSuccessMaxAgeMs: 24 * 60 * 60 * 1000,
};

export interface LiveOperabilityRejection {
  readonly modelId: string;
  readonly providerId: string;
  readonly routeId: string;
  readonly reason:
    | 'live_operability_blocked'
    | 'recent_non_retryable_error'
    | 'cooldown_active'
    | 'live_chat_state_unknown';
  readonly lastErrorKind?: ProviderErrorKind;
  readonly lastHttpStatus?: number;
  readonly cooldownUntil?: string;
  readonly lastChatSuccessAt?: string;
  readonly lastChatFailureAt?: string;
}

export interface FilterResult {
  readonly allowed: readonly ModelCandidate[];
  readonly rejected: readonly LiveOperabilityRejection[];
  readonly policyApplied: LiveOperabilityFilterPolicy;
}

function routeIdOf(candidate: ModelCandidate): string {
  const m = candidate.model as { routeId?: string; id: string };
  return m.routeId ?? m.id;
}

/** 01C.1B-F — route-tolerant lookup. Tries exact (provider, route,
 *  model) first, falls back to any record matching (provider, modelId)
 *  regardless of routeId, finally falls back to ANY record matching
 *  the provider when the most-recent failure was an
 *  ACCOUNT-LEVEL condition (insufficient_credits / consumer_suspended /
 *  invalid_auth). Those conditions apply to ALL models on the
 *  provider — different model IDs of the same broken account should
 *  also be blocked, even if their specific (provider, modelId) tuple
 *  was never directly probed. */
const PROVIDER_LEVEL_KINDS = new Set([
  'insufficient_credits',
  'consumer_suspended',
  'invalid_auth',
]);

function lookupLiveState(
  store: LiveChatOperabilityStore,
  providerId: string,
  routeId: string,
  modelId: string,
) {
  const exact = store.get({ providerId, routeId, modelId });
  if (exact) return exact;
  const byModel = store.getByModel(providerId, modelId);
  if (byModel.length > 0) {
    return [...byModel].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )[0];
  }
  // 01C.1B-F — provider-level escalation. When no exact / by-model
  // record exists but the provider has a recent account-level failure
  // (different model, but same broken account), return that state so
  // the planner blocks the whole provider for critical roles.
  const allStates = store.snapshot();
  const p = providerId.toLowerCase();
  const providerStates = allStates.filter((s) => s.providerId === p);
  if (providerStates.length === 0) return undefined;
  const mostRecent = [...providerStates].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )[0];
  if (
    mostRecent.lastErrorKind &&
    PROVIDER_LEVEL_KINDS.has(mostRecent.lastErrorKind)
  ) {
    return mostRecent;
  }
  return undefined;
}

/**
 * Apply the live-operability filter to a candidate pool.
 *
 * Semantics:
 *   - `requireLiveChatOperability=false` → no-op, all candidates pass
 *   - `requireLiveChatOperability=true`:
 *     - candidate has known live state AND `chatReady=true` AND cooldown not active
 *       → ALLOWED
 *     - candidate has known live state AND non-retryable error recent
 *       → REJECTED with reason `recent_non_retryable_error`
 *     - candidate has known live state AND cooldown still active
 *       → REJECTED with reason `cooldown_active`
 *     - candidate has NO live state:
 *       - `allowUnknownLiveOperability=true` → ALLOWED (with note)
 *       - `allowUnknownLiveOperability=false` → REJECTED with reason `live_chat_state_unknown`
 *
 * The function is PURE — no side effects, no DB writes. Caller is
 * responsible for surfacing the `rejected` array on the plan output.
 */
export function filterCandidatesByLiveOperability(
  candidates: readonly ModelCandidate[],
  policy: LiveOperabilityFilterPolicy = DEFAULT_LIVE_OPERABILITY_POLICY,
): FilterResult {
  if (!policy.requireLiveChatOperability) {
    return { allowed: candidates, rejected: [], policyApplied: policy };
  }
  const store = policy.storeOverride ?? getLiveChatOperabilityStore();
  const allowed: ModelCandidate[] = [];
  const rejected: LiveOperabilityRejection[] = [];
  const now = Date.now();

  for (const candidate of candidates) {
    const providerId = candidate.providerId ?? candidate.model.provider ?? '';
    const routeId = routeIdOf(candidate);
    const modelId = candidate.model.id;
    const state = lookupLiveState(store, providerId, routeId, modelId);

    if (!state) {
      if (policy.allowUnknownLiveOperability) {
        allowed.push(candidate);
      } else {
        rejected.push({
          modelId,
          providerId,
          routeId,
          reason: 'live_chat_state_unknown',
        });
      }
      continue;
    }

    // Cooldown active?
    if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now) {
      rejected.push({
        modelId,
        providerId,
        routeId,
        reason: 'cooldown_active',
        lastErrorKind: state.lastErrorKind,
        lastHttpStatus: state.lastHttpStatus,
        cooldownUntil: state.cooldownUntil,
        lastChatFailureAt: state.lastChatFailureAt,
      });
      continue;
    }

    // Non-retryable error recorded recently?
    if (state.lastErrorKind && !state.chatReady) {
      rejected.push({
        modelId,
        providerId,
        routeId,
        reason: 'recent_non_retryable_error',
        lastErrorKind: state.lastErrorKind,
        lastHttpStatus: state.lastHttpStatus,
        lastChatFailureAt: state.lastChatFailureAt,
      });
      continue;
    }

    // chatReady false but no error kind → conservative reject
    if (!state.chatReady) {
      rejected.push({
        modelId,
        providerId,
        routeId,
        reason: 'live_operability_blocked',
        lastChatFailureAt: state.lastChatFailureAt,
      });
      continue;
    }

    allowed.push(candidate);
  }

  // Optional: rank chatReady-recent ahead of chatReady-stale when policy
  // says so. Pure ranking transform, doesn't alter membership. Uses the
  // same route-tolerant lookup as the gate above so records keyed under
  // (provider, providerId, model) still match candidates whose routeId
  // defaults to modelId.
  if (policy.preferRecentChatSuccess && allowed.length > 1) {
    const successAge = (c: ModelCandidate): number => {
      const providerId = c.providerId ?? c.model.provider ?? '';
      const routeId = routeIdOf(c);
      const s = lookupLiveState(store, providerId, routeId, c.model.id);
      const ts = s?.lastChatSuccessAt ? new Date(s.lastChatSuccessAt).getTime() : 0;
      return ts === 0 ? Number.POSITIVE_INFINITY : now - ts;
    };
    const ranked = [...allowed].sort((a, b) => successAge(a) - successAge(b));
    return { allowed: ranked, rejected, policyApplied: policy };
  }

  return { allowed, rejected, policyApplied: policy };
}

/**
 * Build a summary record of all known live states — sanitized for
 * surfacing on the plan response.
 */
export function summarizeLiveOperabilitySnapshot(
  store: LiveChatOperabilityStore = getLiveChatOperabilityStore(),
): {
  readonly totalStates: number;
  readonly chatReadyCount: number;
  readonly blockedCount: number;
  readonly recentlyFailedKinds: Readonly<Record<string, number>>;
} {
  const states: readonly LiveChatOperabilityState[] = store.snapshot();
  let chatReadyCount = 0;
  let blockedCount = 0;
  const kinds: Record<string, number> = {};
  for (const s of states) {
    if (s.chatReady) chatReadyCount++;
    else blockedCount++;
    if (s.lastErrorKind) {
      kinds[s.lastErrorKind] = (kinds[s.lastErrorKind] ?? 0) + 1;
    }
  }
  return {
    totalStates: states.length,
    chatReadyCount,
    blockedCount,
    recentlyFailedKinds: kinds,
  };
}
