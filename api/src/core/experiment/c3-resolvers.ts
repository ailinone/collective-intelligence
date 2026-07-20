// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * C3 Resolvers — single-query, structured, audit-friendly.
 *
 * Replaces the N+1 per-provider loops in `c3-experiment-configs.ts` that
 * exhausted the Prisma pool when `getAllC3Configs()` invoked 15 builders
 * concurrently. Each resolver here issues ONE query, then groups in JS.
 *
 * Returned shape includes:
 *  - `candidates`: structured rows with classification + reason
 *  - `blocked`:    rows rejected by a filter stage, with stage + reason
 *  - `funnel`:     per-stage input/output counts
 *  - `warnings`:   non-fatal observations (e.g. zero candidates with reason)
 *
 * The `description` strings in C3 configs stay backwards compatible: the
 * resolver returns `pins` matching the old return shape so existing
 * callers (`buildC3MainComparison`, etc.) keep working unchanged.
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import type { ProviderTier } from '@/core/operability/operational-candidate-pool';
import { scoreModelFreshness, compareFreshness } from './model-freshness';

const log = logger.child({ component: 'c3-resolvers' });

// ─── Structural classification helpers ──────────────────────────────────

/**
 * Canonical model-owner allowlist. Used to gate budget pins (and any
 * resolver where user-namespaced experimental forks should be excluded).
 *
 * Owners are the substring BEFORE the first `/` in a HuggingFace-style id.
 * For non-prefixed ids (e.g. `gpt-5.4-pro`) the provider name fills the
 * same role.
 *
 * Conservative list — known frontier orgs + major open-weight orgs only.
 * Extending requires a code change so the C3 budget pool can't silently
 * pull in random user namespaces.
 */
export const CANONICAL_MODEL_OWNERS = new Set<string>([
  // Closed frontier
  'openai', 'anthropic', 'google', 'x-ai', 'xai',
  // Open-weight frontier
  'meta', 'meta-llama', 'mistral', 'mistralai', 'qwen', 'qwen-team',
  'deepseek', 'deepseek-ai', 'cohere',
  'moonshotai', 'moonshot', 'kimi-team',
  'microsoft', 'ibm', 'ibm-granite',
  '01-ai', 'baichuan', 'internlm', 'allenai', 'ai21',
  'databricks', 'snowflake', 'nvidia', 'reka',
  'sambanova', 'upstage', 'minimax', 'perplexity',
  'jamba', 'gemma', 'google-deepmind',
  // Hub providers expose models under their own namespace too — allow the
  // namespace but the resolver still filters by canonical model name inside.
  'huggingface',
]);

/**
 * Model names known to be ROUTING ALIASES, not concrete models. These
 * have sentinel prices and no fixed identity; pinning them breaks
 * reproducibility because the underlying model changes per request.
 */
const ROUTING_ALIAS_NAMES = new Set<string>([
  'auto', 'default', 'router', 'dynamic', 'optimized', 'optimised',
]);

/**
 * Known aggregator provider names. Reused from
 * `operational-candidate-pool.ts` to keep tier classification consistent
 * across the codebase (no second source of truth).
 */
const KNOWN_AGGREGATORS = new Set<string>([
  'aihubmix', 'cometapi', 'openrouter', 'aiml', 'nanogpt', 'edenai',
  'novita', 'routeway', 'requesty', 'helicone', 'heliconeai', 'poe',
  'ai302', '302ai', 'imagerouter', 'vercel-ai-gateway', 'orqai',
  // huggingface hosts community models under arbitrary user namespaces.
  // Classifying as 'aggregator' forces the budget resolver to require a
  // canonical owner — otherwise random user-namespaced finetunes like
  // `rednote-hilab/dots.ocr` (an OCR model tagged 'chat') leak into
  // budget pins. Top-tier picks from canonical HF orgs (Qwen/, deepseek-ai/,
  // meta-llama/) still pass — their owners are in CANONICAL_MODEL_OWNERS.
  'huggingface',
]);

/**
 * Heuristic tier classifier. Mirrors the OperationalCandidatePool logic
 * but operates on raw `providerId` because we don't always have the
 * integration class in DB queries.
 */
export function classifyProviderTier(providerName: string): ProviderTier {
  const id = providerName.toLowerCase();
  if (id.startsWith('ollama') || id.includes('local') || id === 'self-hosted') return 'local';
  if (KNOWN_AGGREGATORS.has(id)) return 'aggregator';
  if (id.includes('cloudflare') || id.includes('workers-ai') || id.includes('edge')) return 'edge';
  // Observers are providers that EXPOSE models without executing them
  // (e.g. catalog mirrors). None in the current local catalog; treat as
  // 'native' fallback for now.
  return 'native';
}

/**
 * Extract owner from a model id. Returns the part before the first `/`
 * for HF-style ids, or the provider name when no prefix exists.
 */
export function extractModelOwner(modelId: string, providerName: string): string {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx > 0) return modelId.slice(0, slashIdx).toLowerCase();
  return providerName.toLowerCase();
}

// ─── Classification: TopTier ────────────────────────────────────────────

export type TopTierClass =
  | 'frontier_closed_direct'
  | 'frontier_via_aggregator'
  | 'high_capability_open_weight'
  | 'reasoning_premium'
  | 'high_context_premium'
  | 'local_top';

const FRONTIER_CLOSED_FAMILIES = ['gpt-', 'claude', 'gemini', 'grok', 'o1', 'o3', 'o4'];
const OPEN_WEIGHT_FRONTIER_FAMILIES = [
  'llama-3', 'llama3', 'qwen3', 'qwen-2.5', 'qwen2.5',
  'deepseek-v3', 'deepseek-r1', 'mistral-large', 'magistral',
  'kimi', 'k2-', 'command-a', 'command-r', 'jamba',
];
const REASONING_HINTS = ['reasoning', 'thinking_mode', 'deep_research'];

function classifyTopTier(args: {
  modelId: string;
  providerName: string;
  providerTier: ProviderTier;
  capabilities: string[];
  contextWindow: number | null;
}): TopTierClass {
  const id = args.modelId.toLowerCase();
  const caps = args.capabilities.map((c) => c.toLowerCase());

  // Local first (overrides everything else)
  if (args.providerTier === 'local') return 'local_top';

  // Reasoning-premium: model has reasoning capability OR name matches
  if (caps.some((c) => REASONING_HINTS.includes(c)) ||
      /\b(o1|o3|o4|deepseek-r1|reasoner|thinking)\b/.test(id)) {
    return 'reasoning_premium';
  }

  // Frontier closed-source families
  if (FRONTIER_CLOSED_FAMILIES.some((fam) => id.includes(fam))) {
    return args.providerTier === 'aggregator'
      ? 'frontier_via_aggregator'
      : 'frontier_closed_direct';
  }

  // Open-weight frontier
  if (OPEN_WEIGHT_FRONTIER_FAMILIES.some((fam) => id.includes(fam))) {
    return 'high_capability_open_weight';
  }

  // High-context premium (≥ 200k)
  if ((args.contextWindow ?? 0) >= 200_000) {
    return 'high_context_premium';
  }

  // Fallback: treat as open-weight (everything else is unrecognised but chat)
  return 'high_capability_open_weight';
}

// ─── Common types ────────────────────────────────────────────────────────

export interface TopTierCandidate {
  providerId: string;       // provider.name
  modelId: string;
  modelFamily?: string;
  canonicalModelId?: string;
  topTierClass: TopTierClass;
  providerTier: ProviderTier;
  contextWindow?: number;
  healthState?: string;
  creditStatus?: string;
  reason: string;
  // 2026-05-12 (ramp-final): freshness fields populated by the
  // freshness-aware resolver. `freshnessFamily` is the canonical family
  // key ('kimi','gpt',…) used for cross-provider intra-family ranking;
  // `freshnessGenerationScore` is a family-specific numeric score
  // (higher = newer); `isPreview`/`isDeprecated` are subtractive flags.
  freshnessFamily?: string;
  freshnessGenerationScore?: number;
  isPreview?: boolean;
  isDeprecated?: boolean;
}

export interface OwnCandidate {
  providerId: string;
  modelId: string;
  modelFamily?: string;
  providerTier: ProviderTier;
  contextWindow?: number;
  reason: string;
}

export interface BudgetCandidate {
  providerId: string;
  modelId: string;
  modelFamily?: string;
  providerTier: ProviderTier;
  contextWindow?: number;
  inputCostPer1k?: number;
  outputCostPer1k?: number;
  reason: string;
}

/**
 * 2026-05-12 (scale-probe): policySource separates three classes of
 * exclusion so the audit can distinguish dev-only contortions from
 * principled scientific selection.
 *
 * - `debugPolicy`: operator-applied env exclusions (EXPERIMENT_*_BLOCKED_*)
 *   and adapter-incompatibility workarounds. NOT scientific. The
 *   audit flags these as `debugOnly: true`.
 * - `operationalReadinessPolicy`: hub-state-driven (no_credits,
 *   auth_failed, rate_limited, temporarily_unavailable). Applies in any
 *   environment where the provider/model truly can't run.
 * - `experimentSelectionPolicy`: principled selection ranking (freshness,
 *   per-provider cap, model owner allowlist, capability filter). The
 *   "scientific" exclusion path.
 */
export type PolicySource = 'debugPolicy' | 'operationalReadinessPolicy' | 'experimentSelectionPolicy';

export interface BlockedCandidate {
  providerId: string;
  modelId: string;
  modelFamily?: string;
  role: 'top_tier' | 'own' | 'budget';
  blockedReason: string;
  stage: string;
  /**
   * Which of the three policy types caused this exclusion. Required
   * so dashboards / reports can distinguish "blocked because the
   * operator added a dev-env workaround" from "blocked because the
   * provider's API key was revoked" from "blocked because a fresher
   * model won the ranking".
   */
  policySource?: PolicySource;
  /** True iff policySource === 'debugPolicy'. Convenience flag. */
  debugOnly?: boolean;
}

export interface ResolverFunnel {
  stages: Array<{
    name: string;
    input: number;
    output: number;
    removed: number;
    mainRemovalReasons: Record<string, number>;
  }>;
}

export interface ResolverOutput<T> {
  candidates: T[];
  blocked: BlockedCandidate[];
  funnel: ResolverFunnel;
  warnings: string[];
  reasonIfZero?: string;
}

// ─── Memoization (30s TTL) ──────────────────────────────────────────────
// Repeated calls in the same `getAllC3Configs()` cycle hit one cached
// result instead of hammering Prisma. TTL is short so the audit endpoint
// reflects recent catalog state.

const RESOLVER_CACHE_TTL_MS = Number(process.env.C3_RESOLVER_CACHE_TTL_MS ?? 30_000);

interface CachedEntry<T> { value: T; expiresAt: number; }

/**
 * Per-options cache. Critical because the canary builder calls with
 * tighter limits (maxProviders:3) while main-comparison calls without —
 * a shared cache would poison main-comparison with a 3-entry slice the
 * first time canary is hit.
 */
class KeyedTTLCache<T> {
  private map = new Map<string, CachedEntry<T>>();
  async get(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.map.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = await fn();
    this.map.set(key, { value, expiresAt: now + RESOLVER_CACHE_TTL_MS });
    return value;
  }

  invalidate(): void { this.map.clear(); }
}

const topTierCache = new KeyedTTLCache<ResolverOutput<TopTierCandidate>>();
const ownCache = new KeyedTTLCache<ResolverOutput<OwnCandidate>>();
const budgetCache = new KeyedTTLCache<ResolverOutput<BudgetCandidate>>();

export function invalidateC3ResolverCaches(): void {
  topTierCache.invalidate();
  ownCache.invalidate();
  budgetCache.invalidate();
}

// ─── Top-tier resolver ──────────────────────────────────────────────────

export async function resolveTopTierStructured(opts?: {
  maxProviders?: number;
  perProvider?: number;
}): Promise<ResolverOutput<TopTierCandidate>> {
  const key = `mp=${opts?.maxProviders ?? 'default'}|pp=${opts?.perProvider ?? 'default'}`;
  return topTierCache.get(key, async () => doResolveTopTier(opts));
}

async function doResolveTopTier(opts?: {
  maxProviders?: number;
  perProvider?: number;
}): Promise<ResolverOutput<TopTierCandidate>> {
  const maxProviders = opts?.maxProviders
    ?? Number(process.env.EXPERIMENT_TOP_TIER_MAX_PROVIDERS ?? 30);
  const perProvider = opts?.perProvider
    ?? Number(process.env.EXPERIMENT_TOP_TIER_PER_PROVIDER ?? 1);
  const minContext = Number(process.env.EXPERIMENT_TOP_TIER_MIN_CONTEXT ?? 4096);
  const includeLocal = (process.env.EXPERIMENT_TOP_TIER_INCLUDE_LOCAL ?? 'true') === 'true';

  const blocked: BlockedCandidate[] = [];
  const warnings: string[] = [];
  const reasonCounts: Record<string, Record<string, number>> = {};

  // SINGLE query — pre-filter chat capability at DB layer so we don't
  // waste the per-provider top-K window on non-chat models.
  let rows: Array<{
    id: string;
    displayName: string | null;
    contextWindow: number | null;
    inputCostPer1k: { toNumber(): number } | number | null;
    capabilities: unknown;
    provider: { name: string };
  }> = [];
  try {
    rows = await prisma.model.findMany({
      where: {
        status: 'active',
        contextWindow: { gte: minContext },
        // Prisma JSON filter: capabilities array contains "chat"
        capabilities: { array_contains: ['chat'] },
        ...(includeLocal ? {} : {
          provider: { name: { not: { startsWith: 'ollama' } } },
        }),
      },
      orderBy: [
        { contextWindow: 'desc' },
        { inputCostPer1k: 'asc' },
      ],
      include: { provider: true },
      // Wide window: we'll dedupe-by-provider in JS and pick the top per group.
      take: 5000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'Top-tier resolver: DB query failed');
    return {
      candidates: [],
      blocked: [],
      funnel: { stages: [{ name: 'db_query', input: 0, output: 0, removed: 0, mainRemovalReasons: { db_error: 1 } }] },
      warnings: [`db_query_failed: ${msg}`],
      reasonIfZero: 'db_query_failed',
    };
  }

  const stageRawCount = rows.length;

  // Lazy credit monitor lookup. Optimistic on absence.
  let creditMonitor: { hasCredits(providerId: string): boolean } | null = null;
  try {
    const mod = await import('@/services/credit-monitor-service');
    creditMonitor = mod.getCreditMonitorService();
  } catch {
    warnings.push('credit_monitor_unavailable_optimistic');
  }

  // Health registry (optional — operability layer)
  let healthRegistry: {
    lookup(key: { providerId: string; modelId: string }): { state: string } | undefined;
  } | null = null;
  try {
    const mod = await import('@/core/operability/provider-health-registry');
    healthRegistry = mod.getProviderHealthRegistry();
  } catch {
    warnings.push('health_registry_unavailable_optimistic');
  }

  // 2026-05-11: ProviderOperabilityHub-aware skip — providers in
  // `auth_failed` / `no_credits` / `temporarily_unavailable` buckets
  // are excluded from pin selection. Without this the resolver kept
  // pinning providers that we already KNEW couldn't execute, causing
  // the canary's success rate to vary 40-86% on the same config.
  // Hub state is populated by runtime feedback (base-strategy.ts) and
  // by the catalog bootstrap. After canary #10 we observed 10/33
  // executions hit provider_quota_error — those provider slots should
  // not have been pinned to begin with.
  let hubSummary: Record<string, string[]> | null = null;
  try {
    const mod = await import('@/core/provider-operability-hub');
    hubSummary = mod.getProviderOperabilityHub().getSummary() as Record<string, string[]>;
  } catch {
    warnings.push('hub_unavailable_no_runtime_skip');
  }
  // 2026-05-12 (scale-probe): split exclusions into operational (hub
  // state) vs debug (env override) sets so we can tag policySource on
  // every blockedCandidate. Without this split the audit reports
  // `hub_unhealthy_or_blocklisted` ambiguously — operator can't tell
  // whether the model is REALLY unhealthy in this env or just
  // operator-excluded for a dev workaround.
  const operationallyUnhealthy = new Set<string>();
  if (hubSummary) {
    for (const p of [...(hubSummary.auth_failed ?? []), ...(hubSummary.no_credits ?? []), ...(hubSummary.temporarily_unavailable ?? [])]) {
      const baseId = p.includes(':') ? p.split(':')[0]! : p;
      operationallyUnhealthy.add(baseId.toLowerCase());
    }
  }

  // Explicit blocklist (operator override). Comma-separated provider IDs.
  const debugBlocklist = new Set<string>(
    (process.env.EXPERIMENT_BLOCKED_PROVIDERS ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  // 2026-05-12 (ramp-final): some providers have tiered billing —
  // their high-context premium models are 402 while their cheaper
  // models still work. EXPERIMENT_TOP_TIER_BLOCKED_PROVIDERS skips
  // them at top-tier only, leaving budget intact.
  const debugTopTierBlocklist = new Set<string>(
    (process.env.EXPERIMENT_TOP_TIER_BLOCKED_PROVIDERS ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );

  // Combined set used by the picker (any exclusion fires). Source is
  // tracked separately for audit-side classification.
  const unhealthyProviders = new Set<string>([
    ...operationallyUnhealthy,
    ...debugBlocklist,
    ...debugTopTierBlocklist,
  ]);
  if (unhealthyProviders.size > 0) {
    log.info({
      operational: [...operationallyUnhealthy],
      debugEnv: [...debugBlocklist],
      debugTopTierEnv: [...debugTopTierBlocklist],
    }, 'Top-tier resolver: skipping providers (split by policy source)');
  }

  // Helper for the picker loop to classify which policy fired.
  function classifyBlockPolicy(providerId: string): { source: PolicySource; reason: string } {
    const p = providerId.toLowerCase();
    if (operationallyUnhealthy.has(p)) return { source: 'operationalReadinessPolicy', reason: 'hub_state_unhealthy' };
    if (debugBlocklist.has(p)) return { source: 'debugPolicy', reason: 'env_blocklist:EXPERIMENT_BLOCKED_PROVIDERS' };
    if (debugTopTierBlocklist.has(p)) return { source: 'debugPolicy', reason: 'env_blocklist:EXPERIMENT_TOP_TIER_BLOCKED_PROVIDERS' };
    return { source: 'operationalReadinessPolicy', reason: 'unknown' };
  }

  // 2026-05-12 (ramp-final): re-sort `rows` so freshness is the tiebreaker
  // within ctx-ties AND within the same family. The previous comparator
  // returned 0 across families which made the order non-transitive
  // (A<B within kimi, A=C across families, C=B across families → sort
  // produces undefined results). Fix: a fully transitive total order
  //
  //   1) contextWindow desc   (primary — same as the SQL ORDER BY)
  //   2) family alpha asc     (groups same-family rows together)
  //   3) freshness desc       (kimi-k2.6 > kimi-k2.5 > kimi-k2-0905)
  //   4) cost asc             (final tiebreaker)
  //
  // The family-alpha-grouping step is what makes (3) effective: if
  // two same-ctx rows belong to the same family, they're adjacent
  // before freshness comparison runs, so the picker sees the fresher
  // sibling first. Without this, an interleaving row from a different
  // family at the same ctx would split the family group.
  rows.sort((a, b) => {
    const ctxA = a.contextWindow ?? 0;
    const ctxB = b.contextWindow ?? 0;
    if (ctxA !== ctxB) return ctxB - ctxA;

    const fa = scoreModelFreshness(a.id);
    const fb = scoreModelFreshness(b.id);

    // Group by family so same-family rows are adjacent. Unknown family
    // sorts last (alphabetically "unknown" > most family names; we
    // could special-case but the simple compare is good enough).
    if (fa.family !== fb.family) return fa.family.localeCompare(fb.family);

    // Within same family + ctx: freshness desc.
    const cmp = compareFreshness(fa, fb);
    if (cmp !== 0) return cmp;

    // Final tiebreaker: cost asc.
    const costA = typeof a.inputCostPer1k === 'object' && a.inputCostPer1k !== null
      ? a.inputCostPer1k.toNumber()
      : ((a.inputCostPer1k as number | null) ?? Number.POSITIVE_INFINITY);
    const costB = typeof b.inputCostPer1k === 'object' && b.inputCostPer1k !== null
      ? b.inputCostPer1k.toNumber()
      : ((b.inputCostPer1k as number | null) ?? Number.POSITIVE_INFINITY);
    return costA - costB;
  });

  // 2026-05-12 (ramp-final): model-level blocklist. Some providers are
  // globally healthy but have specific models out of balance (e.g.
  // gmi/XiaomiMiMo/MiMo-V2.5 returns HTTP 402 while gmi/nvidia/* works
  // fine). Provider-level blocking would also kill the working models,
  // so we add a complementary EXPERIMENT_BLOCKED_MODELS for
  // `provider:modelId` tuples. Case-insensitive on provider, exact on
  // modelId (model IDs often contain meaningful casing like
  // "XiaomiMiMo/MiMo-V2.5").
  const blockedModels = new Set<string>(
    (process.env.EXPERIMENT_BLOCKED_MODELS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((tuple) => {
        const idx = tuple.indexOf(':');
        if (idx < 0) return tuple.toLowerCase(); // bare provider — treat as provider-level
        return `${tuple.slice(0, idx).toLowerCase()}:${tuple.slice(idx + 1)}`;
      }),
  );
  if (blockedModels.size > 0) {
    log.info({ blockedModels: [...blockedModels] }, 'Top-tier resolver: model-level blocklist active');
  }

  // Group by provider, pick top-K per provider
  const perProviderPicks = new Map<string, TopTierCandidate[]>();
  let kept = 0;

  for (const row of rows) {
    if (perProviderPicks.size >= maxProviders &&
        !perProviderPicks.has(row.provider.name)) {
      blocked.push({
        providerId: row.provider.name,
        modelId: row.id,
        role: 'top_tier',
        blockedReason: 'max_providers_reached',
        stage: 'per_provider_cap',
        policySource: 'experimentSelectionPolicy',
      });
      reasonCounts['per_provider_cap'] = reasonCounts['per_provider_cap'] ?? {};
      reasonCounts['per_provider_cap']['max_providers_reached'] = (reasonCounts['per_provider_cap']['max_providers_reached'] ?? 0) + 1;
      continue;
    }

    const existing = perProviderPicks.get(row.provider.name) ?? [];
    if (existing.length >= perProvider) {
      blocked.push({
        providerId: row.provider.name,
        modelId: row.id,
        role: 'top_tier',
        blockedReason: 'per_provider_cap_reached',
        stage: 'per_provider_cap',
        policySource: 'experimentSelectionPolicy',
      });
      continue;
    }

    const providerTier = classifyProviderTier(row.provider.name);

    // Hub-aware skip: providers known to be unhealthy from runtime
    // feedback OR explicitly blocklisted via env are excluded.
    if (unhealthyProviders.has(row.provider.name.toLowerCase())) {
      const cls = classifyBlockPolicy(row.provider.name);
      blocked.push({
        providerId: row.provider.name,
        modelId: row.id,
        role: 'top_tier',
        blockedReason: cls.reason,
        stage: cls.source === 'debugPolicy' ? 'env_blocklist' : 'hub_filter',
        policySource: cls.source,
        debugOnly: cls.source === 'debugPolicy',
      });
      reasonCounts['hub_filter'] = reasonCounts['hub_filter'] ?? {};
      reasonCounts['hub_filter'][cls.reason] = (reasonCounts['hub_filter'][cls.reason] ?? 0) + 1;
      continue;
    }

    // Model-level blocklist (operator override for specific model that
    // is out of balance while the rest of the provider's catalog works).
    if (blockedModels.has(`${row.provider.name.toLowerCase()}:${row.id}`)) {
      blocked.push({
        providerId: row.provider.name,
        modelId: row.id,
        role: 'top_tier',
        blockedReason: 'model_blocklisted:EXPERIMENT_BLOCKED_MODELS',
        stage: 'model_blocklist',
        policySource: 'debugPolicy',
        debugOnly: true,
      });
      reasonCounts['model_blocklist'] = reasonCounts['model_blocklist'] ?? {};
      reasonCounts['model_blocklist']['blocked_model'] = (reasonCounts['model_blocklist']['blocked_model'] ?? 0) + 1;
      continue;
    }

    // Credit filter (optimistic when unknown)
    if (creditMonitor && !creditMonitor.hasCredits(row.provider.name)) {
      blocked.push({
        providerId: row.provider.name,
        modelId: row.id,
        role: 'top_tier',
        blockedReason: 'no_credits',
        stage: 'credit_filter',
        policySource: 'operationalReadinessPolicy',
      });
      reasonCounts['credit_filter'] = reasonCounts['credit_filter'] ?? {};
      reasonCounts['credit_filter']['no_credits'] = (reasonCounts['credit_filter']['no_credits'] ?? 0) + 1;
      continue;
    }

    // Health filter (skip auth_failed / insufficient_credit; degraded ok)
    let healthState: string | undefined;
    if (healthRegistry) {
      const record = healthRegistry.lookup({ providerId: row.provider.name, modelId: row.id });
      healthState = record?.state;
      if (healthState === 'auth_failed' || healthState === 'insufficient_credit') {
        blocked.push({
          providerId: row.provider.name,
          modelId: row.id,
          role: 'top_tier',
          blockedReason: `health_${healthState}`,
          stage: 'health_filter',
          policySource: 'operationalReadinessPolicy',
        });
        reasonCounts['health_filter'] = reasonCounts['health_filter'] ?? {};
        reasonCounts['health_filter'][`health_${healthState}`] = (reasonCounts['health_filter'][`health_${healthState}`] ?? 0) + 1;
        continue;
      }
    }

    const caps = Array.isArray(row.capabilities) ? row.capabilities as string[] : [];
    const ctx = row.contextWindow ?? undefined;
    const topTierClass = classifyTopTier({
      modelId: row.id,
      providerName: row.provider.name,
      providerTier,
      capabilities: caps,
      contextWindow: row.contextWindow,
    });

    const fresh = scoreModelFreshness(row.id);
    existing.push({
      providerId: row.provider.name,
      modelId: row.id,
      modelFamily: extractModelOwner(row.id, row.provider.name),
      canonicalModelId: row.id.includes('/') ? row.id.split('/').slice(1).join('/') : row.id,
      topTierClass,
      providerTier,
      contextWindow: ctx,
      healthState,
      creditStatus: creditMonitor ? (creditMonitor.hasCredits(row.provider.name) ? 'ok' : 'no_credits') : 'unknown',
      reason: `picked_top_${existing.length + 1}_for_provider`,
      freshnessFamily: fresh.family !== 'unknown' ? fresh.family : undefined,
      freshnessGenerationScore: fresh.generationScore || undefined,
      isPreview: fresh.isPreview || undefined,
      isDeprecated: fresh.isDeprecated || undefined,
    });
    perProviderPicks.set(row.provider.name, existing);
    kept++;
  }

  const candidates: TopTierCandidate[] = [];
  for (const picks of perProviderPicks.values()) candidates.push(...picks);

  if (candidates.length === 0) {
    warnings.push('top_tier_unavailable_check_blocked_candidates_for_reason');
  }

  const funnel: ResolverFunnel = {
    stages: [
      { name: 'db_query (active + ctx>=min + chat)', input: -1, output: stageRawCount, removed: 0, mainRemovalReasons: {} },
      { name: 'per_provider_cap', input: stageRawCount, output: kept + (blocked.filter(b => b.stage !== 'per_provider_cap').length), removed: (reasonCounts['per_provider_cap'] ? Object.values(reasonCounts['per_provider_cap']).reduce((a, b)=>a + b, 0) : 0), mainRemovalReasons: reasonCounts['per_provider_cap'] ?? {} },
      { name: 'credit_filter', input: stageRawCount, output: kept + blocked.filter(b => b.stage === 'health_filter').length, removed: (reasonCounts['credit_filter'] ? Object.values(reasonCounts['credit_filter']).reduce((a, b)=>a + b, 0) : 0), mainRemovalReasons: reasonCounts['credit_filter'] ?? {} },
      { name: 'health_filter', input: kept + blocked.filter(b => b.stage === 'health_filter').length, output: kept, removed: blocked.filter(b => b.stage === 'health_filter').length, mainRemovalReasons: reasonCounts['health_filter'] ?? {} },
      { name: 'final_pins', input: kept, output: candidates.length, removed: 0, mainRemovalReasons: {} },
    ],
  };

  log.info({ kept, blocked: blocked.length, providers: perProviderPicks.size }, 'Top-tier resolver: complete (single-query)');

  return {
    candidates,
    blocked,
    funnel,
    warnings,
    reasonIfZero: candidates.length === 0 ? 'no_provider_with_chat_capable_min_context_model' : undefined,
  };
}

// ─── Own resolver ───────────────────────────────────────────────────────

export async function resolveOwnStructured(): Promise<ResolverOutput<OwnCandidate>> {
  return ownCache.get('default', doResolveOwn);
}

async function doResolveOwn(): Promise<ResolverOutput<OwnCandidate>> {
  const enabled = process.env.OWN_MODEL_ENABLED === 'true';
  if (!enabled) {
    return {
      candidates: [],
      blocked: [],
      funnel: { stages: [{ name: 'env_gate', input: 0, output: 0, removed: 1, mainRemovalReasons: { own_model_disabled: 1 } }] },
      warnings: ['own_model_disabled_by_env'],
      reasonIfZero: 'OWN_MODEL_ENABLED=false (env gate)',
    };
  }

  try {
    const rows = await prisma.model.findMany({
      where: {
        status: 'active',
        OR: [
          { provider: { name: 'own-model' } },
          { id: { startsWith: 'own/' } },
          // 2026-07-06: self-hosted local-tier (Ollama on the project VPS)
          // counts as own infrastructure for H-B — see resolveOwnModels.
          { provider: { name: { startsWith: 'ollama' } } },
        ],
      },
      include: { provider: true },
      orderBy: { contextWindow: 'desc' },
    });

    const candidates: OwnCandidate[] = [];
    const blocked: BlockedCandidate[] = [];
    for (const row of rows) {
      const caps = Array.isArray(row.capabilities) ? row.capabilities as string[] : [];
      if (!caps.includes('chat')) {
        blocked.push({
          providerId: row.provider.name,
          modelId: row.id,
          role: 'own',
          blockedReason: 'not_chat_capable',
          stage: 'capability_filter',
        });
        continue;
      }
      candidates.push({
        providerId: row.provider.name,
        modelId: row.id,
        modelFamily: extractModelOwner(row.id, row.provider.name),
        providerTier: classifyProviderTier(row.provider.name),
        contextWindow: row.contextWindow ?? undefined,
        reason: 'active_chat_capable_own',
      });
    }

    return {
      candidates,
      blocked,
      funnel: {
        stages: [
          { name: 'db_query (own-model rows)', input: -1, output: rows.length, removed: 0, mainRemovalReasons: {} },
          { name: 'capability_filter', input: rows.length, output: candidates.length, removed: blocked.length, mainRemovalReasons: blocked.length > 0 ? { not_chat_capable: blocked.length } : {} },
        ],
      },
      warnings: candidates.length === 0 ? ['own_models_unavailable_no_chat_capable_own_row'] : [],
      reasonIfZero: candidates.length === 0 ? 'own_models_unavailable' : undefined,
    };
  } catch (err) {
    return {
      candidates: [],
      blocked: [],
      funnel: { stages: [{ name: 'db_query', input: 0, output: 0, removed: 0, mainRemovalReasons: { db_error: 1 } }] },
      warnings: [`db_query_failed: ${err instanceof Error ? err.message : String(err)}`],
      reasonIfZero: 'db_query_failed',
    };
  }
}

// ─── Budget resolver ────────────────────────────────────────────────────

export async function resolveBudgetStructured(opts?: { maxPicks?: number }): Promise<ResolverOutput<BudgetCandidate>> {
  const key = `picks=${opts?.maxPicks ?? 'default'}`;
  return budgetCache.get(key, () => doResolveBudget(opts));
}

async function doResolveBudget(opts?: { maxPicks?: number }): Promise<ResolverOutput<BudgetCandidate>> {
  const maxPicks = opts?.maxPicks ?? 2;
  const minContext = Number(process.env.EXPERIMENT_BUDGET_MIN_CONTEXT ?? 8192);
  const minCost = Number(process.env.EXPERIMENT_BUDGET_MIN_COST_PER_1K ?? 0.00001); // 1e-5 USD/1k tokens
  const blocked: BlockedCandidate[] = [];
  const warnings: string[] = [];
  const reasonCounts: Record<string, number> = {};

  let rows: Array<{
    id: string;
    displayName: string | null;
    contextWindow: number | null;
    inputCostPer1k: { toNumber(): number } | number | null;
    outputCostPer1k: { toNumber(): number } | number | null;
    capabilities: unknown;
    provider: { name: string };
  }> = [];
  try {
    rows = await prisma.model.findMany({
      where: {
        status: 'active',
        contextWindow: { gte: minContext },
        capabilities: { array_contains: ['chat'] },
        inputCostPer1k: { gte: minCost },
      },
      orderBy: [
        { inputCostPer1k: 'asc' },
        { contextWindow: 'desc' },
      ],
      include: { provider: true },
      take: 500,
    });
  } catch (err) {
    return {
      candidates: [],
      blocked: [],
      funnel: { stages: [{ name: 'db_query', input: 0, output: 0, removed: 0, mainRemovalReasons: { db_error: 1 } }] },
      warnings: [`db_query_failed: ${err instanceof Error ? err.message : String(err)}`],
      reasonIfZero: 'db_query_failed',
    };
  }

  const rawCount = rows.length;
  let afterAlias = 0;
  let afterOwner = 0;
  const seenProviders = new Set<string>();
  const candidates: BudgetCandidate[] = [];

  // 2026-05-11: Hub-aware skip (mirrors the top-tier resolver). Without
  // this the budget resolver would re-pin chutes / openrouter that
  // we already know are quota-exhausted via runtime feedback.
  const unhealthyProviders = new Set<string>();
  try {
    const mod = await import('@/core/provider-operability-hub');
    const summary = mod.getProviderOperabilityHub().getSummary() as Record<string, string[]>;
    for (const p of [...(summary.auth_failed ?? []), ...(summary.no_credits ?? []), ...(summary.temporarily_unavailable ?? [])]) {
      const baseId = p.includes(':') ? p.split(':')[0]! : p;
      unhealthyProviders.add(baseId.toLowerCase());
    }
  } catch { /* hub unavailable — fall through optimistically */ }
  const blocklist = (process.env.EXPERIMENT_BLOCKED_PROVIDERS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const id of blocklist) unhealthyProviders.add(id);

  // 2026-05-12 (ramp-final): model-level blocklist — see top-tier resolver
  // for rationale. Same parsing rules: `provider:modelId` tuples,
  // case-insensitive on provider, exact on modelId.
  const blockedModels = new Set<string>(
    (process.env.EXPERIMENT_BLOCKED_MODELS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((tuple) => {
        const idx = tuple.indexOf(':');
        if (idx < 0) return tuple.toLowerCase();
        return `${tuple.slice(0, idx).toLowerCase()}:${tuple.slice(idx + 1)}`;
      }),
  );

  for (const row of rows) {
    if (candidates.length >= maxPicks) break;

    // Stage 0: hub/blocklist
    if (unhealthyProviders.has(row.provider.name.toLowerCase())) {
      blocked.push({ providerId: row.provider.name, modelId: row.id, role: 'budget', blockedReason: 'hub_unhealthy_or_blocklisted', stage: 'hub_filter' });
      reasonCounts['hub_unhealthy'] = (reasonCounts['hub_unhealthy'] ?? 0) + 1;
      continue;
    }

    // Stage 0.5: model-level blocklist
    if (blockedModels.has(`${row.provider.name.toLowerCase()}:${row.id}`)) {
      blocked.push({ providerId: row.provider.name, modelId: row.id, role: 'budget', blockedReason: 'model_blocklisted', stage: 'model_blocklist' });
      reasonCounts['model_blocklisted'] = (reasonCounts['model_blocklisted'] ?? 0) + 1;
      continue;
    }

    // Stage A: reject routing aliases by name
    const lastSegment = row.id.includes('/') ? row.id.split('/').slice(-1)[0] : row.id;
    if (ROUTING_ALIAS_NAMES.has(lastSegment.toLowerCase())) {
      blocked.push({ providerId: row.provider.name, modelId: row.id, role: 'budget', blockedReason: 'routing_alias_not_concrete_model', stage: 'alias_filter' });
      reasonCounts['routing_alias'] = (reasonCounts['routing_alias'] ?? 0) + 1;
      continue;
    }
    afterAlias++;

    // Stage B: canonical owner allowlist (anti user-namespaced experimental forks).
    //
    // Rule (strict to keep budget pool clean of community-namespaced forks):
    //   - `org/model` ids → require `org` in CANONICAL_MODEL_OWNERS, OR
    //                       `org` == provider name (provider hosts under
    //                       its own namespace, e.g. `openai/gpt-4o-mini`)
    //   - unprefixed ids   → require providerTier == 'local' OR provider name
    //                        in CANONICAL_MODEL_OWNERS (e.g. plain `gpt-4o-mini`
    //                        on native openai). For unknown providers we
    //                        cannot tell what the unprefixed id represents,
    //                        so we reject conservatively.
    //
    // The end goal: budget pins should be names a human auditor would
    // recognise. `rednote-hilab/dots.ocr` on a serverless host fails the
    // first rule; `huggingface/...` aggregator pins fail it too. Native
    // openai/anthropic/google etc. pass.
    const owner = extractModelOwner(row.id, row.provider.name);
    const providerTier = classifyProviderTier(row.provider.name);
    const providerName = row.provider.name.toLowerCase();
    const slashedId = row.id.includes('/');

    const isCanonical = slashedId
      ? (CANONICAL_MODEL_OWNERS.has(owner) || owner === providerName)
      : (providerTier === 'local' || CANONICAL_MODEL_OWNERS.has(providerName));

    if (!isCanonical) {
      blocked.push({ providerId: row.provider.name, modelId: row.id, role: 'budget', blockedReason: `non_canonical_owner:${owner}`, stage: 'owner_allowlist' });
      reasonCounts['non_canonical_owner'] = (reasonCounts['non_canonical_owner'] ?? 0) + 1;
      continue;
    }
    afterOwner++;

    // Stage C: one pick per provider
    if (seenProviders.has(row.provider.name)) {
      blocked.push({ providerId: row.provider.name, modelId: row.id, role: 'budget', blockedReason: 'provider_already_picked', stage: 'provider_dedup' });
      continue;
    }
    seenProviders.add(row.provider.name);

    const inCost = typeof row.inputCostPer1k === 'object' && row.inputCostPer1k !== null
      ? row.inputCostPer1k.toNumber()
      : (row.inputCostPer1k as number | null) ?? undefined;
    const outCost = typeof row.outputCostPer1k === 'object' && row.outputCostPer1k !== null
      ? row.outputCostPer1k.toNumber()
      : (row.outputCostPer1k as number | null) ?? undefined;

    candidates.push({
      providerId: row.provider.name,
      modelId: row.id,
      modelFamily: owner,
      providerTier,
      contextWindow: row.contextWindow ?? undefined,
      inputCostPer1k: inCost,
      outputCostPer1k: outCost,
      reason: `cheapest_canonical_pick_${candidates.length + 1}`,
    });
  }

  if (candidates.length === 0) warnings.push('budget_pins_unavailable_after_filters');

  log.info({ kept: candidates.length, blocked: blocked.length, rawCount }, 'Budget resolver: complete');

  return {
    candidates,
    blocked,
    funnel: {
      stages: [
        { name: 'db_query (active + ctx>=min + chat + cost>=min)', input: -1, output: rawCount, removed: 0, mainRemovalReasons: {} },
        { name: 'alias_filter', input: rawCount, output: afterAlias, removed: reasonCounts['routing_alias'] ?? 0, mainRemovalReasons: reasonCounts['routing_alias'] ? { routing_alias: reasonCounts['routing_alias'] } : {} },
        { name: 'owner_allowlist', input: afterAlias, output: afterOwner, removed: reasonCounts['non_canonical_owner'] ?? 0, mainRemovalReasons: reasonCounts['non_canonical_owner'] ? { non_canonical_owner: reasonCounts['non_canonical_owner'] } : {} },
        { name: 'final_pins (per-provider dedup)', input: afterOwner, output: candidates.length, removed: 0, mainRemovalReasons: {} },
      ],
    },
    warnings,
    reasonIfZero: candidates.length === 0 ? 'no_canonical_chat_model_at_budget_tier' : undefined,
  };
}

// ─── Legacy shape (backwards-compatible) ────────────────────────────────
// Wrappers that return the same {id, displayName, provider} tuple shape
// used by the existing config builders. The builders can keep working
// unchanged while the structured output is captured by the audit endpoint.

export async function resolveTopTierLegacy(): Promise<Array<{ id: string; displayName: string; provider: string }>> {
  const out = await resolveTopTierStructured();
  return out.candidates.map((c) => ({ id: c.modelId, displayName: c.modelId, provider: c.providerId }));
}

export async function resolveOwnLegacy(): Promise<Array<{ id: string; displayName: string }>> {
  const out = await resolveOwnStructured();
  return out.candidates.map((c) => ({ id: c.modelId, displayName: c.modelId }));
}

export async function resolveBudgetLegacy(): Promise<Array<{ id: string; displayName: string }>> {
  const out = await resolveBudgetStructured();
  return out.candidates.map((c) => ({ id: c.modelId, displayName: c.modelId }));
}
