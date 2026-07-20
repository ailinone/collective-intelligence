// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RegistryBuilder — pure function that derives the three layers
 * (CanonicalModel, ModelProviderOffering, ProviderModelRoute) from
 * a sequence of `LegacyModelSnapshot` rows.
 *
 * MVP 2 invariants:
 *   - Pure function. No I/O. No DB. No Redis. No TEI. No providers.
 *   - No global singleton, no module-level state.
 *   - No mutation of input.
 *   - Output is deterministic given the same input.
 *   - Legacy snapshots are preserved verbatim in the resulting registry
 *     (`getModelSnapshots()` returns them unchanged) — the registry_cache
 *     equivalence invariant.
 *
 * Derivation rules (MVP 2 — conservative; later MVPs will refine):
 *   - 1 LegacyModelSnapshot = 1 ModelProviderOffering
 *   - 1 Offering = 1 ProviderModelRoute (sub-Offering routes deferred)
 *   - canonicalModelId = `${providerId}:${id}` (no heuristic merging yet)
 *
 * Skipped rows: a snapshot missing `id` OR `providerId` is dropped and
 * counted in `diagnostics.skippedReasons`. Everything else is preserved
 * — registry_cache does not filter by status, lifecycle, capability,
 * etc. That responsibility stays in the legacy `PoolBuilder`.
 */

import type {
  CanonicalLifecycle,
  CreditStatus,
  Currency,
  MinimalChatStatus,
  OfferingLifecycle,
  OperabilityState,
  RouteKind,
} from './types';
import type { CanonicalModel } from './canonical-model';
import type { ModelProviderOffering } from './model-offering';
import type { ProviderModelRoute } from './model-route';
import { buildRouteId } from './model-route';
import type { LegacyModelSnapshot } from './legacy-model-snapshot';
import { RuntimeModelRegistry } from './runtime-model-registry';
import type {
  RegistryBuildDiagnostics,
  RegistryBuildInput,
  RegistryBuildResult,
} from './registry-snapshot';

// ─── Defaults (route-level runtime state when no signal available) ──────

const DEFAULT_HEALTH_STATE: OperabilityState = 'unknown';
const DEFAULT_CREDIT_STATUS: CreditStatus = 'unknown';
const DEFAULT_MINIMAL_CHAT_STATUS: MinimalChatStatus = 'untested';
const DEFAULT_CURRENCY: Currency = 'USD';

// ─── Helpers (pure, no I/O) ─────────────────────────────────────────────

/**
 * Normalises the legacy `capabilities` JSON column to a string[]. The
 * column historically carried either `string[]`, a record, or null.
 * Returns an empty array on any unrecognised shape — no exceptions.
 */
function normaliseCapabilities(raw: unknown): readonly string[] {
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item === 'string') out.push(item);
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    const out: string[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === true) out.push(key);
    }
    return out;
  }
  return [];
}

/**
 * Returns the canonical capability list for an offering — preferring
 * the URI column, falling back to the legacy JSON column.
 */
function resolveCapabilities(snapshot: LegacyModelSnapshot): readonly string[] {
  if (snapshot.capabilityUris && snapshot.capabilityUris.length > 0) {
    return snapshot.capabilityUris;
  }
  return normaliseCapabilities(snapshot.capabilities);
}

function hasCapability(caps: readonly string[], ...needles: readonly string[]): boolean {
  for (const c of caps) {
    const lc = c.toLowerCase();
    for (const n of needles) {
      if (lc.includes(n)) return true;
    }
  }
  return false;
}

/**
 * Maps the legacy `lifecycleStatus` or `status` field onto the
 * CanonicalLifecycle union. Unknown strings default to `'current'` so
 * the registry doesn't drop rows whose legacy status is a value we
 * haven't catalogued — drift-safe by design.
 */
function mapCanonicalLifecycle(snapshot: LegacyModelSnapshot): CanonicalLifecycle {
  const lc = snapshot.lifecycleStatus?.toLowerCase() ?? '';
  if (lc === 'preview' || lc === 'beta' || lc === 'experimental') return 'preview';
  if (lc === 'deprecated' || snapshot.status === 'deprecated') return 'deprecated';
  if (lc === 'retired' || lc === 'sunset') return 'retired';
  // legacy `status` mapping
  if (snapshot.status === 'inactive' || snapshot.status === 'disabled') {
    // inactive ≠ deprecated semantically; default to 'current' so
    // registry_cache does not silently relabel.
    return 'current';
  }
  return 'current';
}

function mapOfferingLifecycle(snapshot: LegacyModelSnapshot): OfferingLifecycle {
  const status = snapshot.status?.toLowerCase() ?? '';
  if (status === 'deprecated' || status === 'sunset') return 'sunset';
  if (status === 'inactive' || status === 'disabled') return 'retired';
  return 'active';
}

/**
 * Builds the deterministic embedding-document text fed to the embedder
 * in later MVPs. Stable across re-builds when input is stable.
 */
function buildSemanticDocument(input: {
  canonicalModelId: string;
  providerId: string;
  modelId: string;
  capabilities: readonly string[];
  contextWindow: number;
}): string {
  const sortedCaps = [...input.capabilities].sort().join(',');
  return [
    `canonical:${input.canonicalModelId}`,
    `provider:${input.providerId}`,
    `model:${input.modelId}`,
    `capabilities:${sortedCaps}`,
    `context:${input.contextWindow}`,
  ].join(' ');
}

/**
 * Pure helper that derives `canonicalModelId`. MVP 2 keeps it strictly
 * structural — `${providerId}:${id}`. A heuristic resolver with
 * confidence + alias table lands in a later MVP.
 */
function deriveCanonicalModelId(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function deriveOfferingId(snapshot: LegacyModelSnapshot): string {
  if (snapshot.uid && snapshot.uid.length > 0) return snapshot.uid;
  return `${snapshot.providerId}:${snapshot.id}`;
}

// ─── Builder ────────────────────────────────────────────────────────────

/**
 * Constructs a `RuntimeModelRegistry` from legacy snapshots. Pure.
 */
export function buildRuntimeModelRegistry(
  input: RegistryBuildInput,
): RegistryBuildResult {
  const now = input.now ?? new Date(0).toISOString();
  // `now` defaults to epoch when not provided — keeps the function
  // deterministic for tests. Callers in production pass `new Date().toISOString()`.

  const routeKindByProvider = input.routeKindByProvider ?? {};
  const source = input.source ?? 'unknown';

  const canonicalAccum = new Map<string, CanonicalModel>();
  const offerings: ModelProviderOffering[] = [];
  const routes: ProviderModelRoute[] = [];
  const skippedReasons: Record<string, number> = {};
  let skippedCount = 0;

  // Track which capabilities have been observed per canonical model so
  // we can build a union later.
  const canonicalCapabilities = new Map<string, Set<string>>();

  for (const snapshot of input.models) {
    // ─── Validation: drop rows missing the unique key ────────────────
    if (!snapshot.id || snapshot.id.length === 0) {
      skippedReasons['missing_id'] = (skippedReasons['missing_id'] ?? 0) + 1;
      skippedCount += 1;
      continue;
    }
    if (!snapshot.providerId || snapshot.providerId.length === 0) {
      skippedReasons['missing_provider_id'] =
        (skippedReasons['missing_provider_id'] ?? 0) + 1;
      skippedCount += 1;
      continue;
    }

    const canonicalModelId = deriveCanonicalModelId(
      snapshot.providerId,
      snapshot.id,
    );
    const offeringId = deriveOfferingId(snapshot);
    const capabilities = resolveCapabilities(snapshot);
    const routeKind: RouteKind =
      routeKindByProvider[snapshot.providerId] ?? 'native';
    const contextWindow = snapshot.contextWindow ?? 0;
    const maxOutputTokens = snapshot.maxOutputTokens ?? 0;

    // ─── Offering (1:1 with snapshot) ────────────────────────────────
    const aliases: string[] = [snapshot.id];
    if (snapshot.name && snapshot.name !== snapshot.id) aliases.push(snapshot.name);
    if (snapshot.displayName && snapshot.displayName !== snapshot.id) {
      aliases.push(snapshot.displayName);
    }

    const offering: ModelProviderOffering = {
      offeringId,
      canonicalModelId,
      modelOwner: snapshot.providerId, // refined by later resolver MVPs
      servingProviderId: snapshot.providerId,
      providerModelId: snapshot.id,
      aliases: Object.freeze(aliases),
      providerReportedCapabilities: capabilities,
      providerReportedContextWindow: contextWindow,
      providerReportedMaxOutputTokens: maxOutputTokens,
      lifecycle: mapOfferingLifecycle(snapshot),
      firstSeenAt: snapshot.createdAt ?? now,
      lastSeenAt: snapshot.lastSyncedAt ?? snapshot.updatedAt ?? now,
      lastNormalizedAt: snapshot.capabilityUpdatedAt ?? snapshot.updatedAt ?? now,
    };
    offerings.push(offering);

    // ─── Route (1:1 with offering in MVP 2) ──────────────────────────
    const inputCostPer1k = snapshot.inputCostPer1k ?? 0;
    const outputCostPer1k = snapshot.outputCostPer1k ?? 0;

    const route: ProviderModelRoute = {
      routeId: buildRouteId({
        offeringId,
        accessProviderId: snapshot.providerId,
      }),
      canonicalModelId,
      offeringId,
      accessProviderId: snapshot.providerId,
      servingProviderId: snapshot.providerId,
      routeKind,
      endpointBaseUrl: '', // populated by later MVP from catalog
      endpointPath: '',
      providerModelId: snapshot.id,
      requestModelId: snapshot.id,

      inputCostPer1M: inputCostPer1k * 1000,
      outputCostPer1M: outputCostPer1k * 1000,
      cachedInputCostPer1M: null,
      currency: DEFAULT_CURRENCY,
      pricingSource: 'inferred',
      lastPricingUpdateAt: snapshot.updatedAt ?? now,

      contextWindow,
      maxOutputTokens,
      supportsStreaming: hasCapability(capabilities, 'streaming'),
      supportsJson: hasCapability(capabilities, 'json_mode', 'json'),
      supportsTools: hasCapability(capabilities, 'tools', 'function_calling'),
      supportsVision: hasCapability(capabilities, 'vision', 'image_understanding'),
      supportsImages: hasCapability(capabilities, 'image_generation', 'image_edit'),
      supportsAudio: hasCapability(
        capabilities,
        'audio_generation',
        'text_to_speech',
        'speech_to_text',
      ),

      healthState: DEFAULT_HEALTH_STATE,
      creditStatus: DEFAULT_CREDIT_STATUS,
      minimalChatStatus: DEFAULT_MINIMAL_CHAT_STATUS,
      latencyP50Ms: null,
      latencyP95Ms: null,
      ttftP50Ms: null,
      ttftP95Ms: null,
      successRateWindow: 0,
      errorRateWindow: 0,
      lastProbeAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      failureCooldownUntil: null,
      blockedReason: null,
    };
    routes.push(route);

    // ─── Canonical (accumulated union per id) ────────────────────────
    const accCaps = canonicalCapabilities.get(canonicalModelId) ?? new Set<string>();
    for (const c of capabilities) accCaps.add(c);
    canonicalCapabilities.set(canonicalModelId, accCaps);

    if (!canonicalAccum.has(canonicalModelId)) {
      const canonical: CanonicalModel = {
        canonicalModelId,
        family: 'unknown', // refined by heuristic resolver in later MVP
        version: 'unknown',
        generationRank: 0,
        owner: snapshot.providerId,
        lifecycle: mapCanonicalLifecycle(snapshot),
        normalizedCapabilities: accCaps,
        semanticDocument: '', // built below once accCaps is final
        freshnessScore: 0.5,
        qualityPriorByTaskClass: {},
        typicalStrengths: Object.freeze([]),
        knownWeaknesses: Object.freeze([]),
      };
      canonicalAccum.set(canonicalModelId, canonical);
    }
  }

  // Second pass: finalise the canonical semanticDocument with the
  // accumulated capabilities union (now stable).
  const canonicalModels: CanonicalModel[] = [];
  for (const [canonicalModelId, canonical] of canonicalAccum) {
    const caps = canonicalCapabilities.get(canonicalModelId) ?? new Set<string>();
    const sampleRoute = routes.find((r) => r.canonicalModelId === canonicalModelId);
    canonicalModels.push({
      ...canonical,
      normalizedCapabilities: caps,
      semanticDocument: buildSemanticDocument({
        canonicalModelId,
        providerId: canonical.owner,
        modelId: canonicalModelId.split(':').slice(1).join(':') || canonicalModelId,
        capabilities: [...caps],
        contextWindow: sampleRoute?.contextWindow ?? 0,
      }),
    });
  }

  const registry = new RuntimeModelRegistry({
    canonicalModels,
    offerings,
    routes,
    legacyModels: input.models, // verbatim — registry_cache invariant
    builtAt: Date.parse(now) || 0,
    version: 1,
  });

  const diagnostics: RegistryBuildDiagnostics = {
    inputModelCount: input.models.length,
    canonicalModelCount: canonicalModels.length,
    offeringCount: offerings.length,
    routeCount: routes.length,
    skippedCount,
    skippedReasons: Object.freeze({ ...skippedReasons }),
    source,
    builtAtIso: now,
  };

  return { registry, diagnostics };
}
