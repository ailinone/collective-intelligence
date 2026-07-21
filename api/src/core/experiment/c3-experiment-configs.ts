// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * C3 Experiment Configurations
 *
 * Pre-built experiment configs that connect the 116-task suite with
 * the C3 validation arms: main comparison, ablation, hidden-info,
 * herding, learning baselines, and longitudinal.
 *
 * Usage:
 *   POST /v1/admin/experiment/create
 *   body: await buildC3MainComparison()
 *
 * These configs are the bridge between:
 * - the 116 tasks in experiment-suite.ts (WHAT to test)
 * - the C3 validation infrastructure (HOW to test)
 *
 * Models are resolved DYNAMICALLY from the DB at experiment creation time,
 * then PINNED for that experiment run (not 'auto' during execution).
 */

import type { ExperimentConfig, ModeConfig, AblationConfig, CollectiveStrategy, CollectiveConfig, SingleModelConfig, SingleBudgetConfig, ForcedPoolCollectiveConfig, AdversarialScenarioName } from './experiment-types';
import { BENCHMARK_COLLECTIVE_STRATEGIES } from './experiment-types';
import { EXPERIMENT_SUITE, getVerifiableTaskIndices, getCanvasPhysicsTaskIndices, getHardVerifiableTaskIndices, getCodeVerifiedTaskIndices, getRunnableTextTaskIndices, getToolCallingTaskIndices } from './experiment-suite';
import { loadHumanEvalTasks, loadGsm8kTasks } from './experiment-dataset-loader';
import { scoreModelFreshness } from './model-freshness';
import { CANONICAL_MODEL_OWNERS, classifyProviderTier, extractModelOwner } from './c3-resolvers';
import { generateAblationMatrix } from '@/core/validation/c3/ablation-config';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'c3-experiment-configs' });

// ─── Task index ranges for domain-specific subsets ───────────────────────
// These should match the experiment-suite.ts layout.
// Empty array = all tasks.

/**
 * Pick a stratified-by-complexity sample of task indices.
 *
 * Pilots that hardcode `[0,1,10,11,20,21,...]` arbitrarily skew toward
 * the first 50 task slots and over-sample tech-domain tasks. This
 * helper draws a balanced sample by:
 *
 *   1. Splitting EXPERIMENT_SUITE into low/medium/high buckets
 *   2. Picking `perBucket` indices from each, evenly spaced across the
 *      bucket so domain coverage is wide (not just first-N)
 *   3. Returning the union, sorted by index
 *
 * Deterministic — given the same suite + perBucket, the same indices
 * come out every call. Operators can override via `options.taskIndices`
 * on every builder if they want a specific custom sample.
 */
export function pickStratifiedTaskIndices(perBucket = 4): number[] {
  const buckets: Record<string, number[]> = { low: [], medium: [], high: [] };
  for (const task of EXPERIMENT_SUITE) {
    if (task.complexity in buckets) {
      buckets[task.complexity]!.push(task.index);
    }
  }

  const picked: number[] = [];
  for (const indices of Object.values(buckets)) {
    if (indices.length === 0) continue;
    if (indices.length <= perBucket) {
      picked.push(...indices);
      continue;
    }
    // Even spacing across the bucket — Math.floor(i * step) so the
    // sample includes both early and late indices in the bucket.
    const step = indices.length / perBucket;
    for (let i = 0; i < perBucket; i++) {
      picked.push(indices[Math.floor(i * step)]!);
    }
  }
  return picked.sort((a, b) => a - b);
}

/**
 * Adversarial task indices — the 6 tasks tagged `taskType: 'adversarial'`
 * in the suite. Used by the adversarial-robustness phase to ensure the
 * scenarios run against tasks DESIGNED for adversarial probing, not
 * the first 6 generic tasks (which previous default did).
 */
export const ADVERSARIAL_TASK_INDICES: number[] = EXPERIMENT_SUITE
  .filter((t) => t.taskType === 'adversarial')
  .map((t) => t.index);

// ─── Dynamic Model Resolution ────────────────────────────────────────────

/**
 * Semantic definition of which model families to include as individual arms
 * in the experiment. This is a research parameter, not a provider list.
 * Each family maps to the originalProvider metadata field set during discovery.
 *
 * Configuration knobs (env-tunable, no hardcoded provider lists):
 *   - EXPERIMENT_TOP_TIER_MAX_PROVIDERS:  cap on distinct providers (default 30)
 *   - EXPERIMENT_TOP_TIER_PER_PROVIDER:   top-K models per provider (default 1)
 *   - EXPERIMENT_TOP_TIER_MIN_CONTEXT:    minimum contextWindow filter (default 4096)
 *   - EXPERIMENT_TOP_TIER_REQUIRE_CHAT:   require 'chat' capability (default true)
 *   - EXPERIMENT_TOP_TIER_INCLUDE_LOCAL:  include Ollama/local providers (default true)
 *
 * Operator override: pass `families` to buildC3MainComparison() to constrain
 * (e.g. for a focused comparison). Default is to discover ALL providers in DB.
 */

/**
 * Resolve top-tier chat models DYNAMICALLY from the entire runtime catalog.
 *
 * Architectural principle: NO hardcoded provider list. The catalog has 30+
 * providers and 60k+ models; restricting to a 7-family whitelist contradicts
 * the dynamic-discovery thesis. Instead:
 *
 *   1. Query DISTINCT provider names that have ≥1 active chat-capable model.
 *   2. For each provider, take the top-K (default K=1) models ranked by
 *      contextWindow desc + inputCostPer1k asc.
 *   3. Filter by minimum contextWindow + chat capability (structural).
 *   4. Filter by credit monitor (optimistic when unknown).
 *   5. Cap final result at maxProviders to keep experiments tractable.
 *
 * The result is ALL providers represented, not just the closed-source frontier.
 * Hub providers (cometapi/aihubmix), open-source serverless (groq/cerebras),
 * local (ollama-local), specialty (cohere/jina) — all eligible.
 */
/**
 * Lazy operability gate shared by the arm resolvers (c3-v4 finding: the arm
 * builders consulted only the credit monitor, so arms were built for providers
 * the operability hub already knew were auth_failed/no_credits — 28.6% frozen
 * error rate). A model only enters an arm if its provider is currently USABLE
 * (healthy/recovering/degraded/unknown). Optimistic when the hub is unavailable.
 */
async function getOperabilityGate(): Promise<(providerName: string) => boolean> {
  try {
    const mod = await import('@/core/provider-operability-hub');
    const hub = mod.getProviderOperabilityHub();
    return (providerName: string) => hub.isProviderUsable(providerName);
  } catch (err) {
    log.warn({ error: String(err) }, 'Operability hub unavailable — arm resolvers proceeding optimistic');
    return () => true;
  }
}

/**
 * Canonical-owner gate (mis-election guard), shared with resolveFrontierModels
 * below: a substring/prefix id match has no owner awareness, so a community
 * fork on an aggregator provider (e.g. `King3Djbl/mythos-9b-unhinged` on a
 * HuggingFace-style hub) can win a slot outright. This was fixed for the
 * frontier-election path (buildC3FrontierComparison) but NOT for the two
 * resolvers the newer benchmark configs (c3-ha-hard, c3-code-verified,
 * c3-canvas-physics, and the main comparison itself) actually use —
 * resolveTopTierModels / resolveBudgetModels. Require the same allowlist here.
 */
function isCanonicalOwnerModel(modelId: string, providerName: string): boolean {
  const owner = extractModelOwner(modelId, providerName);
  const providerTier = classifyProviderTier(providerName);
  const providerNameLower = providerName.toLowerCase();
  return modelId.includes('/')
    ? (CANONICAL_MODEL_OWNERS.has(owner) || owner === providerNameLower)
    : (providerTier === 'local' || CANONICAL_MODEL_OWNERS.has(providerNameLower));
}

async function resolveTopTierModels(options?: {
  /** Optional family whitelist for focused comparisons. Empty = all providers. */
  families?: string[];
  /** Optional cap on distinct providers — unset (default) means ALL eligible
   *  providers are included. See EXPERIMENT_TOP_TIER_MAX_PROVIDERS below for
   *  why an explicit cap here is a genuine, not incidental, scope decision. */
  maxProviders?: number;
  /** Override default top-K per provider. */
  perProvider?: number;
}): Promise<Array<{ id: string; displayName: string; provider: string }>> {
  // 2026-07-20: no cap by default (was 30). Step 1 discovers providers via
  // `orderBy: { name: 'asc' }`, and the old default silently stopped the
  // Step 2 loop once 30 models were collected — with 77 eligible providers,
  // that hard-excluded every provider whose name sorted after ~'w'
  // (confirmed: `zai`, `xai` never contributed a single-model arm; the run
  // that surfaced this had 45 providers represented, cut off exactly at
  // 'wandb'). The exclusion tracked alphabetical position, not model
  // quality — GLM (zai), xAI's own listing, and anything else past that
  // point never had a chance regardless of how good the model was. An
  // operator can still scope a specific run down via
  // EXPERIMENT_TOP_TIER_MAX_PROVIDERS or the `maxProviders` param; that is
  // now an explicit choice instead of an alphabetical accident.
  const maxProviders = options?.maxProviders
    ?? Number(process.env.EXPERIMENT_TOP_TIER_MAX_PROVIDERS ?? Infinity);
  const perProvider = options?.perProvider
    ?? Number(process.env.EXPERIMENT_TOP_TIER_PER_PROVIDER ?? 1);
  const minContext = Number(process.env.EXPERIMENT_TOP_TIER_MIN_CONTEXT ?? 4096);
  const requireChat = (process.env.EXPERIMENT_TOP_TIER_REQUIRE_CHAT ?? 'true') === 'true';
  const includeLocal = (process.env.EXPERIMENT_TOP_TIER_INCLUDE_LOCAL ?? 'true') === 'true';

  const results: Array<{ id: string; displayName: string; provider: string }> = [];

  // Lazy-import the credit monitor (boot-order safety)
  let creditMonitor: { hasCredits(providerId: string): boolean } | null = null;
  try {
    const mod = await import('@/services/credit-monitor-service');
    creditMonitor = mod.getCreditMonitorService();
  } catch (err) {
    log.warn({ error: String(err) }, 'Credit monitor unavailable — proceeding without credit-aware filter');
  }
  const isOperable = await getOperabilityGate();
  const { isNonGenerativeModel } = await import('@/core/pool/non-generative-filter');

  // Step 1: discover provider universe DYNAMICALLY
  let providers: string[];
  if (options?.families && options.families.length > 0) {
    providers = options.families;
    log.info({ providers, override: 'families_param' }, 'Using operator-provided family whitelist');
  } else {
    // Query DISTINCT providers that have ≥1 active model in DB.
    // Note: capabilities is JSON, not String[], so we filter by chat capability
    // structurally per-candidate (in the model loop below) rather than via
    // Prisma WHERE — this lets the same query work regardless of capability
    // schema evolution.
    try {
      const distinctProviderRows = await prisma.provider.findMany({
        where: {
          models: {
            some: { status: 'active' },
          },
        },
        select: { name: true },
        orderBy: { name: 'asc' },
      });
      providers = (Array.isArray(distinctProviderRows) ? distinctProviderRows : [])
        .map((p) => p.name)
        .filter((name) => includeLocal || !name.startsWith('ollama'));
      log.info(
        { discoveredProviders: providers.length, includeLocal },
        'Dynamic provider discovery complete (no hardcoded list)',
      );
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Dynamic provider discovery failed; returning empty pool',
      );
      return [];
    }
  }

  // Step 2: per-provider top-K models, ranked structurally
  for (const family of providers) {
    if (results.length >= maxProviders * perProvider) break;

    const candidatesRaw = await prisma.model.findMany({
      where: {
        status: 'active',
        provider: { name: family },
        ...(minContext > 0 ? { contextWindow: { gte: minContext } } : {}),
      },
      orderBy: [
        { contextWindow: 'desc' },
        { inputCostPer1k: 'asc' },
      ],
      include: { provider: true },
      take: Math.max(perProvider * 5, 5), // window for credit-aware fallback
    });

    const candidates = Array.isArray(candidatesRaw) ? candidatesRaw : [];

    if (candidates.length === 0) {
      log.debug({ family }, 'No active model in DB for provider — skipping');
      continue;
    }

    let pickedForProvider = 0;
    const skipReasons: Array<{ modelId: string; reason: string }> = [];

    for (const candidate of candidates) {
      if (pickedForProvider >= perProvider) break;

      const caps = Array.isArray(candidate.capabilities) ? candidate.capabilities : [];
      if (requireChat && !caps.includes('chat')) {
        skipReasons.push({ modelId: candidate.id, reason: 'not_chat_capable' });
        continue;
      }

      // Non-generative floor: embeddings/rerankers mislabeled 'chat' must not
      // become arms (c3-v4: intfloat-multilingual-e5-base voted in consensus).
      if (isNonGenerativeModel({ id: candidate.id, capabilities: caps as string[] })) {
        skipReasons.push({ modelId: candidate.id, reason: 'non_generative' });
        continue;
      }

      // Canonical-owner gate: a community fork on an aggregator (e.g. a
      // HuggingFace hub listing) must not win a top-tier slot outright.
      if (!isCanonicalOwnerModel(candidate.id, candidate.provider.name)) {
        skipReasons.push({ modelId: candidate.id, reason: 'non_canonical_owner' });
        continue;
      }

      // Credit-aware filter: optimistic when monitor has no probe yet
      if (creditMonitor && !creditMonitor.hasCredits(candidate.provider.name)) {
        skipReasons.push({ modelId: candidate.id, reason: 'no_credits' });
        continue;
      }

      // Operability gate: do not build arms on providers the hub knows are
      // dead (auth_failed / no_credits / rate_limited / temporarily_unavailable).
      if (!isOperable(candidate.provider.name)) {
        skipReasons.push({ modelId: candidate.id, reason: 'not_operable' });
        continue;
      }

      results.push({
        id: candidate.id,
        displayName: candidate.displayName,
        provider: candidate.provider.name,
      });
      pickedForProvider++;
    }

    if (pickedForProvider === 0) {
      log.debug(
        { family, candidatesConsidered: candidates.length, skipReasons: skipReasons.slice(0, 3) },
        'No usable model in provider window — skipping',
      );
      continue;
    }

    log.info(
      {
        provider: family,
        modelsPickedForProvider: pickedForProvider,
        skippedAlternatives: skipReasons.length,
      },
      'Resolved top-tier model(s) for provider (dynamic + credit-aware)',
    );
  }

  return results;
}

/**
 * Query the DB for own models served by the model-stack via the
 * `own-model` provider adapter (see `api/src/providers/own-model/`).
 *
 * F1.4 followup — when `OWN_MODEL_ENABLED=true` AND the discovery
 * mechanism has materialized at least one row whose provider name is
 * `own-model` (or whose id starts with `own/`), the C3 Main Comparison
 * gains:
 *
 *   1. A `single-model` arm for the own model alone — baseline for the
 *      own model in isolation.
 *   2. A `forced-pool-collective` "Mixed Collective" arm pairing the
 *      own model with the cheapest external models under
 *      `sensitivity-consensus` — directly tests the CI thesis that a
 *      small/cheap locally-trained model cooperating with cheap
 *      externals can beat a top-tier individual.
 *
 * When no own model is present (default / OWN_MODEL_ENABLED=false),
 * this returns `[]` and the arm group is silently omitted. The C3
 * Main Comparison continues to function exactly as before.
 *
 * 2026-07-06 (H-B instantiation on the existing VPS): SELF-HOSTED
 * local-tier rows (provider name starting with 'ollama') also count as
 * "own" — H-B's semantic is "a model served on OWN infrastructure at
 * marginal cost cooperating with cheap externals", and an Ollama service
 * on the project VPS is exactly that. The ollama provider has full
 * discovery+execution wiring (unlike the in-memory own-model P4 bridge),
 * so these rows are routable. Still gated by OWN_MODEL_ENABLED so the
 * H-B arms never appear by accident.
 */
async function resolveOwnModels(): Promise<Array<{ id: string; displayName: string }>> {
  if (process.env.OWN_MODEL_ENABLED !== 'true') {
    return [];
  }

  try {
    const models = await prisma.model.findMany({
      where: {
        status: 'active',
        OR: [
          { provider: { name: 'own-model' } },
          { id: { startsWith: 'own/' } },
          { provider: { name: { startsWith: 'ollama' } } },
        ],
      },
      include: { provider: true },
      orderBy: [{ contextWindow: 'desc' }],
    });

    const chatModels = models.filter((m) => {
      const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
      return caps.includes('chat');
    });

    if (chatModels.length === 0) {
      log.warn(
        { ownModelEnabled: true, totalRows: models.length },
        'OWN_MODEL_ENABLED=true but no chat-capable own/* model in DB — Mixed Collective arms will be skipped',
      );
      return [];
    }

    return chatModels.map((m) => ({ id: m.id, displayName: m.displayName }));
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to resolve own models');
    return [];
  }
}

/**
 * Query the DB for the 2 cheapest active chat models from different providers.
 * Used as the budget baseline arms.
 */
async function resolveBudgetModels(): Promise<Array<{ id: string; displayName: string }>> {
  try {
    const models = await prisma.model.findMany({
      where: { status: 'active' },
      include: { provider: true },
      orderBy: [{ inputCostPer1k: 'asc' }],
      take: 20,
    });

    const isOperable = await getOperabilityGate();
    const { isNonGenerativeModel } = await import('@/core/pool/non-generative-filter');

    // Filter to chat-capable, GENERATIVE models: the cheapest rows are exactly
    // where mislabeled embeddings/rerankers concentrate (near-zero cost), so
    // the budget arms were the most junk-prone in c3-v4.
    const chatModels = models.filter((m) => {
      const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
      return caps.includes('chat')
        && !isNonGenerativeModel({ id: m.id, capabilities: caps as string[] })
        // Canonical-owner gate: the cheapest rows are also where anonymous
        // community forks on aggregators concentrate — same mis-election risk
        // as the frontier/top-tier resolvers.
        && isCanonicalOwnerModel(m.id, m.provider.name);
    });

    // Pick cheapest 2 from different OPERABLE providers
    const seen = new Set<string>();
    const results: Array<{ id: string; displayName: string }> = [];

    for (const m of chatModels) {
      if (seen.has(m.provider.name)) continue;
      if (!isOperable(m.provider.name)) continue;
      seen.add(m.provider.name);
      results.push({ id: m.id, displayName: m.displayName });
      if (results.length >= 2) break;
    }

    return results;
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to resolve budget models');
    return [];
  }
}

// ─── Config Builders ─────────────────────────────────────────────────────

/**
 * PHASE 1: Main 14-arm comparison (restructured from 4-arm)
 *
 * Arm group 1: Each top-tier model individually (up to 6 arms)
 * Arm group 2: Each CI strategy (all 29 registered collective strategies)
 * Arm group 3: Budget models (2 arms, cheapest from different providers)
 * Arm group 4: Adaptive (1 arm)
 *
 * Models are resolved dynamically from the DB at creation time, then pinned.
 */
export async function buildC3MainComparison(options?: {
  taskIndices?: number[];
  repetitions?: number;
  maxBudgetUsd?: number;
  collectiveStrategy?: CollectiveStrategy;
}): Promise<ExperimentConfig> {
  const topModels = await resolveTopTierModels();
  const budgetModels = await resolveBudgetModels();
  const ownModels = await resolveOwnModels();
  // Use ALL registered collective strategies — no hardcoded subset
  const strategies: CollectiveStrategy[] = [...BENCHMARK_COLLECTIVE_STRATEGIES]; // stubs (e.g. hierarchical) excluded — see NON_COLLECTIVE_BENCHMARK_STRATEGIES

  // F1.4 followup — Mixed Collective arms (only when own/* is present).
  // Each Mixed Collective forces a pool of [own-model + 2 cheapest
  // externals] under a chosen strategy. This is the specific arm that
  // measures the core CI thesis: smaller cheaper models cooperating
  // beat top-tier individuals.
  const mixedCollectiveArms: ForcedPoolCollectiveConfig[] = [];
  if (ownModels.length > 0 && budgetModels.length >= 2) {
    const primaryOwn = ownModels[0];
    const mixedPool = [primaryOwn.id, budgetModels[0].id, budgetModels[1].id];
    // Two strategies: classic consensus (deterministic baseline) and
    // sensitivity-consensus (the new path) so the report can distinguish
    // "mix helps" from "sensitivity-consensus helps" effects.
    const mixedStrategies: CollectiveStrategy[] = ['consensus', 'sensitivity-consensus'];
    for (const strategy of mixedStrategies) {
      mixedCollectiveArms.push({
        mode: 'forced-pool-collective',
        strategy,
        forcedModelPool: mixedPool,
        displayName: `Mixed Collective ${strategy} (own + 2 budget)`,
        qualityTarget: 1.0,
        requiredCapabilities: ['chat'],
      });
    }
  }

  const modes: ModeConfig[] = [
    // Arm group 1: Each top-tier model individually
    // NOTE: We do NOT use preferredProviders here because native providers may lack
    // API keys (e.g., ANTHROPIC_API_KEY empty). The orchestration engine automatically
    // routes through the best available provider (CometAPI, AiHubMix, etc.).
    // The model ID alone is sufficient to identify the model uniquely enough.
    ...topModels.map((m): SingleModelConfig => ({
      mode: 'single-model',
      modelId: m.id,
      displayName: `${m.displayName} (${m.provider})`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.95,
    })),

    // Arm group 1b (F1.4 followup): Own models individually — baseline
    // for the own model in isolation, used to compute the "own model
    // alone" → "own model in mixed collective" gain.
    ...ownModels.map((m): SingleModelConfig => ({
      mode: 'single-model',
      modelId: m.id,
      displayName: `Own: ${m.displayName}`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.95,
    })),

    // Arm group 2: Each CI strategy
    // qualityTarget=1.0: the goal is maximum quality from the collective.
    // Individual models are selected by quality-first sort from getEligibleModels().
    // The CI thesis: combining multiple good models produces output quality > any individual.
    ...strategies.map((strategy): ModeConfig => ({
      mode: 'collective',
      strategy,
      qualityTarget: 1.0,
      requiredCapabilities: ['chat'],
    })),

    // Arm group 2b (F1.4 followup): Mixed Collective — own + budget,
    // forced pool, validates the smaller-cheaper-cooperating thesis.
    ...mixedCollectiveArms,

    // Arm group 3: Budget models (cheapest from different providers)
    ...budgetModels.map((m): SingleBudgetConfig => ({
      mode: 'single-budget',
      modelId: m.id,
      displayName: `Budget: ${m.displayName}`,
      qualityTarget: 0.30,
      requiredCapabilities: ['chat'],
    })),

    // Arm group 4: Adaptive
    { mode: 'adaptive' as const, requiredCapabilities: ['chat'] },
  ];

  const armSummary = `${topModels.length} top-tier + ${ownModels.length} own + ${strategies.length} strategies + ${mixedCollectiveArms.length} mixed + ${budgetModels.length} budget + 1 adaptive = ${modes.length} arms`;

  return {
    name: `C3 Main Comparison — ${modes.length}-arm matrix`,
    description: `${armSummary}. Models pinned at creation: [${topModels.map(m => m.id).join(', ')}]. Budget: [${budgetModels.map(m => m.id).join(', ')}].`,
    // Default to the RUNNABLE text set, not [] (whole suite). An empty list made
    // getFilteredTasks return every task — including compositor-strategy tasks
    // (strategy unimplemented → mislabeled, contaminating attribution) and
    // payload-less multimodal tasks (asked to analyze an attachment the suite
    // never populates → guaranteed failures). getRunnableTextTaskIndices()
    // excludes exactly those. Operators can still pass an explicit taskIndices.
    // (review TS-02 — getRunnableTextTaskIndices was dead code until now.)
    taskIndices: options?.taskIndices ?? getRunnableTextTaskIndices(),
    modes,
    repetitions: options?.repetitions ?? 3,
    maxBudgetUsd: options?.maxBudgetUsd ?? 200,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 10,
    freezeLearningDuringEval: true,
  };
}

/**
 * H-A verifiable mini-run (2026-07-04, post-7bb900e2 analysis).
 *
 * The 7bb900e2 partial never reached tasks 116-125 (the verifiable subset with
 * objective answerCheck — complexity-first queue ordering + pause at 17%), so
 * H-A — the pre-registered PRIMARY thesis test ("a collective WITH the
 * verifier armed beats the best single at equal-or-lower cost") — was never
 * exercised. This config adjudicates exactly that, cheaply: 10 verifiable
 * tasks × (top-tier singles + consensus + blind-debate) × 3 reps.
 *
 * The verifiable tasks carry `answerCheck`; the runner forwards it as
 * `ailin_constraints.answer_check`, the engine resolves it into
 * `context.answerVerifier`, and consensus can select the checker-verified
 * voter (consensus_verified_individual). No arm changes needed — the wiring
 * is armed by the tasks themselves.
 *
 * Protocol notes (per reports/experiments/2026-07-03-v4-preregistration.md):
 * pin the judge via EXPERIMENT_JUDGE_MODEL (a non-competitor family) — the
 * 7bb900e2 dynamic-judge deviation is one of the reasons that run is only
 * directional. Budget: ~$2-5 total at observed per-exec costs.
 */
// Derived from the suite (every task carrying an objective answerCheck), NOT a
// hardcoded list — so the HARD verifiable tasks added later (126-135, the ones
// that actually discriminate frontier models; the 116-125 block tops out at
// difficulty 0.6 where frontier accuracy is ~100%) are automatically included
// in the H-A adjudication. A static list silently excluded them.
export const VERIFIABLE_TASK_INDICES: number[] = getVerifiableTaskIndices();

export async function buildC3VerifiableMiniRun(options?: {
  repetitions?: number;
  maxBudgetUsd?: number;
}): Promise<ExperimentConfig> {
  const topModels = await resolveTopTierModels();

  const modes: ModeConfig[] = [
    // Every top-tier single — determines "best single on these tasks" rather
    // than assuming 7bb900e2's groq/compound carries over to this subset.
    ...topModels.map((m): SingleModelConfig => ({
      mode: 'single-model',
      modelId: m.id,
      displayName: `${m.displayName} (${m.provider})`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.95,
    })),
    // The two collective arms H-A compares: consensus (verifier-armed via the
    // tasks' answerCheck) and blind-debate (strongest q_pos collective in
    // 7bb900e2 that is CHEAPER than single — the independence-preserving arm).
    { mode: 'collective', strategy: 'consensus', qualityTarget: 1.0, requiredCapabilities: ['chat'] },
    { mode: 'collective', strategy: 'blind-debate', qualityTarget: 1.0, requiredCapabilities: ['chat'] },
  ];

  return {
    name: `C3 H-A Verifiable Mini-Run — ${modes.length}-arm × ${VERIFIABLE_TASK_INDICES.length} tasks`,
    description:
      `Adjudicates pre-registered H-A on the verifiable subset (tasks ${VERIFIABLE_TASK_INDICES[0]}-` +
      `${VERIFIABLE_TASK_INDICES[VERIFIABLE_TASK_INDICES.length - 1]}, objective answer_check → ` +
      `best-of-N verifier armed). Arms: ${topModels.length} top-tier singles + consensus + blind-debate.`,
    taskIndices: [...VERIFIABLE_TASK_INDICES],
    modes,
    repetitions: options?.repetitions ?? 3,
    maxBudgetUsd: options?.maxBudgetUsd ?? 10,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    // Small warmup: the arms are few and the tasks cheap; 4 executions prime
    // providers/judge without eating the budget.
    warmupExecutions: 4,
    freezeLearningDuringEval: true,
  };
}

/**
 * PURE H-A test (2026-07-12) — the fairest chance for the thesis. Runs ONLY the
 * hard verifiable tier (146-155: multi-step computations where frontier singles
 * slip and errors are INDEPENDENT, so a diverse pool recovers the answer)
 * against every top-tier SINGLE, the verifier-armed COLLECTIVE (consensus — the
 * ONLY strategy that consumes context.answerVerifier and runs best-of-N), and a
 * NON-verifier collective (blind-debate) as the contrast that isolates what the
 * verifier itself contributes. Undiluted by the easy block, this isolates the
 * regime where the collective CAN beat a single: objective verification + a
 * diverse pool. If the thesis fails HERE, it fails everywhere. Pinned judge is
 * optional (the answer_check is the oracle); the judge only scores reasoning.
 */

/**
 * Benchmark single-model arms = UNION of per-provider breadth
 * (resolveTopTierModels — one model per registered provider, includes every
 * onboarded provider) and elected frontier flagships (resolveFrontierModels —
 * GPT-5.x/Claude Opus/Fable/Mythos/Gemini Pro/Grok 4+, whichever generation is
 * newest in the catalog; dynamic family/generation matching, never a hardcoded
 * model id). Deduped by model id (frontier's entry wins on a tie).
 *
 * WHY the union, not just one or the other: resolveTopTierModels alone was
 * shown (see resolveFrontierModels' own docstring, from the 7bb900e2 audit) to
 * surface haiku/flash-lite-class per-provider picks, NOT the market frontier —
 * so a "vs frontier" benchmark run only on resolveTopTierModels could compare
 * the collective against models weaker than what a user actually means by
 * "GPT-5.6" or "Grok 4.5", biasing the result toward the collective. Using
 * ONLY resolveFrontierModels would drop the breadth across every other
 * onboarded provider. The union guarantees both: whichever GPT-5.x/Grok-4.x/
 * Claude-Opus/Gemini-Pro flagship is CURRENTLY newest in the catalog is always
 * an arm, alongside the full provider breadth ("frontier models alongside all
 * the others").
 */
async function resolveBenchmarkSingles(): Promise<Array<{ id: string; displayName: string; provider: string }>> {
  const [broad, frontier] = await Promise.all([
    resolveTopTierModels(),
    resolveFrontierModels(),
  ]);
  const seen = new Set<string>();
  const merged: Array<{ id: string; displayName: string; provider: string }> = [];
  for (const m of [...frontier, ...broad]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push({ id: m.id, displayName: m.displayName, provider: m.provider });
  }
  return merged;
}

export async function buildC3HaHard(options?: {
  repetitions?: number;
  maxBudgetUsd?: number;
}): Promise<ExperimentConfig> {
  const topModels = await resolveBenchmarkSingles();
  const taskIndices = getHardVerifiableTaskIndices();

  const modes: ModeConfig[] = [
    ...topModels.map((m): SingleModelConfig => ({
      mode: 'single-model',
      modelId: m.id,
      displayName: `${m.displayName} (${m.provider})`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.95,
    })),
    // consensus is the ONLY strategy that consumes context.answerVerifier →
    // best-of-N selects a checker-passing voter when synthesis/majority is wrong.
    // This is the mechanism under test.
    { mode: 'collective', strategy: 'consensus', qualityTarget: 1.0, requiredCapabilities: ['chat'] },
    // blind-debate: a collective WITHOUT the verifier — the contrast that shows
    // whether any collective edge comes from the verifier or from ensembling alone.
    { mode: 'collective', strategy: 'blind-debate', qualityTarget: 1.0, requiredCapabilities: ['chat'] },
  ];

  return {
    name: `C3 H-A HARD — ${modes.length}-arm × ${taskIndices.length} hard verifiable tasks`,
    description:
      `PURE H-A test on the hard verifiable tier (tasks ${taskIndices[0] ?? '?'}-` +
      `${taskIndices[taskIndices.length - 1] ?? '?'}). ${topModels.length} singles (current frontier ` +
      `flagships — GPT-5.x/Claude Opus/Gemini Pro/Grok 4.x, whichever generation is newest in the ` +
      `catalog — alongside the full per-provider breadth) vs verifier-armed consensus + blind-debate. ` +
      `Isolates the best-of-N regime — the collective wins iff a diverse voter recovers what the best ` +
      `single missed.`,
    taskIndices,
    modes,
    repetitions: options?.repetitions ?? 3,
    maxBudgetUsd: options?.maxBudgetUsd ?? 15,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 4,
    freezeLearningDuringEval: true,
  };
}

/**
 * CODE-VERIFIED benchmark (2026-07-12) — "coding with real functional delivery".
 * The 156-160 tasks are EXECUTED in the sandbox against hidden tests; the score
 * is the objective pass rate (passedCases/totalCases), not the fuzzy judge.
 * Runs the code tasks × top-tier singles + verifier-armed consensus + a few
 * collectives, so the report shows whether a collective's code is objectively
 * MORE correct than a strong single's. Judge NOT required (grading is execution).
 */
export async function buildC3CodeVerified(options?: {
  repetitions?: number;
  maxBudgetUsd?: number;
  collectiveStrategies?: CollectiveStrategy[];
}): Promise<ExperimentConfig> {
  const topModels = await resolveBenchmarkSingles();
  const taskIndices = getCodeVerifiedTaskIndices();
  const strategies: CollectiveStrategy[] =
    options?.collectiveStrategies ?? ['consensus', 'debate', 'competitive'];

  const modes: ModeConfig[] = [
    ...topModels.map((m): SingleModelConfig => ({
      mode: 'single-model',
      modelId: m.id,
      displayName: `${m.displayName} (${m.provider})`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.95,
    })),
    ...strategies.map((strategy): CollectiveConfig => ({
      mode: 'collective',
      strategy,
      qualityTarget: 1.0,
      requiredCapabilities: ['chat'],
    })),
  ];

  return {
    name: `C3 Code-Verified — ${modes.length}-arm × ${taskIndices.length} executed tasks`,
    description:
      `Collective-vs-single on EXECUTED code (tasks ${taskIndices[0] ?? '?'}-` +
      `${taskIndices[taskIndices.length - 1] ?? '?'}); score = sandbox test pass rate, graded ` +
      `POST-HOC on each arm's final output (the sandbox is NOT a runtime verifier inside the ` +
      `collective — this measures collective SYNTHESIS vs the best single, not best-of-N ` +
      `selection; review V1). ${topModels.length} singles (current frontier flagships + full ` +
      `provider breadth) + ${strategies.join(', ')}.`,
    taskIndices,
    modes,
    repetitions: options?.repetitions ?? 3,
    maxBudgetUsd: options?.maxBudgetUsd ?? 20,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 4,
    freezeLearningDuringEval: true,
  };
}

/**
 * PUBLIC-BENCHMARK axis: HumanEval (code pass@1) — Ailin¹ Collective
 * Intelligence vs flagship-solo on the standard public dataset.
 *
 * Loads the vendored 164 HumanEval problems (see experiment-dataset-loader.ts)
 * as an explicit `tasks` universe, so the run maps directly onto a benchmark
 * the market reports. Each problem is graded by SANDBOX EXECUTION of the
 * dataset's native check() harness — binary pass@1, no LLM judge (so no judge
 * pin required). Arms: the benchmark singles (frontier flagships + provider
 * breadth) as the flagship-solo baseline, plus a few collective strategies so
 * "does orchestration beat the best single on real code?" is measured on a
 * defensible, market-comparable axis.
 */
export async function buildAilinHumanEval(options?: {
  repetitions?: number;
  maxBudgetUsd?: number;
  collectiveStrategies?: CollectiveStrategy[];
  limit?: number;
}): Promise<ExperimentConfig> {
  const topModels = await resolveBenchmarkSingles();
  const tasks = loadHumanEvalTasks({ limit: options?.limit });
  const strategies: CollectiveStrategy[] =
    options?.collectiveStrategies ?? ['consensus', 'critique-repair', 'cost-cascade'];

  const modes: ModeConfig[] = [
    ...topModels.map((m): SingleModelConfig => ({
      mode: 'single-model',
      modelId: m.id,
      displayName: `${m.displayName} (${m.provider})`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.95,
    })),
    ...strategies.map((strategy): CollectiveConfig => ({
      mode: 'collective',
      strategy,
      qualityTarget: 1.0,
      requiredCapabilities: ['chat'],
    })),
  ];

  return {
    name: `Ailin¹ HumanEval — ${modes.length}-arm × ${tasks.length} problems (code pass@1)`,
    description:
      `Public-benchmark axis: HumanEval (${tasks.length} problems) graded by sandbox execution ` +
      `of each problem's native check() harness — binary pass@1, judge-free. ` +
      `${topModels.length} flagship-solo singles vs Ailin¹ ${strategies.join(', ')}. ` +
      `Market-comparable code-generation axis for the Ailin¹ Collective Intelligence thesis.`,
    taskIndices: tasks.map((t) => t.index),
    tasks,
    modes,
    repetitions: options?.repetitions ?? 1,
    maxBudgetUsd: options?.maxBudgetUsd ?? 30,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 4,
    freezeLearningDuringEval: true,
  };
}

/**
 * PUBLIC-BENCHMARK axis: GSM8K (grade-school math accuracy) — Ailin¹
 * Collective Intelligence vs flagship-solo on the standard public dataset.
 *
 * Loads a bounded, deterministic prefix of the GSM8K test split (see
 * experiment-dataset-loader.ts) as an explicit `tasks` universe. Each problem
 * is graded by `numeric_equals` on the model's `FINAL: <n>` line — objective,
 * no sandbox, no LLM judge (so no judge pin required). Arms: benchmark singles
 * (flagship-solo baseline) plus a few collective strategies, to measure
 * whether orchestration lifts grade-school-math accuracy on a market-comparable
 * axis.
 */
export async function buildAilinGsm8k(options?: {
  repetitions?: number;
  maxBudgetUsd?: number;
  collectiveStrategies?: CollectiveStrategy[];
  limit?: number;
}): Promise<ExperimentConfig> {
  const topModels = await resolveBenchmarkSingles();
  const tasks = loadGsm8kTasks({ limit: options?.limit ?? 100 });
  const strategies: CollectiveStrategy[] =
    options?.collectiveStrategies ?? ['consensus', 'adaptive', 'cost-cascade'];

  const modes: ModeConfig[] = [
    ...topModels.map((m): SingleModelConfig => ({
      mode: 'single-model',
      modelId: m.id,
      displayName: `${m.displayName} (${m.provider})`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.9,
    })),
    ...strategies.map((strategy): CollectiveConfig => ({
      mode: 'collective',
      strategy,
      qualityTarget: 1.0,
      requiredCapabilities: ['chat'],
    })),
  ];

  return {
    name: `Ailin¹ GSM8K — ${modes.length}-arm × ${tasks.length} problems (math accuracy)`,
    description:
      `Public-benchmark axis: GSM8K (${tasks.length} problems) graded by numeric_equals on the ` +
      `FINAL line — objective, judge-free, no sandbox. ${topModels.length} flagship-solo singles ` +
      `vs Ailin¹ ${strategies.join(', ')}. Market-comparable grade-school-math axis for the ` +
      `Ailin¹ Collective Intelligence thesis.`,
    taskIndices: tasks.map((t) => t.index),
    tasks,
    modes,
    repetitions: options?.repetitions ?? 1,
    maxBudgetUsd: options?.maxBudgetUsd ?? 20,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 4,
    freezeLearningDuringEval: true,
  };
}

/**
 * TOOL-CALLING capability run (capability #4, 2026-07-13).
 *
 * The tasks (166-169) hand the model a deterministic tool whose FICTIONAL result
 * it cannot know without calling it (made-up currencies / SKUs — see
 * experiment-tool-catalog.ts). The runner forwards `tools` + `tool_choice`; the
 * server runs its real agentic tool loop (base-strategy.executeModelWithTools),
 * executing the tool via the registry and feeding the datum back; the runner then
 * grades OBJECTIVELY — answer_check on the post-loop FINAL answer, OR a matching
 * raw tool_call. NO LLM judge (so no judge pin is required). A model that CALLS
 * the tool scores 1; one that answers BLIND cannot reach the number → 0.
 *
 * Arms: the benchmark singles (frontier flagships + provider breadth) — does the
 * model recognise it MUST call the tool? — plus loop-capable collectives, to see
 * whether orchestration helps or hurts tool use. `agentic` is the tool-native
 * planner; `collaborative`/`sequential` branch to executeModelWithTools for their
 * primary role, so the loop actually runs. `hierarchical` is deliberately absent:
 * it is a NON_COLLECTIVE_BENCHMARK_STRATEGIES stub (manager-only = a single model).
 * Every arm requires `function_calling` so only capable models are selected.
 */
export async function buildC3ToolCalling(options?: {
  repetitions?: number;
  maxBudgetUsd?: number;
  taskIndices?: number[];
  collectiveStrategies?: CollectiveStrategy[];
}): Promise<ExperimentConfig> {
  const topModels = await resolveBenchmarkSingles();
  const taskIndices = options?.taskIndices?.length
    ? options.taskIndices
    : getToolCallingTaskIndices();
  // Loop-capable, genuine collectives only (all branch to executeModelWithTools).
  const strategies: CollectiveStrategy[] =
    options?.collectiveStrategies ?? ['agentic', 'collaborative', 'sequential'];
  const CAPS = ['chat', 'function_calling'];

  const modes: ModeConfig[] = [
    ...topModels.map((m): SingleModelConfig => ({
      mode: 'single-model',
      modelId: m.id,
      displayName: `${m.displayName} (${m.provider})`,
      requiredCapabilities: CAPS,
      qualityTarget: 0.95,
    })),
    ...strategies.map((strategy): CollectiveConfig => ({
      mode: 'collective',
      strategy,
      qualityTarget: 1.0,
      requiredCapabilities: CAPS,
    })),
  ];

  return {
    name: `C3 Tool-Calling — ${modes.length}-arm × ${taskIndices.length} tasks`,
    description:
      `Capability #4 (tool-calling): the answer is only reachable by CALLING a provided ` +
      `deterministic tool whose fictional result is unknowable (tasks ${taskIndices.join(', ')}). ` +
      `Objective grade — answer_check on the post-loop FINAL answer OR a matching tool_call; ` +
      `NO LLM judge. ${topModels.length} singles (frontier flagships + provider breadth) + ` +
      `${strategies.join(', ')}. All arms require function_calling.`,
    taskIndices,
    modes,
    repetitions: options?.repetitions ?? 3,
    maxBudgetUsd: options?.maxBudgetUsd ?? 10,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 2,
    freezeLearningDuringEval: true,
  };
}

/**
 * CANVAS-PHYSICS code benchmark (2026-07-11). Mirrors the public "build a
 * self-contained HTML5 canvas scene with real physics" contests: compares the
 * COLLECTIVE strategies where best-of-N helps (consensus — verifier-armed via
 * the tasks' structural full-text answerCheck — blind-debate, competitive,
 * massive-parallel) against every top-tier SINGLE, on the 10 canvas scenes
 * (tasks 136-145). The thesis lever here is concrete: a collective can REJECT a
 * structurally-broken candidate (no <canvas>/context/animation loop) and
 * synthesize from the ones that run — "a broken output costs you reruns".
 *
 * Cost note: these emit large code outputs (up to 32k tokens); default budget is
 * higher and repetitions lower than the numeric mini-run. Uses a PINNED judge
 * (physics plausibility is judged) — set EXPERIMENT_JUDGE_MODEL (non-competitor).
 */
export async function buildC3CanvasPhysics(options?: {
  repetitions?: number;
  maxBudgetUsd?: number;
  collectiveStrategies?: CollectiveStrategy[];
}): Promise<ExperimentConfig> {
  const topModels = await resolveBenchmarkSingles();
  const taskIndices = getCanvasPhysicsTaskIndices();
  const strategies: CollectiveStrategy[] =
    options?.collectiveStrategies ?? ['consensus', 'blind-debate', 'competitive', 'massive-parallel'];

  const modes: ModeConfig[] = [
    ...topModels.map((m): SingleModelConfig => ({
      mode: 'single-model',
      modelId: m.id,
      displayName: `${m.displayName} (${m.provider})`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.95,
    })),
    ...strategies.map((strategy): CollectiveConfig => ({
      mode: 'collective',
      strategy,
      qualityTarget: 1.0,
      requiredCapabilities: ['chat'],
    })),
  ];

  return {
    name: `C3 Canvas-Physics — ${modes.length}-arm × ${taskIndices.length} scenes`,
    description:
      `Collective-vs-single on self-contained HTML5 canvas physics scenes ` +
      `(tasks ${taskIndices[0] ?? '?'}-${taskIndices[taskIndices.length - 1] ?? '?'}). ` +
      `Structural full-text verifier (has <canvas>/getContext/requestAnimationFrame) arms ` +
      `best-of-N; the judge scores physics plausibility. ${topModels.length} singles (current ` +
      `frontier flagships + full provider breadth) + ${strategies.join(', ')}.`,
    taskIndices,
    modes,
    repetitions: options?.repetitions ?? 2,
    maxBudgetUsd: options?.maxBudgetUsd ?? 40,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 4,
    freezeLearningDuringEval: true,
  };
}

/**
 * Frontier supplement (2026-07-05, post-7bb900e2 single-arm audit).
 *
 * The main comparison's single arm is built by resolveTopTierModels() —
 * 1 model per provider ranked by contextWindow/cost — which yields the
 * best model EACH PROVIDER serves, not the frontier of the market. In
 * 7bb900e2 that arm contained haiku/flash-lite/gpt-3.5-class models and
 * zero current flagships, so "collective ≥ best single" was never tested
 * against the single models the thesis actually names as the bar.
 *
 * This config pins the CURRENT FLAGSHIP of each frontier family
 * (GPT-5.4+, Claude Opus 4.6+, Gemini Pro newest, Grok 4+) as explicit
 * single arms and runs them on the same task suite (stratified sample ∪
 * verifiable subset) against the three collective arms that survived the
 * v4 errata analysis (consensus, blind-debate, expert-panel).
 *
 * PROTOCOL — judge MUST be pinned to a NON-competitor family: with all
 * four flagship families now contestants, EXPERIMENT_JUDGE_MODEL must be
 * qwen/deepseek/mistral-class or the scores are self-graded. Do NOT
 * dispatch while another experiment is running (one-at-a-time invariant).
 *
 * Operator override: EXPERIMENT_FRONTIER_MODEL_IDS="id1,id2,..." pins the
 * single arms to exact catalog ids, bypassing family resolution.
 */
interface FrontierFamilySpec {
  /** Freshness family key from model-freshness.ts. */
  family: string;
  /** Human label for logs + config description. */
  label: string;
  /** Provider that serves this family natively (preferred over aggregators). */
  homeProviders: string[];
  /** Structural candidate filter over the lowercased model id. */
  match: (idLower: string) => boolean;
  /**
   * Freshness floor — generations below this are NOT current flagships
   * and must not fill the slot (e.g. gemini-1.5-pro, grok-3). The floor
   * is a guard, not the target: within the matched set the NEWEST
   * generation always wins, so gpt-5.5 beats gpt-5.4 when both exist.
   */
  minGeneration: number;
  /**
   * How many distinct models to pin from this family's ranking (default 1).
   * take:2 keeps the incumbent AND the newer release as separate arms
   * (2026-07-05 round 2: "os atuais + gpt-5.6/gemini-3.5" — both compared).
   */
  take?: number;
}

const FRONTIER_FAMILY_SPECS: FrontierFamilySpec[] = [
  { family: 'gpt', label: 'GPT-5.x (top-2 newest)', homeProviders: ['openai'], match: (id) => id.includes('gpt-5'), minGeneration: 5.0, take: 2 },
  { family: 'claude', label: 'Claude Opus 4.6+', homeProviders: ['anthropic'], match: (id) => id.includes('opus'), minGeneration: 4.5 },
  // Mythos-class tier (2026-07-05 round 2): Fable/Mythos ids do not carry a
  // parseable claude version (freshness score 0), so their floor is 0 and
  // the match pattern is the selector. Absent from the catalog → arm omitted
  // and logged, run proceeds.
  { family: 'claude', label: 'Claude Fable 5', homeProviders: ['anthropic'], match: (id) => id.includes('fable'), minGeneration: 0 },
  { family: 'claude', label: 'Claude Mythos 5', homeProviders: ['anthropic'], match: (id) => id.includes('mythos'), minGeneration: 0 },
  { family: 'gemini', label: 'Gemini Pro (top-2 newest)', homeProviders: ['google'], match: (id) => id.includes('gemini') && id.includes('pro'), minGeneration: 2.5, take: 2 },
  { family: 'grok', label: 'Grok 4+', homeProviders: ['xai', 'x-ai'], match: (id) => id.includes('grok'), minGeneration: 4.0 },
];

/**
 * Downsized/specialty variants that share a flagship's name but are not
 * the flagship (grok-4-fast, gpt-5.1-codex-mini, *-search-api...). A
 * flagship arm filled by one of these would fake the comparison low.
 */
const FRONTIER_VARIANT_EXCLUSIONS = [
  'mini', 'nano', 'lite', 'flash', 'fast', 'micro', 'tiny', 'small',
  'codex', 'distill', 'air', 'search', 'audio', 'realtime', 'transcribe',
  'tts', 'embed', 'image',
];

// Token-bounded matcher: variants are dash/dot-delimited segments of the
// id ('gpt-5.1-codex-mini', 'grok-4-fast'). A raw substring test would
// false-positive on 'geMINI' — the token must sit between delimiters.
const FRONTIER_VARIANT_EXCLUSION_RE = new RegExp(
  `(?:^|[-_./])(?:${FRONTIER_VARIANT_EXCLUSIONS.join('|')})(?:$|[-_./])`,
);

export async function resolveFrontierModels(options?: {
  /** Cap on pinned singles (round 2: up to 8 flagship arms). */
  maxModels?: number;
}): Promise<Array<{ id: string; displayName: string; provider: string; family: string }>> {
  const maxModels = options?.maxModels ?? 10;

  // Lazy credit monitor (same optimistic pattern as resolveTopTierModels).
  let creditMonitor: { hasCredits(providerId: string): boolean } | null = null;
  try {
    const mod = await import('@/services/credit-monitor-service');
    creditMonitor = mod.getCreditMonitorService();
  } catch {
    log.warn('Credit monitor unavailable — frontier resolution proceeds without credit filter');
  }

  // Operability gate (review F3): resolveTopTierModels/resolveBudgetModels gate
  // on the operability hub (skip providers the hub already knows are
  // auth_failed/no_credits/dead), but the FRONTIER resolver did NOT — so a dead
  // flagship could be elected as a single arm and fail every task (0 score),
  // contaminating the H-A comparison with a phantom frontier competitor. Apply
  // the SAME gate here. Optimistic when the hub is unavailable.
  const operable = await getOperabilityGate();

  type Row = {
    id: string;
    displayName: string | null;
    contextWindow: number | null;
    capabilities: unknown;
    provider: { name: string };
  };

  const isChatCapable = (row: Row): boolean => {
    const caps = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];
    return caps.includes('chat');
  };

  // Operator override: exact catalog ids, DB-existence checked, order kept.
  const overrideIds = (process.env.EXPERIMENT_FRONTIER_MODEL_IDS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (overrideIds.length > 0) {
    const rows: Row[] = await prisma.model.findMany({
      where: { status: 'active', id: { in: overrideIds } },
      include: { provider: true },
    });
    const byId = new Map(rows.filter(isChatCapable).map((r) => [r.id, r]));
    const pinned = overrideIds
      .filter((id) => {
        if (byId.has(id)) return true;
        log.warn({ modelId: id }, 'EXPERIMENT_FRONTIER_MODEL_IDS entry not active+chat-capable in DB — skipped');
        return false;
      })
      .slice(0, maxModels)
      .map((id) => {
        const row = byId.get(id)!;
        return {
          id: row.id,
          displayName: row.displayName ?? row.id,
          provider: row.provider.name,
          family: scoreModelFreshness(row.id).family,
        };
      });
    log.info({ requested: overrideIds.length, pinned: pinned.length }, 'Frontier singles pinned via EXPERIMENT_FRONTIER_MODEL_IDS');
    return pinned;
  }

  // Default path: one broad query, then per-family flagship election in JS
  // (structural filters stay in JS so they hold regardless of how the DB
  // layer evolves — same rationale as resolveTopTierModels).
  let rows: Row[] = [];
  try {
    const raw = await prisma.model.findMany({
      where: {
        status: 'active',
        OR: ['gpt-5', 'opus', 'gemini', 'grok', 'fable', 'mythos'].map((p) => ({ id: { contains: p } })),
      },
      orderBy: [{ contextWindow: 'desc' }],
      include: { provider: true },
      take: 2000,
    });
    rows = Array.isArray(raw) ? raw : [];
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : String(err) }, 'Frontier resolution query failed — no flagship singles');
    return [];
  }

  const picked: Array<{ id: string; displayName: string; provider: string; family: string }> = [];

  for (const spec of FRONTIER_FAMILY_SPECS) {
    if (picked.length >= maxModels) break;

    const candidates = rows
      .filter((row) => {
        const idLower = row.id.toLowerCase();
        if (!spec.match(idLower)) return false;
        if (!isChatCapable(row)) return false;
        if (FRONTIER_VARIANT_EXCLUSION_RE.test(idLower)) return false;
        if (creditMonitor && !creditMonitor.hasCredits(row.provider.name)) return false;
        // Operability gate (review F3) — skip a flagship whose provider the hub
        // knows is not currently usable, so it never becomes a dead single arm.
        if (!operable(row.provider.name)) {
          log.warn({ modelId: row.id, provider: row.provider.name, family: spec.family },
            'Frontier candidate rejected — provider not operable');
          return false;
        }
        // Canonical-owner gate (mis-election guard): the broad substring
        // match above (id.includes('mythos') etc.) has no owner awareness,
        // so a community fork like `King3Djbl/mythos-9b-unhinged` on the
        // huggingface aggregator can win a flagship slot outright — its
        // family is 'unknown' to scoreModelFreshness, which forces score=0,
        // and zero-floor specs (Fable/Mythos, minGeneration: 0) treat that
        // as a pass rather than a reject. Require the same owner-allowlist
        // used to gate C3 budget pins (resolveBudgetStructured's Stage B).
        const owner = extractModelOwner(row.id, row.provider.name);
        const providerTier = classifyProviderTier(row.provider.name);
        const providerName = row.provider.name.toLowerCase();
        const isCanonicalOwner = row.id.includes('/')
          ? (CANONICAL_MODEL_OWNERS.has(owner) || owner === providerName)
          : (providerTier === 'local' || CANONICAL_MODEL_OWNERS.has(providerName));
        if (!isCanonicalOwner) {
          log.warn({ modelId: row.id, provider: row.provider.name, owner, family: spec.family },
            'Frontier candidate rejected — non-canonical model owner');
          return false;
        }
        return true;
      })
      .map((row) => {
        const fresh = scoreModelFreshness(row.id);
        // Sanity clamp: date-token parses (e.g. claude-3-opus-20240229 →
        // 20240229) must not outrank real versions. >100 means the parser
        // read a date/sequence, not a generation — treat as unparseable.
        const score = fresh.family === spec.family && fresh.generationScore <= 100
          ? fresh.generationScore
          : 0;
        return { row, fresh, score };
      })
      .filter((c) => c.score >= spec.minGeneration && !c.fresh.isDeprecated)
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.fresh.isPreview !== b.fresh.isPreview) return a.fresh.isPreview ? 1 : -1;
        const aHome = spec.homeProviders.includes(a.row.provider.name.toLowerCase()) ? 0 : 1;
        const bHome = spec.homeProviders.includes(b.row.provider.name.toLowerCase()) ? 0 : 1;
        if (aHome !== bHome) return aHome - bHome;
        return (b.row.contextWindow ?? 0) - (a.row.contextWindow ?? 0);
      });

    if (candidates.length === 0) {
      log.warn(
        { family: spec.family, label: spec.label, minGeneration: spec.minGeneration },
        'No current-flagship candidate in catalog for frontier family — arm omitted',
      );
      continue;
    }

    // Take the top-N DISTINCT model ids for this spec, skipping ids another
    // spec already pinned (e.g. an explicit-family spec overlapping the
    // generic one). take:2 keeps incumbent + newer release as separate arms.
    const takeN = spec.take ?? 1;
    let taken = 0;
    for (const cand of candidates) {
      if (taken >= takeN || picked.length >= maxModels) break;
      if (picked.some((p) => p.id === cand.row.id)) continue;
      picked.push({
        id: cand.row.id,
        displayName: cand.row.displayName ?? cand.row.id,
        provider: cand.row.provider.name,
        family: spec.family,
      });
      taken++;
      log.info(
        {
          family: spec.family,
          label: spec.label,
          modelId: cand.row.id,
          provider: cand.row.provider.name,
          generationScore: cand.score,
          pickIndex: taken,
          alternativesConsidered: candidates.length - 1,
        },
        'Frontier flagship elected for family (newest generation wins)',
      );
    }
  }

  return picked;
}

export async function buildC3FrontierComparison(options?: {
  taskIndices?: number[];
  repetitions?: number;
  maxBudgetUsd?: number;
}): Promise<ExperimentConfig> {
  const frontier = await resolveFrontierModels();

  const modes: ModeConfig[] = [
    ...frontier.map((m): SingleModelConfig => ({
      mode: 'single-model',
      modelId: m.id,
      displayName: `${m.displayName} (${m.provider}, frontier ${m.family})`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.95,
    })),
    // The collective arms the flagship singles must beat: consensus
    // (verifier-armed on the verifiable subset), blind-debate (strongest
    // cheap independence-preserving arm in 7bb900e2), expert-panel
    // (strongest role-structured arm).
    { mode: 'collective', strategy: 'consensus', qualityTarget: 1.0, requiredCapabilities: ['chat'] },
    { mode: 'collective', strategy: 'blind-debate', qualityTarget: 1.0, requiredCapabilities: ['chat'] },
    { mode: 'collective', strategy: 'expert-panel', qualityTarget: 1.0, requiredCapabilities: ['chat'] },
  ];

  // Same suite as the main run, sampled to stay cheap: a wide stratified
  // draw plus ALL verifiable tasks (H-A needs them against real flagships).
  const taskIndices = options?.taskIndices && options.taskIndices.length > 0
    ? options.taskIndices
    : [...new Set([...pickStratifiedTaskIndices(10), ...VERIFIABLE_TASK_INDICES])].sort((a, b) => a - b);

  return {
    name: `C3 Frontier Supplement — ${frontier.length} flagship singles vs 3 collectives × ${taskIndices.length} tasks`,
    description:
      `Directed supplement: explicit flagship single arms (${frontier.map((m) => m.id).join(', ') || 'NONE RESOLVED'}) ` +
      `vs consensus/blind-debate/expert-panel on a stratified sample ∪ verifiable subset of the same suite. ` +
      `Closes the 7bb900e2 gap where the single arm had no frontier model. ` +
      `Judge must be pinned NON-competitor (EXPERIMENT_JUDGE_MODEL, qwen/deepseek/mistral-class).`,
    taskIndices,
    modes,
    repetitions: options?.repetitions ?? 2,
    // 2026-07-05 round 2: raised from 60. The CreditGovernor splits the cap
    // into per-ARM buckets (maxBudget / #arms); with ~10 arms and collective
    // arms costing $0.2-0.6/exec × ~76 execs (~$15-35/arm), a $60 cap
    // starves exactly the expensive arms (silent skips in run 9590ff41 —
    // now counted via progress.skipReasons but still lost coverage). The cap
    // is a CEILING, not a target: observed full-run spend is $40-120.
    maxBudgetUsd: options?.maxBudgetUsd ?? 250,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 4,
    freezeLearningDuringEval: true,
  };
}

/**
 * H-A top-up (2026-07-05, post-9590ff41 adjudication).
 *
 * Run 9590ff41 gave the flagship SINGLES two full reps on the verifiable
 * subset (20/20 each), but the collective arms were truncated by silent
 * `arm_budget_exceeded` skips (consensus covered 5/10 tasks, blind-debate
 * 1/10): the per-arm budget bucket (maxBudget / #arms) penalizes exactly
 * the arms that cost more per execution, and complexity-first ordering put
 * the verifiable (low-complexity) tasks at the END of the queue.
 *
 * This config runs ONLY the three collective arms on ONLY the verifiable
 * tasks, with a budget sized so no arm bucket can bite (~$6/arm vs ~$0.2/exec
 * observed × 20 execs ≈ $4/arm worst case).
 *
 * POOLING RULE: these rows pool with 9590ff41's single-arm rows ONLY if
 * EXPERIMENT_JUDGE_MODEL is pinned to the SAME judge (deepseek-v4-pro) —
 * same instrument or no comparison. The start workflow enforces the
 * non-competitor gate for this key.
 */
export function buildC3FrontierHaTopup(options?: {
  repetitions?: number;
  maxBudgetUsd?: number;
}): ExperimentConfig {
  const modes: ModeConfig[] = [
    { mode: 'collective', strategy: 'consensus', qualityTarget: 1.0, requiredCapabilities: ['chat'] },
    { mode: 'collective', strategy: 'blind-debate', qualityTarget: 1.0, requiredCapabilities: ['chat'] },
    { mode: 'collective', strategy: 'expert-panel', qualityTarget: 1.0, requiredCapabilities: ['chat'] },
  ];

  return {
    name: `C3 Frontier H-A Top-up — 3 collectives × ${VERIFIABLE_TASK_INDICES.length} verifiable tasks`,
    description:
      'Collectives-only top-up of the 9590ff41 frontier supplement on the verifiable subset ' +
      '(116-125, answer_check → best-of-N verifier armed). Completes the H-A sample the ' +
      'arm-budget skips truncated. Pool with 9590ff41 singles only under the SAME pinned judge.',
    taskIndices: [...VERIFIABLE_TASK_INDICES],
    modes,
    repetitions: options?.repetitions ?? 2,
    maxBudgetUsd: options?.maxBudgetUsd ?? 18,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 2,
    freezeLearningDuringEval: true,
  };
}

/**
 * H-B mini-run (2026-07-06, first instantiation — Ollama on the project VPS).
 *
 * Pre-registered H-B: "a small/cheap model on OWN infrastructure,
 * cooperating with cheap externals, beats the top-tier individual at
 * lower cost". Never exercised before because no own/self-hosted model
 * existed. With Ollama registered (see workflow action setup-own-model)
 * and OWN_MODEL_ENABLED=true, this config builds the directed test:
 *
 *   - own single arm(s): the self-hosted model(s) alone (baseline);
 *   - Mixed Collective arms: forced pool [own + 2 cheapest externals]
 *     under consensus AND sensitivity-consensus (same construction as
 *     buildC3MainComparison, so results pool);
 *   - reference arms: dynamic-pool consensus + the cheapest external as
 *     a single (the "cheap external alone" baseline).
 *
 * Tasks: stratified sample ∪ verifiable subset — same suite as the
 * frontier campaign, so H-B results compare directly against the
 * committed flagship numbers UNDER THE SAME PINNED JUDGE (workflow gate
 * enforces the non-competitor pin for this key).
 */
export async function buildC3HbMixedMiniRun(options?: {
  taskIndices?: number[];
  repetitions?: number;
  maxBudgetUsd?: number;
}): Promise<ExperimentConfig> {
  const ownModels = await resolveOwnModels();
  // Own models are near-zero-cost, so the budget resolver would pick them
  // too — dedupe so the mixed pool is genuinely [own + 2 EXTERNAL cheap].
  const budgetModels = (await resolveBudgetModels())
    .filter((b) => !ownModels.some((o) => o.id === b.id));

  const modes: ModeConfig[] = [];
  for (const m of ownModels.slice(0, 2)) {
    modes.push({
      mode: 'single-model',
      modelId: m.id,
      displayName: `Own: ${m.displayName}`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.95,
    });
  }
  if (ownModels.length > 0 && budgetModels.length >= 2) {
    const mixedPool = [ownModels[0].id, budgetModels[0].id, budgetModels[1].id];
    for (const strategy of ['consensus', 'sensitivity-consensus'] as CollectiveStrategy[]) {
      modes.push({
        mode: 'forced-pool-collective',
        strategy,
        forcedModelPool: mixedPool,
        displayName: `Mixed Collective ${strategy} (own + 2 budget)`,
        qualityTarget: 1.0,
        requiredCapabilities: ['chat'],
      });
    }
  }
  if (budgetModels.length > 0) {
    modes.push({
      mode: 'single-model',
      modelId: budgetModels[0].id,
      displayName: `Budget single: ${budgetModels[0].displayName}`,
      requiredCapabilities: ['chat'],
      qualityTarget: 0.95,
    });
  }
  modes.push({ mode: 'collective', strategy: 'consensus', qualityTarget: 1.0, requiredCapabilities: ['chat'] });

  const taskIndices = options?.taskIndices && options.taskIndices.length > 0
    ? options.taskIndices
    : [...new Set([...pickStratifiedTaskIndices(10), ...VERIFIABLE_TASK_INDICES])].sort((a, b) => a - b);

  return {
    name: `C3 H-B Mixed Mini-Run — ${ownModels.length} own + mixed collectives × ${taskIndices.length} tasks`,
    description:
      `First H-B instantiation: own/self-hosted model(s) (${ownModels.slice(0, 2).map((m) => m.id).join(', ') || 'NONE RESOLVED'}) ` +
      `alone and inside Mixed Collectives (forced pool own + 2 budget: ${budgetModels.slice(0, 2).map((m) => m.id).join(', ')}), ` +
      `vs dynamic consensus and the cheapest external single. Same suite/judge as the frontier campaign — ` +
      `judge must stay pinned NON-competitor (EXPERIMENT_JUDGE_MODEL).`,
    taskIndices,
    modes,
    repetitions: options?.repetitions ?? 2,
    maxBudgetUsd: options?.maxBudgetUsd ?? 20,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 2,
    freezeLearningDuringEval: true,
  };
}

/**
 * PHASE 2: Ablation study
 * Generates 11 conditions (full + 10 single-component ablations)
 * for a given strategy across a subset of tasks.
 */
export function buildC3Ablation(options?: {
  strategy?: CollectiveStrategy;
  taskIndices?: number[];
  repetitions?: number;
  maxBudgetUsd?: number;
}): ExperimentConfig {
  const strategy = options?.strategy ?? 'debate';
  const matrix = generateAblationMatrix(strategy);

  // Convert to ModeConfig[]
  const modes: ModeConfig[] = matrix.map((ab): AblationConfig => ({
    mode: 'ablation',
    strategy: ab.strategy as CollectiveStrategy,
    displayName: ab.displayName,
    disableComponents: ab.disableComponents,
    requiredCapabilities: ['chat'],
  }));

  return {
    name: `C3 Ablation — ${strategy}`,
    description: `Component ablation study for ${strategy}. 11 conditions: full + 10 single-component ablations.`,
    // Default to the RUNNABLE text set, not [] (whole suite). An empty list made
    // getFilteredTasks return every task — including compositor-strategy tasks
    // (strategy unimplemented → mislabeled, contaminating attribution) and
    // payload-less multimodal tasks (asked to analyze an attachment the suite
    // never populates → guaranteed failures). getRunnableTextTaskIndices()
    // excludes exactly those. Operators can still pass an explicit taskIndices.
    // (review TS-02 — getRunnableTextTaskIndices was dead code until now.)
    taskIndices: options?.taskIndices ?? getRunnableTextTaskIndices(),
    modes,
    repetitions: options?.repetitions ?? 2,
    maxBudgetUsd: options?.maxBudgetUsd ?? 300,
    delayBetweenCallsMs: 1500,
    maxConcurrency: 4,
    warmupExecutions: 0,
    freezeLearningDuringEval: true,
  };
}

/**
 * PHASE 3: Independence & Herding test
 * Runs multiple collective strategies to measure diversity and herding.
 * Uses a focused subset of tasks for efficiency.
 */
export function buildC3IndependenceHerding(options?: {
  taskIndices?: number[];
  repetitions?: number;
  maxBudgetUsd?: number;
}): ExperimentConfig {
  const strategies: CollectiveStrategy[] = [...BENCHMARK_COLLECTIVE_STRATEGIES]; // stubs (e.g. hierarchical) excluded — see NON_COLLECTIVE_BENCHMARK_STRATEGIES

  const modes: ModeConfig[] = strategies.map((strategy): ModeConfig => ({
    mode: 'collective',
    strategy,
    requiredCapabilities: ['chat'],
  }));

  return {
    name: 'C3 Independence & Herding Test',
    description: `Runs all ${strategies.length} registered collective strategies to measure real diversity via IndependenceTestService. Herding scenarios injected via hidden-info suite.`,
    // Default to the RUNNABLE text set, not [] (whole suite). An empty list made
    // getFilteredTasks return every task — including compositor-strategy tasks
    // (strategy unimplemented → mislabeled, contaminating attribution) and
    // payload-less multimodal tasks (asked to analyze an attachment the suite
    // never populates → guaranteed failures). getRunnableTextTaskIndices()
    // excludes exactly those. Operators can still pass an explicit taskIndices.
    // (review TS-02 — getRunnableTextTaskIndices was dead code until now.)
    taskIndices: options?.taskIndices ?? getRunnableTextTaskIndices(),
    modes,
    repetitions: options?.repetitions ?? 2,
    maxBudgetUsd: options?.maxBudgetUsd ?? 150,
    delayBetweenCallsMs: 2000,
    maxConcurrency: 3,
    warmupExecutions: 0,
    freezeLearningDuringEval: true,
  };
}

/**
 * PHASE 5: Learning baselines
 * Compares Thompson Sampling selection (default) against epsilon-greedy and random.
 * Uses ablation to disable bandit for the random/epsilon-greedy conditions.
 *
 * - Arm 1: Full collective (Thompson Sampling active) — control
 * - Arm 2: Ablation -bandit (random selection) — baseline
 * - Arm 3: Single Tier 1 — oracle-like upper bound (resolved dynamically)
 */
export async function buildC3LearningBaselines(options?: {
  strategy?: CollectiveStrategy;
  taskIndices?: number[];
  repetitions?: number;
  maxBudgetUsd?: number;
}): Promise<ExperimentConfig> {
  const strategy = options?.strategy ?? 'debate';
  const topModels = await resolveTopTierModels();

  // Pick the best available single model for the oracle arm
  const oracleModel = topModels[0];

  const modes: ModeConfig[] = [
    // Control: full Thompson Sampling
    {
      mode: 'collective',
      strategy,
      qualityTarget: 0.80,
      requiredCapabilities: ['chat'],
    },
    // Ablation: random selection (bandit disabled)
    {
      mode: 'ablation',
      strategy,
      displayName: `${strategy} (random selection)`,
      disableComponents: ['bandit'],
      requiredCapabilities: ['chat'],
    },
    // Oracle: single Tier 1 (pinned model or fallback to auto)
    oracleModel
      ? {
          mode: 'single-model' as const,
          modelId: oracleModel.id,
          displayName: `Oracle (${oracleModel.displayName})`,
          qualityTarget: 0.95,
          requiredCapabilities: ['chat'],
        }
      : {
          mode: 'single-model' as const,
          modelId: 'auto',
          displayName: 'Oracle (best available)',
          qualityTarget: 0.95,
          requiredCapabilities: ['chat'],
        },
  ];

  return {
    name: `C3 Learning Baselines — ${strategy}`,
    description: `Compares Thompson Sampling vs random selection vs oracle (${oracleModel?.id ?? 'auto'}). Measures cumulative regret.`,
    // Default to the RUNNABLE text set, not [] (whole suite). An empty list made
    // getFilteredTasks return every task — including compositor-strategy tasks
    // (strategy unimplemented → mislabeled, contaminating attribution) and
    // payload-less multimodal tasks (asked to analyze an attachment the suite
    // never populates → guaranteed failures). getRunnableTextTaskIndices()
    // excludes exactly those. Operators can still pass an explicit taskIndices.
    // (review TS-02 — getRunnableTextTaskIndices was dead code until now.)
    taskIndices: options?.taskIndices ?? getRunnableTextTaskIndices(),
    modes,
    repetitions: options?.repetitions ?? 3,
    maxBudgetUsd: options?.maxBudgetUsd ?? 100,
    delayBetweenCallsMs: 1500,
    maxConcurrency: 4,
    warmupExecutions: 20, // Warmup to let TS learn
    freezeLearningDuringEval: true,
  };
}

/**
 * PHASE 6: Longitudinal learning
 * Runs a single collective strategy over many executions WITHOUT
 * freezing learning, then measures improvement over time via snapshots.
 */
export function buildC3Longitudinal(options?: {
  strategy?: CollectiveStrategy;
  taskIndices?: number[];
  repetitions?: number;
  maxBudgetUsd?: number;
}): ExperimentConfig {
  const strategy = options?.strategy ?? 'debate';

  return {
    name: `C3 Longitudinal Learning — ${strategy}`,
    description: `Measures learning improvement over time. Learning NOT frozen. Snapshots taken every 100 updates.`,
    // Default to the RUNNABLE text set, not [] (whole suite). An empty list made
    // getFilteredTasks return every task — including compositor-strategy tasks
    // (strategy unimplemented → mislabeled, contaminating attribution) and
    // payload-less multimodal tasks (asked to analyze an attachment the suite
    // never populates → guaranteed failures). getRunnableTextTaskIndices()
    // excludes exactly those. Operators can still pass an explicit taskIndices.
    // (review TS-02 — getRunnableTextTaskIndices was dead code until now.)
    taskIndices: options?.taskIndices ?? getRunnableTextTaskIndices(),
    modes: [{ mode: 'collective', strategy, requiredCapabilities: ['chat'] }],
    repetitions: options?.repetitions ?? 5,
    maxBudgetUsd: options?.maxBudgetUsd ?? 150,
    delayBetweenCallsMs: 1000,
    maxConcurrency: 4,
    warmupExecutions: 0,
    freezeLearningDuringEval: false, // Learning stays active
  };
}

/**
 * MINI-RUN PILOT: Small-scale version of Phase 1 for infrastructure validation.
 *
 * 12 tasks (4 low + 4 medium + 4 high, evenly spaced through the suite
 * so domain diversity is wide) × N arms × 2 reps. Replaces the prior
 * arbitrary `[0,1,10,11,20,21,30,31,40,41]` sample which:
 *   - skewed 80% tech-domain
 *   - skipped tasks 50-115 (compositor/leader-test/multi-modal)
 *   - had no complexity stratification guarantee
 */
export async function buildC3Pilot(options?: {
  taskIndices?: number[];
  maxBudgetUsd?: number;
}): Promise<ExperimentConfig> {
  const pilotTasks = options?.taskIndices ?? pickStratifiedTaskIndices(4);

  const mainConfig = await buildC3MainComparison({
    taskIndices: pilotTasks,
    repetitions: 2,
    maxBudgetUsd: options?.maxBudgetUsd ?? 25,
  });

  return {
    ...mainConfig,
    name: 'C3 Pilot — Infrastructure Validation',
    description:
      'Mini-run to validate C3 infrastructure: scoring path, ablation flags, ' +
      'diversity measurement, ROI recording, budget governance. Tasks are ' +
      'stratified by complexity (low/medium/high) and evenly spaced through ' +
      'the suite for wide domain coverage.',
  };
}

/**
 * PHASE 7 (F2.8): Adversarial Robustness
 *
 * Drives every collective strategy through the synthetic adversarial
 * scenarios in `core/coordination/adversarial-scenarios.ts`. Each
 * arm pairs one strategy with one scenario. The scenarios are
 * deterministic (signal generators), so this phase does NOT consume
 * top-tier-model API budget for the attack simulation itself — the
 * model calls are still measured via the existing strategy budget,
 * but the attack pattern is canned.
 *
 * Goal: provide an executable, reproducible spec for the
 * coordination layer's robustness claims. Operators can run this
 * arm to verify that:
 *   - poisoning + spamming patterns trigger the conservative
 *     detector (when adversaries are pure-cohort);
 *   - mixed cohorts do NOT produce false positives;
 *   - majority decisions survive a small hostile minority;
 *   - median / trimmed_mean aggregators damp outliers as designed.
 *
 * Scenarios live in production code so this builder consumes them
 * by name (`AdversarialScenarioName`) and the experiment-runner
 * resolves the generator at execution time.
 */
export const C3_ADVERSARIAL_STRATEGIES: CollectiveStrategy[] = [
  'consensus',
  'debate',
  'sensitivity-consensus',
  'tri-role-collective',
  'critique-repair',
];

/**
 * The five canned adversarial scenarios shipped in
 * `core/coordination/adversarial-scenarios.ts`. The cross-product of
 * `C3_ADVERSARIAL_STRATEGIES × C3_ADVERSARIAL_SCENARIOS` produces the
 * arm matrix for the robustness phase.
 */
export const C3_ADVERSARIAL_SCENARIOS: AdversarialScenarioName[] = [
  'sensitivity_poisoning',
  'herding_cascade',
  'confidence_spamming',
  'outlier_amplification',
  'hostile_minority',
];

export function buildC3AdversarialRobustness(options?: {
  strategies?: CollectiveStrategy[];
  scenarios?: AdversarialScenarioName[];
  taskIndices?: number[];
  repetitions?: number;
  maxBudgetUsd?: number;
}): ExperimentConfig {
  const strategies = options?.strategies ?? C3_ADVERSARIAL_STRATEGIES;
  const scenarios = options?.scenarios ?? C3_ADVERSARIAL_SCENARIOS;

  // F2.9 — Cross-product (strategy × scenario). Each mode tags its
  // scenario via `adversarialScenario`; downstream tooling
  // (experiment-runner, report generator, dashboards) groups by both
  // axes so detector accuracy can be measured per pair.
  const modes: ModeConfig[] = [];
  for (const strategy of strategies) {
    for (const scenario of scenarios) {
      const mode: CollectiveConfig = {
        mode: 'collective',
        strategy,
        qualityTarget: 0.85,
        requiredCapabilities: ['chat'],
        adversarialScenario: scenario,
        displayName: `${strategy} × ${scenario}`,
      };
      modes.push(mode);
    }
  }

  return {
    name: 'C3 Adversarial Robustness',
    description:
      `Cross-product of ${strategies.length} collective strategies × ${scenarios.length} adversarial ` +
      `scenarios = ${strategies.length * scenarios.length} arms. Measures detector accuracy and ` +
      'aggregator robustness across the canonical attack patterns ' +
      '(poisoning, herding cascade, confidence spamming, outlier amplification, hostile minority). ' +
      `Tasks default to the ${ADVERSARIAL_TASK_INDICES.length} suite entries tagged ` +
      "`taskType: 'adversarial'` so the scenarios run against tasks DESIGNED for adversarial " +
      'probing, not the first N generic tasks.',
    // Default to the suite's adversarial-tagged tasks. Operators can
    // override via options.taskIndices for broader runs.
    taskIndices: options?.taskIndices ?? ADVERSARIAL_TASK_INDICES,
    modes,
    repetitions: options?.repetitions ?? 2,
    maxBudgetUsd: options?.maxBudgetUsd ?? 120,
    delayBetweenCallsMs: 1500,
    maxConcurrency: 3,
    warmupExecutions: 0,
    freezeLearningDuringEval: true,
  };
}

/**
 * MINI-RUN ADVERSARIAL PILOT: Small-scale verification that the
 * adversarial arm wires correctly without burning the budget.
 * 6 tasks × (N strategies × M scenarios) × 1 rep.
 */
export function buildC3AdversarialPilot(options?: {
  strategies?: CollectiveStrategy[];
  scenarios?: AdversarialScenarioName[];
  maxBudgetUsd?: number;
}): ExperimentConfig {
  return {
    ...buildC3AdversarialRobustness({
      strategies: options?.strategies ?? ['consensus', 'sensitivity-consensus', 'tri-role-collective'],
      // Pilot uses the two highest-signal scenarios so detector
      // wiring is exercised without the full cross-product cost.
      scenarios: options?.scenarios ?? ['sensitivity_poisoning', 'herding_cascade'],
      // Use the suite's adversarial-tagged tasks. Half the count of
      // the full robustness phase to keep the pilot cheap.
      taskIndices: ADVERSARIAL_TASK_INDICES.slice(
        0,
        Math.max(3, Math.ceil(ADVERSARIAL_TASK_INDICES.length / 2)),
      ),
      repetitions: 1,
      maxBudgetUsd: options?.maxBudgetUsd ?? 30,
    }),
    name: 'C3 Adversarial Pilot',
    description: 'Mini adversarial run to validate detector wiring across 3 strategies × 2 scenarios on adversarial-tagged tasks.',
  };
}

/**
 * MINI-RUN ABLATION PILOT: Small-scale ablation test
 * 5 tasks x 11 conditions x 1 rep = 55 executions
 */
export function buildC3AblationPilot(options?: {
  strategy?: CollectiveStrategy;
  taskIndices?: number[];
  maxBudgetUsd?: number;
}): ExperimentConfig {
  const pilotTasks = options?.taskIndices ?? [0, 10, 20, 30, 40];

  return {
    ...buildC3Ablation({
      strategy: options?.strategy ?? 'debate',
      taskIndices: pilotTasks,
      repetitions: 1,
      maxBudgetUsd: options?.maxBudgetUsd ?? 30,
    }),
    name: 'C3 Ablation Pilot',
    description: 'Mini ablation run to verify all 10 component ablations produce observable differences.',
  };
}

/**
 * Single source of truth: maps every C3 config key to its builder.
 *
 * This map is the ONLY place that lists which configs exist. Both
 * the GET /v1/admin/experiment/c3-configs (listing) and POST
 * /v1/admin/experiment/c3-create (dispatch) endpoints read from
 * here, so they CANNOT drift out of sync. The architectural
 * invariant "every key in the listing is callable" is enforced
 * structurally — there's nowhere else to add a key.
 *
 * Builders accept an optional opts object so the API can override
 * taskIndices / repetitions / maxBudgetUsd from the request body.
 */
export const C3_CONFIG_BUILDERS: Record<
  string,
  (opts?: Record<string, unknown>) => ExperimentConfig | Promise<ExperimentConfig>
> = {
  'c3-pilot': (opts) => buildC3Pilot(opts as Parameters<typeof buildC3Pilot>[0]),
  'c3-ablation-pilot': (opts) => buildC3AblationPilot(opts as Parameters<typeof buildC3AblationPilot>[0]),
  'c3-main-comparison': (opts) =>
    buildC3MainComparison(opts as Parameters<typeof buildC3MainComparison>[0]),
  // H-A adjudication: verifiable tasks (116-125, answer_check → best-of-N
  // verifier) × top-tier singles + consensus + blind-debate. See the builder
  // docstring and reports/experiments/2026-07-03-v4-preregistration.md.
  'c3-ha-verifiable-minirun': (opts) =>
    buildC3VerifiableMiniRun(opts as Parameters<typeof buildC3VerifiableMiniRun>[0]),
  // PURE H-A test (2026-07-12): hard verifiable tier (146-155) × singles +
  // verifier-armed consensus + blind-debate contrast. The fairest, undiluted
  // chance for the thesis in the objective-verification regime.
  'c3-ha-hard': (opts) =>
    buildC3HaHard(opts as Parameters<typeof buildC3HaHard>[0]),
  // Code-verified benchmark (2026-07-12): executed-and-tested code (156-160),
  // scored by sandbox pass rate — "coding with real functional delivery".
  'c3-code-verified': (opts) =>
    buildC3CodeVerified(opts as Parameters<typeof buildC3CodeVerified>[0]),
  // Capability #4 (tool-calling, 2026-07-13): the answer is only reachable by
  // calling a provided deterministic tool (tasks 166-169). Objectively graded —
  // no LLM judge, so no judge pin required. See buildC3ToolCalling.
  'c3-tool-calling': (opts) =>
    buildC3ToolCalling(opts as Parameters<typeof buildC3ToolCalling>[0]),
  // Public-benchmark axes (2026-07-21): Ailin¹ Collective Intelligence vs
  // flagship-solo on the STANDARD public datasets, so results map onto what
  // the market reports. Both judge-free (sandbox pass@1 / numeric_equals), so
  // no judge pin required. Tasks loaded from vendored fixtures — see
  // experiment-dataset-loader.ts.
  'ailin-humaneval': (opts) =>
    buildAilinHumanEval(opts as Parameters<typeof buildAilinHumanEval>[0]),
  'ailin-gsm8k': (opts) =>
    buildAilinGsm8k(opts as Parameters<typeof buildAilinGsm8k>[0]),
  // Canvas-physics code benchmark (2026-07-11): collective strategies vs top-tier
  // singles on self-contained HTML5 canvas physics scenes (tasks 136-145), with a
  // structural full-text verifier arming best-of-N. PINNED judge required.
  'c3-canvas-physics': (opts) =>
    buildC3CanvasPhysics(opts as Parameters<typeof buildC3CanvasPhysics>[0]),
  // Frontier supplement (2026-07-05): explicit flagship singles
  // (GPT-5.4+/Opus 4.6+/Gemini Pro/Grok 4+) vs the three surviving
  // collective arms, on stratified sample ∪ verifiable subset. See the
  // builder docstring for the pinned-judge protocol requirement.
  'c3-frontier-comparison': (opts) =>
    buildC3FrontierComparison(opts as Parameters<typeof buildC3FrontierComparison>[0]),
  // H-A top-up: collectives-only × verifiable subset — completes the sample
  // the 9590ff41 arm-budget skips truncated. Same pinned judge required.
  'c3-frontier-ha-topup': (opts) =>
    buildC3FrontierHaTopup(opts as Parameters<typeof buildC3FrontierHaTopup>[0]),
  // H-B first instantiation (2026-07-06): own/self-hosted (Ollama on the
  // VPS) + Mixed Collectives vs cheap-single and dynamic consensus.
  'c3-hb-mixed-minirun': (opts) =>
    buildC3HbMixedMiniRun(opts as Parameters<typeof buildC3HbMixedMiniRun>[0]),
  'c3-ablation-debate': (opts) =>
    buildC3Ablation({ strategy: 'debate', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-consensus': (opts) =>
    buildC3Ablation({ strategy: 'consensus', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-war-room': (opts) =>
    buildC3Ablation({ strategy: 'war-room', ...(opts as Record<string, unknown> | undefined) }),
  // Phase 2c strategies — these were missing from ablation coverage
  // entirely. Without them, the component-importance analysis ignores
  // the strategies that the coord-stable shadow wire actually targets.
  'c3-ablation-sensitivity-consensus': (opts) =>
    buildC3Ablation({
      strategy: 'sensitivity-consensus',
      ...(opts as Record<string, unknown> | undefined),
    }),
  'c3-ablation-tri-role-collective': (opts) =>
    buildC3Ablation({
      strategy: 'tri-role-collective',
      ...(opts as Record<string, unknown> | undefined),
    }),
  'c3-ablation-expert-panel': (opts) =>
    buildC3Ablation({
      strategy: 'expert-panel',
      ...(opts as Record<string, unknown> | undefined),
    }),
  'c3-ablation-critique-repair': (opts) =>
    buildC3Ablation({
      strategy: 'critique-repair',
      ...(opts as Record<string, unknown> | undefined),
    }),
  // Universal ablation coverage (2026-07-19): the 7 configs above were the
  // strategies the coord-stable shadow wire and Phase 2c work happened to
  // target — the other 23 non-stub collective strategies (everything in
  // BENCHMARK_COLLECTIVE_STRATEGIES except the 7 above) had zero ablation
  // coverage. Same builder, same 11-condition (full + 10 single-component)
  // matrix, just the remaining strategy names — no new logic.
  'c3-ablation-collaborative': (opts) =>
    buildC3Ablation({ strategy: 'collaborative', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-parallel': (opts) =>
    buildC3Ablation({ strategy: 'parallel', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-sequential': (opts) =>
    buildC3Ablation({ strategy: 'sequential', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-hybrid': (opts) =>
    buildC3Ablation({ strategy: 'hybrid', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-competitive': (opts) =>
    buildC3Ablation({ strategy: 'competitive', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-massive-parallel': (opts) =>
    buildC3Ablation({ strategy: 'massive-parallel', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-cost-cascade': (opts) =>
    buildC3Ablation({ strategy: 'cost-cascade', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-quality-multipass': (opts) =>
    buildC3Ablation({ strategy: 'quality-multipass', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-adaptive': (opts) =>
    buildC3Ablation({ strategy: 'adaptive', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-contextual': (opts) =>
    buildC3Ablation({ strategy: 'contextual', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-reinforcement': (opts) =>
    buildC3Ablation({ strategy: 'reinforcement', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-blind-debate': (opts) =>
    buildC3Ablation({ strategy: 'blind-debate', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-devil-advocate-consensus': (opts) =>
    buildC3Ablation({ strategy: 'devil-advocate-consensus', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-safety-quorum': (opts) =>
    buildC3Ablation({ strategy: 'safety-quorum', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-diversity-ensemble': (opts) =>
    buildC3Ablation({ strategy: 'diversity-ensemble', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-stigmergic-refinement': (opts) =>
    buildC3Ablation({ strategy: 'stigmergic-refinement', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-swarm-explore': (opts) =>
    buildC3Ablation({ strategy: 'swarm-explore', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-clarification-first': (opts) =>
    buildC3Ablation({ strategy: 'clarification-first', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-research-synthesize': (opts) =>
    buildC3Ablation({ strategy: 'research-synthesize', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-double-diamond': (opts) =>
    buildC3Ablation({ strategy: 'double-diamond', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-multi-hop-qa': (opts) =>
    buildC3Ablation({ strategy: 'multi-hop-qa', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-persona-exploration': (opts) =>
    buildC3Ablation({ strategy: 'persona-exploration', ...(opts as Record<string, unknown> | undefined) }),
  'c3-ablation-agentic': (opts) =>
    buildC3Ablation({ strategy: 'agentic', ...(opts as Record<string, unknown> | undefined) }),
  'c3-independence-herding': (opts) =>
    buildC3IndependenceHerding(opts as Parameters<typeof buildC3IndependenceHerding>[0]),
  'c3-learning-baselines': (opts) =>
    buildC3LearningBaselines(opts as Parameters<typeof buildC3LearningBaselines>[0]),
  'c3-longitudinal': (opts) =>
    buildC3Longitudinal(opts as Parameters<typeof buildC3Longitudinal>[0]),
  // F2.8 — Adversarial robustness phase. Both builders previously
  // existed in this module but were missing from the /c3-create
  // dispatcher, so callers got 400 "Unknown config key" despite
  // seeing them in the GET /c3-configs listing. Routing them through
  // the central map closes that drift permanently.
  'c3-adversarial-robustness': (opts) =>
    buildC3AdversarialRobustness(opts as Parameters<typeof buildC3AdversarialRobustness>[0]),
  'c3-adversarial-pilot': (opts) =>
    buildC3AdversarialPilot(opts as Parameters<typeof buildC3AdversarialPilot>[0]),
};

/**
 * Get all C3 experiment configs as a named collection for the
 * /c3-configs listing. Iterates the central C3_CONFIG_BUILDERS so
 * the listing is always exactly what /c3-create can dispatch.
 */
export async function getAllC3Configs(): Promise<Record<string, ExperimentConfig>> {
  const entries = await Promise.all(
    Object.entries(C3_CONFIG_BUILDERS).map(async ([key, builder]) => {
      const config = await builder();
      return [key, config] as const;
    }),
  );
  return Object.fromEntries(entries);
}
