// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-P — Shared role-specific candidate pool builder.
 *
 * Centralizes the per-role catalog query that 01C.1B-J introduced so
 * BOTH the dry-run path AND the real execution path (when reconstructing
 * a plan to compare against the approved fingerprint) use the SAME
 * source data. Without this single-source-of-truth, dry-run could
 * approve a plan derived from a 512-cap judge-aware pool while real
 * execution recomputes against a 64-cap generic pool — and the resulting
 * fingerprints would never match, leading either to spurious
 * `PLAN_EXECUTION_PARITY_FAILED` errors or (worse) to silent divergence.
 *
 * The builder is intentionally framework-agnostic:
 *   - takes a `ModelRepositoryLike` so tests can inject a fake DB,
 *   - emits both raw `Model` arrays AND lightweight `roleCandidateStats`
 *     so callers can attach per-role audit data without re-querying.
 *
 * The pool sizes / sort orders mirror the 01C.1B-J judge audit findings:
 *   - judge:        ≥16k context, sortBy quality, limit 512
 *   - synthesizer:  ≥32k context, sortBy quality, limit 256
 *   - participant + fallback share the generic 256-cap pool — their
 *     constraints (chat-capable, ≥8k context, no structured-output
 *     requirement) are comfortably satisfied by usage-sorted samples.
 */
import type { Model, ModelCapability } from '@/types';
import type { LiveChatOperabilityState } from '@/core/operability/live-chat-operability-state';
import {
  buildLiveReadyCandidateDedupeKey,
  injectLiveReadyCandidatesIntoRolePool,
  isStateCurrentlyEligible,
  type LiveReadyCandidateInjectionPolicy,
  type LiveReadyCandidateInjectionResult,
  type LiveReadyInjectionMetadata,
} from './live-ready-candidate-injection';

/** Minimal surface this module needs from the repository. Defined locally
 *  so tests can supply a tiny fake without depending on the full DB. */
export interface ModelRepositoryLike {
  searchModels(criteria: {
    status?: 'active' | 'inactive' | 'maintenance';
    capabilities?: readonly ModelCapability[];
    minContextWindow?: number;
    sortBy?: 'cost' | 'quality' | 'context' | 'performance' | 'reliability';
    sortOrder?: 'asc' | 'desc';
    limit?: number;
  }): Promise<Model[]>;
}

/** 01C.1B-J1D-R4A — minimal surface the live-ready injector needs from
 *  the LiveChatOperabilityStore. Defined here so the pool builder stays
 *  decoupled from the concrete singleton and tests can fake it.
 *  `snapshot()` returns ALL known states; the injector filters internally. */
export interface LiveChatOperabilityStoreLike {
  snapshot(): readonly LiveChatOperabilityState[];
}

export interface RoleSpecificPoolBuilderOptions {
  readonly repo: ModelRepositoryLike;
  /** Generic shared pool size — used as fallback for participant + fallback
   *  roles when their dedicated query is unnecessary. Default 256. */
  readonly sharedPoolLimit?: number;
  /** Judge-specific pool size. 01C.1B-J audit showed 512 is generous —
   *  the catalog has ~2,470 ctx≥16k chat-capable models. */
  readonly judgePoolLimit?: number;
  /** Synthesizer-specific pool size. ~2,000 ctx≥32k models in catalog,
   *  256 is sufficient for top-quality picks. */
  readonly synthesizerPoolLimit?: number;
  /** When provided, the judge query is restricted to `inputCostPer1k ≤
   *  maxCostPer1kJudge`. Mirrors `STRATEGY_EVALUATOR_MAX_COST_USD`. */
  readonly maxCostPer1kJudge?: number;

  // ─── 01C.1B-J1D-R4A — live-ready injection options ────────────────────

  /** When true AND `liveOperabilityStore` is provided, union live-ready
   *  catalog rows from the store into each per-role pool BEFORE the
   *  caller applies the live-operability filter. Default false — when
   *  omitted, the pool builder behaves exactly as it did pre-R4A. */
  readonly injectLiveReadyFromStore?: boolean;
  /** Live operability store the injector pulls chatReady states from.
   *  Required when `injectLiveReadyFromStore=true`; ignored otherwise. */
  readonly liveOperabilityStore?: LiveChatOperabilityStoreLike;
  /** Optional snapshot hash that uniquely identifies the in-store data
   *  set. Threaded into injection metadata + plan fingerprint so the
   *  parity check detects substitution. */
  readonly liveOperabilitySnapshotHash?: string;
  /** Optional snapshot path for audit trail (not loaded; just recorded). */
  readonly liveOperabilitySnapshotPath?: string;
  /** Optional override for the injection policy. Defaults to
   *  DEFAULT_LIVE_READY_INJECTION_POLICY. */
  readonly liveReadyInjectionPolicy?: LiveReadyCandidateInjectionPolicy;
}

/** 01C.1B-J1D-R4A — per-role injection trace surfaced on the plan. The
 *  caller (DryRunService) attaches this to the plan output + fingerprint. */
export interface LiveReadyInjectionPerRoleTrace {
  readonly role: 'participant' | 'synthesizer' | 'judge' | 'fallback';
  readonly baseCandidateCount: number;
  readonly liveReadyStatesSeen: number;
  readonly catalogMatches: number;
  readonly injectedLiveReadyCount: number;
  readonly dedupedExistingLiveReadyCount: number;
  readonly postInjectionCandidateCount: number;
  readonly injectedCandidates: ReadonlyArray<{
    readonly logicalModelId: string;
    readonly providerId: string;
    readonly apiModelId?: string;
    readonly routeId?: string;
  }>;
  readonly rejectionCounts: Readonly<Record<string, number>>;
  readonly metadata: LiveReadyInjectionMetadata;
}

export interface RoleSpecificPools {
  /** The shared (legacy) generic pool. Used as fallback when a role
   *  doesn't get its own dedicated query (currently participant +
   *  fallback). Always populated. */
  readonly sharedPool: readonly Model[];
  /** Role-specific pools. `undefined` means the role should use
   *  `sharedPool` instead. */
  readonly participantPool?: readonly Model[];
  readonly synthesizerPool?: readonly Model[];
  readonly judgePool?: readonly Model[];
  readonly fallbackPool?: readonly Model[];
  /** Lightweight per-role stats. Surfaced on the plan via
   *  `roleCandidateStats.<role>.sourceUniverseCount`. */
  readonly roleCandidateStats: {
    readonly participant: { readonly sourceUniverseCount: number; readonly source: 'shared_pool' | 'role_specific_pool' };
    readonly synthesizer: { readonly sourceUniverseCount: number; readonly source: 'shared_pool' | 'role_specific_pool'; readonly minContextWindow?: number };
    readonly judge: { readonly sourceUniverseCount: number; readonly source: 'shared_pool' | 'role_specific_pool'; readonly minContextWindow?: number; readonly maxCostPer1k?: number };
    readonly fallback: { readonly sourceUniverseCount: number; readonly source: 'shared_pool' | 'role_specific_pool' };
  };
  /** 01C.1B-J1D-R4A — present ONLY when `injectLiveReadyFromStore` was
   *  enabled AND the store yielded at least zero matches. Undefined when
   *  the flag was off (preserves pre-R4A behavior surface). */
  readonly liveReadyInjection?: {
    readonly enabled: boolean;
    readonly source: 'live_operability_store';
    readonly snapshotHash?: string;
    readonly snapshotPath?: string;
    readonly byRole: ReadonlyArray<LiveReadyInjectionPerRoleTrace>;
  };
}

/**
 * Build role-specific candidate pools from the catalog. SAME function
 * is used by:
 *   - `applyDryRunFailClosedGate` (chat-request-processor.ts) for the
 *     dry-run short-circuit path,
 *   - the planned-but-not-yet-implemented `executionParityCheck` path,
 *   - the future real-execution path when reconstructing the plan to
 *     compare fingerprints.
 *
 * Failures of role-specific queries are NOT fatal: the caller falls
 * back to the shared pool and the role's `sourceUniverseCount` reflects
 * the smaller pool (visible in `roleCandidateStats`).
 */
export async function buildConsensusRoleSpecificCandidatePools(
  opts: RoleSpecificPoolBuilderOptions,
): Promise<RoleSpecificPools> {
  const sharedPoolLimit = opts.sharedPoolLimit ?? 256;
  const judgePoolLimit = opts.judgePoolLimit ?? 512;
  const synthesizerPoolLimit = opts.synthesizerPoolLimit ?? 256;

  // Shared generic pool — always populated.
  const sharedPool = await opts.repo.searchModels({
    status: 'active',
    capabilities: ['chat'],
    limit: sharedPoolLimit,
  });

  // Judge pool: ≥16k context, sortBy quality, optional cost cap.
  let judgePool: readonly Model[] | undefined;
  try {
    judgePool = await opts.repo.searchModels({
      status: 'active',
      capabilities: ['chat'],
      minContextWindow: 16000,
      sortBy: 'quality',
      sortOrder: 'desc',
      limit: judgePoolLimit,
    });
  } catch {
    // Fail silently — judge will fall back to sharedPool.
    judgePool = undefined;
  }

  // Synthesizer pool: ≥32k context, sortBy quality.
  let synthesizerPool: readonly Model[] | undefined;
  try {
    synthesizerPool = await opts.repo.searchModels({
      status: 'active',
      capabilities: ['chat'],
      minContextWindow: 32000,
      sortBy: 'quality',
      sortOrder: 'desc',
      limit: synthesizerPoolLimit,
    });
  } catch {
    synthesizerPool = undefined;
  }

  // Participant + fallback: use shared pool. Their constraints are
  // looser; the 256-cap sample already satisfies them.
  let participantPool: readonly Model[] | undefined = undefined;
  let fallbackPool: readonly Model[] | undefined = undefined;
  let augmentedSharedPool: readonly Model[] = sharedPool;
  let augmentedSynthesizerPool = synthesizerPool;
  let augmentedJudgePool = judgePool;

  // ─── 01C.1B-J1D-R4A — live-ready injection ──────────────────────────
  //
  // When enabled, augment each per-role catalog pool with live-ready
  // models from the store (resolved against the catalog so we never
  // fabricate). Default off — preserves pre-R4A behavior surface.
  let liveReadyInjection: RoleSpecificPools['liveReadyInjection'] | undefined;

  if (opts.injectLiveReadyFromStore && opts.liveOperabilityStore) {
    const allStates = opts.liveOperabilityStore.snapshot();
    const eligibleStates = allStates.filter((s) => isStateCurrentlyEligible(s));

    // Cache catalog rows for the eligible (providerId, modelId) pairs.
    // This is a single DB query (status=active, no limit) filtered in
    // memory by the eligible set. Keeps lookups O(1) thereafter.
    const eligibleProviderModelPairs = new Set(
      eligibleStates.map((s) => `${s.providerId.toLowerCase()}|${s.modelId.toLowerCase()}`),
    );
    const catalogIndex = new Map<string, Model[]>();
    if (eligibleStates.length > 0) {
      // We do NOT widen the limit (would re-introduce the J1D-R3 gap on
      // the OTHER side). Instead, query unrestricted by chat capability —
      // the live-ready filter already gated the relevant models. Cap is
      // still large enough to cover any single-stage operator workflow
      // (up to 10k entries), but only the ones matching the eligible
      // (provider, model) pairs are indexed.
      const catalogRows = await opts.repo.searchModels({
        status: 'active',
        capabilities: ['chat'],
        limit: 10_000,
      });
      for (const row of catalogRows) {
        const key = `${row.provider.toLowerCase()}|${row.id.toLowerCase()}`;
        if (!eligibleProviderModelPairs.has(key)) continue;
        const arr = catalogIndex.get(key) ?? [];
        arr.push(row);
        catalogIndex.set(key, arr);
      }
    }

    const resolveCatalog = (state: LiveChatOperabilityState): Model | Model[] | undefined => {
      const key = `${state.providerId.toLowerCase()}|${state.modelId.toLowerCase()}`;
      const rows = catalogIndex.get(key);
      if (!rows || rows.length === 0) return undefined;
      if (rows.length > 1) return rows; // injector treats as ambiguous
      return rows[0];
    };

    const projectCandidateKey = (m: Model, role: string) =>
      buildLiveReadyCandidateDedupeKey({
        role,
        logicalModelId: m.id,
        providerId: m.provider,
        apiModelId: m.id,
      });
    const projectStateKey = (s: LiveChatOperabilityState, role: string) =>
      buildLiveReadyCandidateDedupeKey({
        role,
        logicalModelId: s.modelId,
        providerId: s.providerId,
        apiModelId: s.modelId,
        routeId: s.routeId,
      });
    const candidateSupportsRole = (m: Model, _role: string): boolean =>
      Array.isArray(m.capabilities) && m.capabilities.includes('chat' as ModelCapability);
    const attachInjectionMetadata = (m: Model, _metadata: LiveReadyInjectionMetadata): Model =>
      // The pool builder works at Model granularity. Per-candidate injection
      // metadata is recorded centrally in `liveReadyInjection.byRole[].injectedCandidates`
      // (not mutated onto the Model — Model is shared across roles). The
      // downstream wrapper (`wrapAsCandidate` in ConsensusPlanDryRunService)
      // can carry per-role metadata if needed in a future stage.
      m;
    const projectStateForTrace = (s: LiveChatOperabilityState) => ({
      logicalModelId: s.modelId,
      providerId: s.providerId,
      apiModelId: s.modelId,
      routeId: s.routeId,
      source: 'live_operability_store' as const,
    });

    const runForRole = (
      role: 'participant' | 'synthesizer' | 'judge' | 'fallback',
      basePool: readonly Model[],
    ): { newPool: readonly Model[]; trace: LiveReadyInjectionPerRoleTrace } => {
      const result: LiveReadyCandidateInjectionResult<Model> = injectLiveReadyCandidatesIntoRolePool({
        role,
        baseCandidates: basePool,
        liveReadyStates: eligibleStates,
        resolveCatalogCandidate: resolveCatalog,
        candidateSupportsRole,
        projectCandidateKey,
        projectStateKey,
        attachInjectionMetadata,
        projectStateForTrace,
        stateIsEligible: () => true, // we already pre-filtered eligibleStates
        stateProvider: (s) => s.providerId,
        stateModel: (s) => s.modelId,
        policy: opts.liveReadyInjectionPolicy,
        snapshotHash: opts.liveOperabilitySnapshotHash,
        snapshotPath: opts.liveOperabilitySnapshotPath,
      });

      const rejectionCounts: Record<string, number> = {};
      for (const r of result.rejected) {
        rejectionCounts[r.reason] = (rejectionCounts[r.reason] ?? 0) + 1;
      }
      const newPool: Model[] = [...basePool, ...result.injectedCandidates];
      return {
        newPool,
        trace: {
          role,
          baseCandidateCount: result.baseCandidateCount,
          liveReadyStatesSeen: result.liveReadyStatesSeen,
          catalogMatches: result.catalogMatches,
          injectedLiveReadyCount: result.injectedCandidates.length,
          dedupedExistingLiveReadyCount: result.dedupedExistingCandidates.length,
          postInjectionCandidateCount: newPool.length,
          injectedCandidates: result.injectedCandidates.map((m) => ({
            logicalModelId: m.id,
            providerId: m.provider,
            apiModelId: m.id,
          })),
          rejectionCounts,
          metadata: result.metadata,
        },
      };
    }

    const sharedRun = runForRole('participant', sharedPool);
    augmentedSharedPool = sharedRun.newPool;
    // participant + fallback share augmented shared pool; record per-role
    // traces so each role's trace exists in the output.
    participantPool = augmentedSharedPool;
    fallbackPool = augmentedSharedPool;
    const fallbackRun = runForRole('fallback', sharedPool);
    // (We use the same augmented sharedPool above; this run records the
    // independent rejection set + injection trace for the fallback role.)

    const synthRun = synthesizerPool
      ? runForRole('synthesizer', synthesizerPool)
      : runForRole('synthesizer', sharedPool);
    augmentedSynthesizerPool = synthesizerPool ? synthRun.newPool : synthesizerPool;
    // For synthesizer / judge: when role-specific pool exists, we
    // augment it. When it doesn't, the role falls back to the shared
    // pool which is already augmented above — so we just record the
    // trace without changing pool wiring.

    const judgeRun = judgePool
      ? runForRole('judge', judgePool)
      : runForRole('judge', sharedPool);
    augmentedJudgePool = judgePool ? judgeRun.newPool : judgePool;

    liveReadyInjection = {
      enabled: true,
      source: 'live_operability_store',
      snapshotHash: opts.liveOperabilitySnapshotHash,
      snapshotPath: opts.liveOperabilitySnapshotPath,
      byRole: [
        // Use sharedRun trace for participant (its pool is the shared one
        // augmented). fallbackRun trace is independent because the planner
        // also treats `fallback_single` distinctly.
        sharedRun.trace,
        synthRun.trace,
        judgeRun.trace,
        { ...fallbackRun.trace, role: 'fallback' },
      ],
    };
  }

  const roleCandidateStats: RoleSpecificPools['roleCandidateStats'] = {
    participant: {
      sourceUniverseCount: augmentedSharedPool.length,
      source: 'shared_pool',
    },
    synthesizer: augmentedSynthesizerPool
      ? {
          sourceUniverseCount: augmentedSynthesizerPool.length,
          source: 'role_specific_pool',
          minContextWindow: 32000,
        }
      : { sourceUniverseCount: augmentedSharedPool.length, source: 'shared_pool' },
    judge: augmentedJudgePool
      ? {
          sourceUniverseCount: augmentedJudgePool.length,
          source: 'role_specific_pool',
          minContextWindow: 16000,
          maxCostPer1k: opts.maxCostPer1kJudge,
        }
      : { sourceUniverseCount: augmentedSharedPool.length, source: 'shared_pool' },
    fallback: {
      sourceUniverseCount: augmentedSharedPool.length,
      source: 'shared_pool',
    },
  };

  return {
    sharedPool: augmentedSharedPool,
    participantPool,
    synthesizerPool: augmentedSynthesizerPool,
    judgePool: augmentedJudgePool,
    fallbackPool,
    roleCandidateStats,
    ...(liveReadyInjection ? { liveReadyInjection } : {}),
  };
}
