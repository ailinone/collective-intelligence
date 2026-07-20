// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ConsensusExecutionPlanner — dry-run planner for ConsensusStrategy.
 *
 * Produces a `ConsensusExecutionPlan` that lists which models would
 * play each role (participants, synthesizer, judge, fallbackSingle)
 * WITHOUT executing them. Used by:
 *   - Strategy 01C.0 dry-run probe (env-gated)
 *   - Future audit dashboards
 *
 * The planner depends ONLY on the ModelRoleResolver. It does NOT call
 * providers, does NOT touch the DB beyond the catalog reader the
 * resolver was constructed with, and does NOT mutate global state.
 *
 * Each subsequent role resolution receives the prior role's
 * `selected` model ids via `excludeModelIds` so the judge / synthesizer
 * is INDEPENDENT from participants by default (subject to operability).
 */
import { ModelRoleResolver } from '../model-selection/model-role-resolver';
import type {
  ModelCandidate,
  ModelRoleResolutionResult,
  RoleConstraints,
  TaskProfile,
} from '../model-selection/model-role-types';

/**
 * Strategy 01C.0.2 — lightweight pool summary surfaced on the plan so
 * dry-run consumers can see credit/operability state breakdown WITHOUT
 * running the full ProviderCreditAuditService. Counts are derived
 * from the candidate pool ModelCandidate flags (hasCredits,
 * providerHealthy, rateLimited, isLocal); zero DB calls.
 *
 * For deeper analysis (stale reconciliation, non-billable probes),
 * operators run `ProviderCreditAuditService` separately.
 */
export interface ConsensusPlanPoolSummary {
  readonly totalCandidates: number;
  readonly usableProviderCount: number;
  readonly usableModelCount: number;
  readonly noCreditsProviderCount: number;
  readonly authFailedProviderCount: number;
  readonly rateLimitedProviderCount: number;
  readonly unknownProviderCount: number;
  readonly localProvidersConsidered: number;
  readonly aggregatorsConsidered: number;
  readonly routersConsidered: number;
  readonly distinctProvidersConsidered: number;
  /** Strategy 01C.0.3 — operability source for this pool view. */
  readonly operabilitySnapshotSource?: 'metadata_only' | 'non_billable_probe' | 'hub_cache' | 'unknown';
  /** Strategy 01C.0.3 — true when at least one provider in the pool
   *  had a successful non-billable probe applied. False when the pool
   *  uses pure hub_cache / metadata_only. Operators MUST set this to
   *  true before Strategy 01C.1 runs (or explicitly authorize
   *  minimal_billable_probe). */
  readonly safeNonBillableProbeAvailable?: boolean;
  /** Strategy 01C.0.3 — critical stale state count surfaced from the
   *  snapshot when the audit ran in non_billable_probe mode. */
  readonly criticalStaleOperabilityStateCount?: number;
}

export interface ConsensusExecutionPlan {
  readonly strategyName: 'consensus';
  readonly taskProfile: TaskProfile;
  readonly participants: readonly ModelCandidate[];
  readonly synthesizer?: ModelCandidate;
  readonly judge?: ModelCandidate;
  readonly fallbackSingle?: ModelCandidate;
  readonly roleSelectionTrace: readonly ModelRoleResolutionResult[];
  readonly executable: boolean;
  readonly blockers: readonly string[];
  readonly hardcodedModelUsed: false;
  readonly selectionSource: 'dynamic';
  /** Strategy 01C.0.2 — pool summary derived from candidate flags. */
  readonly poolSummary?: ConsensusPlanPoolSummary;
  /** Strategy 01C.1B-J — per-role candidate statistics for diagnosis
   *  of `no_eligible_judge`-class blockers. */
  readonly roleCandidateStats?: {
    readonly participant: RoleCandidateStats;
    readonly synthesizer: RoleCandidateStats;
    readonly judge: RoleCandidateStats;
    readonly fallbackSingle: RoleCandidateStats;
  };
  /** 01C.1B-J1C §13 — per-role grouping of flat `blockers`. */
  readonly blockersByRole?: {
    readonly participant: readonly string[];
    readonly synthesizer: readonly string[];
    readonly judge: readonly string[];
    readonly fallback: readonly string[];
  };
  /** 01C.1B-J1C §13 — per-role readiness summary derived from selections. */
  readonly criticalRoleReadiness?: {
    readonly participant: { readonly role: 'participant'; readonly selectedCount: number; readonly targetCount: number; readonly blocked: boolean; readonly firstBlocker: string | null };
    readonly synthesizer: { readonly role: 'synthesizer'; readonly selectedCount: number; readonly targetCount: number; readonly blocked: boolean; readonly firstBlocker: string | null };
    readonly judge: { readonly role: 'judge'; readonly selectedCount: number; readonly targetCount: number; readonly blocked: boolean; readonly firstBlocker: string | null };
    readonly fallback: { readonly role: 'fallback'; readonly selectedCount: number; readonly targetCount: number; readonly blocked: boolean; readonly firstBlocker: string | null };
  };
  /** 01C.1B-J1C §13 — readiness summary (all-roles-selected + blocked-roles + total). */
  readonly routeReadinessSummary?: {
    readonly allRolesSelected: boolean;
    readonly blockedRoles: readonly string[];
    readonly totalBlockers: number;
  };
  /**
   * 01C.1B-J1G-R0 §8 — top-level shortcut to the synthesizer resolver's
   * SynthesizerSelectionSummary. Reachable via
   * `roleSelectionTrace.find(t => t.role === 'synthesizer')?.synthesizerSelectionSummary`
   * but surfaced here for direct fingerprint/audit access.
   *
   * Only populated when the synthesizer role was resolved successfully
   * (i.e., the hybrid scorer ran). Undefined when resolution failed or
   * pool was empty.
   */
  readonly synthesizerSelectionSummary?: ModelRoleResolutionResult['synthesizerSelectionSummary'];
  /**
   * 01C.1B-J1D-R4D — Judge expansion trace. Tells the consumer whether
   * the planner had to expand the judge pool past the role-specific
   * cap to find a viable judge, and how the expansion behaved. Always
   * emitted (with `judgePoolExpanded=false` when the role-specific pool
   * sufficed). The values are AUDITABLE: they reflect what actually
   * happened, not what the policy asked for.
   */
  readonly judgeExpansionTrace?: {
    readonly role: 'judge';
    readonly judgePoolExpanded: boolean;
    readonly originalPoolSize: number;
    readonly expandedPoolSize: number;
    readonly expansionSource: string;
    readonly selectedFromExpandedPool: boolean;
    readonly judgeReusedFromPriorRole: boolean;
  };
}

export interface PlanInput {
  readonly taskProfile: TaskProfile;
  readonly candidatePool: readonly ModelCandidate[];
  readonly participantsCount?: number;
  readonly participantConstraints?: RoleConstraints;
  readonly synthesizerConstraints?: RoleConstraints;
  readonly judgeConstraints?: RoleConstraints;
  readonly fallbackConstraints?: RoleConstraints;
  /** Strategy 01C.0.3 — when the caller applied a snapshot to the
   *  pool, pass it here so the plan's `poolSummary` carries the
   *  provenance (operabilitySnapshotSource + safeNonBillableProbeAvailable). */
  readonly reconciledSnapshot?: import('@/core/operability/reconciled-operability-snapshot').ReconciledOperabilitySnapshot;
  /** 01C.1B-J2-E-R2 — Multi-source / task-aware quality snapshot, forwarded
   *  to `resolver.resolve(...)` so the synthesizer scorer can use real
   *  external benchmark scores instead of catalog placeholders. When
   *  omitted, the resolver falls back to catalog `performance.quality`.
   *  Passing this through here is what makes the plan's qualitySnapshotHash
   *  reflect the actual snapshot used at synthesizer selection time. */
  readonly modelQualityCalibrationSnapshot?: import('../role-selection/model-quality-calibration').ModelQualityCalibrationSnapshot;
  /** 01C.1B-J1D-R4C — Dynamic context policy. When `enabled: true`, the
   *  planner threads it into every `resolver.resolve(...)` call so each
   *  role's context filter uses the plan-derived budget AND audit-trailed
   *  context overrides (instead of static `policy.contextWindowMin`).
   *  When undefined, behavior is identical to pre-R4C — pool builder
   *  default flow preserved. */
  readonly contextPolicy?: import('../model-selection/model-role-types').ModelRoleResolutionInput['contextPolicy'];
  /** 01C.1B-J1D-R4D — Judge eligibility policy. When `enabled: true`, the
   *  resolver uses the broader `detectStructuredOutputSupport` classifier
   *  for `role === 'judge'` AND, if `fullRegistryExpansionEnabled: true`,
   *  the planner falls back to `judgeExpansionPool` when the initial
   *  role-specific judge pool produces 0 selected. When undefined or
   *  disabled, behavior is identical to pre-R4D. */
  readonly judgeEligibilityPolicy?: import('../model-selection/model-role-types').ModelRoleResolutionInput['judgeEligibilityPolicy'];
  /** 01C.1B-J2-C-R5 — Quality coverage policy. When `useQualityIdentityResolver=true`,
   *  the resolver uses the new alias-aware quality snapshot matcher (and not
   *  the exact-string `findEntry`). Default off preserves J2-C-R4 hash. */
  readonly qualityPolicy?: import('../model-selection/model-role-types').ModelRoleResolutionInput['qualityPolicy'];
  /** 01C.1B-J1D-R4D — Pre-built expanded judge pool from the full
   *  registry. The planner uses this ONLY when the role-specific judge
   *  pool produces 0 selected AND `judgeEligibilityPolicy.fullRegistryExpansionEnabled`
   *  is true. Built by the caller (`chat-request-processor`) so the
   *  planner stays free of repository dependencies. */
  readonly judgeExpansionPool?: readonly ModelCandidate[];
  /** Strategy 01C.1B-J — role-specific candidate pools.
   *
   * The default behavior passes `candidatePool` to all 4 role
   * resolutions, which is fine when the pool already meets every
   * role's criteria. But for the judge role specifically, a generic
   * pool sampled by usage_count rarely surfaces models that satisfy
   * the conjunction `chat AND ≥16k ctx AND structured-output AND
   * cost ≤ judge budget`. The 01C.1B-J audit proved 677 judge-strict
   * candidates exist in the 18,563-model chat-capable catalog — but
   * a 256-cap usage-sorted pool surfaced 0 of them.
   *
   * Callers (currently `ConsensusPlanDryRunService`) should pass a
   * judge-targeted pool here built from a separate catalog query
   * with `minContextWindow: 16000`, `maxCostPer1k` aligned with the
   * judge budget, and `sortBy: 'quality'` so judge-eligible models
   * outrank heavy-usage smaller ones.
   *
   * When omitted, the planner falls back to `candidatePool` for
   * backwards compatibility.
   */
  readonly roleSpecificPools?: {
    readonly participant?: readonly ModelCandidate[];
    readonly synthesizer?: readonly ModelCandidate[];
    readonly judge?: readonly ModelCandidate[];
    readonly fallback?: readonly ModelCandidate[];
  };
}

/**
 * Strategy 01C.1B-J — per-role candidate statistics surfaced on the
 * plan so the dry-run consumer can see, per role:
 *   - which universe was searched (full registry vs. generic pool)
 *   - how many candidates were eligible at each filter stage
 *   - which model was selected
 *   - the policy tier (strict, structured-output-unknown-allowed,
 *     context8k-fallback, etc.)
 *   - a degradation reason if a lower tier was used
 *
 * Counts are populated by the resolver's trace; the planner just
 * shapes them into the plan output.
 */
export interface RoleCandidateStats {
  readonly role: 'participant' | 'synthesizer' | 'judge' | 'fallback_single';
  readonly sourceUniverseCount: number;
  readonly eligibleBeforeFilters: number;
  readonly eligibleAfterCapabilityFilter: number;
  readonly eligibleAfterContextFilter: number;
  readonly eligibleAfterStructuredOutputFilter: number;
  readonly eligibleAfterCostFilter: number;
  readonly eligibleAfterOperabilityFilter: number;
  readonly selectedCount: number;
  readonly rejectionReasonCounts: Readonly<Record<string, number>>;
  readonly policyTier?: 'strict' | 'structured_output_unknown_allowed' | 'context_8k_fallback' | 'unknown';
  readonly degradationReason?: string;
}

export class ConsensusExecutionPlanner {
  constructor(private readonly resolver: ModelRoleResolver) {}

  async plan(input: PlanInput): Promise<ConsensusExecutionPlan> {
    const traces: ModelRoleResolutionResult[] = [];
    const blockers: string[] = [];

    // 01C.1B-J — pick the per-role candidate pool. When the caller
    // supplies `roleSpecificPools.<role>` we use it; otherwise we fall
    // back to the shared `candidatePool` (the legacy behavior). The
    // judge benefits most from a dedicated pool because the 256-cap
    // usage-sorted generic pool rarely surfaces ≥16k+structured-output
    // candidates (proven in 01C.1B-J audit: 677 strict-eligible models
    // exist in the full 18,563-model chat-capable catalog).
    const participantPool =
      input.roleSpecificPools?.participant ?? input.candidatePool;
    const synthesizerPool =
      input.roleSpecificPools?.synthesizer ?? input.candidatePool;
    const judgePool = input.roleSpecificPools?.judge ?? input.candidatePool;
    const fallbackPool =
      input.roleSpecificPools?.fallback ?? input.candidatePool;

    // 1. Participants — multi-model, provider-diverse.
    const participantsResult = await this.resolver.resolve({
      taskProfile: input.taskProfile,
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: participantPool,
      constraints: {
        ...input.participantConstraints,
        count: input.participantsCount ?? input.participantConstraints?.count ?? 3,
      },
      // 01C.1B-J2-E-R2: thread the multi-source quality snapshot so the
      // participant scorer can use task-aware quality (when populated).
      modelQualityCalibrationSnapshot: input.modelQualityCalibrationSnapshot,
      contextPolicy: input.contextPolicy, qualityPolicy: input.qualityPolicy,
    });
    traces.push(participantsResult);
    if (participantsResult.selected.length < 3) {
      blockers.push(
        `insufficient_participants:got=${participantsResult.selected.length},need>=3`,
      );
    }

    const participantIds = participantsResult.selected.map((c) => c.model.id);
    const participantProviders = participantsResult.selected.map((c) => c.providerId);

    // 2. Synthesizer — long-context, instruction-following, independent
    //    from participants when possible. Falls back to overlap if no
    //    independent synthesizer exists in the pool.
    let synthesizerResult = await this.resolver.resolve({
      taskProfile: input.taskProfile,
      strategyName: 'consensus',
      role: 'synthesizer',
      candidatePool: synthesizerPool,
      constraints: {
        ...input.synthesizerConstraints,
        excludeModelIds: [
          ...(input.synthesizerConstraints?.excludeModelIds ?? []),
          ...participantIds,
        ],
      },
      // 01C.1B-J2-E-R2: synthesizer is the role most affected by task-aware
      // quality routing. Pass the snapshot here so the scorer rejects the
      // J1G manual-bump anti-pattern in the runtime path.
      modelQualityCalibrationSnapshot: input.modelQualityCalibrationSnapshot,
      contextPolicy: input.contextPolicy, qualityPolicy: input.qualityPolicy,
    });
    if (synthesizerResult.selected.length === 0) {
      synthesizerResult = await this.resolver.resolve({
        taskProfile: input.taskProfile,
        strategyName: 'consensus',
        role: 'synthesizer',
        candidatePool: synthesizerPool,
        constraints: { ...input.synthesizerConstraints },
        modelQualityCalibrationSnapshot: input.modelQualityCalibrationSnapshot,
      contextPolicy: input.contextPolicy, qualityPolicy: input.qualityPolicy,
      });
    }
    traces.push(synthesizerResult);
    if (synthesizerResult.selected.length === 0) {
      blockers.push('no_eligible_synthesizer');
    }
    const synthesizer = synthesizerResult.selected[0];
    const synthesizerId = synthesizer?.model.id;

    // 3. Judge — JSON-capable, low-cost, independent. 01C.1B-J: judge
    //    uses its OWN candidate pool (judgePool) so the 256-cap
    //    generic pool's bias toward heavy-traffic small models doesn't
    //    starve the judge slot. Try first with strict exclusions
    //    (no overlap with participants/synthesizer). If empty, try
    //    again allowing reuse — emit `judge_reused_from_participants`
    //    note rather than failing closed.
    const judgeExcludeIds = [
      ...(input.judgeConstraints?.excludeModelIds ?? []),
      ...participantIds,
      ...(synthesizerId ? [synthesizerId] : []),
    ];
    let judgeResult = await this.resolver.resolve({
      taskProfile: input.taskProfile,
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: judgePool,
      constraints: {
        requireJsonOutput: true,
        ...input.judgeConstraints,
        excludeModelIds: judgeExcludeIds,
      },
      modelQualityCalibrationSnapshot: input.modelQualityCalibrationSnapshot,
      contextPolicy: input.contextPolicy, qualityPolicy: input.qualityPolicy,
      judgeEligibilityPolicy: input.judgeEligibilityPolicy,
    });
    let judgeReusedFromPriorRole = false;
    if (judgeResult.selected.length === 0) {
      // 01C.1B-J: when strict exclusion empties the judge slot, retry
      // WITHOUT excluding participants/synthesizer. If the catalog has
      // a judge-eligible candidate that happens to also be picked as
      // participant or synthesizer, reuse is preferable to failing the
      // whole plan. The blocker only fires if the catalog itself
      // can't satisfy judge constraints at all.
      const retry = await this.resolver.resolve({
        taskProfile: input.taskProfile,
        strategyName: 'consensus',
        role: 'judge',
        candidatePool: judgePool,
        constraints: {
          requireJsonOutput: true,
          ...input.judgeConstraints,
          excludeModelIds: input.judgeConstraints?.excludeModelIds ?? [],
        },
        modelQualityCalibrationSnapshot: input.modelQualityCalibrationSnapshot,
      contextPolicy: input.contextPolicy, qualityPolicy: input.qualityPolicy,
        judgeEligibilityPolicy: input.judgeEligibilityPolicy,
      });
      if (retry.selected.length > 0) {
        judgeResult = retry;
        judgeReusedFromPriorRole = true;
      }
    }

    // 01C.1B-J1D-R4D §10 — full-registry pool expansion. When the
    // role-specific judge pool (judgePool) and the retry-without-exclusions
    // BOTH produce 0 selected, AND the caller enabled judge full-registry
    // expansion AND supplied `judgeExpansionPool`, re-run the resolver
    // with the wider pool. This catches cases where the role-specific
    // pool was sampled too narrowly and missed a viable structured-
    // output judge that lives elsewhere in the catalog.
    //
    // The expanded pool re-runs ALL filters (capability, live-ready,
    // context budget, exclusions, structured-output) — no gates are
    // bypassed. The only difference is the pool size.
    let judgePoolExpanded = false;
    let originalPoolSize = judgePool.length;
    let expandedPoolSize = 0;
    let selectedFromExpandedPool = false;
    const expansionEnabled =
      input.judgeEligibilityPolicy?.enabled === true &&
      input.judgeEligibilityPolicy.fullRegistryExpansionEnabled === true;
    if (
      judgeResult.selected.length === 0 &&
      expansionEnabled &&
      Array.isArray(input.judgeExpansionPool) &&
      input.judgeExpansionPool.length > 0
    ) {
      const expansionPool = input.judgeExpansionPool;
      expandedPoolSize = expansionPool.length;
      const expandedRetry = await this.resolver.resolve({
        taskProfile: input.taskProfile,
        strategyName: 'consensus',
        role: 'judge',
        candidatePool: expansionPool,
        constraints: {
          requireJsonOutput: true,
          ...input.judgeConstraints,
          // First try with strict exclusions on the expanded pool too.
          excludeModelIds: judgeExcludeIds,
        },
        modelQualityCalibrationSnapshot: input.modelQualityCalibrationSnapshot,
        contextPolicy: input.contextPolicy, qualityPolicy: input.qualityPolicy,
        judgeEligibilityPolicy: input.judgeEligibilityPolicy,
      });
      if (expandedRetry.selected.length > 0) {
        judgeResult = expandedRetry;
        judgePoolExpanded = true;
        selectedFromExpandedPool = true;
      } else {
        // Last resort on the expanded pool: drop overlap exclusions.
        const expandedReuseRetry = await this.resolver.resolve({
          taskProfile: input.taskProfile,
          strategyName: 'consensus',
          role: 'judge',
          candidatePool: expansionPool,
          constraints: {
            requireJsonOutput: true,
            ...input.judgeConstraints,
            excludeModelIds: input.judgeConstraints?.excludeModelIds ?? [],
          },
          modelQualityCalibrationSnapshot: input.modelQualityCalibrationSnapshot,
          contextPolicy: input.contextPolicy, qualityPolicy: input.qualityPolicy,
          judgeEligibilityPolicy: input.judgeEligibilityPolicy,
        });
        if (expandedReuseRetry.selected.length > 0) {
          judgeResult = expandedReuseRetry;
          judgePoolExpanded = true;
          selectedFromExpandedPool = true;
          judgeReusedFromPriorRole = true;
        }
      }
    }
    traces.push(judgeResult);
    if (judgeResult.selected.length === 0) {
      // Judge is REQUIRED for fully_validated consensus per Strategy 01B
      // contract. Without one, the planner still emits a plan but flags
      // it as not executable for the SOTA path — caller can fall back
      // to UnavailableEvaluator if they accept structurally-only results.
      blockers.push('no_eligible_judge');
    }

    // 4. Fallback single — best individual; overlap with participants OK.
    const fallbackResult = await this.resolver.resolve({
      taskProfile: input.taskProfile,
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: fallbackPool,
      constraints: { ...input.fallbackConstraints },
      modelQualityCalibrationSnapshot: input.modelQualityCalibrationSnapshot,
      contextPolicy: input.contextPolicy, qualityPolicy: input.qualityPolicy,
    });
    traces.push(fallbackResult);
    if (fallbackResult.selected.length === 0) {
      blockers.push('no_eligible_fallback_single');
    }

    const executable = blockers.length === 0;
    // tag for future provider-diversity audit: ensure participants are
    // distinct providers when possible.
    if (new Set(participantProviders).size < participantsResult.selected.length) {
      // Not a hard blocker — diversity policy already tried — but record
      // it in trace so observers know.
      blockers.push('participants_provider_diversity_unmet');
    }

    const poolSummary: ConsensusPlanPoolSummary = {
      ...summarizePool(input.candidatePool),
      operabilitySnapshotSource: input.reconciledSnapshot?.source ?? 'hub_cache',
      safeNonBillableProbeAvailable:
        input.reconciledSnapshot?.safeNonBillableProbeAvailable ?? false,
      criticalStaleOperabilityStateCount:
        input.reconciledSnapshot?.criticalStaleOperabilityStateCount,
    };

    // 01C.1B-J — per-role stats. Each role gets:
    //   sourceUniverseCount = size of the pool the role searched
    //   eligibleAfter<Stage> = remaining candidates after each filter
    //   rejectionReasonCounts = tally of why others were dropped
    //   policyTier = 'strict' (no relaxed-tier path was taken this turn)
    //   degradationReason = present if a fallback path fired
    const buildStats = (
      role: RoleCandidateStats['role'],
      pool: readonly ModelCandidate[],
      result: ModelRoleResolutionResult,
      tierOverride?: RoleCandidateStats['policyTier'],
      degradationReason?: string,
    ): RoleCandidateStats => {
      const reasons: Record<string, number> = {};
      for (const r of result.rejected ?? []) {
        const k = r.reason ?? 'unknown';
        reasons[k] = (reasons[k] ?? 0) + 1;
      }
      const trace = result.trace;
      const stageCounts = (trace as { stageCounts?: Record<string, number> }).stageCounts ?? {};
      return {
        role,
        sourceUniverseCount: pool.length,
        eligibleBeforeFilters: pool.length,
        eligibleAfterCapabilityFilter: stageCounts.capability ?? pool.length,
        eligibleAfterContextFilter: stageCounts.context_window ?? stageCounts.capability ?? pool.length,
        eligibleAfterStructuredOutputFilter: stageCounts.role_specific ?? stageCounts.context_window ?? pool.length,
        eligibleAfterCostFilter: stageCounts.cost ?? pool.length,
        eligibleAfterOperabilityFilter:
          (stageCounts.health ?? pool.length) +
          (stageCounts.credits ?? 0) +
          (stageCounts.rate_limit ?? 0),
        selectedCount: result.selected.length,
        rejectionReasonCounts: reasons,
        policyTier: tierOverride ?? 'strict',
        degradationReason,
      };
    };
    const roleCandidateStats = {
      participant: buildStats('participant', participantPool, participantsResult),
      synthesizer: buildStats('synthesizer', synthesizerPool, synthesizerResult),
      judge: buildStats(
        'judge',
        judgePool,
        judgeResult,
        'strict',
        judgeReusedFromPriorRole ? 'judge_reused_from_participants_or_synthesizer' : undefined,
      ),
      fallbackSingle: buildStats('fallback_single', fallbackPool, fallbackResult),
    };

    // 01C.1B-J1C §13 — Per-role explainability. Group the flat
    // `blockers` array by role so operators can read at a glance
    // which role is blocking, and emit a `criticalRoleReadiness`
    // structure with per-role counts derived from the resolved
    // selections. The shape is additive — existing consumers that
    // only read `blockers`/`executable` are unaffected.
    const blockersByRole: Record<'participant' | 'synthesizer' | 'judge' | 'fallback', readonly string[]> = {
      participant: blockers.filter((b) => b.startsWith('insufficient_participants') || b.startsWith('no_eligible_participant')),
      synthesizer: blockers.filter((b) => b.startsWith('no_eligible_synthesizer') || b.includes('synthesizer')),
      judge: blockers.filter((b) => b.startsWith('no_eligible_judge') || b.includes('judge')),
      fallback: blockers.filter((b) => b.startsWith('no_eligible_fallback') || b.includes('fallback')),
    };
    const criticalRoleReadiness = {
      participant: {
        role: 'participant' as const,
        selectedCount: participantsResult.selected.length,
        targetCount: input.participantsCount ?? input.participantConstraints?.count ?? 3,
        blocked: blockersByRole.participant.length > 0,
        firstBlocker: blockersByRole.participant[0] ?? null,
      },
      synthesizer: {
        role: 'synthesizer' as const,
        selectedCount: synthesizerResult.selected.length,
        targetCount: 1,
        blocked: blockersByRole.synthesizer.length > 0,
        firstBlocker: blockersByRole.synthesizer[0] ?? null,
      },
      judge: {
        role: 'judge' as const,
        selectedCount: judgeResult.selected.length,
        targetCount: 1,
        blocked: blockersByRole.judge.length > 0,
        firstBlocker: blockersByRole.judge[0] ?? null,
      },
      fallback: {
        role: 'fallback' as const,
        selectedCount: fallbackResult.selected.length,
        targetCount: 1,
        blocked: blockersByRole.fallback.length > 0,
        firstBlocker: blockersByRole.fallback[0] ?? null,
      },
    } as const;
    const routeReadinessSummary = {
      allRolesSelected:
        participantsResult.selected.length >= 3 &&
        synthesizerResult.selected.length >= 1 &&
        judgeResult.selected.length >= 1 &&
        fallbackResult.selected.length >= 1,
      blockedRoles: Object.entries(blockersByRole)
        .filter(([, b]) => b.length > 0)
        .map(([role]) => role),
      totalBlockers: blockers.length,
    };

    // 01C.1B-J1D-R4D — Judge expansion trace.
    const judgeExpansionTrace = {
      role: 'judge' as const,
      judgePoolExpanded,
      originalPoolSize,
      expandedPoolSize,
      expansionSource:
        input.judgeEligibilityPolicy?.expansionSource ?? 'full_registry_role_specific',
      selectedFromExpandedPool,
      judgeReusedFromPriorRole,
    } as const;

    return {
      strategyName: 'consensus',
      taskProfile: input.taskProfile,
      participants: participantsResult.selected,
      synthesizer,
      judge: judgeResult.selected[0],
      fallbackSingle: fallbackResult.selected[0],
      roleSelectionTrace: traces,
      executable,
      blockers,
      // 01C.1B-J1C §13 — additive explainability fields.
      blockersByRole,
      criticalRoleReadiness,
      routeReadinessSummary,
      hardcodedModelUsed: false,
      selectionSource: 'dynamic',
      poolSummary,
      roleCandidateStats,
      // 01C.1B-J1G-R0 §8 — top-level shortcut to synthesizer scoring summary.
      ...(synthesizerResult.synthesizerSelectionSummary
        ? { synthesizerSelectionSummary: synthesizerResult.synthesizerSelectionSummary }
        : {}),
      // 01C.1B-J1D-R4D — Judge expansion trace (always emitted; values
      // reflect actual behavior so callers can verify whether expansion
      // ran). When `judgeEligibilityPolicy` is undefined this trace
      // simply reports `judgePoolExpanded=false`.
      judgeExpansionTrace,
    };
  }
}

/**
 * Strategy 01C.0.2 — derive a lightweight credit/operability summary
 * from the candidate pool. Used by chat-request-processor and probe
 * scripts to surface "did the planner have anywhere to choose from?"
 * without a separate audit run.
 */
export function summarizePool(
  pool: readonly ModelCandidate[],
): ConsensusPlanPoolSummary {
  const providers = new Set<string>();
  let usableProviderCount = 0;
  let usableModelCount = 0;
  let noCreditsProviderCount = 0;
  let authFailedProviderCount = 0;
  let rateLimitedProviderCount = 0;
  let localProvidersConsidered = 0;
  let aggregatorsConsidered = 0;
  let routersConsidered = 0;

  // Distinct providers indexed by id; first observation wins.
  const seenProvider = new Map<string, { healthy: boolean; hasCredits: boolean; rateLimited: boolean; isLocal: boolean; isAgg: boolean; isRouter: boolean }>();
  const AGGREGATOR_HINTS = ['aihub', 'openrouter', 'eden', 'cometapi'];
  const ROUTER_HINTS = ['router'];
  for (const c of pool) {
    providers.add(c.providerId);
    if (!seenProvider.has(c.providerId)) {
      const pid = c.providerId.toLowerCase();
      seenProvider.set(c.providerId, {
        healthy: c.providerHealthy,
        hasCredits: c.hasCredits,
        rateLimited: c.rateLimited,
        isLocal: c.isLocal,
        isAgg: AGGREGATOR_HINTS.some((h) => pid.includes(h)),
        isRouter: ROUTER_HINTS.some((h) => pid.includes(h)),
      });
    }
    if (c.providerHealthy && c.hasCredits && !c.rateLimited) {
      usableModelCount++;
    }
  }
  for (const state of seenProvider.values()) {
    if (state.isLocal) localProvidersConsidered++;
    if (state.isAgg) aggregatorsConsidered++;
    if (state.isRouter) routersConsidered++;
    if (!state.healthy) {
      authFailedProviderCount++;
      continue;
    }
    if (!state.hasCredits) {
      noCreditsProviderCount++;
      continue;
    }
    if (state.rateLimited) {
      rateLimitedProviderCount++;
      continue;
    }
    usableProviderCount++;
  }
  const knownTotal =
    usableProviderCount +
    noCreditsProviderCount +
    authFailedProviderCount +
    rateLimitedProviderCount;
  const unknownProviderCount = Math.max(0, seenProvider.size - knownTotal);

  return {
    totalCandidates: pool.length,
    usableProviderCount,
    usableModelCount,
    noCreditsProviderCount,
    authFailedProviderCount,
    rateLimitedProviderCount,
    unknownProviderCount,
    localProvidersConsidered,
    aggregatorsConsidered,
    routersConsidered,
    distinctProvidersConsidered: providers.size,
  };
}
