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
 * Centralizes the per-role candidate derivation that 01C.1B-J introduced so
 * BOTH the dry-run path AND the real execution path (when reconstructing
 * a plan to compare against the approved fingerprint) use the SAME
 * source data. Without this single-source-of-truth, dry-run could
 * approve a plan derived from one universe while real execution
 * recomputes against another, and the resulting fingerprints would never
 * match, leading either to spurious `PLAN_EXECUTION_PARITY_FAILED` errors
 * or (worse) to silent divergence.
 *
 * Source of truth: the in-memory catalog cache (`getAllCatalogModels`),
 * NOT a repository query. The earlier `searchModels(...)` queries carried
 * a `limit` (256/512/256, and 10_000 for live-ready injection) on top of
 * the repository's default `ORDER BY created_at DESC`, so every pool was
 * really "the N most recently discovered chat models", never the catalog.
 * Reading the full catalog once and filtering in memory means:
 *   - every pool sees every eligible model (no recency window),
 *   - zero extra Postgres round-trips per plan (the catalog snapshot is
 *     already refreshed fleet-wide by the catalog-cache-refresh job and
 *     shared through Redis, so every replica derives pools from the same
 *     rows, which also tightens fingerprint parity between replicas),
 *   - the column projection is the catalog hot-path one by construction.
 *
 * Status semantics are preserved on purpose: the repository queries
 * filtered `status = 'active'`, while the catalog cache holds every row
 * with `status != 'disabled'` (deprecated/maintenance/preview/legacy
 * included). The in-memory filter below keeps only `active`, so those
 * other statuses stay OUT of the pools exactly as before.
 *
 * Ordering is explicit for fingerprint determinism only. Downstream
 * consumers (PoolBuilder, ModelRoleResolver) re-rank every pool with
 * stable sorts and cut the top N, so the order chosen here decides ties
 * and nothing else; the catalog array itself has no stable order
 * (Postgres heap order or the Redis snapshot), which is why we cannot
 * just pass it through. Nothing depends on `created_at` any more.
 *
 * The builder is intentionally framework-agnostic:
 *   - takes a `CandidateCatalogSource` so tests can inject a fake catalog,
 *   - emits both raw `Model` arrays AND lightweight `roleCandidateStats`
 *     so callers can attach per-role audit data without re-querying.
 *
 * Per-role constraints mirror the 01C.1B-J judge audit findings:
 *   - judge:        ≥16k context, quality-first order
 *   - synthesizer:  ≥32k context, quality-first order
 *   - participant + fallback share the generic active chat pool
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

/** Minimal surface this module needs from the catalog. Defined locally
 *  so tests can supply a tiny fake without depending on the full cache.
 *  Production wires `getAllCatalogModels` from model-catalog-service. */
export interface CandidateCatalogSource {
  listCatalogModels(): Promise<readonly Model[]>;
}

export const JUDGE_MIN_CONTEXT_WINDOW = 16_000;
export const SYNTHESIZER_MIN_CONTEXT_WINDOW = 32_000;

/** 01C.1B-J1D-R4A — minimal surface the live-ready injector needs from
 *  the LiveChatOperabilityStore. Defined here so the pool builder stays
 *  decoupled from the concrete singleton and tests can fake it.
 *  `snapshot()` returns ALL known states; the injector filters internally. */
export interface LiveChatOperabilityStoreLike {
  snapshot(): readonly LiveChatOperabilityState[];
}

export interface RoleSpecificPoolBuilderOptions {
  readonly catalog: CandidateCatalogSource;
  /** Recorded in the judge stats (mirrors `STRATEGY_EVALUATOR_MAX_COST_USD`).
   *  The pool itself is not cost-filtered here; the planner applies cost. */
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
  /** The shared generic pool (every active chat-capable catalog row).
   *  Used by participant + fallback. Always populated. */
  readonly sharedPool: readonly Model[];
  /** Role-specific pools. `undefined` means the role should use
   *  `sharedPool` instead. Judge + synthesizer are always populated by this
   *  builder; the optionality is kept so the dry-run service contract stays
   *  unchanged. */
  readonly participantPool?: readonly Model[];
  readonly synthesizerPool?: readonly Model[];
  readonly judgePool?: readonly Model[];
  readonly fallbackPool?: readonly Model[];
  /** Lightweight per-role stats. Surfaced on the plan via
   *  `roleCandidateStats.<role>.sourceUniverseCount`. */
  readonly roleCandidateStats: {
    readonly participant: {
      readonly sourceUniverseCount: number;
      readonly source: 'shared_pool' | 'role_specific_pool';
    };
    readonly synthesizer: {
      readonly sourceUniverseCount: number;
      readonly source: 'shared_pool' | 'role_specific_pool';
      readonly minContextWindow?: number;
    };
    readonly judge: {
      readonly sourceUniverseCount: number;
      readonly source: 'shared_pool' | 'role_specific_pool';
      readonly minContextWindow?: number;
      readonly maxCostPer1k?: number;
    };
    readonly fallback: {
      readonly sourceUniverseCount: number;
      readonly source: 'shared_pool' | 'role_specific_pool';
    };
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

function isActiveChatModel(m: Model): boolean {
  return (
    m.status === 'active' &&
    Array.isArray(m.capabilities) &&
    m.capabilities.includes('chat' as ModelCapability)
  );
}

function compareProviderThenId(a: Model, b: Model): number {
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function compareQualityDescThenProviderId(a: Model, b: Model): number {
  const qa = a.performance?.quality ?? 0;
  const qb = b.performance?.quality ?? 0;
  if (qa !== qb) return qb - qa;
  return compareProviderThenId(a, b);
}

/**
 * Build role-specific candidate pools from the full catalog. SAME function
 * is used by:
 *   - `applyDryRunFailClosedGate` (chat-request-processor.ts) for the
 *     dry-run short-circuit path,
 *   - the `executionParityCheck` recompute,
 *   - the real-execution path when reconstructing the plan to compare
 *     fingerprints.
 *
 * A catalog read failure is fatal (it is a hard precondition for the rest
 * of the planner). There is no per-role I/O any more, so there is nothing
 * left to fall back from: every pool is derived from the same array.
 */
export async function buildConsensusRoleSpecificCandidatePools(
  opts: RoleSpecificPoolBuilderOptions
): Promise<RoleSpecificPools> {
  const catalog = await opts.catalog.listCatalogModels();
  const chatActive = catalog.filter(isActiveChatModel);

  const sharedPool: readonly Model[] = [...chatActive].sort(compareProviderThenId);
  const judgePool: readonly Model[] = chatActive
    .filter((m) => m.contextWindow >= JUDGE_MIN_CONTEXT_WINDOW)
    .sort(compareQualityDescThenProviderId);
  const synthesizerPool: readonly Model[] = chatActive
    .filter((m) => m.contextWindow >= SYNTHESIZER_MIN_CONTEXT_WINDOW)
    .sort(compareQualityDescThenProviderId);

  let participantPool: readonly Model[] | undefined = undefined;
  let fallbackPool: readonly Model[] | undefined = undefined;
  let augmentedSharedPool: readonly Model[] = sharedPool;
  let augmentedSynthesizerPool: readonly Model[] = synthesizerPool;
  let augmentedJudgePool: readonly Model[] = judgePool;

  // ─── 01C.1B-J1D-R4A — live-ready injection ──────────────────────────
  //
  // When enabled, augment each per-role catalog pool with live-ready
  // models from the store (resolved against the catalog so we never
  // fabricate). Default off — preserves pre-R4A behavior surface.
  let liveReadyInjection: RoleSpecificPools['liveReadyInjection'] | undefined;

  if (opts.injectLiveReadyFromStore && opts.liveOperabilityStore) {
    const allStates = opts.liveOperabilityStore.snapshot();
    const eligibleStates = allStates.filter((s) => isStateCurrentlyEligible(s));

    // Index the (providerId, modelId) pairs the store knows about over the
    // same active chat rows the pools were derived from, so injection can
    // never resolve a row the pools could not have seen.
    const eligibleProviderModelPairs = new Set(
      eligibleStates.map((s) => `${s.providerId.toLowerCase()}|${s.modelId.toLowerCase()}`)
    );
    const catalogIndex = new Map<string, Model[]>();
    if (eligibleStates.length > 0) {
      for (const row of chatActive) {
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
      // (not mutated onto the Model: Model objects come straight from the
      // shared catalog cache and are visible to every other consumer). The
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
      basePool: readonly Model[]
    ): { newPool: readonly Model[]; trace: LiveReadyInjectionPerRoleTrace } => {
      const result: LiveReadyCandidateInjectionResult<Model> =
        injectLiveReadyCandidatesIntoRolePool({
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
    };

    const sharedRun = runForRole('participant', sharedPool);
    augmentedSharedPool = sharedRun.newPool;
    // participant + fallback share augmented shared pool; record per-role
    // traces so each role's trace exists in the output.
    participantPool = augmentedSharedPool;
    fallbackPool = augmentedSharedPool;
    const fallbackRun = runForRole('fallback', sharedPool);
    // (We use the same augmented sharedPool above; this run records the
    // independent rejection set + injection trace for the fallback role.)

    const synthRun = runForRole('synthesizer', synthesizerPool);
    augmentedSynthesizerPool = synthRun.newPool;

    const judgeRun = runForRole('judge', judgePool);
    augmentedJudgePool = judgeRun.newPool;

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
    synthesizer: {
      sourceUniverseCount: augmentedSynthesizerPool.length,
      source: 'role_specific_pool',
      minContextWindow: SYNTHESIZER_MIN_CONTEXT_WINDOW,
    },
    judge: {
      sourceUniverseCount: augmentedJudgePool.length,
      source: 'role_specific_pool',
      minContextWindow: JUDGE_MIN_CONTEXT_WINDOW,
      maxCostPer1k: opts.maxCostPer1kJudge,
    },
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
