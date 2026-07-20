// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G2 — Provider Canonical Model Resolver.
 *
 * Given a `providerId` and a set of available models (from catalog,
 * discovery, last-successful), returns the BEST canonical model id to
 * use for a chat probe — applying provider-specific alias rewrites and
 * confidence scoring.
 *
 * Priority order (highest authority first):
 *   1. `last_success` — model that recently chat-succeeded on this
 *      provider (highest signal)
 *   2. `provider_discovery` — model listed by the provider's /models
 *      endpoint (provider is the source of truth for what works)
 *   3. `catalog_alias` — catalog model with provider-alias rewrite
 *      applied
 *   4. `known_provider_default` — operator-curated default
 *   5. `manual_probe_spec` — explicit caller-provided model
 *   6. `none` — no candidate found
 */
import { resolveProviderApiModelId } from './provider-model-aliases';

export type CanonicalProbeModelSource =
  | 'provider_discovery'
  | 'catalog_alias'
  | 'catalog_direct'
  | 'known_provider_default'
  | 'last_success'
  | 'manual_probe_spec'
  | 'none';

export type CanonicalProbeConfidence = 'high' | 'medium' | 'low';

export interface CanonicalProbeModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly apiModelId: string;
  readonly canonicalModelId?: string;
  readonly source: CanonicalProbeModelSource;
  readonly confidence: CanonicalProbeConfidence;
  readonly reason: string;
}

export interface CatalogCandidate {
  readonly id: string;
  readonly modelId?: string;
  readonly canonicalModelId?: string;
  readonly capabilities?: readonly string[];
}

export interface DiscoveredModel {
  readonly id: string;
  readonly modelId?: string;
}

export interface ResolveCanonicalProbeModelInput {
  readonly providerId: string;
  readonly providerKind?: string;
  readonly catalogModels: readonly CatalogCandidate[];
  readonly discoveredModels?: readonly DiscoveredModel[];
  readonly lastSuccessfulModels?: readonly string[];
  readonly manualOverride?: string;
}

/**
 * Resolve the canonical probe model.
 *
 * The function is PURE — no DB calls, no HTTP. Caller passes the
 * available evidence; the resolver picks.
 */
export function resolveCanonicalProbeModel(
  input: ResolveCanonicalProbeModelInput,
): CanonicalProbeModel | null {
  const providerId = input.providerId;

  // 1) Manual override (caller knows best).
  if (input.manualOverride && input.manualOverride.length > 0) {
    const { apiModelId, aliasUsed } = resolveProviderApiModelId(providerId, input.manualOverride);
    return {
      providerId,
      modelId: input.manualOverride,
      apiModelId,
      source: 'manual_probe_spec',
      confidence: 'high',
      reason: aliasUsed
        ? `manual override with alias applied (${input.manualOverride} → ${apiModelId})`
        : `manual override (${input.manualOverride})`,
    };
  }

  // 2) Last-success — strongest live signal.
  if (input.lastSuccessfulModels && input.lastSuccessfulModels.length > 0) {
    const last = input.lastSuccessfulModels[0];
    const { apiModelId, aliasUsed } = resolveProviderApiModelId(providerId, last);
    return {
      providerId,
      modelId: last,
      apiModelId,
      source: 'last_success',
      confidence: 'high',
      reason: aliasUsed
        ? `last successful chat probe (alias applied)`
        : `last successful chat probe`,
    };
  }

  // 3) Provider discovery — model the provider says it serves.
  if (input.discoveredModels && input.discoveredModels.length > 0) {
    const first = input.discoveredModels[0];
    return {
      providerId,
      modelId: first.id,
      apiModelId: first.id,
      source: 'provider_discovery',
      confidence: 'high',
      reason: 'first model from provider /models discovery',
    };
  }

  // 4) Catalog with alias — most catalog rows need no alias, but for
  //    providers in PROVIDER_MODEL_ALIASES the rewrite is critical.
  for (const cand of input.catalogModels) {
    // Skip non-chat candidates if capability info available.
    if (cand.capabilities && cand.capabilities.length > 0) {
      if (!cand.capabilities.includes('chat')) continue;
    }
    const { apiModelId, aliasUsed } = resolveProviderApiModelId(providerId, cand.id);
    if (aliasUsed) {
      return {
        providerId,
        modelId: cand.id,
        apiModelId,
        canonicalModelId: cand.canonicalModelId,
        source: 'catalog_alias',
        confidence: 'medium',
        reason: `catalog model with provider-alias rewrite (${cand.id} → ${apiModelId})`,
      };
    }
  }

  // 5) Catalog direct (no alias rewrite needed) — first chat-capable.
  for (const cand of input.catalogModels) {
    if (cand.capabilities && cand.capabilities.length > 0) {
      if (!cand.capabilities.includes('chat')) continue;
    }
    return {
      providerId,
      modelId: cand.id,
      apiModelId: cand.id,
      canonicalModelId: cand.canonicalModelId,
      source: 'catalog_direct',
      confidence: 'medium',
      reason: 'first chat-capable catalog model (no alias needed)',
    };
  }

  // 6) Nothing found.
  return null;
}
