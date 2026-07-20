// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4A §7 — Live-ready candidate injection helper.
 *
 * Pure functions that take `LiveChatOperabilityStore` chatReady states +
 * a catalog resolver callback and produce an augmented per-role pool.
 *
 * The function is responsible for:
 *   1. Filtering store states to those that are CURRENTLY chatReady AND
 *      eligible for critical role (cooldown expired, no recent non-
 *      retryable failure).
 *   2. Resolving each eligible state to a real catalog Model via the
 *      injected `resolveCatalogCandidate(state)` callback. We REQUIRE a
 *      catalog match — never fabricate a candidate.
 *   3. Filtering by role capability compatibility (callback `candidateSupportsRole`).
 *   4. Deduplicating against the existing role pool (via a deterministic
 *      key built from `role | logicalModelId | providerId | apiModelId |
 *      routeId | adapterKind`).
 *   5. Attaching audit metadata (`injectedByLiveReadyStore: true`,
 *      `liveReadyEvidenceSource: 'live_operability_store'`) onto every
 *      injected candidate so traces + plan fingerprint can record provenance.
 *   6. Recording explicit, classified rejections so the planFingerprint +
 *      operator audit can see WHY a live-ready state didn't make it in.
 *
 * Pure: no fs, no fetch, no DB. The catalog resolver + capability check
 * are injected, so tests can drive both deterministically.
 *
 * Naming guarantee for the dedupe key: changing role, logicalModelId,
 * providerId, apiModelId, routeId, or adapterKind ALL must change the
 * dedupe key. The tests in `__tests__/live-ready-candidate-injection.test.ts`
 * pin every field individually.
 */
import type { LiveChatOperabilityState } from '../../operability/live-chat-operability-state';

// ─── Types ────────────────────────────────────────────────────────────────

export type LiveReadyInjectionRejectionReason =
  | 'live_ready_state_not_in_catalog'
  | 'ambiguous_catalog_match'
  | 'capability_mismatch'
  | 'role_mismatch'
  | 'duplicate_candidate'
  | 'missing_provider_or_model'
  | 'not_live_ready';

export interface LiveReadyInjectionRejection {
  readonly reason: LiveReadyInjectionRejectionReason;
  readonly providerId?: string;
  readonly routeId?: string;
  readonly logicalModelId?: string;
  readonly apiModelId?: string;
  readonly role?: string;
}

export interface LiveReadyCandidateInjectionPolicy {
  readonly enabled: boolean;
  readonly source: 'live_operability_store';
  readonly requireCatalogMatch: true;
  readonly allowCrossRoleByCapabilities: boolean;
  readonly dedupeStrategy: 'role_logical_provider_api_route';
  readonly maxInjectedPerRole?: number;
}

export interface LiveReadyDedupeKeyInput {
  readonly role?: string;
  readonly logicalModelId?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly apiModelId?: string;
  readonly routeId?: string;
  readonly adapterKind?: string;
}

export interface LiveReadyInjectionMetadata {
  readonly liveOperabilitySnapshotHash?: string;
  readonly liveOperabilitySnapshotPath?: string;
  readonly injectedByLiveReadyStore: true;
}

export interface LiveReadyInjectionTraceEntry {
  readonly logicalModelId?: string;
  readonly providerId?: string;
  readonly apiModelId?: string;
  readonly routeId?: string;
  readonly source: 'live_operability_store';
}

export interface LiveReadyCandidateInjectionResult<TCandidate> {
  readonly role: string;
  readonly baseCandidateCount: number;
  readonly liveReadyStatesSeen: number;
  readonly catalogMatches: number;
  /** Brand-new candidates ADDED to the pool (not already present in base). */
  readonly injectedCandidates: readonly TCandidate[];
  /** Existing candidates that we *did* match against a live-ready state.
   *  These are NOT re-added; we just annotated them. */
  readonly dedupedExistingCandidates: readonly TCandidate[];
  readonly rejected: readonly LiveReadyInjectionRejection[];
  readonly trace: readonly LiveReadyInjectionTraceEntry[];
  readonly metadata: LiveReadyInjectionMetadata;
}

// ─── Defaults ─────────────────────────────────────────────────────────────

export const DEFAULT_LIVE_READY_INJECTION_POLICY: LiveReadyCandidateInjectionPolicy = {
  enabled: true,
  source: 'live_operability_store',
  requireCatalogMatch: true,
  allowCrossRoleByCapabilities: true,
  dedupeStrategy: 'role_logical_provider_api_route',
  maxInjectedPerRole: 20,
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function normalize(v: string | undefined | null): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Build a deterministic dedupe key from the identifying tuple. Any change
 * to role / logicalModelId / providerId / apiModelId / routeId / adapterKind
 * MUST change the key. Whitespace + case are normalized.
 */
export function buildLiveReadyCandidateDedupeKey(input: LiveReadyDedupeKeyInput): string {
  return [
    normalize(input.role),
    normalize(input.logicalModelId ?? input.modelId),
    normalize(input.providerId),
    normalize(input.apiModelId),
    normalize(input.routeId),
    normalize(input.adapterKind),
  ].join('|');
}

/**
 * Returns true ONLY when the state is currently usable for a critical
 * role: chatReady, no active cooldown, eligibleForCriticalRole flag set.
 * Mirrors LiveChatOperabilityStore.isEligibleForCriticalRole() but works
 * on a raw snapshot entry (no store reference required — pure).
 */
export function isStateCurrentlyEligible(
  state: Pick<
    LiveChatOperabilityState,
    'chatReady' | 'eligibleForCriticalRole' | 'cooldownUntil'
  >,
  now: number = Date.now(),
): boolean {
  if (!state.chatReady) return false;
  if (state.eligibleForCriticalRole === false) return false;
  if (state.cooldownUntil) {
    const ts = new Date(state.cooldownUntil).getTime();
    if (Number.isFinite(ts) && ts > now) return false;
  }
  return true;
}

// ─── Main injector ────────────────────────────────────────────────────────

export interface InjectLiveReadyCandidatesInput<TCandidate, TState> {
  readonly role: string;
  readonly baseCandidates: readonly TCandidate[];
  readonly liveReadyStates: readonly TState[];
  /**
   * Map a live-ready state to ONE (or zero/multiple) catalog candidates.
   * Returns:
   *   - undefined → no catalog match → rejection `live_ready_state_not_in_catalog`
   *   - one candidate → injected (or dedupe-matched against base)
   *   - multiple candidates → rejection `ambiguous_catalog_match` (we refuse
   *     to guess when the catalog returns >1 match for the same state)
   */
  readonly resolveCatalogCandidate: (state: TState) => TCandidate | readonly TCandidate[] | undefined;
  readonly candidateSupportsRole: (candidate: TCandidate, role: string) => boolean;
  readonly projectCandidateKey: (candidate: TCandidate, role: string) => string;
  readonly projectStateKey: (state: TState, role: string) => string;
  readonly attachInjectionMetadata: (
    candidate: TCandidate,
    metadata: LiveReadyInjectionMetadata,
  ) => TCandidate;
  readonly projectStateForTrace: (state: TState) => LiveReadyInjectionTraceEntry;
  readonly stateIsEligible: (state: TState) => boolean;
  readonly stateLogicalRole?: (state: TState) => string | undefined;
  readonly stateProvider: (state: TState) => string | undefined;
  readonly stateModel: (state: TState) => string | undefined;
  readonly policy?: LiveReadyCandidateInjectionPolicy;
  readonly snapshotHash?: string;
  readonly snapshotPath?: string;
  readonly now?: number;
}

/**
 * Augment a per-role pool with live-ready candidates from the store.
 *
 * Pipeline:
 *   1. If `policy.enabled === false`, return passthrough (zero injections).
 *   2. Filter states by `stateIsEligible(state)` (chatReady + cooldown OK).
 *   3. For each eligible state:
 *      a. If `stateLogicalRole(state)` exists and !== role and policy
 *         disallows cross-role → reject (`role_mismatch`).
 *      b. If state is missing provider OR model → reject.
 *      c. Resolve via callback → reject when undefined/empty.
 *      d. Reject when resolver returns multiple candidates.
 *      e. Check capability fit → reject when not supported.
 *      f. Deduplicate against base + already-injected via projectCandidateKey.
 *      g. Otherwise attach metadata, push.
 *   4. Honor `maxInjectedPerRole`.
 *
 * Output: stable, deterministic, no I/O, no mutation of inputs.
 */
export function injectLiveReadyCandidatesIntoRolePool<TCandidate, TState>(
  input: InjectLiveReadyCandidatesInput<TCandidate, TState>,
): LiveReadyCandidateInjectionResult<TCandidate> {
  const policy = input.policy ?? DEFAULT_LIVE_READY_INJECTION_POLICY;
  const metadata: LiveReadyInjectionMetadata = {
    liveOperabilitySnapshotHash: input.snapshotHash,
    liveOperabilitySnapshotPath: input.snapshotPath,
    injectedByLiveReadyStore: true,
  };

  if (!policy.enabled) {
    return {
      role: input.role,
      baseCandidateCount: input.baseCandidates.length,
      liveReadyStatesSeen: input.liveReadyStates.length,
      catalogMatches: 0,
      injectedCandidates: [],
      dedupedExistingCandidates: [],
      rejected: [],
      trace: [],
      metadata,
    };
  }

  const baseKeys = new Set(input.baseCandidates.map((c) => input.projectCandidateKey(c, input.role)));
  const injected: TCandidate[] = [];
  const injectedKeys = new Set<string>();
  const dedupedExisting: TCandidate[] = [];
  const rejected: LiveReadyInjectionRejection[] = [];
  const trace: LiveReadyInjectionTraceEntry[] = [];

  let catalogMatches = 0;

  for (const state of input.liveReadyStates) {
    if (!input.stateIsEligible(state)) {
      rejected.push({ reason: 'not_live_ready' });
      continue;
    }
    const providerId = input.stateProvider(state);
    const stateModelId = input.stateModel(state);
    if (!providerId || !stateModelId) {
      rejected.push({ reason: 'missing_provider_or_model', providerId, logicalModelId: stateModelId });
      continue;
    }

    const stateRole = input.stateLogicalRole?.(state);
    if (stateRole && stateRole !== input.role && !policy.allowCrossRoleByCapabilities) {
      rejected.push({ reason: 'role_mismatch', providerId, logicalModelId: stateModelId, role: stateRole });
      continue;
    }

    const resolved = input.resolveCatalogCandidate(state);
    if (!resolved || (Array.isArray(resolved) && resolved.length === 0)) {
      rejected.push({
        reason: 'live_ready_state_not_in_catalog',
        providerId,
        logicalModelId: stateModelId,
      });
      continue;
    }
    if (Array.isArray(resolved) && resolved.length > 1) {
      rejected.push({
        reason: 'ambiguous_catalog_match',
        providerId,
        logicalModelId: stateModelId,
      });
      continue;
    }
    // Array.isArray widens `resolved` to any[] in the true branch and — because its
    // guard asserts a *mutable* any[] — fails to drop `readonly TCandidate[]` in the
    // false branch, so the single-candidate case stays the union. The non-empty /
    // non-array guards above already proved it's a single TCandidate here; assert it
    // on both branches (sanctioned assertion — not `as any` / `as unknown as`).
    const candidate: TCandidate = Array.isArray(resolved)
      ? (resolved[0] as TCandidate)
      : (resolved as TCandidate);
    catalogMatches++;

    if (!input.candidateSupportsRole(candidate, input.role)) {
      rejected.push({
        reason: 'capability_mismatch',
        providerId,
        logicalModelId: stateModelId,
        role: input.role,
      });
      continue;
    }

    const candidateKey = input.projectCandidateKey(candidate, input.role);

    if (baseKeys.has(candidateKey)) {
      dedupedExisting.push(candidate);
      trace.push(input.projectStateForTrace(state));
      continue;
    }
    if (injectedKeys.has(candidateKey)) {
      rejected.push({
        reason: 'duplicate_candidate',
        providerId,
        logicalModelId: stateModelId,
      });
      continue;
    }
    if (
      typeof policy.maxInjectedPerRole === 'number' &&
      injected.length >= policy.maxInjectedPerRole
    ) {
      // Silently stop adding (operator capped the inject set); record one
      // rejection so the trace shows the cap fired.
      rejected.push({
        reason: 'duplicate_candidate',
        providerId,
        logicalModelId: stateModelId,
      });
      continue;
    }

    const augmented = input.attachInjectionMetadata(candidate, metadata);
    injected.push(augmented);
    injectedKeys.add(candidateKey);
    trace.push(input.projectStateForTrace(state));
  }

  return {
    role: input.role,
    baseCandidateCount: input.baseCandidates.length,
    liveReadyStatesSeen: input.liveReadyStates.length,
    catalogMatches,
    injectedCandidates: injected,
    dedupedExistingCandidates: dedupedExisting,
    rejected,
    trace,
    metadata,
  };
}
