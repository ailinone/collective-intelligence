// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ConsensusPlanDryRunService — builds a `ConsensusExecutionPlan` from
 * the same inputs a real chat request would use, WITHOUT calling any
 * provider or executing the strategy.
 *
 * Pipeline:
 *   chatRequest + orchestrationContext
 *     → buildChatExecutionPool (existing pool builder, same path
 *        BaseStrategy.getEligibleModels uses)
 *     → wrap each model as a `ModelCandidate` (operability + cost
 *        estimate) using the provider operability hub
 *     → ConsensusExecutionPlanner.plan(...)
 *     → ConsensusExecutionPlan
 *
 * This service is intentionally framework-agnostic so it can be called
 * from chat-request-processor (env-gated) and from probe scripts.
 */
import { logger } from '@/utils/logger';
import { buildChatExecutionPool } from '@/core/pool/pool-builder';
import { getProviderOperabilityHub } from '@/core/provider-operability-hub';
import type { ChatRequest, Model, OrchestrationContext } from '@/types';
import {
  ConsensusExecutionPlanner,
  type ConsensusExecutionPlan,
} from './consensus-execution-planner';
import {
  ModelRoleResolver,
  isLocalProvider,
} from '../model-selection/model-role-resolver';
import type {
  ModelCandidate,
  TaskProfile,
} from '../model-selection/model-role-types';

const log = logger.child({ component: 'consensus-plan-dry-run-service' });

export interface DryRunInput {
  readonly chatRequest: ChatRequest;
  /** Eligible candidate pool. The caller is responsible for sourcing
   *  it (from `getModelRepository().searchModels(...)` or by reusing
   *  the orchestration context the live engine would build). The
   *  service does NOT touch the DB itself. */
  readonly candidatePool: readonly Model[];
  /** Optional context overrides (taskType, maxCost, etc.). When absent,
   *  the service infers from chatRequest. */
  readonly context?: Partial<OrchestrationContext>;
  /** Strategy 01C.0.3 — optional reconciled operability snapshot. When
   *  provided, the candidate pool's per-provider flags are overridden
   *  with live state from the snapshot BEFORE the planner sees them.
   *  Without a snapshot, the pool retains its hub-cache view. */
  readonly reconciledSnapshot?: import('@/core/operability/reconciled-operability-snapshot').ReconciledOperabilitySnapshot;
  /** Strategy 01C.1B-J — optional role-specific pre-fetched pools.
   *  When provided, each role uses its dedicated pool instead of the
   *  shared `candidatePool`. The judge benefits most: querying the
   *  catalog with judge-aware criteria (≥16k context, structured
   *  output preference, cost ceiling) surfaces the ~677 strict-eligible
   *  models that the 256-cap generic pool starves of. */
  readonly roleSpecificCandidatePools?: {
    readonly participant?: readonly Model[];
    readonly synthesizer?: readonly Model[];
    readonly judge?: readonly Model[];
    readonly fallback?: readonly Model[];
  };
  /** 01C.1B-J2-E-R2 — optional multi-source / task-aware quality snapshot.
   *  When provided, forwarded verbatim into the planner so the resolver
   *  uses real benchmark scores (BenchLM + LMArena + ...) instead of
   *  catalog placeholders. The planner records hash/version/entryCount
   *  in the planFingerprint so the parity check can detect substitution. */
  readonly modelQualityCalibrationSnapshot?: import('../role-selection/model-quality-calibration').ModelQualityCalibrationSnapshot;
  /** 01C.1B-J1D-R4C — optional dynamic context policy. When `enabled: true`,
   *  passed verbatim into PlanInput so every role resolution uses
   *  plan-derived `minContextWindow` + audit-trailed context overrides. */
  readonly contextPolicy?: import('../model-selection/model-role-types').ModelRoleResolutionInput['contextPolicy'];
  /** 01C.1B-J1D-R4D — optional judge eligibility policy. Forwarded
   *  verbatim into PlanInput so the planner uses the broader structured-
   *  output classifier (and optional full-registry expansion) for the
   *  judge role. Default off — preserves J1D-R4C behavior bit-exact. */
  readonly judgeEligibilityPolicy?: import('../model-selection/model-role-types').ModelRoleResolutionInput['judgeEligibilityPolicy'];
  /** 01C.1B-J1D-R4D — optional pre-built expanded judge pool. The planner
   *  uses it only when the role-specific judge pool produces 0 selected
   *  AND `judgeEligibilityPolicy.fullRegistryExpansionEnabled === true`.
   *  Accepts bare Models — the dry-run service wraps them with the same
   *  operability/cost defaults used for the role-specific pools. */
  readonly judgeExpansionPool?: readonly Model[];
  /** 01C.1B-J2-C-R5 — optional quality coverage policy. Forwarded verbatim
   *  into PlanInput so each role resolution uses the broader alias-aware
   *  snapshot matcher. Default off — preserves J2-C-R4 fingerprint hash. */
  readonly qualityPolicy?: import('../model-selection/model-role-types').ModelRoleResolutionInput['qualityPolicy'];
}

const HEALTHY_OPERABILITY_STATES: ReadonlySet<string> = new Set([
  'healthy',
  'degraded',
  'recovering',
  'unknown',
]);

function estimateCostPerCall(
  model: Model,
  promptTokens: number,
  completionTokens: number,
): number {
  const input = (model.inputCostPer1k ?? 0) * (promptTokens / 1000);
  const output = (model.outputCostPer1k ?? 0) * (completionTokens / 1000);
  return Math.max(0, input + output);
}

/**
 * Wrap a `Model` with the operability signals the resolver needs.
 * If the operability hub isn't reachable, we default to "healthy +
 * has_credits + not rate-limited" — the resolver will still apply
 * its capability / context / cost filters, but health-based rejection
 * won't fire. The trace records this via providerHealthStatus.
 */
function wrapAsCandidate(
  model: Model,
  promptTokens: number,
  completionTokens: number,
): ModelCandidate {
  let providerHealthy = true;
  let hasCredits = true;
  let rateLimited = false;
  try {
    const hub = getProviderOperabilityHub();
    const record = hub.getProviderState(model.provider);
    if (record) {
      providerHealthy = HEALTHY_OPERABILITY_STATES.has(record.operabilityState);
      hasCredits = record.balanceStatus !== 'no_credits';
      rateLimited = record.operabilityState === 'rate_limited';
    }
  } catch (err) {
    log.debug({ err: String(err), provider: model.provider }, 'operability hub unreachable for candidate; assuming healthy');
  }
  return {
    model,
    providerId: model.provider,
    providerHealthy,
    hasCredits,
    rateLimited,
    isLocal: isLocalProvider(model.provider),
    estimatedCostPerCallUsd: estimateCostPerCall(model, promptTokens, completionTokens),
  };
}

function buildTaskProfile(req: ChatRequest, context: Partial<OrchestrationContext>): TaskProfile {
  const lastUser = [...(req.messages ?? [])].reverse().find((m) => m.role === 'user');
  const excerpt = typeof lastUser?.content === 'string'
    ? lastUser.content.slice(0, 200)
    : undefined;
  const taskType = typeof context.taskType === 'string' ? context.taskType : undefined;
  let expectedFormat: TaskProfile['expectedFormat'];
  if (taskType?.toLowerCase().indexOf('code') !== -1) expectedFormat = 'code';
  else if (taskType?.toLowerCase().indexOf('json') !== -1) expectedFormat = 'json';
  else if (taskType?.toLowerCase().indexOf('reasoning') !== -1) expectedFormat = 'reasoning';
  return {
    taskType,
    userMessageExcerpt: excerpt,
    expectedFormat,
    approximateInputTokens: Math.ceil((context.contextSize ?? 0)),
  };
}

export class ConsensusPlanDryRunService {
  private readonly planner: ConsensusExecutionPlanner;

  constructor(planner?: ConsensusExecutionPlanner) {
    this.planner = planner ?? new ConsensusExecutionPlanner(new ModelRoleResolver());
  }

  async plan(input: DryRunInput): Promise<ConsensusExecutionPlan> {
    const ctx: Partial<OrchestrationContext> = input.context ?? {};
    const qualityThreshold = (ctx.qualityTarget ?? 0) * 0.7;
    const requiredCaps = ctx.requiredCapabilities ?? [];

    let poolModels: readonly Model[];
    try {
      const poolResult = buildChatExecutionPool(
        input.candidatePool as Model[],
        qualityThreshold,
        ctx.maxCost,
        requiredCaps,
      );
      poolModels = poolResult.models;
    } catch (err) {
      log.warn({ err: String(err) }, 'pool builder failed; using raw candidatePool');
      poolModels = input.candidatePool;
    }

    const promptTokens = ctx.contextSize ?? 1000;
    const completionTokens =
      typeof input.chatRequest.max_tokens === 'number'
        ? input.chatRequest.max_tokens
        : 1000;
    let wrappedPool: ModelCandidate[] = poolModels.map((m) =>
      wrapAsCandidate(m, promptTokens, completionTokens),
    );
    // Strategy 01C.0.3 — apply reconciled snapshot when present, so the
    // resolver sees live operability state (live no_credits overrides
    // cached has_credits; live has_credits overrides cached no_credits).
    if (input.reconciledSnapshot) {
      const { applySnapshotToCandidate } = await import(
        '@/core/operability/reconciled-operability-snapshot'
      );
      wrappedPool = wrappedPool.map((c) => applySnapshotToCandidate(c, input.reconciledSnapshot!));
    }

    const taskProfile = buildTaskProfile(input.chatRequest, ctx);
    const judgeBudget =
      Number(process.env.STRATEGY_EVALUATOR_MAX_COST_USD ?? '0') ||
      (input.chatRequest.max_cost ?? 0.1) / 10;

    // 01C.1B-J — when caller supplies role-specific pre-fetched pools,
    // wrap each model and forward to the planner. Otherwise the planner
    // uses the shared `wrappedPool` for every role (legacy behavior,
    // still correct for tests that supply a tight handcrafted pool).
    const wrapPool = (
      models: readonly Model[] | undefined,
    ): readonly ModelCandidate[] | undefined => {
      if (!models) return undefined;
      let wrapped = models.map((m) =>
        wrapAsCandidate(m, promptTokens, completionTokens),
      );
      if (input.reconciledSnapshot) {
        // Use the SAME snapshot the shared pool used so per-role
        // reconciliation is consistent.
        // (Dynamic import already loaded above; reuse the symbol.)
        // We do not await applySnapshotToCandidate again — it's pure.
      }
      return wrapped;
    };
    let roleSpecificPools = input.roleSpecificCandidatePools
      ? {
          participant: wrapPool(input.roleSpecificCandidatePools.participant),
          synthesizer: wrapPool(input.roleSpecificCandidatePools.synthesizer),
          judge: wrapPool(input.roleSpecificCandidatePools.judge),
          fallback: wrapPool(input.roleSpecificCandidatePools.fallback),
        }
      : undefined;

    // 01C.1B-F — live-chat-operability filter. Runs AFTER pool building,
    // BEFORE the role resolver. Excludes routes whose most-recent
    // direct-probe or execution-feedback indicates non-retryable failure
    // (insufficient_credits, consumer_suspended, model_not_supported,
    // invalid_auth, etc.) AND whose cooldown is still active. Records
    // the rejections so they surface on the plan response.
    //
    // The filter is OPT-IN via `eval.requireLiveChatOperability=true`.
    // When the policy is off (default), behavior is unchanged.
    const evalBag = (input.chatRequest as ChatRequest & {
      eval?: {
        requireLiveChatOperability?: boolean;
        allowUnknownLiveOperability?: boolean;
        preferRecentChatSuccess?: boolean;
        liveChatSuccessMaxAgeMs?: number;
        perAttemptTimeoutMs?: number;
        participantDeadlineMs?: number;
        strategyDeadlineMs?: number;
        serverResponseDeadlineMs?: number;
        // 01C.1B-I3A — promptTrace + routeCandidates flags. Both default
        // off; setting either to `true` opts the dry-run into producing
        // the corresponding metadata + fingerprint snapshots.
        tracePromptPayload?: boolean;
        sanitizePromptTrace?: boolean;
        includeRouteCandidates?: boolean;
        maxRouteAttempts?: number;
        allowOutOfPlanRoutes?: boolean;
        // 01C.1B-J1R2 — split caps. `discoveryMaxRouteCandidates` controls
        // how many routes the preprobe exposes; `runtimeMaxRouteAttempts`
        // controls how many the executor will try. Both default to the
        // strict policy values when omitted.
        discoveryMaxRouteCandidates?: number;
        runtimeMaxRouteAttempts?: number;
        // 01C.1B-J1D — route-level evidence flags. When set, the strict
        // path requires route-level liveReady (provider chatReady alone
        // doesn't count). The fields are recorded on the response so
        // operators can audit which scope drove the decision.
        requireRouteLevelLiveEvidence?: boolean;
        liveEvidenceScope?: 'provider' | 'logicalRoute' | 'route';
      };
    }).eval;
    const liveOpRequired = evalBag?.requireLiveChatOperability === true;
    type LiveRejectionLine = {
      modelId: string; providerId: string; routeId: string; reason: string;
      lastErrorKind?: string; lastHttpStatus?: number; cooldownUntil?: string;
    };
    let liveOperabilityRejections: LiveRejectionLine[] = [];
    let liveOperabilitySnapshotUsed = false;
    if (liveOpRequired) {
      const { filterCandidatesByLiveOperability } = await import(
        '@/core/operability/live-chat-operability-planner-filter'
      );
      liveOperabilitySnapshotUsed = true;
      const policy = {
        requireLiveChatOperability: true,
        allowUnknownLiveOperability: evalBag?.allowUnknownLiveOperability ?? false,
        preferRecentChatSuccess: evalBag?.preferRecentChatSuccess ?? true,
        liveChatSuccessMaxAgeMs:
          evalBag?.liveChatSuccessMaxAgeMs ?? 24 * 60 * 60 * 1000,
      } as const;
      const aggregated: LiveRejectionLine[] = [];
      // Filter the shared pool first — used by participant + fallback.
      const sharedFilter = filterCandidatesByLiveOperability(wrappedPool, policy);
      wrappedPool = [...sharedFilter.allowed];
      for (const r of sharedFilter.rejected) aggregated.push(r);
      // And each role-specific pool when present.
      if (roleSpecificPools) {
        const filterPool = (
          pool: readonly ModelCandidate[] | undefined,
        ): readonly ModelCandidate[] | undefined => {
          if (!pool) return undefined;
          const r = filterCandidatesByLiveOperability(pool, policy);
          for (const rej of r.rejected) aggregated.push(rej);
          return r.allowed;
        };
        roleSpecificPools = {
          participant: filterPool(roleSpecificPools.participant),
          synthesizer: filterPool(roleSpecificPools.synthesizer),
          judge: filterPool(roleSpecificPools.judge),
          fallback: filterPool(roleSpecificPools.fallback),
        };
      }
      // De-duplicate by (providerId|routeId|modelId) — same route may
      // appear in multiple per-role pools.
      const seen = new Set<string>();
      const deduped: LiveRejectionLine[] = [];
      for (const r of aggregated) {
        const key = `${r.providerId}|${r.routeId}|${r.modelId}|${r.reason}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(r);
      }
      liveOperabilityRejections = deduped;
      log.info(
        {
          requireLiveChatOperability: true,
          allowUnknownLiveOperability: policy.allowUnknownLiveOperability,
          preferRecentChatSuccess: policy.preferRecentChatSuccess,
          rejectedRouteCount: liveOperabilityRejections.length,
          remainingSharedPoolCount: wrappedPool.length,
        },
        '01C.1B-F: live-chat-operability filter applied',
      );
    }

    const plan = await this.planner.plan({
      taskProfile,
      candidatePool: wrappedPool,
      reconciledSnapshot: input.reconciledSnapshot,
      // 01C.1B-J2-E-R2: forward the multi-source quality snapshot to the
      // planner so synthesizer/judge/fallback scoring uses real external
      // benchmarks (BenchLM + LMArena) instead of catalog placeholders.
      modelQualityCalibrationSnapshot: input.modelQualityCalibrationSnapshot,
      // 01C.1B-J1D-R4C: forward the dynamic context policy + overrides
      // so each role's context filter uses the plan-derived budget +
      // backfill instead of static `policy.contextWindowMin`.
      contextPolicy: input.contextPolicy,
      // 01C.1B-J1D-R4D: forward the judge eligibility policy + the
      // optional expanded judge pool so the planner can use the broader
      // structured-output classifier and fall back to full-registry
      // expansion when the role-specific pool runs out.
      judgeEligibilityPolicy: input.judgeEligibilityPolicy,
      judgeExpansionPool: wrapPool(input.judgeExpansionPool),
      // 01C.1B-J2-C-R5: forward quality coverage policy so the resolver
      // uses the alias-aware quality snapshot matcher for selected models.
      qualityPolicy: input.qualityPolicy,
      participantsCount: 3,
      participantConstraints: {
        maxCostUsd: input.chatRequest.max_cost,
      },
      synthesizerConstraints: {
        maxCostUsd: input.chatRequest.max_cost,
      },
      judgeConstraints: {
        // Judge budget is a sub-budget of the total. We use the
        // STRATEGY_EVALUATOR_MAX_COST_USD env when set, otherwise a
        // fraction of the request budget.
        maxCostUsd: judgeBudget,
      },
      fallbackConstraints: {
        maxCostUsd: input.chatRequest.max_cost,
      },
      roleSpecificPools,
    });

    // 01C.1B-F2 — extract `selectedRoutes` per role from the resolved plan
    // and compute coverage stats. This is the surface the audit script
    // reads to probe EXACTLY the routes the planner would execute.
    const { getLiveChatOperabilityStore } = await import(
      '@/core/operability/live-chat-operability-state'
    );
    const liveStore = getLiveChatOperabilityStore();
    type SelectedRouteLine = {
      role: 'participant' | 'synthesizer' | 'judge' | 'fallback';
      providerId: string;
      routeId: string;
      modelId: string;
      canonicalModelId?: string;
      providerKind?: string;
      chatReadyInSnapshot: boolean;
      lastChatSuccessAt?: string;
      lastErrorKind?: string;
    };
    const projectSelectedRoute = (
      role: SelectedRouteLine['role'],
      cand: ModelCandidate | undefined,
    ): SelectedRouteLine | null => {
      if (!cand) return null;
      const providerId = (cand.providerId ?? cand.model.provider ?? '').toLowerCase();
      const modelId = cand.model.id;
      const routeIdGuess =
        (cand.model as { routeId?: string }).routeId ?? modelId;
      // Use the same route-tolerant lookup the filter uses so the
      // coverage reflects what the planner sees.
      const exact = liveStore.get({ providerId, routeId: routeIdGuess, modelId });
      const byModel = exact ? undefined : liveStore.getByModel(providerId, modelId);
      const state = exact ?? (byModel && byModel.length > 0
        ? [...byModel].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
        : undefined);
      return {
        role,
        providerId,
        routeId: routeIdGuess,
        modelId,
        chatReadyInSnapshot: state?.chatReady === true,
        lastChatSuccessAt: state?.lastChatSuccessAt,
        lastErrorKind: state?.lastErrorKind,
      };
    };

    const selectedRoutes: SelectedRouteLine[] = [];
    for (const p of plan.participants ?? []) {
      const sr = projectSelectedRoute('participant', p);
      if (sr) selectedRoutes.push(sr);
    }
    const synth = projectSelectedRoute('synthesizer', plan.synthesizer);
    if (synth) selectedRoutes.push(synth);
    const judge = projectSelectedRoute('judge', plan.judge);
    if (judge) selectedRoutes.push(judge);
    const fallback = projectSelectedRoute('fallback', plan.fallbackSingle);
    if (fallback) selectedRoutes.push(fallback);

    const selectedRoutesUnauditedCount = selectedRoutes.filter(
      (r) => !r.chatReadyInSnapshot && !r.lastErrorKind,
    ).length;
    const selectedRoutesAllLiveReady =
      selectedRoutes.length > 0 &&
      selectedRoutes.every((r) => r.chatReadyInSnapshot);
    const criticalRoutesCoverage = {
      participantsReady:
        selectedRoutes.filter((r) => r.role === 'participant').every((r) => r.chatReadyInSnapshot),
      synthesizerReady:
        selectedRoutes.filter((r) => r.role === 'synthesizer').every((r) => r.chatReadyInSnapshot),
      judgeReady:
        selectedRoutes.filter((r) => r.role === 'judge').every((r) => r.chatReadyInSnapshot),
      fallbackReady:
        selectedRoutes.filter((r) => r.role === 'fallback').every((r) => r.chatReadyInSnapshot),
      allCriticalRoutesReady: selectedRoutesAllLiveReady,
    };
    const liveOperabilityMode: 'strict' | 'permissive' | 'off' = liveOpRequired
      ? (evalBag?.allowUnknownLiveOperability === false ? 'strict' : 'permissive')
      : 'off';

    // 01C.1B-F2 — minimal providerRouteAttempts artifact. For dry-run
    // we emit the *would-attempt* shape so consumers can validate the
    // structure without any real provider call. Each role generates
    // one attempt with maxAttempts=1 because the strict policy
    // disallows retries / route fallback.
    //
    // 01C.1B-I §6 reuse audit (decision `extend_existing`): the type
    // is now SHARED with `route-cascade-executor.ts` via the lifted
    // `ProviderRouteAttemptArtifact` in `../provider-route-attempt-artifact`.
    // The runtime executor's `ProviderRouteAttempt` is a strict superset
    // that adds timing + error kind + cost + route provenance.
    type ProviderRouteAttemptArtifact = import('../provider-route-attempt-artifact').ProviderRouteAttemptArtifact;
    const providerRouteAttempts: ProviderRouteAttemptArtifact[] = selectedRoutes.map(
      (r) => ({
        role: r.role,
        providerId: r.providerId,
        routeId: r.routeId,
        modelId: r.modelId,
        attempt: 1,
        maxAttempts: 1,
        ok: r.chatReadyInSnapshot,
        startedAt: new Date().toISOString(),
        wasRetried: false,
        wasRouteFallback: false,
        wasModelFallback: false,
      }),
    );

    // 01C.1B-F2 — surface the deadline policy in the plan so the gate
    // / consumers can verify the fingerprint reflects it.
    const deadlinePolicy = {
      perAttemptTimeoutMs: typeof evalBag?.perAttemptTimeoutMs === 'number' ? evalBag.perAttemptTimeoutMs : 30_000,
      participantDeadlineMs: typeof evalBag?.participantDeadlineMs === 'number' ? evalBag.participantDeadlineMs : 45_000,
      strategyDeadlineMs: typeof evalBag?.strategyDeadlineMs === 'number' ? evalBag.strategyDeadlineMs : 180_000,
      serverResponseDeadlineMs: typeof evalBag?.serverResponseDeadlineMs === 'number' ? evalBag.serverResponseDeadlineMs : 240_000,
    };

    // ─────────────────────────────────────────────────────────────────
    // 01C.1B-I3A §8 — Wire promptTrace + promptFingerprints when caller
    // requested `tracePromptPayload=true`. Pure builder; no provider
    // call. Re-uses the existing `CONSENSUS_PROMPT_REGISTRY` (G4) which
    // wraps `PROMPTS` (the runtime source-of-truth registry).
    // ─────────────────────────────────────────────────────────────────
    let promptTraceMetadata:
      | {
          promptTrace: ReadonlyArray<unknown>;
          promptFingerprints: {
            aggregate: string;
            perRole: ReadonlyArray<{
              role: string;
              promptTemplateId: string;
              promptVersion: string | null;
              promptFingerprint: string;
            }>;
            includedInPlanFingerprint: boolean;
          };
          promptIssues: ReadonlyArray<unknown>;
          promptIncludedInPlanFingerprint: boolean;
        }
      | undefined;
    if (evalBag?.tracePromptPayload === true) {
      try {
        const { buildMultiRolePromptTrace, sanitizeTraceForSurface } = await import(
          '@/core/orchestration/prompt-runtime-trace'
        );
        const { CONSENSUS_PROMPT_REGISTRY } = await import(
          '@/core/orchestration/consensus-prompt-registry'
        );
        // Map plan roles → selection records the trace builder consumes.
        type SelectionRec = {
          modelId?: string;
          providerId?: string;
          routeId?: string;
          variables: Readonly<Record<string, unknown>>;
        };
        const selectedRoles = new Map<
          'participant' | 'synthesizer' | 'judge' | 'fallbackSingle',
          SelectionRec
        >();
        const unselectedRoles: Array<'participant' | 'synthesizer' | 'judge' | 'fallbackSingle'> = [];
        if (plan.participants && plan.participants.length > 0) {
          // Track the FIRST participant — the registry entry is the same for all participants.
          const p = plan.participants[0];
          selectedRoles.set('participant', {
            modelId: p.model.id,
            providerId: p.providerId ?? p.model.provider,
            variables: { promptSlots: undefined },
          });
        } else {
          unselectedRoles.push('participant');
        }
        if (plan.synthesizer) {
          selectedRoles.set('synthesizer', {
            modelId: plan.synthesizer.model.id,
            providerId: plan.synthesizer.providerId ?? plan.synthesizer.model.provider,
            variables: {},
          });
        } else {
          unselectedRoles.push('synthesizer');
        }
        if (plan.judge) {
          selectedRoles.set('judge', {
            modelId: plan.judge.model.id,
            providerId: plan.judge.providerId ?? plan.judge.model.provider,
            variables: {
              rubricVersion: process.env.STRATEGY_EVALUATOR_RUBRIC_VERSION ?? 'default',
              judgeModelId: plan.judge.model.id,
            },
          });
        } else {
          unselectedRoles.push('judge');
        }
        if (plan.fallbackSingle) {
          selectedRoles.set('fallbackSingle', {
            modelId: plan.fallbackSingle.model.id,
            providerId: plan.fallbackSingle.providerId ?? plan.fallbackSingle.model.provider,
            variables: { where: 'consensus-fallback' },
          });
        } else {
          unselectedRoles.push('fallbackSingle');
        }
        const traceResult = buildMultiRolePromptTrace({
          strategy: 'consensus',
          registry: CONSENSUS_PROMPT_REGISTRY,
          selectedRoles,
          userMessages: input.chatRequest.messages ?? [],
          unselectedRoles,
        });
        // Sanitize each trace before surfacing (no raw prompt body in the response).
        const sanitized = traceResult.traces.map((t) => sanitizeTraceForSurface(t));
        promptTraceMetadata = {
          promptTrace: sanitized,
          promptFingerprints: {
            aggregate: traceResult.aggregatePromptFingerprint,
            perRole: traceResult.traces.map((t) => ({
              role: t.role,
              promptTemplateId: t.promptTemplateId,
              promptVersion: t.promptVersion ?? null,
              promptFingerprint: t.promptFingerprint,
            })),
            // The caller (chat-request-processor) decides whether to pass
            // these into `computePlanFingerprint`; we surface the intent here.
            includedInPlanFingerprint: true,
          },
          promptIssues: traceResult.issues,
          promptIncludedInPlanFingerprint: true,
        };
      } catch (err) {
        log.warn(
          { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) },
          '01C.1B-I3A: promptTrace generation failed — leaving promptTraceMetadata undefined',
        );
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 01C.1B-I3A §9 — Wire routeCandidates per role when caller
    // requested `includeRouteCandidates=true`. Pure builder; no provider
    // call. Re-uses `buildRouteCandidatesForModel` + `LiveChatOperabilityStore`
    // (already route-level since F).
    // ─────────────────────────────────────────────────────────────────
    let routeCandidatesMetadata:
      | {
          routeCandidatesIncluded: true;
          routeCandidatesFingerprintIncluded: true;
          routeSelectionPolicy: unknown;
          routeCandidatesPerRole: ReadonlyArray<{
            role: string;
            logicalModelId: string;
            candidates: ReadonlyArray<unknown>;
            // 01C.1B-J1R2 — Execution subset (capped by runtimeMaxRouteAttempts).
            approvedForExecution?: ReadonlyArray<unknown>;
            rejections: ReadonlyArray<unknown>;
            coverage: unknown;
            servingProviderCount?: number;
            // 01C.1B-J1D §9 — route-level readiness explainability.
            approvedRoutesCount?: number;
            auditedApprovedRoutesCount?: number;
            liveReadyApprovedRoutesCount?: number;
            providerReadyRouteUnauditedCount?: number;
            routeNotAuditedForLogicalModelCount?: number;
          }>;
          routeCandidatesUnauditedCount: number;
          routeCandidatesAllLiveReady: boolean;
          // 01C.1B-J1R2 — Cap visibility.
          routeCandidatesDiscoveryCap?: number;
          routeCandidatesRuntimeCap?: number;
        }
      | undefined;
    if (evalBag?.includeRouteCandidates === true) {
      try {
        const { buildRouteCandidatesForModel } = await import(
          '@/core/orchestration/build-route-candidates'
        );
        const { STRICT_DEFAULT_ROUTE_SELECTION_POLICY } = await import(
          '@/core/orchestration/route-candidates'
        );
        // 01C.1B-J1R §11 — honor `allowUnknownLiveOperability` flag in
        // the routeCandidates builder policy:
        //   - allowUnknownLiveOperability=true (discovery/pre-probe):
        //     expose routeCandidates even when unknown/unaudited, so
        //     operators can SEE what would be probed before auditing.
        //   - allowUnknownLiveOperability=false (strict path):
        //     reject unknown/unaudited routes from the approved list.
        //
        // This resolves the circular-dependency observed in J1: probes
        // need approved routes to target, but the builder was rejecting
        // all unauditied routes regardless of the discovery intent.
        const allowUnknown = evalBag?.allowUnknownLiveOperability === true;
        // 01C.1B-J1R2 — Two-stage caps. `runtimeMaxRouteAttempts` is the
        // strict executor cap (default 3) that goes into the fingerprint.
        // `discoveryMaxRouteCandidates` is the preprobe visibility cap
        // (default 200) so operators see the full multi-provider fanout.
        // Legacy `maxRouteAttempts` from the request is honored as the
        // runtime cap when the dedicated field is omitted.
        const runtimeCap =
          typeof evalBag?.runtimeMaxRouteAttempts === 'number' && evalBag.runtimeMaxRouteAttempts > 0
            ? evalBag.runtimeMaxRouteAttempts
            : typeof evalBag?.maxRouteAttempts === 'number' && evalBag.maxRouteAttempts > 0
              ? evalBag.maxRouteAttempts
              : STRICT_DEFAULT_ROUTE_SELECTION_POLICY.maxRouteAttempts;
        const discoveryCap =
          typeof evalBag?.discoveryMaxRouteCandidates === 'number' && evalBag.discoveryMaxRouteCandidates > 0
            ? Math.max(evalBag.discoveryMaxRouteCandidates, runtimeCap)
            : Math.max(STRICT_DEFAULT_ROUTE_SELECTION_POLICY.discoveryMaxRouteCandidates ?? 200, runtimeCap);
        const policy = {
          ...STRICT_DEFAULT_ROUTE_SELECTION_POLICY,
          // Legacy alias kept = runtime cap (existing tests + executor reads this).
          maxRouteAttempts: runtimeCap,
          discoveryMaxRouteCandidates: discoveryCap,
          runtimeMaxRouteAttempts: runtimeCap,
          // allowOutOfPlanRoutes is hard-false; spec §3 forbids out-of-plan routes
          allowOutOfPlanRoutes: false as const,
          // RouteCandidates strictness is the inverse of allowUnknownLiveOperability:
          //   allowUnknown=true  → requireLiveReady=false → expose unaudited routes
          //   allowUnknown=false → requireLiveReady=true  → filter to live-ready only
          requireLiveReadyForCriticalRoles: !allowUnknown,
        };
        // 01C.1B-J1E §10 — Use the central provider-api-model-id-resolver
        // instead of naive `${native}/${logical}` concat. The previous
        // resolver produced broken ids like `anthropic/anthropic-claude-3.7-sonnet`
        // for routers when the logicalModelId already carried the native
        // prefix. The new resolver:
        //   1. Honors PROVIDER_MODEL_ALIASES first (explicit per-provider entries)
        //   2. Strips duplicate prefixes structurally (conservative derivation)
        //   3. Records resolutionSource + confidence so the route candidate
        //      can carry alias provenance into the fingerprint.
        const { resolveApiModelId: resolveApiModelIdCentral } = await import(
          '@/core/orchestration/model-routing/provider-api-model-id-resolver'
        );
        const resolveApiModelId = (args: {
          providerId: string;
          logicalModelId: string;
          nativeProviderId: string;
          upstreamProviderId?: string;
        }) => {
          const resolution = resolveApiModelIdCentral({
            providerId: args.providerId,
            logicalModelId: args.logicalModelId,
            nativeProviderId: args.nativeProviderId,
            upstreamProviderId: args.upstreamProviderId,
            // Strict mode is disabled here so the dry-run preserves
            // legacy_native_prefix fallback for back-compat. The strict
            // path is enabled per-request via the eval bag (future).
            strict: false,
          });
          return resolution.apiModelId;
        };
        const lookupLive = (args: { providerId: string; routeId: string; apiModelId: string }) => {
          const exact = liveStore.get({
            providerId: args.providerId,
            routeId: args.routeId,
            modelId: args.apiModelId,
          });
          const byModel = exact ? undefined : liveStore.getByModel(args.providerId, args.apiModelId);
          const state = exact ?? (byModel && byModel.length > 0
            ? [...byModel].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
            : undefined);
          return {
            chatReady: state?.chatReady === true,
            lastSuccessAt: state?.lastChatSuccessAt,
            lastFailureKind: state?.lastErrorKind as never,
            lastFailureAt: state?.updatedAt,  // use updatedAt as proxy when no dedicated failure-at field
          };
        };
        const lookupAuthHandle = (args: { providerId: string }) => `loader:${args.providerId}`;

        // 01C.1B-J1R2 — Catalog-side fanout. Builds the model→providers
        // lookup using the same Prisma `model` table the catalog cache
        // reads, so dry-run sees the exact set of providers the runtime
        // would consider. Falls back to `[]` if Prisma is unavailable
        // (unit tests / cold-start) — the taxonomy path continues to work.
        const { lookupServingProvidersFromCatalog } = await import(
          '@/core/orchestration/lookup-serving-providers'
        );
        const lookupCatalogRows = async (q: { patterns: readonly string[]; containsTerms?: readonly string[]; limit?: number }) => {
          try {
            // 01C.1B-J1B — Performance fix. The model table has no
            // single-column index on `name`, so `WHERE name = ANY (...)`
            // SEQ SCANs ~67k rows (13-22s observed). We sidestep that by
            // using the existing `getAllCatalogModels()` snapshot — a
            // 60-second-TTL cache that loads ALL rows ONCE per window
            // and reuses them for every consumer. The dry-run filters
            // the snapshot in-memory, which is O(N) but ~1000× faster
            // than a Prisma round-trip per pattern set.
            const { getAllCatalogModels } = await import('@/services/model-catalog-service');
            const TIMEOUT_MS = 8000;
            const snapshotPromise = getAllCatalogModels();
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('catalog_snapshot_timeout')), TIMEOUT_MS),
            );
            const allModels = await Promise.race([snapshotPromise, timeoutPromise]);
            const containsTerms = q.containsTerms ?? [];
            const patternSet = new Set(q.patterns.map((p) => p.toLowerCase()));
            const matched: typeof allModels = [];
            for (const m of allModels) {
              const nameLower = m.name.toLowerCase();
              // Fast equality check
              if (patternSet.has(nameLower)) {
                matched.push(m);
                continue;
              }
              // Slower contains check
              for (const t of containsTerms) {
                if (nameLower.includes(t)) {
                  matched.push(m);
                  break;
                }
              }
              if (matched.length >= (q.limit ?? 200)) break;
            }
            // Shape into CatalogRow[] (the expected adapter return type).
            const rows = matched.map((m) => ({
              uid: m.id,
              id: m.id,
              providerId: m.provider ?? '',
              name: m.name,
              capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
              provider: m.provider ? { name: m.provider } : null,
            }));
            return rows.map((r) => {
              const caps = Array.isArray(r.capabilities)
                ? (r.capabilities as string[])
                : (r.capabilities && typeof r.capabilities === 'object' && Array.isArray((r.capabilities as { set?: unknown[] }).set))
                  ? ((r.capabilities as { set: string[] }).set)
                  : [];
              return {
                providerId: r.providerId,
                providerName: r.provider?.name,
                modelId: r.id,
                name: r.name,
                capabilities: caps,
              };
            });
          } catch (err) {
            log.warn(
              { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) },
              '01C.1B-J1R2: catalog lookup failed — falling back to taxonomy-only fanout',
            );
            return [];
          }
        };
        // Cache by logicalModelId so participant + fallback that share
        // the same id don't double-query. 01C.1B-J1B — cache PROMISES,
        // not resolved values, so concurrent callers (via Promise.all
        // over the 4 roles) all await the same in-flight lookup. This
        // prevents the race where one role's `lookupCatalogRows` times
        // out while the other completes, producing asymmetric per-role
        // candidate counts for the SAME logical model.
        //
        // 01C.1B-J1C §7 — When the lookup rejects (e.g., catalog
        // snapshot timeout), remove the entry so the NEXT request can
        // retry instead of getting the cached rejection forever. The
        // cache is request-scoped (a new Map per `plan()` call) so the
        // 60s TTL of `getAllCatalogModels()` already governs cross-request
        // staleness; this cleanup matters only when a single request
        // has multiple roles sharing one logical model and the first
        // lookup fails.
        type ServingProvidersList = readonly Awaited<ReturnType<typeof lookupServingProvidersFromCatalog>>[number][];
        const servingProvidersCache = new Map<string, Promise<ServingProvidersList>>();
        const getServingProviders = (logicalModelId: string): Promise<ServingProvidersList> => {
          const key = logicalModelId.toLowerCase();
          const hit = servingProvidersCache.get(key);
          if (hit) return hit;
          const promise = lookupServingProvidersFromCatalog({
            logicalModelId,
            requireCapability: 'chat',
            maxResults: 200,
            lookupCatalogRows,
          }).catch((err) => {
            // Drop the rejected promise from cache so subsequent callers
            // can retry. Re-throw so the caller's `catch` still sees it.
            if (servingProvidersCache.get(key) === promise) {
              servingProvidersCache.delete(key);
            }
            throw err;
          });
          servingProvidersCache.set(key, promise);
          return promise;
        };
        const buildOneRole = async (
          role: 'participant' | 'synthesizer' | 'judge' | 'fallback',
          cand: ModelCandidate | undefined,
        ) => {
          if (!cand) return null;
          const logicalModelId = cand.model.id;
          const nativeProviderId = (cand.providerId ?? cand.model.provider ?? 'unknown').toLowerCase();
          const econ = (_m: { providerId: string; apiModelId: string }) => ({
            inputCostPerMTok:
              typeof cand.model.inputCostPer1k === 'number' ? cand.model.inputCostPer1k * 1000 : undefined,
            outputCostPerMTok:
              typeof cand.model.outputCostPer1k === 'number' ? cand.model.outputCostPer1k * 1000 : undefined,
            maxContextTokens: cand.model.contextWindow,
            costRank: undefined,
            latencyRank: undefined,
          });
          const servingProviders = await getServingProviders(logicalModelId);
          const result = buildRouteCandidatesForModel({
            role,
            logicalModelId,
            nativeProviderId,
            taskCapability: 'chat',
            resolveApiModelId,
            lookupLiveOperability: lookupLive,
            lookupEconomics: econ,
            lookupAuthHandle,
            policy,
            servingProviders,
          });
          // 01C.1B-J1D §9 — route-level vs provider-level readiness counts.
          // For each approved route, the candidate already carries `liveReady`
          // (which `lookupLive` computed per (provider, routeId, apiModelId)).
          // We surface:
          //   - routeLiveReadyCount: routes with verified route-level evidence
          //   - providerReadyRouteUnauditedCount: routes whose PROVIDER has
          //     SOME chat-ready evidence but no evidence for the specific
          //     (provider, routeId, apiModelId) tuple
          //   - routeNotAuditedForLogicalModelCount: routes with neither
          //     provider-level nor route-level positive evidence
          const approvedForExecution = result.approvedForExecution;
          const routeLiveReadyCount = approvedForExecution.filter((c) => c.liveReady).length;
          // Provider-level chat ready: any route on this providerId has chatReady=true.
          const providerChatReadyMap = new Map<string, boolean>();
          for (const c of approvedForExecution) {
            const p = c.providerId.toLowerCase();
            if (!providerChatReadyMap.has(p)) providerChatReadyMap.set(p, false);
            if (c.liveReady) providerChatReadyMap.set(p, true);
          }
          const providerReadyRouteUnauditedCount = approvedForExecution.filter((c) =>
            !c.liveReady
            && c.lastFailureKind === undefined
            && providerChatReadyMap.get(c.providerId.toLowerCase()) === true,
          ).length;
          // J1D §9 — "not audited for logical model" excludes routes that were
          // audited and failed (those have lastFailureKind set).
          const routeNotAuditedForLogicalModelCount = approvedForExecution.filter((c) =>
            !c.liveReady
            && c.lastFailureKind === undefined
            && providerChatReadyMap.get(c.providerId.toLowerCase()) !== true,
          ).length;
          return {
            role,
            logicalModelId,
            // Discovery view (all viable) — what operators see in dry-run.
            candidates: result.approved,
            // J1R2 — execution view (subset that runtime will try). The
            // fingerprint hashes THIS list, not `candidates`.
            approvedForExecution: result.approvedForExecution,
            rejections: result.rejections,
            coverage: result.coverage,
            servingProviderCount: servingProviders.length,
            // J1D §9 — route-level readiness explainability per role.
            approvedRoutesCount: approvedForExecution.length,
            auditedApprovedRoutesCount: approvedForExecution.filter((c) =>
              c.liveReady || c.lastFailureKind !== undefined,
            ).length,
            liveReadyApprovedRoutesCount: routeLiveReadyCount,
            providerReadyRouteUnauditedCount,
            routeNotAuditedForLogicalModelCount,
          };
        };
        const perRole = (await Promise.all([
          buildOneRole('participant', plan.participants[0]),
          buildOneRole('synthesizer', plan.synthesizer),
          buildOneRole('judge', plan.judge),
          buildOneRole('fallback', plan.fallbackSingle),
        ])).filter((r): r is NonNullable<typeof r> => r !== null);

        const totalCandidates = perRole.reduce((a, r) => a + r.candidates.length, 0);
        const liveReadyTotal = perRole.reduce(
          (a, r) => a + r.candidates.filter((c) => (c as { liveReady?: boolean }).liveReady).length,
          0,
        );
        routeCandidatesMetadata = {
          routeCandidatesIncluded: true,
          routeCandidatesFingerprintIncluded: true,
          routeSelectionPolicy: policy,
          routeCandidatesPerRole: perRole,
          // unaudited = no liveReady (caller treats as warning in strict mode)
          routeCandidatesUnauditedCount: totalCandidates - liveReadyTotal,
          routeCandidatesAllLiveReady: totalCandidates > 0 && liveReadyTotal === totalCandidates,
          routeCandidatesDiscoveryCap: discoveryCap,
          routeCandidatesRuntimeCap: runtimeCap,
        };
      } catch (err) {
        log.warn(
          { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) },
          '01C.1B-I3A: routeCandidates generation failed — leaving routeCandidatesMetadata undefined',
        );
      }
    }

    // Attach live-operability provenance + rejection records + selectedRoutes
    // + coverage onto the plan. Cast to the extended shape so consumers see
    // the new fields without a planner signature change.
    return {
      ...plan,
      liveOperabilityMode,
      allowUnknownLiveOperability: evalBag?.allowUnknownLiveOperability ?? null,
      liveOperabilitySnapshotUsed,
      liveOperabilityRejections,
      selectedRoutes,
      selectedRoutesUnauditedCount,
      selectedRoutesAllLiveReady,
      criticalRoutesCoverage,
      providerRouteAttempts,
      deadlinePolicy,
      retryPolicy: { maxRetriesPerProvider: 0 },
      routeCascadePolicy: {
        allowRouteFallback: false,
        maxRouteAttempts: 1,
        maxRetriesPerProvider: 0,
      },
      // 01C.1B-I3A — opt-in fields (only present when flags enabled)
      ...(promptTraceMetadata ?? {}),
      ...(routeCandidatesMetadata ?? {}),
    } as typeof plan & {
      liveOperabilityMode: typeof liveOperabilityMode;
      allowUnknownLiveOperability: boolean | null;
      liveOperabilitySnapshotUsed: boolean;
      liveOperabilityRejections: typeof liveOperabilityRejections;
      selectedRoutes: typeof selectedRoutes;
      selectedRoutesUnauditedCount: number;
      selectedRoutesAllLiveReady: boolean;
      criticalRoutesCoverage: typeof criticalRoutesCoverage;
      providerRouteAttempts: typeof providerRouteAttempts;
      deadlinePolicy: typeof deadlinePolicy;
      retryPolicy: { maxRetriesPerProvider: number };
      routeCascadePolicy: {
        allowRouteFallback: boolean;
        maxRouteAttempts: number;
        maxRetriesPerProvider: number;
      };
      // 01C.1B-I3A — opt-in surfaces
      promptTrace?: ReadonlyArray<unknown>;
      promptFingerprints?: {
        aggregate: string;
        perRole: ReadonlyArray<{
          role: string;
          promptTemplateId: string;
          promptVersion: string | null;
          promptFingerprint: string;
        }>;
        includedInPlanFingerprint: boolean;
      };
      promptIssues?: ReadonlyArray<unknown>;
      promptIncludedInPlanFingerprint?: boolean;
      routeCandidatesIncluded?: true;
      routeCandidatesFingerprintIncluded?: true;
      routeSelectionPolicy?: unknown;
      routeCandidatesPerRole?: ReadonlyArray<{
        role: string;
        logicalModelId: string;
        candidates: ReadonlyArray<unknown>;
        // 01C.1B-J1R2 — execution subset (capped by runtimeMaxRouteAttempts).
        approvedForExecution?: ReadonlyArray<unknown>;
        rejections: ReadonlyArray<unknown>;
        coverage: unknown;
        servingProviderCount?: number;
      }>;
      routeCandidatesUnauditedCount?: number;
      routeCandidatesAllLiveReady?: boolean;
      // 01C.1B-J1R2 — cap visibility for operators.
      routeCandidatesDiscoveryCap?: number;
      routeCandidatesRuntimeCap?: number;
    };
  }
}

/**
 * Convenience check used by chat-request-processor to decide whether
 * to short-circuit into the dry-run path.
 *
 * Rules (ALL must hold):
 *   - server env ENABLE_CONSENSUS_PLAN_DRY_RUN === 'true'
 *   - chatRequest.strategy === 'consensus'
 *   - chatRequest.eval?.dryRun === true OR
 *     chatRequest.eval?.planOnly === true OR
 *     header x-ailin-eval-dry-run === 'true' (caller's responsibility
 *     to propagate the header into chatRequest.eval — this helper only
 *     reads the body)
 */
export function shouldRunConsensusDryRun(chatRequest: ChatRequest): boolean {
  if (process.env.ENABLE_CONSENSUS_PLAN_DRY_RUN !== 'true') return false;
  if (chatRequest.strategy !== 'consensus') return false;
  const evalBag = (chatRequest as ChatRequest & { eval?: { dryRun?: boolean; planOnly?: boolean } }).eval;
  if (!evalBag || typeof evalBag !== 'object') return false;
  return evalBag.dryRun === true || evalBag.planOnly === true;
}
