// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-P — Deterministic plan fingerprint.
 *
 * Given a `ConsensusExecutionPlan`, compute:
 *   - `executionPlanId` — random uuid-like identifier (one-shot, used
 *     as a handoff token between dry-run and real execution).
 *   - `planFingerprint` — SHA-256 over a canonical JSON projection of
 *     the plan's selection fields. Stable across runs for the same
 *     plan content; changes when participants / synthesizer / judge /
 *     fallback / role policies / budget / strict flags change.
 *
 * Sanitization rules (NEVER include in the fingerprint or the surfaced
 * snapshot):
 *   - API keys / bearer tokens / org IDs / user IDs
 *   - Raw prompt content (the user's `messages[]`)
 *   - Provider payload responses
 *
 * The fingerprint contract is documented in the canonical interface
 * below so future readers can audit it. ANY change to the fingerprint
 * recipe is a breaking change for `executionParityCheck` consumers
 * and MUST bump `plannerVersion`.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ConsensusExecutionPlan } from './consensus-execution-planner';

/**
 * Bump this when the fingerprint recipe changes.
 *
 * History:
 *   - '01C.1B-H'       — multi-route candidate set added
 *   - '01C.1B-J1G-R0'  — roleSelectionPolicy added (synthesizer hybrid scorer)
 *   - '01C.1B-J1G-R2'  — cost-benefit rebalance: coverage penalties removed,
 *                        quality+cost weights bumped (semantic change to
 *                        scoring → plans approved under R0 must re-plan)
 *   - '01C.1B-J2'      — modelQualityCalibrationSnapshot added: quality
 *                        signal now carries provenance (snapshot hash +
 *                        version), executionParityCheck rejects snapshot
 *                        substitution between dry-run and real execution
 *   - '01C.1B-J2-C-R4' — multi-source snapshot (sourceScores[] + per-
 *                        category breakdown + manual-demotion + task-
 *                        aware resolver); scorer now uses per-task
 *                        category quality instead of monolithic
 *                        qualityScore. Bumped because the
 *                        synthesizerSelectionSummary semantics change
 *                        (winner can differ by task type for the same
 *                        candidate pool + snapshot).
 */
export const PLANNER_VERSION = '01C.1B-J2-C-R4' as const;

export interface SanitizedPlanRole {
  readonly modelId: string;
  readonly providerId: string;
  /** Catalog routeId is not always exposed on the Model type; falls
   *  back to modelId for stable hashing when absent. */
  readonly routeId: string;
}

/**
 * 01C.1B-E — Route cascade policy. When `allowRouteFallback=false`,
 * the executor must NOT silently retry the same logical model on a
 * different provider when the first one fails. When `true`, the cascade
 * sequence must be planned ahead of time (future work — current
 * version only carries the policy itself, not yet a per-role cascade
 * sequence).
 *
 * Included in the fingerprint so the dry-run-approved policy locks
 * to the real-execution policy: a caller asking for `maxRetries=0` in
 * the dry-run can't accidentally trigger rescue at execution time
 * because the recomputed fingerprint would no longer match.
 */
export interface RouteCascadePolicySnapshot {
  readonly allowRouteFallback: boolean;
  readonly maxRouteAttempts: number;
  readonly maxRetriesPerProvider: number;
}

/**
 * 01C.1B-F2 — Deadline policy. Caps how long the execution path can
 * take before returning a controlled (possibly degraded) response.
 * Included in the fingerprint so a dry-run approved at 180s strategy
 * deadline cannot be replayed at 600s without the fingerprint tripping.
 */
export interface DeadlinePolicySnapshot {
  readonly perAttemptTimeoutMs: number;
  readonly participantDeadlineMs: number;
  readonly strategyDeadlineMs: number;
  readonly serverResponseDeadlineMs: number;
}

export const STRICT_DEFAULT_DEADLINE_POLICY: DeadlinePolicySnapshot = {
  perAttemptTimeoutMs: 30_000,
  participantDeadlineMs: 45_000,
  strategyDeadlineMs: 180_000,
  serverResponseDeadlineMs: 240_000,
};

/**
 * 01C.1B-G4 — Prompt fingerprint shape carried in the plan snapshot.
 *
 * `aggregate` is the single SHA-256 over all per-role fingerprints
 * (sorted by role). It is what gets baked into the `planFingerprint`
 * via canonical-JSON of this struct — so changing ANY role's prompt
 * propagates to the plan fingerprint deterministically.
 *
 * `perRole` lists each role's individual fingerprint + the templateId
 * so diff payloads can pinpoint which role changed when parity fails.
 *
 * When `tracePromptPayload` is NOT requested or the runtime cannot
 * compute traces (e.g., legacy code path), `aggregate` is the empty
 * string and `perRole` is empty — but the FIELDS still exist so any
 * future caller that flips the flag does not need a snapshot-shape
 * migration.
 */
export interface PromptFingerprintsSnapshot {
  readonly aggregate: string;
  readonly perRole: readonly {
    readonly role: string;
    readonly promptTemplateId: string;
    readonly promptVersion: string | null;
    readonly promptFingerprint: string;
  }[];
  /** True when at least one role's trace was computed and included in
   *  the aggregate hash that feeds `planFingerprint`. False when the
   *  caller skipped trace computation (legacy / no-trace path). */
  readonly includedInPlanFingerprint: boolean;
}

export interface SanitizedPlanSnapshot {
  readonly strategy: 'consensus';
  readonly plannerVersion: typeof PLANNER_VERSION;
  readonly participants: readonly SanitizedPlanRole[];
  readonly synthesizer: SanitizedPlanRole | null;
  readonly judge: SanitizedPlanRole | null;
  readonly fallback: SanitizedPlanRole | null;
  readonly budget: {
    readonly maxTotalCostUsd?: number;
    readonly maxTaskCostUsd?: number;
    readonly maxJudgeCostUsd?: number;
  };
  readonly strict: boolean;
  readonly registryScope: 'full_system_registry';
  readonly probeScope: 'auxiliary';
  readonly roleSpecificRetrieval: boolean;
  /** 01C.1B-E — route cascade / retry policy. Defaults to a strict
   *  fail-fast policy (`{allowRouteFallback:false, maxRouteAttempts:1,
   *  maxRetriesPerProvider:0}`) when caller omits it. */
  readonly routeCascadePolicy: RouteCascadePolicySnapshot;
  /** 01C.1B-F2 — deadline policy. Defaults to `STRICT_DEFAULT_DEADLINE_POLICY`
   *  when caller omits. Inclusion in the fingerprint guarantees the
   *  approved plan cannot be replayed with relaxed deadlines. */
  readonly deadlinePolicy: DeadlinePolicySnapshot;
  /** 01C.1B-G4 — prompt fingerprints (aggregate + per-role).
   *  When `includedInPlanFingerprint=true`, the aggregate hash is part
   *  of the canonical JSON used to compute `planFingerprint`. */
  readonly promptFingerprints: PromptFingerprintsSnapshot;
  /** 01C.1B-H — multi-route candidate set per role.
   *
   *  Carries the ORDERED list of routes the executor is approved to try
   *  for each role's logical model, the route selection policy, and
   *  coverage counters. Empty array per role means caller did not pass
   *  routeCandidates (legacy path) — the snapshot still records the
   *  field so it always participates in the fingerprint deterministically. */
  readonly routeCandidates: RouteCandidatesSnapshot;
  /** 01C.1B-J1G-R0 — role selection policy snapshot. Populated when
   *  the planner invoked the hybrid synthesizer scorer. Empty defaults
   *  when caller skipped (`includedInPlanFingerprint=false`). */
  readonly roleSelectionPolicy: RoleSelectionPolicySnapshot;
}

/**
 * 01C.1B-H — Per-role route candidate projection in the fingerprint.
 * Only the FOUR fields the fingerprint actually needs participate;
 * cost/health/latency RANK drift is intentionally excluded so
 * fingerprints stay stable when only telemetry changes.
 */
export interface RouteCandidateProjection {
  readonly routeId: string;
  readonly logicalModelId: string;
  readonly apiModelId: string;
  readonly providerId: string;
  readonly routerId?: string;
  readonly upstreamProviderId?: string;
  readonly adapterKind: string;
  readonly endpointKind: string;
  readonly equivalenceKind: string;
}

export interface RouteCandidatesSnapshot {
  readonly perRole: readonly {
    readonly role: 'participant' | 'synthesizer' | 'judge' | 'fallbackSingle';
    readonly logicalModelId: string;
    readonly candidates: readonly RouteCandidateProjection[];
  }[];
  readonly policy: {
    readonly orderBy: readonly string[];
    readonly maxRouteAttempts: number;
    readonly allowOutOfPlanRoutes: false;
    readonly allowModelFallback: boolean;
    readonly allowRouterFallback: boolean;
    readonly requireLiveReadyForCriticalRoles: boolean;
  };
  readonly includedInPlanFingerprint: boolean;
}

/**
 * 01C.1B-J1G-R0 §9 — Role selection policy snapshot.
 *
 * Captures the synthesizer-role policy version + candidate pool hash so
 * that an approved plan cannot be re-executed against a stale scorer
 * version or a different candidate pool without the fingerprint
 * detecting the change.
 *
 * `synthesizerPolicyVersion` follows the form `'01C.1B-J1G-R2:<weights-tag>'`.
 * Bumping the hybrid policy weights MUST bump this tag.
 *
 * `synthesizerCandidatePoolHash` is the FNV-1a hex digest of the sorted
 * `(modelId, providerId)` tuples in the pool the scorer evaluated. Same
 * tuples → same hash; any add/remove → different hash → fingerprint
 * mismatch → executionParityCheck rejects.
 *
 * Empty defaults carried when the caller did not invoke the synthesizer
 * scorer (legacy / non-synthesizer-only flows). The fields still exist
 * so the snapshot shape is stable across all flows.
 */
export interface RoleSelectionPolicySnapshot {
  readonly synthesizerPolicyVersion: string;
  readonly synthesizerCandidatePoolHash: string;
  readonly synthesizerQualityFloor: number;
  readonly includedInPlanFingerprint: boolean;
  /**
   * 01C.1B-J2 — Optional ModelQualityCalibrationSnapshot fingerprint info.
   *
   * When the resolver consumed a quality snapshot, these fields are
   * populated so the fingerprint reflects which snapshot fed the
   * synthesizer pick. Substituting a different snapshot between
   * dry-run and real execution changes `qualitySnapshotHash` → fingerprint
   * mismatch → executionParityCheck rejects.
   *
   * Empty strings (`''`) when no snapshot was consumed — the snapshot
   * shape is still in the canonical JSON for deterministic hashing.
   */
  readonly qualitySnapshotVersion: string;
  readonly qualitySnapshotHash: string;
  readonly qualitySnapshotEntryCount: number;
  /**
   * 01C.1B-J1D-R4A — Optional live-ready candidate injection fingerprint.
   *
   * These fields are OPTIONAL and only present when the pool builder
   * actually ran live-ready injection. Their absence (`undefined`) is
   * how we preserve bit-exact fingerprints for callers that never opted
   * into injection — the `canonicalJsonStringify` helper strips
   * undefined fields so adding these here does NOT change the J2-E-R2
   * baseline hash for the disabled-default path.
   *
   * When present:
   *   - `enabled`: always true (omitting the field means "not enabled")
   *   - `snapshotHash`: hash of the store snapshot the injector saw
   *     (substituting a different snapshot between dry-run and real
   *     execution changes the fingerprint → parity rejects)
   *   - `byRoleProjection`: stable per-role projection of injected
   *     candidates (logicalModelId+providerId+apiModelId+routeId),
   *     sorted canonically. Changing which models were injected → hash
   *     change → parity rejects.
   */
  readonly liveReadyInjectionEnabled?: true;
  readonly liveReadyInjectionSnapshotHash?: string;
  readonly liveReadyInjectionByRoleProjection?: ReadonlyArray<{
    readonly role: string;
    readonly injectedLiveReadyCount: number;
    readonly postInjectionCandidateCount: number;
    readonly injectedCandidates: ReadonlyArray<{
      readonly logicalModelId: string;
      readonly providerId: string;
      readonly apiModelId: string;
      readonly routeId: string;
    }>;
  }>;
  /**
   * 01C.1B-J1D-R4C — Optional context policy fingerprint.
   *
   * Captures: formula version, safety margin, participantCount,
   * per-role minContextWindow, backfill hash, and a sanitized projection
   * of applied overrides. Changing any of these mutates the fingerprint,
   * so the parity check rejects substitution between dry-run and (future)
   * real execution.
   *
   * Optional + undefined-default preserves J2-E-R2's baseline hash for
   * callers that never opt into the policy.
   */
  readonly contextPolicyEnabled?: true;
  readonly contextPolicyFormulaVersion?: string;
  readonly contextPolicySafetyMarginRatio?: number;
  readonly contextPolicyAbsoluteSafetyMarginTokens?: number;
  readonly contextPolicyParticipantCount?: number;
  readonly contextPolicyParticipantMaxOutputTokens?: number;
  readonly contextPolicySynthesizerMaxOutputTokens?: number;
  readonly contextPolicyJudgeMaxOutputTokens?: number;
  readonly contextPolicyBackfillHash?: string;
  /** Per-role minContextWindow + components. Sorted by role. */
  readonly contextPolicyByRole?: ReadonlyArray<{
    readonly role: string;
    readonly minContextWindow: number;
    readonly requiredInputTokens: number;
    readonly safetyMarginTokens: number;
  }>;
  /** Sanitized projection of applied overrides. NEVER contains secrets. */
  readonly contextPolicyAppliedOverrides?: ReadonlyArray<{
    readonly providerId?: string;
    readonly routeId?: string;
    readonly apiModelId?: string;
    readonly canonicalModelId?: string;
    readonly effectiveContextWindow: number;
    readonly effectiveMaxOutputTokens?: number;
    readonly source: string;
    readonly confidence: string;
  }>;

  /**
   * 01C.1B-J1D-R4D — Judge eligibility policy snapshot.
   *
   * Captures: policy version, structured-output equivalence buckets,
   * weakAllowed flag, fullRegistryExpansionEnabled, expansion source,
   * a stable backfill hash (optional), and whether dynamic context
   * budget + live-ready evidence were required. Any of these changing
   * → fingerprint changes → parity rejects.
   *
   * Optional + undefined-default preserves J1D-R4C's baseline hash for
   * callers that never opt into the policy.
   */
  readonly judgeEligibilityPolicyEnabled?: true;
  readonly judgeEligibilityPolicyVersion?: string;
  readonly judgeStructuredOutputStrong?: ReadonlyArray<string>;
  readonly judgeStructuredOutputMedium?: ReadonlyArray<string>;
  readonly judgeStructuredOutputWeakAllowed?: boolean;
  readonly judgeFullRegistryExpansionEnabled?: boolean;
  readonly judgeExpansionSource?: string;
  readonly judgeStructuredOutputBackfillHash?: string;
  readonly judgeRequireLiveReadyEvidence?: boolean;
  readonly judgeRequireDynamicContextBudget?: boolean;

  /**
   * 01C.1B-J2-C-R5 — Quality coverage policy snapshot.
   *
   * Captures: policy version, qualitySnapshotHash, whether the alias-aware
   * resolver is enabled, the requireNoCatalogFallbackForSelected gate, and
   * a deterministic projection of the per-selected-model quality coverage.
   * Any of these changing → fingerprint changes → parity rejects.
   *
   * Optional + undefined-default preserves J1D-R4D baseline hash for callers
   * that never opt into the policy.
   */
  readonly qualityPolicyEnabled?: true;
  readonly qualityPolicyVersion?: string;
  readonly qualitySnapshotHashFromR5?: string;
  readonly qualityIdentityResolverEnabled?: boolean;
  readonly qualityRequireNoCatalogFallbackForSelected?: boolean;
  readonly qualityAllowFamilyInferenceForSelected?: boolean;
  /** Sanitized per-selected-role quality coverage projection. NEVER contains
   *  prompts or secrets. */
  readonly qualitySelectedCoverage?: ReadonlyArray<{
    readonly role: string;
    readonly runtimeModelId: string;
    readonly qualityCanonicalId: string;
    readonly matchKind: string;
    readonly confidence: string;
    readonly qualityScoreSource: string;
    readonly familyInferenceUsed: boolean;
    readonly catalogFallbackUsed: boolean;
  }>;

  /**
   * 01C.1B-J2-C-R6-HARDEN — C3 eligibility policy snapshot.
   *
   * Captures: policy version, whether all selected models are c3-eligible,
   * and a per-model c3 eligibility projection. Any change → fingerprint
   * change → parity rejects.
   *
   * Optional + undefined-default preserves J2-C-R5 baseline hash for callers
   * that never opt into the c3 eligibility gate.
   */
  readonly c3EligibilityPolicyEnabled?: true;
  readonly c3EligibilityPolicyVersion?: string;
  readonly c3EligibilityAllModelsEligible?: boolean;
  readonly c3EligibilityEligibleCount?: number;
  readonly c3EligibilityBlockedCount?: number;
  /** Sanitized per-selected-model c3 eligibility projection. */
  readonly c3EligibilitySelectedCoverage?: ReadonlyArray<{
    readonly modelId: string;
    readonly c3Eligible: boolean;
    readonly status: string;
    readonly reason: string;
    readonly matchConfidence: string;
    readonly variantEvidence: string;
    readonly aaSlug: string | null;
  }>;
}

export interface PlanFingerprintInput {
  readonly plan: ConsensusExecutionPlan;
  readonly budget?: {
    readonly maxTotalCostUsd?: number;
    readonly maxTaskCostUsd?: number;
    readonly maxJudgeCostUsd?: number;
  };
  readonly strict: boolean;
  readonly roleSpecificRetrieval: boolean;
  /** 01C.1B-E — route cascade policy. When omitted, the strict default
   *  `{allowRouteFallback:false, maxRouteAttempts:1, maxRetriesPerProvider:0}`
   *  is used. The chat-request-processor / parity gate reads
   *  `eval.maxRetriesPerProvider` + `eval.allowCrossProviderRouteFallback`
   *  + `eval.maxRouteAttempts` and passes them here so the fingerprint
   *  reflects what the executor will actually honor. */
  readonly routeCascadePolicy?: RouteCascadePolicySnapshot;
  readonly deadlinePolicy?: DeadlinePolicySnapshot;
  /** 01C.1B-G4 — optional pre-computed prompt fingerprints. Caller passes
   *  the result of `buildMultiRolePromptTrace` here so the plan
   *  fingerprint deterministically incorporates prompt content. When
   *  omitted, the snapshot carries an EMPTY `promptFingerprints` and
   *  `includedInPlanFingerprint=false`. */
  readonly promptFingerprints?: PromptFingerprintsSnapshot;
  /** 01C.1B-H — optional pre-computed route candidates per role. When
   *  provided, every role's candidate list participates in the plan
   *  fingerprint; route swap at runtime → fingerprint mismatch →
   *  executionParityCheck rejects. When omitted, snapshot carries an
   *  empty `routeCandidates` and `includedInPlanFingerprint=false`. */
  readonly routeCandidates?: RouteCandidatesSnapshot;
  /** 01C.1B-J1G-R0 — role selection policy snapshot. When provided,
   *  the synthesizer policy version + candidate pool hash participate
   *  in the plan fingerprint. Same input → same hash; scorer-weight
   *  bump or pool change → fingerprint mismatch → parity rejects. */
  readonly roleSelectionPolicy?: RoleSelectionPolicySnapshot;
}

export interface PlanFingerprintResult {
  readonly executionPlanId: string;
  readonly planFingerprint: string;
  readonly planCreatedAt: string;
  readonly planSource: 'dry_run' | 'runtime_planner' | 'approved_dry_run_plan';
  readonly plannerVersion: typeof PLANNER_VERSION;
  readonly snapshot: SanitizedPlanSnapshot;
  readonly registryScope: 'full_system_registry';
  readonly probeScope: 'auxiliary';
  readonly roleSpecificRetrieval: boolean;
}

/**
 * Canonical-JSON stringify: keys sorted alphabetically, no whitespace,
 * no `undefined` values, arrays preserved in given order.
 *
 * This is the contract the fingerprint depends on. Any deviation
 * (e.g., spreading object literals in different orders elsewhere) is
 * fine — what matters is THIS function's output is stable.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'undefined') return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalJsonStringify(v));
    }
    return '{' + parts.join(',') + '}';
  }
  return 'null';
}

/**
 * Extract the sanitized role projection from a ModelCandidate. Provider
 * routing is reduced to `modelId / providerId / routeId` — the three
 * fields needed to prove the same model would execute on the same
 * provider with the same routing.
 */
function projectRole(
  candidate: ConsensusExecutionPlan['participants'][number] | undefined,
): SanitizedPlanRole | null {
  if (!candidate) return null;
  return {
    modelId: candidate.model.id,
    providerId: candidate.providerId ?? candidate.model.provider ?? 'unknown',
    routeId:
      (candidate.model as { routeId?: string }).routeId ?? candidate.model.id,
  };
}

/**
 * Build the sanitized snapshot from a plan + extras. Pure function;
 * trivial to test.
 */
export const STRICT_DEFAULT_ROUTE_CASCADE_POLICY: RouteCascadePolicySnapshot = {
  allowRouteFallback: false,
  maxRouteAttempts: 1,
  maxRetriesPerProvider: 0,
};

/** Default empty prompt-fingerprints used when caller didn't compute traces. */
const EMPTY_PROMPT_FINGERPRINTS: PromptFingerprintsSnapshot = {
  aggregate: '',
  perRole: [],
  includedInPlanFingerprint: false,
};

/** 01C.1B-H — default empty route-candidates carried when caller didn't
 *  pass any. The fields still exist so the fingerprint shape is stable. */
const EMPTY_ROUTE_CANDIDATES: RouteCandidatesSnapshot = {
  perRole: [],
  policy: {
    orderBy: [],
    maxRouteAttempts: 0,
    allowOutOfPlanRoutes: false,
    allowModelFallback: false,
    allowRouterFallback: false,
    requireLiveReadyForCriticalRoles: false,
  },
  includedInPlanFingerprint: false,
};

/** 01C.1B-J1G-R0 — default empty role-selection-policy carried when
 *  caller didn't invoke the synthesizer scorer. Fields still exist so
 *  the snapshot shape is stable. */
const EMPTY_ROLE_SELECTION_POLICY: RoleSelectionPolicySnapshot = {
  synthesizerPolicyVersion: '',
  synthesizerCandidatePoolHash: '',
  synthesizerQualityFloor: 0,
  includedInPlanFingerprint: false,
  qualitySnapshotVersion: '',
  qualitySnapshotHash: '',
  qualitySnapshotEntryCount: 0,
  // 01C.1B-J1D-R4A — the 3 optional liveReadyInjection* fields are
  // omitted (undefined) here, NOT set to neutral values. Reason: the
  // canonical-JSON projection strips undefined keys, so prior callers
  // who never enable injection get an identical canonical projection
  // (and therefore the same fingerprint hash) as before this stage.
};

export function buildSanitizedPlanSnapshot(
  input: PlanFingerprintInput,
): SanitizedPlanSnapshot {
  return {
    strategy: 'consensus',
    plannerVersion: PLANNER_VERSION,
    participants: input.plan.participants
      .map(projectRole)
      .filter((r): r is SanitizedPlanRole => r !== null),
    synthesizer: projectRole(input.plan.synthesizer),
    judge: projectRole(input.plan.judge),
    fallback: projectRole(input.plan.fallbackSingle),
    budget: {
      maxTotalCostUsd: input.budget?.maxTotalCostUsd,
      maxTaskCostUsd: input.budget?.maxTaskCostUsd,
      maxJudgeCostUsd: input.budget?.maxJudgeCostUsd,
    },
    strict: input.strict,
    registryScope: 'full_system_registry',
    probeScope: 'auxiliary',
    roleSpecificRetrieval: input.roleSpecificRetrieval,
    routeCascadePolicy: input.routeCascadePolicy ?? STRICT_DEFAULT_ROUTE_CASCADE_POLICY,
    deadlinePolicy: input.deadlinePolicy ?? STRICT_DEFAULT_DEADLINE_POLICY,
    promptFingerprints: input.promptFingerprints ?? EMPTY_PROMPT_FINGERPRINTS,
    routeCandidates: input.routeCandidates ?? EMPTY_ROUTE_CANDIDATES,
    roleSelectionPolicy: input.roleSelectionPolicy ?? EMPTY_ROLE_SELECTION_POLICY,
  };
}

/**
 * Compute the fingerprint metadata for a plan. Deterministic for the
 * same input. Caller controls whether the resulting `executionPlanId`
 * is fresh (one-shot) or reused from a previously approved plan.
 */
export function computePlanFingerprint(
  input: PlanFingerprintInput,
  opts: {
    readonly planSource?: 'dry_run' | 'runtime_planner' | 'approved_dry_run_plan';
    readonly executionPlanId?: string;
    readonly nowISO?: string;
  } = {},
): PlanFingerprintResult {
  const snapshot = buildSanitizedPlanSnapshot(input);
  const canonical = canonicalJsonStringify(snapshot);
  const planFingerprint = createHash('sha256').update(canonical).digest('hex');
  return {
    executionPlanId: opts.executionPlanId ?? randomUUID(),
    planFingerprint,
    planCreatedAt: opts.nowISO ?? new Date().toISOString(),
    planSource: opts.planSource ?? 'runtime_planner',
    plannerVersion: PLANNER_VERSION,
    snapshot,
    registryScope: 'full_system_registry',
    probeScope: 'auxiliary',
    roleSpecificRetrieval: input.roleSpecificRetrieval,
  };
}

/**
 * Compare two fingerprints + their snapshots, return a diff suitable
 * for the `PLAN_EXECUTION_PARITY_FAILED` error payload.
 *
 * The diff is HUMAN-READABLE — operators see exactly which role
 * disagreed (e.g., `judge: planned=gemma-3-4b-it, would_execute=gpt-4o-mini`).
 *
 * NEVER includes raw model objects, prompts, or any secret content.
 */
export interface PlanFingerprintDiff {
  readonly matched: boolean;
  readonly approvedPlanFingerprint: string;
  readonly wouldExecutePlanFingerprint: string;
  readonly mismatches: {
    readonly participants?: { readonly approved: readonly string[]; readonly wouldExecute: readonly string[] };
    readonly synthesizer?: { readonly approved: string | null; readonly wouldExecute: string | null };
    readonly judge?: { readonly approved: string | null; readonly wouldExecute: string | null };
    readonly fallback?: { readonly approved: string | null; readonly wouldExecute: string | null };
    readonly budget?: { readonly approved: SanitizedPlanSnapshot['budget']; readonly wouldExecute: SanitizedPlanSnapshot['budget'] };
    readonly strict?: { readonly approved: boolean; readonly wouldExecute: boolean };
  };
}

export function diffPlanFingerprints(
  approved: { fingerprint: string; snapshot: SanitizedPlanSnapshot },
  wouldExecute: { fingerprint: string; snapshot: SanitizedPlanSnapshot },
): PlanFingerprintDiff {
  const matched = approved.fingerprint === wouldExecute.fingerprint;
  if (matched) {
    return {
      matched: true,
      approvedPlanFingerprint: approved.fingerprint,
      wouldExecutePlanFingerprint: wouldExecute.fingerprint,
      mismatches: {},
    };
  }
  const mismatches: PlanFingerprintDiff['mismatches'] = {};
  const aIds = approved.snapshot.participants.map((p) => p.modelId);
  const eIds = wouldExecute.snapshot.participants.map((p) => p.modelId);
  if (aIds.length !== eIds.length || aIds.some((v, i) => v !== eIds[i])) {
    (mismatches as Record<string, unknown>).participants = { approved: aIds, wouldExecute: eIds };
  }
  if ((approved.snapshot.synthesizer?.modelId ?? null) !== (wouldExecute.snapshot.synthesizer?.modelId ?? null)) {
    (mismatches as Record<string, unknown>).synthesizer = {
      approved: approved.snapshot.synthesizer?.modelId ?? null,
      wouldExecute: wouldExecute.snapshot.synthesizer?.modelId ?? null,
    };
  }
  if ((approved.snapshot.judge?.modelId ?? null) !== (wouldExecute.snapshot.judge?.modelId ?? null)) {
    (mismatches as Record<string, unknown>).judge = {
      approved: approved.snapshot.judge?.modelId ?? null,
      wouldExecute: wouldExecute.snapshot.judge?.modelId ?? null,
    };
  }
  if ((approved.snapshot.fallback?.modelId ?? null) !== (wouldExecute.snapshot.fallback?.modelId ?? null)) {
    (mismatches as Record<string, unknown>).fallback = {
      approved: approved.snapshot.fallback?.modelId ?? null,
      wouldExecute: wouldExecute.snapshot.fallback?.modelId ?? null,
    };
  }
  const aBudget = canonicalJsonStringify(approved.snapshot.budget);
  const eBudget = canonicalJsonStringify(wouldExecute.snapshot.budget);
  if (aBudget !== eBudget) {
    (mismatches as Record<string, unknown>).budget = {
      approved: approved.snapshot.budget,
      wouldExecute: wouldExecute.snapshot.budget,
    };
  }
  if (approved.snapshot.strict !== wouldExecute.snapshot.strict) {
    (mismatches as Record<string, unknown>).strict = {
      approved: approved.snapshot.strict,
      wouldExecute: wouldExecute.snapshot.strict,
    };
  }
  return {
    matched: false,
    approvedPlanFingerprint: approved.fingerprint,
    wouldExecutePlanFingerprint: wouldExecute.fingerprint,
    mismatches,
  };
}
