// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4B §8 — Inventory planner.
 *
 * Pure module. Given the catalog (subset of `Model[]`) + a set of
 * available provider secrets + the `PROVIDER_SPECS` registry, emits a
 * stratified probe plan that covers up to N top models per provider
 * across all providers with usable secrets/specs.
 *
 * Goals (per spec §3):
 *   - Per provider, pick up to 3 (default) or 5 (max) top models by
 *     a deterministic ranking: quality desc → context window desc → cost asc.
 *   - Skip providers without local secret OR without `PROVIDER_SPECS` entry.
 *   - Skip providers explicitly classified as specialized/non-chat
 *     (deepgram, cartesia, elevenlabs, voyage, embeddings-only, etc.).
 *   - Estimate worst-case cost; cap probe count at MAX_TOTAL_ENDPOINT_PROBES.
 *   - Compute canonical model identity for each candidate so downstream
 *     consensus diversity sees distinct models, not distinct endpoints.
 *
 * Output: `LiveChatInventoryPlan` consumed by the inventory runner.
 *
 * Pure: NO fs, NO env reads, NO fetch, NO DB. Inputs are explicit.
 */
import type { Model, ModelCapability } from '@/types';
import { deriveCanonicalModelIdentity } from '../orchestration/model-selection/canonical-model-identity';

// ─── Types ────────────────────────────────────────────────────────────────

export interface InventoryPlannerInput {
  /** Catalog rows. Caller supplies via repo.searchModels(). Should be
   *  the full active chat-capable catalog (no limit). */
  readonly catalog: readonly Model[];
  /** Set of providerId strings that have `PROVIDER_SPECS` entries in the
   *  audit script's registry. The planner uses this to decide
   *  `providerSpecAvailable` for each route. */
  readonly providersWithSpec: ReadonlySet<string>;
  /** Set of providerId strings that have an API key environment var set
   *  AND non-empty in the runtime environment. The planner uses this to
   *  decide `secretAvailable`. */
  readonly providersWithSecret: ReadonlySet<string>;
  /** Per-provider model count cap. Default 3. */
  readonly modelsPerProvider?: number;
  /** Per-provider model count maximum (when planner has budget headroom). Default 5. */
  readonly maxModelsPerProvider?: number;
  /** Hard total endpoint probe cap. Default 120. */
  readonly maxTotalEndpointProbes?: number;
  /** Per-probe worst-case cost estimate (USD). Default 1e-5 (= 10 tokens at
   *  ~$0.001 per 1k output). Used for budget capping. */
  readonly perProbeWorstCaseCostUsd?: number;
  /** Maximum total budget (USD). Default 0.012. */
  readonly maxTotalCostUsd?: number;
  /** Providers to explicitly exclude (non-chat/specialized). Default set
   *  matches spec §3 (deepgram/cartesia/elevenlabs/voyage/etc.). */
  readonly excludeSpecializedProviders?: ReadonlySet<string>;
}

export interface PlannedProbe {
  readonly providerId: string;
  readonly routeId: string;
  readonly apiModelId: string;
  readonly catalogModelId: string;
  readonly canonicalModelId: string;
  readonly family?: string;
  readonly vendor?: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly capabilities: readonly string[];
  readonly estimatedCostUsd: number;
  readonly secretAvailable: boolean;
  readonly providerSpecAvailable: boolean;
  readonly probeEligible: boolean;
  readonly selectionReason: 'top_quality' | 'largest_context' | 'lowest_cost' | 'json_capable' | 'family_diversity';
}

export interface SkippedProvider {
  readonly providerId: string;
  readonly reason:
    | 'missing_secret'
    | 'missing_provider_spec'
    | 'specialized_non_chat'
    | 'no_catalog_rows'
    | 'all_models_excluded';
  readonly catalogModelCount?: number;
}

export interface InventoryPlanSummary {
  readonly catalogTotalModels: number;
  readonly catalogDistinctModels: number;
  readonly catalogDistinctProviders: number;
  readonly providersWithLocalSecrets: number;
  readonly providersProbeEligible: number;
  readonly providersSkipped: number;
  readonly routesPlanned: number;
  readonly distinctCanonicalModelsPlanned: number;
  readonly estimatedWorstCaseCostUsd: number;
  readonly specializedProvidersExcluded: ReadonlyArray<string>;
  readonly providersMissingSpec: ReadonlyArray<string>;
  readonly providersMissingSecret: ReadonlyArray<string>;
}

export interface LiveChatInventoryPlan {
  readonly generatedAt: string;
  readonly stage: '01C.1B-J1D-R4B-INVENTORY';
  readonly plannedProbes: readonly PlannedProbe[];
  readonly skippedProviders: readonly SkippedProvider[];
  readonly summary: InventoryPlanSummary;
}

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_SPECIALIZED_PROVIDERS = new Set<string>([
  'deepgram',
  'cartesia',
  'elevenlabs',
  'voyage',
  'replicate-image',
  'pinecone',
  'weaviate',
  'qdrant',
  'jina', // embeddings-focused (some chat exists but tier is small)
  'cohere-embed',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────

function isChatCapable(m: Model): boolean {
  return Array.isArray(m.capabilities) && m.capabilities.includes('chat' as ModelCapability);
}

function modelRankingScore(m: Model): number {
  // Higher is better. Use three signals:
  //   quality   (0..1)                            weighted 1.0
  //   context   (normalized log10/6 — 1M ctx ≈ 1) weighted 0.4
  //   inverse cost (normalized to 1/(1+cost))     weighted 0.2
  const q = m.performance?.quality ?? 0.5;
  const ctx = Math.max(0, Math.log10(Math.max(m.contextWindow ?? 1, 1)) / 6);
  const cost = Math.min(0.5, Math.max(0, m.inputCostPer1k ?? 0));
  const invCost = 1 / (1 + cost * 10);
  return q * 1.0 + ctx * 0.4 + invCost * 0.2;
}

function pickTopForProvider(
  rows: readonly Model[],
  modelsPerProvider: number,
): readonly { model: Model; reason: PlannedProbe['selectionReason'] }[] {
  if (rows.length === 0) return [];
  // Rank for top_quality
  const ranked = [...rows].sort((a, b) => modelRankingScore(b) - modelRankingScore(a));
  const out: { model: Model; reason: PlannedProbe['selectionReason'] }[] = [];
  const seen = new Set<string>();

  if (ranked[0]) {
    out.push({ model: ranked[0], reason: 'top_quality' });
    seen.add(ranked[0].id);
  }

  // Largest context window — pick a different model when possible.
  const byCtx = [...rows].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
  for (const m of byCtx) {
    if (out.length >= modelsPerProvider) break;
    if (!seen.has(m.id)) {
      out.push({ model: m, reason: 'largest_context' });
      seen.add(m.id);
      break;
    }
  }

  // Lowest cost — pick a different model when possible.
  const byCost = [...rows].sort(
    (a, b) => (a.inputCostPer1k ?? Number.POSITIVE_INFINITY) - (b.inputCostPer1k ?? Number.POSITIVE_INFINITY),
  );
  for (const m of byCost) {
    if (out.length >= modelsPerProvider) break;
    if (!seen.has(m.id)) {
      out.push({ model: m, reason: 'lowest_cost' });
      seen.add(m.id);
      break;
    }
  }

  // Optional 4th: json_mode / structured_output capable, if present.
  if (out.length < modelsPerProvider) {
    for (const m of ranked) {
      const caps = (m.capabilities ?? []) as readonly string[];
      if (caps.includes('json_mode') || caps.includes('structured_output')) {
        if (!seen.has(m.id)) {
          out.push({ model: m, reason: 'json_capable' });
          seen.add(m.id);
          break;
        }
      }
    }
  }

  // Optional 5th: family diversity — different family from picks so far.
  if (out.length < modelsPerProvider) {
    const pickedFamilies = new Set(
      out.map((p) => deriveCanonicalModelIdentity({ apiModelId: p.model.id }).family).filter(Boolean) as string[],
    );
    for (const m of ranked) {
      if (out.length >= modelsPerProvider) break;
      if (seen.has(m.id)) continue;
      const fam = deriveCanonicalModelIdentity({ apiModelId: m.id }).family;
      if (fam && !pickedFamilies.has(fam)) {
        out.push({ model: m, reason: 'family_diversity' });
        seen.add(m.id);
        break;
      }
    }
  }

  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Build the inventory plan. Pure: identical inputs → identical output.
 */
export function buildInventoryPlan(input: InventoryPlannerInput): LiveChatInventoryPlan {
  const modelsPerProvider = input.modelsPerProvider ?? 3;
  const maxModelsPerProvider = input.maxModelsPerProvider ?? 5;
  const maxTotalEndpointProbes = input.maxTotalEndpointProbes ?? 120;
  const perProbeWorstCaseCostUsd = input.perProbeWorstCaseCostUsd ?? 0.00001;
  const maxTotalCostUsd = input.maxTotalCostUsd ?? 0.012;
  const specialized = input.excludeSpecializedProviders ?? DEFAULT_SPECIALIZED_PROVIDERS;

  // Group catalog by provider, keeping only chat-capable rows.
  const byProvider = new Map<string, Model[]>();
  for (const m of input.catalog) {
    if (!isChatCapable(m)) continue;
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }

  const plannedProbes: PlannedProbe[] = [];
  const skipped: SkippedProvider[] = [];

  // Compute the effective per-provider cap based on budget headroom.
  // First pass: try `modelsPerProvider` for every eligible provider; if
  // that exceeds caps, fall through. If within caps, bump some providers
  // to `maxModelsPerProvider` until we hit the cap.
  const eligibleProviders: string[] = [];
  for (const [providerId] of byProvider.entries()) {
    if (specialized.has(providerId)) {
      skipped.push({ providerId, reason: 'specialized_non_chat' });
      continue;
    }
    if (!input.providersWithSpec.has(providerId)) {
      skipped.push({
        providerId,
        reason: 'missing_provider_spec',
        catalogModelCount: byProvider.get(providerId)?.length ?? 0,
      });
      continue;
    }
    if (!input.providersWithSecret.has(providerId)) {
      skipped.push({
        providerId,
        reason: 'missing_secret',
        catalogModelCount: byProvider.get(providerId)?.length ?? 0,
      });
      continue;
    }
    eligibleProviders.push(providerId);
  }

  // Sort eligible providers deterministically for stable output.
  eligibleProviders.sort();

  for (const providerId of eligibleProviders) {
    const rows = byProvider.get(providerId) ?? [];
    const picks = pickTopForProvider(rows, modelsPerProvider);

    for (const { model, reason } of picks) {
      // Enforce per-route cap (worst-case projected)
      if (plannedProbes.length >= maxTotalEndpointProbes) break;
      const projectedCostUsd =
        (plannedProbes.length + 1) * perProbeWorstCaseCostUsd;
      if (projectedCostUsd > maxTotalCostUsd) break;
      const canonical = deriveCanonicalModelIdentity({
        apiModelId: model.id,
        providerId,
      });
      plannedProbes.push({
        providerId,
        routeId: providerId, // probe-time routeId — matches audit script's record() call
        apiModelId: model.id,
        catalogModelId: model.id,
        canonicalModelId: canonical.canonicalModelId,
        family: canonical.family,
        vendor: canonical.vendor,
        contextWindow: model.contextWindow ?? 0,
        maxOutputTokens: model.maxOutputTokens ?? 0,
        capabilities: (model.capabilities as readonly string[]) ?? [],
        estimatedCostUsd: perProbeWorstCaseCostUsd,
        secretAvailable: true,
        providerSpecAvailable: true,
        probeEligible: true,
        selectionReason: reason,
      });
    }
  }

  // Try to bump providers to maxModelsPerProvider if budget allows.
  if (modelsPerProvider < maxModelsPerProvider) {
    for (const providerId of eligibleProviders) {
      const rows = byProvider.get(providerId) ?? [];
      const existing = plannedProbes.filter((p) => p.providerId === providerId).length;
      if (existing >= maxModelsPerProvider) continue;
      const extraNeeded = maxModelsPerProvider - existing;
      const allPicks = pickTopForProvider(rows, maxModelsPerProvider);
      for (const { model, reason } of allPicks.slice(existing)) {
        if (plannedProbes.length >= maxTotalEndpointProbes) break;
        const projectedCostUsd = (plannedProbes.length + 1) * perProbeWorstCaseCostUsd;
        if (projectedCostUsd > maxTotalCostUsd) break;
        if (extraNeeded <= 0) break;
        // Dedup against existing entries for this provider+model
        if (plannedProbes.some((p) => p.providerId === providerId && p.apiModelId === model.id)) {
          continue;
        }
        const canonical = deriveCanonicalModelIdentity({ apiModelId: model.id, providerId });
        plannedProbes.push({
          providerId,
          routeId: providerId,
          apiModelId: model.id,
          catalogModelId: model.id,
          canonicalModelId: canonical.canonicalModelId,
          family: canonical.family,
          vendor: canonical.vendor,
          contextWindow: model.contextWindow ?? 0,
          maxOutputTokens: model.maxOutputTokens ?? 0,
          capabilities: (model.capabilities as readonly string[]) ?? [],
          estimatedCostUsd: perProbeWorstCaseCostUsd,
          secretAvailable: true,
          providerSpecAvailable: true,
          probeEligible: true,
          selectionReason: reason,
        });
      }
    }
  }

  const distinctCanonical = new Set(plannedProbes.map((p) => p.canonicalModelId));
  const catalogDistinctProviders = byProvider.size;
  const catalogDistinctModels = new Set(input.catalog.map((m) => m.id)).size;

  return {
    generatedAt: new Date().toISOString(),
    stage: '01C.1B-J1D-R4B-INVENTORY',
    plannedProbes,
    skippedProviders: skipped,
    summary: {
      catalogTotalModels: input.catalog.length,
      catalogDistinctModels,
      catalogDistinctProviders,
      providersWithLocalSecrets: input.providersWithSecret.size,
      providersProbeEligible: eligibleProviders.length,
      providersSkipped: skipped.length,
      routesPlanned: plannedProbes.length,
      distinctCanonicalModelsPlanned: distinctCanonical.size,
      estimatedWorstCaseCostUsd: plannedProbes.length * perProbeWorstCaseCostUsd,
      specializedProvidersExcluded: skipped
        .filter((s) => s.reason === 'specialized_non_chat')
        .map((s) => s.providerId)
        .sort(),
      providersMissingSpec: skipped
        .filter((s) => s.reason === 'missing_provider_spec')
        .map((s) => s.providerId)
        .sort(),
      providersMissingSecret: skipped
        .filter((s) => s.reason === 'missing_secret')
        .map((s) => s.providerId)
        .sort(),
    },
  };
}
