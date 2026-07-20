// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ModelRoleResolver — capability-driven model selection.
 *
 * Given a `ModelRoleResolutionInput`, returns the selected candidates +
 * full filter trace. NEVER calls a provider. NEVER hardcodes model
 * names. Decisions come from policies (per-role criteria) + the
 * candidate's capability / cost / health / locality signals.
 *
 * Dependencies are injected so tests can run without DB / providers:
 *   - `catalog` — pulls candidates when no pool is passed in
 *   - `operability` — provider health / credits / rate-limit signals
 *   - `semanticSearch` — optional; default `null` means "fall back to
 *     structured filtering". TEI is NOT wired here.
 */
import { logger } from '@/utils/logger';
import type { Model } from '@/types';
import {
  augmentPolicyForTask,
  POLICIES,
  type RolePolicy,
} from './model-role-policy';
import { TraceBuilder } from './model-role-selection-trace';
import type {
  FilterStage,
  ModelCandidate,
  ModelRoleResolutionInput,
  ModelRoleResolutionResult,
  ModelRoleSelectionTrace,
  RejectedCandidate,
  RoleConstraints,
  StrategyModelRole,
  TaskProfile,
} from './model-role-types';
// 01C.1B-J1G-R0 — hybrid synthesizer policy
import {
  scoreSynthesizerCandidate,
  DEFAULT_HYBRID_SYNTHESIZER_POLICY,
  type SynthesizerCandidateMetrics,
  type SynthesizerScoredCandidate,
} from '../role-selection/synthesizer-role-policy';
// 01C.1B-J2 — quality calibration snapshot integration
import {
  findEntry,
  computeSnapshotHash,
  type ModelQualityCalibrationSnapshot,
} from '../role-selection/model-quality-calibration';
// 01C.1B-J2-C-R4 §13 — Task-aware quality lookup (replaces monolithic snapshotEntry.qualityScore)
import {
  resolveTaskAwareQuality,
} from '../role-selection/task-aware-quality-resolver';
// 01C.1B-J1D-R4C — Effective context metadata + dynamic context budget
// (replaces magic `policy.contextWindowMin` constants with plan-derived
// budget, and corrects catalog underestimates via audit-trailed overrides).
import {
  resolveEffectiveContextMetadata,
  type ContextMetadataOverride,
  type EffectiveContextMetadata,
} from './effective-context-metadata';
import {
  computeDynamicContextBudget,
  candidateSatisfiesContextBudget,
  type ConsensusRole,
  type DynamicContextBudget,
} from './dynamic-context-budget';
import { deriveCanonicalModelIdentity } from './canonical-model-identity';
// 01C.1B-J1D-R4D — Structured-output capability normalization (replaces
// the narrow `json_mode || function_calling || tool_use` check with a
// broader classifier that also accepts a runtime backfill artifact).
import {
  detectStructuredOutputSupport,
  satisfiesJudgeStructuredOutputRequirement,
  type StructuredOutputEvidence,
} from './structured-output-capability';
// 01C.1B-J2-C-R5 — Quality identity resolver + snapshot matcher (replaces
// the narrow exact-string findEntry with an alias-aware matcher that
// understands provider wrappers, vendor prefixes, normalized aliases, and
// family-level fallback).
import { deriveQualityModelIdentity } from './quality-model-identity';
import { matchQualitySnapshotEntry } from './quality-snapshot-matcher';

const log = logger.child({ component: 'model-role-resolver' });

// ─── Dependency interfaces (kept narrow so tests can fake easily) ────

export interface ModelCatalogReader {
  /**
   * Return candidates already wrapped with operability signals. The
   * implementation is responsible for honoring `opts.limit` so this
   * never returns the full 64k catalog.
   */
  searchCandidates(opts: {
    readonly capabilities?: readonly string[];
    readonly limit: number;
  }): Promise<readonly ModelCandidate[]>;
  /** Whether the catalog data source was reachable. */
  isAvailable(): boolean;
}

export interface OperabilityReader {
  /** Required only when the catalog returns bare `Model` objects.
   *  When the catalog already wraps with operability, this is unused. */
  enrich(model: Model): ModelCandidate;
  isAvailable(): boolean;
}

export interface SemanticModelSearchProvider {
  search(input: {
    readonly query: string;
    readonly taskProfile: TaskProfile;
    readonly role: StrategyModelRole;
    readonly limit: number;
  }): Promise<readonly ModelCandidate[]>;
  isAvailable(): boolean;
}

export interface ResolverDeps {
  readonly catalog?: ModelCatalogReader;
  readonly operability?: OperabilityReader;
  readonly semanticSearch?: SemanticModelSearchProvider | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const LOCAL_PROVIDER_TOKENS: readonly string[] = [
  'ollama',
  'xinference',
  'own-model',
  'own_model',
  'self-hosted',
  'self_hosted',
  'localai',
  'localhost',
];

export function isLocalProvider(providerId: string): boolean {
  const p = providerId.toLowerCase();
  return LOCAL_PROVIDER_TOKENS.some((token) => p.includes(token));
}

function modelHasCapability(model: Model, cap: string): boolean {
  if (!Array.isArray(model.capabilities)) return false;
  return model.capabilities.includes(cap as (typeof model.capabilities)[number]);
}

function modelHasAllCapabilities(model: Model, caps: readonly string[]): boolean {
  for (const c of caps) {
    if (!modelHasCapability(model, c)) return false;
  }
  return true;
}

function countPreferredCapabilities(model: Model, caps: readonly string[]): number {
  let n = 0;
  for (const c of caps) if (modelHasCapability(model, c)) n++;
  return n;
}

function rejection(
  candidate: ModelCandidate,
  reason: string,
): RejectedCandidate {
  return {
    modelId: candidate.model.id,
    providerId: candidate.providerId,
    reason,
  };
}

// ─── Pipeline filters ────────────────────────────────────────────────

interface FilterContext {
  readonly pool: readonly ModelCandidate[];
  readonly rejected: RejectedCandidate[];
  readonly trace: TraceBuilder;
}

function applyFilter(
  ctx: FilterContext,
  stage: FilterStage,
  predicate: (c: ModelCandidate) => { ok: true } | { ok: false; reason: string },
): readonly ModelCandidate[] {
  const survivors: ModelCandidate[] = [];
  for (const c of ctx.pool) {
    const verdict = predicate(c);
    if (verdict.ok) {
      survivors.push(c);
    } else {
      ctx.rejected.push(rejection(c, verdict.reason));
    }
  }
  ctx.trace.recordStage(stage, survivors.length);
  return survivors;
}

// ─── Ranking ─────────────────────────────────────────────────────────

interface RankedCandidate {
  readonly candidate: ModelCandidate;
  readonly score: number;
  readonly breakdown: Readonly<Record<string, number>>;
}

/**
 * Result of ranking a pool. For non-synthesizer roles `synthScored` is
 * undefined. For synthesizer it carries the full per-candidate hybrid
 * scorer output, used downstream to build the `SynthesizerSelectionSummary`.
 */
interface RankingResult {
  readonly ranked: RankedCandidate[];
  readonly synthScored?: readonly SynthesizerScoredCandidate[];
}

function rankPool(
  pool: readonly ModelCandidate[],
  policy: RolePolicy,
  constraints: RoleConstraints,
  maxCostPerCall: number,
  qualitySnapshot?: ModelQualityCalibrationSnapshot,
  taskProfile?: TaskProfile,
  qualityPolicy?: import('./model-role-types').ModelRoleResolutionInput['qualityPolicy'],
): RankingResult {
  // 01C.1B-J1G-R0 — for synthesizer role, delegate to the hybrid policy
  // (quality floor + freshness + multi-provider coverage + liveReady +
  // cost-benefit + penalties). For other roles, keep the legacy scorer.
  // This avoids changing behavior for participant/judge/fallback while
  // the synthesizer-specific decision benefits from the J1G evidence.
  if (policy.role === 'synthesizer') {
    return rankPoolForSynthesizer(pool, constraints, policy, qualitySnapshot, taskProfile, qualityPolicy);
  }
  const ranked = pool
    .map<RankedCandidate>((c) => {
      const quality = c.model.performance?.quality ?? 0;
      const reliability = c.model.performance?.reliability ?? 0;
      const cost = c.estimatedCostPerCallUsd;
      const normalisedCost = maxCostPerCall > 0 ? Math.min(1, cost / maxCostPerCall) : 0;
      const costScore = 1 - normalisedCost;
      const prefMatches = countPreferredCapabilities(c.model, policy.preferredCapabilities);
      const localBonus = constraints.preferLocal && c.isLocal ? 0.1 : 0;
      const inventoryBonus = c.model.inventoryRole === 'primary' ? 0.05 : 0;
      const score =
        quality * policy.qualityWeight +
        reliability * policy.reliabilityWeight +
        costScore * policy.costWeight +
        prefMatches * policy.preferredCapBoost +
        localBonus +
        inventoryBonus;
      return {
        candidate: c,
        score,
        breakdown: { quality, reliability, costScore, prefMatches, localBonus, inventoryBonus },
      };
    })
    .sort((a, b) => b.score - a.score);
  return { ranked };
}

/**
 * 01C.1B-J1G-R0 — Synthesizer-specific ranker. Builds
 * SynthesizerCandidateMetrics from each ModelCandidate, calls the J1G
 * hybrid scorer, then projects back into RankedCandidate shape.
 *
 * The metrics extraction uses fields available on the candidate; if a
 * dimension is missing (e.g., no providerCoverageCount), it's filled
 * with a conservative default (1 provider = single-provider risk).
 */
function rankPoolForSynthesizer(
  pool: readonly ModelCandidate[],
  constraints: RoleConstraints,
  policy: RolePolicy,
  qualitySnapshot?: ModelQualityCalibrationSnapshot,
  taskProfile?: TaskProfile,
  qualityPolicy?: import('./model-role-types').ModelRoleResolutionInput['qualityPolicy'],
): RankingResult {
  // Pre-compute preferred capability set for tie-breaker boost.
  const preferredCapSet = new Set(policy.preferredCapabilities);
  const candidatesByFamily = new Map<string, ModelCandidate[]>();
  for (const c of pool) {
    const fam = c.model.id.toLowerCase()
      .replace(/^anthropic[-/]/, '')
      .replace(/^openai[-/]/, '')
      .replace(/^google[-/]/, '');
    if (!candidatesByFamily.has(fam)) candidatesByFamily.set(fam, []);
    candidatesByFamily.get(fam)!.push(c);
  }
  // Score each candidate ONCE, keeping both the projection (RankedCandidate)
  // and the raw SynthesizerScoredCandidate (for the summary artifact).
  const synthScored: SynthesizerScoredCandidate[] = [];
  const ranked: RankedCandidate[] = pool.map((c): RankedCandidate => {
    const fam = c.model.id.toLowerCase()
      .replace(/^anthropic[-/]/, '')
      .replace(/^openai[-/]/, '')
      .replace(/^google[-/]/, '');
    const familyMembers = candidatesByFamily.get(fam) ?? [c];
    const providerCoverageCount = new Set(familyMembers.map((x) => x.providerId)).size;
    // Count overlap between the policy's preferred caps and the model's caps.
    // Cheap; small set sizes (≤6 each).
    let preferredCapabilityMatchCount = 0;
    const modelCaps = c.model.capabilities ?? [];
    for (const cap of modelCaps) {
      if (preferredCapSet.has(cap)) preferredCapabilityMatchCount += 1;
    }
    // 01C.1B-J2 — Look up quality in calibration snapshot (if provided).
    // Match by modelId first, then canonical fallback. If snapshot lacks
    // an entry for this model, fall back to catalog placeholder quality.
    //
    // 01C.1B-J2-C-R4 §13 — When the entry has multi-source / per-category
    // data, use the task-aware resolver to pick the category-specific
    // score matching the current task. This closes the J1G manual-bump
    // anti-pattern: a model good at chat_text is NOT chosen for image_edit
    // just because its chat_text score exceeds catalog placeholder.
    // 01C.1B-J2-C-R5 — when `qualityPolicy.useQualityIdentityResolver=true`,
    // use the broader matcher (provider-wrapper strip + alias normalization +
    // family fallback) instead of the exact-string `findEntry`. Default off
    // preserves J2-C-R4 fingerprint hash bit-exact for callers without the
    // policy.
    let snapshotEntry: ReturnType<typeof findEntry>;
    let snapshotMatchKind: string | undefined;
    let snapshotMatchConfidence: string | undefined;
    if (qualitySnapshot && qualityPolicy?.useQualityIdentityResolver === true) {
      const identity = deriveQualityModelIdentity({
        modelId: c.model.id,
        providerId: c.providerId,
        canonicalModelId: (c.model as { canonicalModelId?: string }).canonicalModelId,
        apiModelId: (c.model as { apiModelId?: string }).apiModelId,
        displayName: (c.model as { displayName?: string }).displayName,
      });
      const match = matchQualitySnapshotEntry({
        runtimeIdentity: identity,
        snapshotEntries: qualitySnapshot.entries,
      });
      if (match.matched) {
        snapshotEntry = match.entry as typeof snapshotEntry;
        snapshotMatchKind = match.matchKind;
        snapshotMatchConfidence = match.confidence;
      } else {
        snapshotEntry = undefined;
      }
    } else if (qualitySnapshot) {
      snapshotEntry = findEntry(qualitySnapshot, c.model.id, c.model.id.replace(/^[a-z0-9-]+[-/]/i, ''));
    } else {
      snapshotEntry = undefined;
    }
    const catalogQuality = c.model.performance?.quality ?? 0;
    const taskAware = taskProfile
      ? resolveTaskAwareQuality(snapshotEntry, taskProfile)
      : { score: snapshotEntry?.qualityScore, resolutionPath: 'aggregate' as const };
    const effectiveQuality = taskAware.score ?? catalogQuality;
    // Surface match kind/confidence into the synthesizer score traces when
    // requested. Available via `synthScored[].qualityMatchKind`.
    void snapshotMatchKind;
    void snapshotMatchConfidence;

    const metrics: SynthesizerCandidateMetrics = {
      modelId: c.model.id,
      providerId: c.providerId,
      familyKey: fam,
      quality: effectiveQuality,
      reliability: c.model.performance?.reliability ?? 0,
      estimatedCostUsd: c.estimatedCostPerCallUsd,
      providerCoverageCount,
      liveReadyRouteCount: 0,  // live-ready evidence not yet plumbed; future enhancement
      aliasConfidence: 'medium', // catalog presence = at least medium confidence
      daysSinceCatalogUpdate: undefined, // last_synced_at is NULL in catalog
      providerCreditRisk: c.hasCredits === false,
      providerAuthRisk: false, // not yet tracked at this layer
      contextWindow: c.model.contextWindow,
      preferredCapabilityMatchCount,
    };
    const result: SynthesizerScoredCandidate = scoreSynthesizerCandidate(metrics, DEFAULT_HYBRID_SYNTHESIZER_POLICY);
    synthScored.push(result);
    const score = result.qualityFloorPassed ? result.breakdown.finalScore : -1;
    return {
      candidate: c,
      score,
      breakdown: {
        qualityScore: result.breakdown.qualityScore,
        coverageScore: result.breakdown.multiProviderCoverageScore,
        liveReadyScore: result.breakdown.liveReadyRouteScore,
        singleProviderPenalty: result.breakdown.singleProviderPenalty,
        lowCoveragePenalty: result.breakdown.lowCoveragePenalty,
        providerCoverageCount,
        qualityFloorPassed: result.qualityFloorPassed ? 1 : 0,
      },
    };
  });
  ranked.sort((a, b) => b.score - a.score);
  return { ranked, synthScored };
}

function pickWithDiversity(
  ranked: readonly RankedCandidate[],
  count: number,
  requireProviderDiversity: boolean,
): RankedCandidate[] {
  if (!requireProviderDiversity) return ranked.slice(0, count);
  const picked: RankedCandidate[] = [];
  const seenProviders = new Set<string>();
  for (const r of ranked) {
    if (picked.length >= count) break;
    if (seenProviders.has(r.candidate.providerId)) continue;
    picked.push(r);
    seenProviders.add(r.candidate.providerId);
  }
  // Fill remainder if we couldn't satisfy diversity (e.g., only 2
  // providers but need 3 picks).
  if (picked.length < count) {
    for (const r of ranked) {
      if (picked.length >= count) break;
      if (picked.includes(r)) continue;
      picked.push(r);
    }
  }
  return picked;
}

// ─── Resolver ────────────────────────────────────────────────────────

const DEFAULT_CATALOG_LIMIT = 64;

export class ModelRoleResolver {
  constructor(private readonly deps: ResolverDeps = {}) {}

  async resolve(input: ModelRoleResolutionInput): Promise<ModelRoleResolutionResult> {
    const policy = augmentPolicyForTask(POLICIES[input.role], {
      taskType: input.taskProfile.taskType,
      expectedFormat: input.taskProfile.expectedFormat,
    });
    const count = input.constraints.count ?? policy.defaultCount;
    const maxCostPerCall =
      input.constraints.maxCostUsd && input.constraints.maxCostUsd > 0
        ? input.constraints.maxCostUsd
        : 1.0;

    let inputCandidates: readonly ModelCandidate[] | null = input.candidatePool ?? null;
    // Initialize with a safe default so the definite-assignment check
    // doesn't trip on the catch/else paths below. By the end of the
    // resolution block one of pool_provided/catalog/source_unavailable
    // will always have been assigned, but TS can't prove that through
    // the nested ifs.
    let registrySourceStatus: ModelRoleSelectionTrace['registrySourceStatus'] = 'source_unavailable';
    let semanticSearchStatus: ModelRoleSelectionTrace['semanticSearchStatus'];

    if (inputCandidates) {
      registrySourceStatus = 'pool_provided';
      semanticSearchStatus = 'not_applicable';
    } else if (this.deps.semanticSearch?.isAvailable()) {
      try {
        inputCandidates = await this.deps.semanticSearch.search({
          query: input.taskProfile.userMessageExcerpt ?? '',
          taskProfile: input.taskProfile,
          role: input.role,
          limit: DEFAULT_CATALOG_LIMIT,
        });
        registrySourceStatus = 'catalog';
        semanticSearchStatus = 'used';
      } catch (err) {
        log.warn({ err: String(err) }, 'semantic search failed, falling back to structured catalog');
        inputCandidates = null;
        semanticSearchStatus = 'source_unavailable';
      }
    } else {
      semanticSearchStatus = this.deps.semanticSearch === null ? 'disabled' : 'source_unavailable';
    }

    if (!inputCandidates) {
      if (this.deps.catalog?.isAvailable()) {
        const requiredCaps = Array.from(
          new Set([
            ...policy.requiredCapabilities,
            ...(input.constraints.requiredCapabilities ?? []),
          ]),
        );
        inputCandidates = await this.deps.catalog.searchCandidates({
          capabilities: requiredCaps,
          limit: DEFAULT_CATALOG_LIMIT,
        });
        registrySourceStatus = 'catalog';
      } else {
        registrySourceStatus = 'source_unavailable';
        inputCandidates = [];
      }
    }

    const trace = new TraceBuilder({
      role: input.role,
      strategyName: input.strategyName,
      inputCandidateCount: inputCandidates.length,
      registrySourceStatus,
      providerHealthStatus: this.deps.operability?.isAvailable()
        ? 'available'
        : inputCandidates.length > 0 // operability signals come bundled in pool when pool was provided
          ? 'available'
          : 'source_unavailable',
      pricingStatus: 'available', // pricing comes off model.inputCostPer1k
      semanticSearchStatus,
    });
    trace.addCriterion(policy.description);

    const rejected: RejectedCandidate[] = [];
    const ctx: FilterContext = { pool: inputCandidates, rejected, trace };

    // 1. Capability — required (policy + caller).
    const requiredCaps = Array.from(
      new Set([
        ...policy.requiredCapabilities,
        ...(input.constraints.requiredCapabilities ?? []),
      ]),
    );
    trace.addCriterion(`requiredCapabilities=[${requiredCaps.join(', ')}]`);
    let pool = applyFilter({ ...ctx, pool: inputCandidates }, 'capability', (c) =>
      modelHasAllCapabilities(c.model, requiredCaps)
        ? { ok: true }
        : { ok: false, reason: 'missing_required_capability' },
    );

    // 2. Provider health.
    pool = applyFilter({ ...ctx, pool }, 'health', (c) =>
      c.providerHealthy
        ? { ok: true }
        : { ok: false, reason: 'provider_unhealthy' },
    );

    // 3. Credits.
    pool = applyFilter({ ...ctx, pool }, 'credits', (c) =>
      c.hasCredits ? { ok: true } : { ok: false, reason: 'no_credits' },
    );

    // 4. Rate limit.
    pool = applyFilter({ ...ctx, pool }, 'rate_limit', (c) =>
      c.rateLimited ? { ok: false, reason: 'rate_limited' } : { ok: true },
    );

    // 5. Cost — within max per-call budget if specified.
    if (input.constraints.maxCostUsd !== undefined && input.constraints.maxCostUsd > 0) {
      const max = input.constraints.maxCostUsd;
      trace.addCriterion(`maxCostUsd=${max}`);
      pool = applyFilter({ ...ctx, pool }, 'cost', (c) =>
        c.estimatedCostPerCallUsd <= max
          ? { ok: true }
          : { ok: false, reason: 'cost_over_budget' },
      );
    } else {
      trace.recordStage('cost', pool.length);
    }

    // 6. Context window.
    //
    // 01C.1B-J1D-R4C: when `input.contextPolicy?.enabled === true`,
    // the filter uses BOTH effective context metadata (override-aware,
    // catalog-correcting) AND a dynamic context budget derived from
    // the plan (participantCount, maxOutputTokens, prompt size, safety
    // margin) — INSTEAD of the static `policy.contextWindowMin`.
    //
    // Default OFF preserves pre-R4C behavior (catalog value vs static
    // constant), so J2-E-R2's baseline planFingerprint stays bit-exact
    // for callers that never opt into the new policy.
    const useDynamicContextBudget = input.contextPolicy?.enabled === true;
    let dynamicBudget: DynamicContextBudget | undefined;
    if (useDynamicContextBudget && input.contextPolicy) {
      // Map StrategyModelRole → ConsensusRole. The static policy uses
      // 8 fine-grained roles; the budget formula compresses to 5
      // (participant/synthesizer/judge/fallback/fallback_single). Roles
      // that aggregate outputs (leader/observer/critic/reviewer) map
      // to synthesizer-style budget (they read participant outputs).
      const r = input.role;
      const budgetRole: ConsensusRole =
        r === 'participant'
          ? 'participant'
          : r === 'synthesizer' || r === 'leader' || r === 'observer' || r === 'critic' || r === 'reviewer'
            ? 'synthesizer'
            : r === 'judge'
              ? 'judge'
              : 'fallback_single';
      dynamicBudget = computeDynamicContextBudget({
        ...input.contextPolicy,
        role: budgetRole,
      });
    }

    const staticMinCtx = Math.max(
      policy.contextWindowMin,
      input.constraints.minContextWindow ?? 0,
    );
    const effectiveMinCtx = dynamicBudget?.minContextWindow ?? staticMinCtx;

    trace.addCriterion(
      useDynamicContextBudget
        ? `minContextWindow=${effectiveMinCtx} (dynamic; staticWouldHaveBeen=${staticMinCtx})`
        : `minContextWindow=${effectiveMinCtx}`,
    );

    const overrides: ReadonlyArray<ContextMetadataOverride> =
      input.contextPolicy?.overrides ?? [];

    pool = applyFilter({ ...ctx, pool }, 'context_window', (c) => {
      // Resolve effective context metadata (override-aware) when policy
      // is enabled. Otherwise use catalog value directly to preserve
      // pre-R4C behavior bit-exact.
      let availableContextWindow: number;
      let effective: EffectiveContextMetadata | undefined;
      if (useDynamicContextBudget) {
        const canonical = deriveCanonicalModelIdentity({
          apiModelId: c.model.id,
          providerId: c.providerId,
        });
        effective = resolveEffectiveContextMetadata({
          providerId: c.providerId,
          apiModelId: c.model.id,
          canonicalModelId: canonical.canonicalModelId,
          catalogContextWindow: c.model.contextWindow,
          catalogMaxOutputTokens: c.model.maxOutputTokens,
          overrides,
        });
        availableContextWindow = effective.effectiveContextWindow;
      } else {
        availableContextWindow = c.model.contextWindow;
      }

      if (useDynamicContextBudget && dynamicBudget) {
        const fit = candidateSatisfiesContextBudget({
          effectiveContextWindow: availableContextWindow,
          effectiveMaxOutputTokens: effective?.effectiveMaxOutputTokens,
          budget: dynamicBudget,
        });
        return fit.ok ? { ok: true } : { ok: false, reason: fit.reason ?? 'context_window_too_small' };
      }
      return availableContextWindow >= effectiveMinCtx
        ? { ok: true }
        : { ok: false, reason: 'context_window_too_small' };
    });

    // 7. Locality.
    if (input.constraints.requireLocal) {
      trace.addCriterion('requireLocal=true');
      pool = applyFilter({ ...ctx, pool }, 'locality', (c) =>
        c.isLocal ? { ok: true } : { ok: false, reason: 'not_local' },
      );
    } else if (input.constraints.allowLocal === false) {
      trace.addCriterion('allowLocal=false');
      pool = applyFilter({ ...ctx, pool }, 'locality', (c) =>
        c.isLocal ? { ok: false, reason: 'local_disallowed' } : { ok: true },
      );
    } else {
      trace.recordStage('locality', pool.length);
    }

    // 8. Exclusions.
    const excludeModels = new Set(input.constraints.excludeModelIds ?? []);
    const excludeProviders = new Set(input.constraints.excludeProviderIds ?? []);
    if (excludeModels.size + excludeProviders.size > 0) {
      pool = applyFilter({ ...ctx, pool }, 'exclusions', (c) => {
        if (excludeModels.has(c.model.id)) return { ok: false, reason: 'excluded_model' };
        if (excludeProviders.has(c.providerId)) return { ok: false, reason: 'excluded_provider' };
        return { ok: true };
      });
    } else {
      trace.recordStage('exclusions', pool.length);
    }

    // 9. Role-specific: judge requires preferJsonOutput. We treat
    //    `requireJsonOutput` from caller as a hard filter.
    //
    // 01C.1B-J1D-R4D — when `judgeEligibilityPolicy.useJudgeStructuredOutputNormalization`
    // is true AND role==='judge', use the broader `detectStructuredOutputSupport`
    // classifier (recognizes json_output / json_mode / structured_output /
    // response_format_json + function_calling / tool_use / tool_calling +
    // optional audit-trailed backfill) instead of the narrow 3-capability
    // check. Default off — preserves J2-E-R2/R4C behavior bit-exact for
    // callers who do not opt in.
    const j1dR4dPolicy = input.judgeEligibilityPolicy;
    const useR4dJudgeNorm =
      input.role === 'judge' &&
      j1dR4dPolicy?.enabled === true &&
      j1dR4dPolicy.useJudgeStructuredOutputNormalization === true;

    if (input.constraints.requireJsonOutput && useR4dJudgeNorm) {
      trace.addCriterion('judgeStructuredOutputNormalization=true');
      const backfill = j1dR4dPolicy.structuredOutputBackfill ?? [];
      const allowWeak = j1dR4dPolicy.allowWeakStructuredOutputForJudge === true;
      pool = applyFilter({ ...ctx, pool }, 'role_specific', (c) => {
        const ev: StructuredOutputEvidence = detectStructuredOutputSupport({
          capabilities: c.model.capabilities as readonly string[] | undefined,
          metadata: (c.model as { metadata?: Record<string, unknown> }).metadata,
          modelId: c.model.id,
          providerId: c.providerId,
          apiModelId: (c.model as { apiModelId?: string }).apiModelId,
          canonicalModelId: (c.model as { canonicalModelId?: string }).canonicalModelId,
          backfill,
        });
        const ok = satisfiesJudgeStructuredOutputRequirement({
          evidence: ev,
          allowWeakStructuredOutputForJudge: allowWeak,
        });
        // Emit per-candidate trace when caller opts in.
        if (j1dR4dPolicy.includeTrace === true) {
          trace.addCriterion(
            `judgeStructuredOutput:${c.model.id}=${ev.support}(${ev.evidenceSource})`,
          );
        }
        return ok
          ? { ok: true }
          : {
              ok: false,
              reason:
                ev.support === 'none'
                  ? 'json_output_not_supported'
                  : `json_output_weak_evidence_disallowed:${ev.support}`,
            };
      });
    } else if (input.constraints.requireJsonOutput) {
      // Legacy narrow filter — preserved for callers without R4D policy.
      trace.addCriterion('requireJsonOutput=true');
      pool = applyFilter({ ...ctx, pool }, 'role_specific', (c) =>
        modelHasCapability(c.model, 'json_mode') ||
        modelHasCapability(c.model, 'function_calling') ||
        modelHasCapability(c.model, 'tool_use')
          ? { ok: true }
          : { ok: false, reason: 'json_output_not_supported' },
      );
    } else {
      trace.recordStage('role_specific', pool.length);
    }

    // Rank + pick. 01C.1B-J2: pass optional quality snapshot through to the
    // synthesizer-specific ranker so quality entries override the placeholder.
    // 01C.1B-J2-C-R4 §13: pass taskProfile so quality lookup is task-aware
    // (matches model's per-category score against the request's task type).
    const { ranked, synthScored } = rankPool(
      pool,
      policy,
      input.constraints,
      maxCostPerCall,
      input.modelQualityCalibrationSnapshot,
      input.taskProfile,
      input.qualityPolicy,
    );
    const picked = pickWithDiversity(ranked, count, policy.requireProviderDiversity);

    trace.setFinalSelected(picked.length);
    if (picked.length === 0) {
      trace.addNote('no_candidate_satisfies_constraints');
    } else if (picked.length < count) {
      trace.addNote(`under_filled_${picked.length}_of_${count}`);
    }

    // 01C.1B-J1G-R0 §8 — Synthesizer selection summary (explainability)
    // 01C.1B-J2 §15 — Snapshot info propagated when present
    let synthesizerSelectionSummary;
    if (input.role === 'synthesizer' && synthScored && synthScored.length > 0) {
      synthesizerSelectionSummary = buildSynthesizerSelectionSummary(
        synthScored,
        picked,
        input.modelQualityCalibrationSnapshot,
      );
    }

    return {
      role: input.role,
      selected: picked.map((r) => r.candidate),
      rejected,
      trace: trace.build(),
      ...(synthesizerSelectionSummary ? { synthesizerSelectionSummary } : {}),
    };
  }
}

// ─── Synthesizer selection summary builder ───────────────────────────────

/**
 * 01C.1B-J1G-R0 §8 — Builds the explainability artifact attached to
 * `ModelRoleResolutionResult` when `role === 'synthesizer'`. Self-contained
 * — depends only on the per-candidate scorer output and the picked winners.
 *
 * The `candidatePoolHash` is a stable digest of the input pool's
 * `(modelId, providerId)` tuples — used by downstream `planFingerprint`
 * for parity / cache invalidation.
 */
function buildSynthesizerSelectionSummary(
  synthScored: readonly SynthesizerScoredCandidate[],
  picked: readonly RankedCandidate[],
  qualitySnapshot?: ModelQualityCalibrationSnapshot,
): import('./model-role-types').SynthesizerSelectionSummary {
  const winnerCandidate = picked[0]?.candidate;
  const winnerScored = winnerCandidate
    ? synthScored.find(
        (s) =>
          s.metrics.modelId === winnerCandidate.model.id &&
          s.metrics.providerId === winnerCandidate.providerId,
      )
    : undefined;

  const accepted = synthScored.filter((s) => s.qualityFloorPassed);
  const rejected = synthScored.filter((s) => !s.qualityFloorPassed);

  // Histogram of rejection reasons (no model ids — just counts).
  const rejectionsByReason: Record<string, number> = {};
  for (const r of rejected) {
    const reason = r.rejectionReason?.split(' ')[0] ?? 'unknown';
    rejectionsByReason[reason] = (rejectionsByReason[reason] ?? 0) + 1;
  }

  // Top alternatives: top 5 accepted EXCLUDING the winner.
  const sortedAccepted = [...accepted].sort(
    (a, b) => b.breakdown.finalScore - a.breakdown.finalScore,
  );
  const topAlternatives = sortedAccepted
    .filter((s) => s !== winnerScored)
    .slice(0, 5)
    .map((s) => ({
      modelId: s.metrics.modelId,
      providerId: s.metrics.providerId,
      providerCoverageCount: s.metrics.providerCoverageCount,
      finalScore: s.breakdown.finalScore,
      qualityFloorPassed: s.qualityFloorPassed,
      selected: false,
    }));

  // Stable pool hash: deterministic over (modelId, providerId) pairs.
  const poolTuples = synthScored
    .map((s) => `${s.metrics.modelId}::${s.metrics.providerId}`)
    .sort();
  const candidatePoolHash = stableHash(poolTuples.join('|'));

  // 01C.1B-J2 §15 — Quality snapshot metadata (when present)
  let qualitySnapshotMetadata: import('./model-role-types').SynthesizerSelectionSummary['qualitySnapshotMetadata'];
  if (qualitySnapshot) {
    let matched = 0;
    for (const s of synthScored) {
      if (findEntry(qualitySnapshot, s.metrics.modelId, s.metrics.modelId)) matched += 1;
    }
    const winnerEntry = winnerScored
      ? findEntry(qualitySnapshot, winnerScored.metrics.modelId, winnerScored.metrics.modelId)
      : undefined;
    // Use module-level computeSnapshotHash to avoid drift between snapshot
    // generation and fingerprint inclusion.
    qualitySnapshotMetadata = {
      snapshotVersion: qualitySnapshot.version,
      snapshotHash: computeSnapshotHash(qualitySnapshot),
      snapshotEntryCount: qualitySnapshot.entries.length,
      candidatesMatched: matched,
      candidatesFallbackToPlaceholder: synthScored.length - matched,
      winnerQualityScoreSource: winnerEntry?.qualityScoreSource ?? 'catalog_fallback',
      winnerQualityConfidence: winnerEntry?.qualityConfidence ?? 'catalog_fallback',
    };
  }

  return {
    policyVersion: '01C.1B-J1G-R2:DEFAULT_HYBRID_SYNTHESIZER_POLICY',
    qualityFloor: DEFAULT_HYBRID_SYNTHESIZER_POLICY.qualityFloor,
    poolSize: synthScored.length,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    winner: winnerScored
      ? {
          modelId: winnerScored.metrics.modelId,
          providerId: winnerScored.metrics.providerId,
          providerCoverageCount: winnerScored.metrics.providerCoverageCount,
          finalScore: winnerScored.breakdown.finalScore,
          qualityFloorPassed: winnerScored.qualityFloorPassed,
          selected: true,
        }
      : null,
    topAlternatives,
    rejectionsByReason,
    candidatePoolHash,
    ...(qualitySnapshotMetadata ? { qualitySnapshotMetadata } : {}),
    ...(winnerScored
      ? {
          winnerComponentBreakdown: {
            qualityScore: winnerScored.breakdown.qualityScore,
            reliabilityScore: winnerScored.breakdown.reliabilityScore,
            costScore: winnerScored.breakdown.costScore,
            freshnessScore: winnerScored.breakdown.freshnessScore,
            multiProviderCoverageScore: winnerScored.breakdown.multiProviderCoverageScore,
            liveReadyRouteScore: winnerScored.breakdown.liveReadyRouteScore,
            aliasConfidenceScore: winnerScored.breakdown.aliasConfidenceScore,
            preferredCapabilityMatchScore: winnerScored.breakdown.preferredCapabilityMatchScore,
            singleProviderPenalty: winnerScored.breakdown.singleProviderPenalty,
            lowCoveragePenalty: winnerScored.breakdown.lowCoveragePenalty,
            stalenessPenalty: winnerScored.breakdown.stalenessPenalty,
            unresolvedAliasPenalty: winnerScored.breakdown.unresolvedAliasPenalty,
            creditAuthRiskPenalty: winnerScored.breakdown.creditAuthRiskPenalty,
            unknownQualityPenalty: winnerScored.breakdown.unknownQualityPenalty,
          },
        }
      : {}),
  };
}

/**
 * Deterministic 32-bit FNV-1a hash, returned as 8-char hex. Stable across
 * runs (same input → same output). Sufficient for plan fingerprint dedup
 * (collision risk only matters if two distinct pools happen to collide;
 * the use is detection, not security).
 */
function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The semantic search interface is intentionally NOT wired. Strategy
 * 01C.0 keeps it disabled while TEI readiness for model selection is
 * audited separately. Pass `semanticSearch: null` to make the trace
 * say "disabled" explicitly; omit it to say "source_unavailable".
 */
export const DISABLED_SEMANTIC_SEARCH = null;
