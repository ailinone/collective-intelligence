// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Catalog-backed resolvers for the DiscoveryScheduler.
 *
 * Reads the static `PROVIDER_CATALOG` (one source of truth for provider
 * metadata: `providerId`, `integrationClass`, `baseUrl`, `apiKeyEnvVar`)
 * and produces the inputs the scheduler needs:
 *   - ConfiguredProvider[] — what to probe
 *   - BuildProbeCallbacksInput[] — how to probe each
 *   - integrationClassByProvider — for tier classification
 *   - fallbackModelsByProvider — for providers that don't enumerate
 *
 * Filtering rules (Phase 1.5 deployment):
 *   - SKIP entries with `enabledByDefault: false` AND no env var set
 *     (catalog-loader has the same logic; we mirror it so the scheduler
 *     doesn't probe disabled providers)
 *   - SKIP entries whose integrationClass is non-chat (embeddings-only,
 *     rerank-only, image-only, etc.) — those have their own discovery
 *     pipelines
 *   - SKIP self-hosted entries unless explicitly opted-in via env
 *
 * The fallback models for native-anthropic / native-openai etc. come
 * from the `getModelsByProvider` query — gives a starting list of
 * known-good models the orchestrator can attempt even when the
 * provider doesn't expose `/v1/models`.
 */

import { logger } from '@/utils/logger';
import { PROVIDER_CATALOG } from '@/providers/catalog/providers.catalog';
import type { ProviderCatalogEntry } from '@/providers/catalog/provider-catalog.types';
import type { ConfiguredProvider } from './discovery-service';
import type { BuildProbeCallbacksInput } from './adapter-probe-callbacks';
import type { DiscoveredModel } from './types';

const log = logger.child({ component: 'catalog-resolver' });

// ─── Filter logic ─────────────────────────────────────────────────────────

/**
 * Integration classes that should participate in chat-completion routing.
 * Other classes (embeddings-only, image-only, etc.) have their own
 * discovery pipelines and are excluded here.
 *
 * Maps to actual ProviderIntegrationClass values from the catalog schema.
 */
const CHAT_ELIGIBLE_INTEGRATION_CLASSES = new Set([
  'oai-compat-pure',
  'oai-compat-quirks',
  'first-party-native',
  'gateway',
  'self-hosted-oai-compat',
  'self-hosted-native',
]);

/** Classes that expose /v1/models — listModels probe is supported. */
const ENUMERABLE_INTEGRATION_CLASSES = new Set([
  'oai-compat-pure',
  'gateway',
  'self-hosted-oai-compat',
]);

/**
 * Returns true if the catalog entry is eligible for the chat-completion
 * operability pipeline (i.e., should be probed by the discovery scheduler).
 */
function isEligibleForChatDiscovery(entry: ProviderCatalogEntry): boolean {
  if (!CHAT_ELIGIBLE_INTEGRATION_CLASSES.has(entry.integrationClass)) {
    return false;
  }

  // Respect catalog-loader's enabledByDefault logic: when false AND env
  // is not set, the entry is skipped.
  const envSet = !!process.env[entry.apiKeyEnvVar];
  const enabledByDefault =
    'enabledByDefault' in entry && typeof entry.enabledByDefault === 'boolean'
      ? entry.enabledByDefault
      : true;
  if (!enabledByDefault && !envSet) return false;

  // Self-hosted entries: opt-in via env (we don't probe Ollama unless the
  // operator sets the host explicitly — empty default would mean every
  // dev machine probes localhost, which is noisy).
  if (entry.integrationClass === 'self-hosted-oai-compat' && !envSet) {
    return false;
  }

  return true;
}

// ─── Resolvers ────────────────────────────────────────────────────────────

/**
 * Returns the `ConfiguredProvider[]` for the discovery scheduler.
 */
export function resolveConfiguredProviders(): ConfiguredProvider[] {
  const out: ConfiguredProvider[] = [];
  for (const entry of PROVIDER_CATALOG) {
    if (!isEligibleForChatDiscovery(entry)) continue;
    out.push({
      providerId: entry.providerId,
      integrationClass: entry.integrationClass,
      apiKeyEnvVar: entry.apiKeyEnvVar,
    });
  }
  log.debug({ count: out.length }, 'Resolved configured providers from catalog');
  return out;
}

/**
 * Returns the inputs to `buildProbeCallbacksMap` — pulls baseUrl from
 * the catalog so each provider's probes hit the right endpoint.
 */
export function resolveProbeCallbackInputs(): BuildProbeCallbacksInput[] {
  const out: BuildProbeCallbacksInput[] = [];
  for (const entry of PROVIDER_CATALOG) {
    if (!isEligibleForChatDiscovery(entry)) continue;
    // The catalog allows multiple model-list paths (some providers expose
    // /models AND /v1/models). We pick the first one declared; the probe
    // adapter falls back to /v1/models if absent.
    const modelListPath = entry.paths?.modelList?.[0];
    out.push({
      providerId: entry.providerId,
      integrationClass: entry.integrationClass,
      baseUrl: entry.baseUrl,
      modelListPath,
    });
  }
  return out;
}

/**
 * Returns `integrationClassByProvider` — used by the OperationalCandidatePool
 * for ProviderTier classification.
 */
export function resolveIntegrationClasses(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of PROVIDER_CATALOG) {
    if (!isEligibleForChatDiscovery(entry)) continue;
    out[entry.providerId] = entry.integrationClass;
  }
  return out;
}

/**
 * Returns `fallbackModelsByProvider` — pulls models from the database
 * for providers that don't enumerate via `/v1/models` (native-anthropic,
 * native-aws-bedrock, first-party-native, etc.).
 *
 * Phase R3 batched implementation (2026-05-09):
 *   The previous version called `getModelsByProvider(id)` once per
 *   provider in a serial loop — N round-trips. Under Prisma pool=5
 *   starvation (dev default), all queries timed out and the pool
 *   ended up empty for native providers. We saw this live: 44 of 57
 *   "available" providers ended up with `probe_error AbortError` in
 *   the live validation report.
 *
 *   Strategy: single `findMany({ where: { providerId: { in: [...] }}})`.
 *   One round-trip, one pool slot, one transaction. Trade-off:
 *   if the SQL fails, we lose all fallbacks (no per-provider isolation).
 *   Mitigation: caller (DiscoveryScheduler) tolerates empty result —
 *   the pool will reflect only enumerable providers + whatever loaded
 *   successfully on prior runs.
 */
export async function resolveFallbackModels(): Promise<Record<string, readonly DiscoveredModel[]>> {
  const result: Record<string, readonly DiscoveredModel[]> = {};

  // Step 1: collect all providerIds that need a fallback (non-enumerable
  // integration classes only — providers that DO list via /v1/models
  // don't need fallback because discovery already enumerates).
  const providerIds = PROVIDER_CATALOG
    .filter(
      (entry) =>
        isEligibleForChatDiscovery(entry)
        && !ENUMERABLE_INTEGRATION_CLASSES.has(entry.integrationClass),
    )
    .map((entry) => entry.providerId);

  if (providerIds.length === 0) return result;

  try {
    // One DB hit instead of N. Pulls only the columns we use to map into
    // DiscoveredModel — avoids deserializing per-row Prisma fields we
    // don't need (each Model row has ~30 columns; cherry-pick reduces
    // serialization cost dramatically).
    const { prisma } = await import('@/database/client');
    const rows = await prisma.model.findMany({
      where: {
        providerId: { in: providerIds },
        status: 'active',
      },
      select: {
        id: true,
        providerId: true,
        contextWindow: true,
        capabilityUris: true,
      },
    });

    // Step 2: group by providerId and shape into DiscoveredModel[].
    // We use an intermediate Map<string, DiscoveredModel[]> so the
    // grouping is O(N) over rows instead of O(N × P).
    const grouped = new Map<string, DiscoveredModel[]>();
    for (const row of rows) {
      const arr = grouped.get(row.providerId) ?? [];
      arr.push({
        modelId: row.id,
        family: row.providerId,
        contextWindow: row.contextWindow ?? undefined,
        capabilities: row.capabilityUris.length > 0 ? row.capabilityUris : undefined,
      });
      grouped.set(row.providerId, arr);
    }
    for (const [providerId, models] of grouped) {
      result[providerId] = models;
    }

    log.debug(
      {
        providerIdsRequested: providerIds.length,
        providersFound: grouped.size,
        rowsTotal: rows.length,
      },
      'Fallback models resolved (batched)',
    );
  } catch (err) {
    // If the batched query fails, we log but DO NOT fall back to per-
    // provider serial queries — that's exactly the behavior we replaced.
    // The pool will reflect only enumerable providers this tick; next
    // tick (5min later) gets another chance.
    log.warn(
      { err: String(err), providerCount: providerIds.length },
      'Batched fallback model resolution failed — pool will lack non-enumerable providers this tick',
    );
  }

  return result;
}

/**
 * Bundle helper that returns all four resolvers in one call.
 * Use directly when wiring the scheduler at bootstrap.
 */
export function buildCatalogResolvers(): {
  resolveProviders: () => ConfiguredProvider[];
  resolveProbeInputs: () => BuildProbeCallbacksInput[];
  resolveIntegrationClasses: () => Record<string, string>;
  resolveFallbackModels: () => Promise<Record<string, readonly DiscoveredModel[]>>;
} {
  return {
    resolveProviders: resolveConfiguredProviders,
    resolveProbeInputs: resolveProbeCallbackInputs,
    resolveIntegrationClasses,
    resolveFallbackModels,
  };
}
