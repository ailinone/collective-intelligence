// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1E §9 — Central provider/API model ID resolver.
 *
 * Replaces the naive `${nativeProviderId}/${logicalModelId}` concat
 * that produced broken ids like `anthropic/anthropic-claude-3.7-sonnet`
 * (rejected by routers as 400 bad_request / 404 model_not_supported).
 *
 * Resolution priority:
 *   1. `provider_explicit_alias`        — PROVIDER_MODEL_ALIASES[providerId][logicalModelId]
 *   2. `route_explicit_alias`           — PROVIDER_MODEL_ALIASES[providerId][nativeProviderId-stripped form]
 *   3. `catalog_provider_model_id`      — input.providerModelId / discoveredApiModelId / routeCandidateApiModelId
 *   4. `catalog_canonical_model_id`     — input.canonicalModelId
 *   5. `conservative_derivation`        — strip nativeProviderId prefix from logical if router/aggregator
 *   6. `legacy_native_identity`         — provider === native, no prefix transformation
 *   7. `legacy_native_prefix`           — naive `${native}/${logical}` (last resort, low confidence)
 *   8. `unresolved`                     — strict mode rejects when only legacy_low remains
 *
 * NO HARDCODING of model-by-model overrides for the production path.
 * Aliases live in PROVIDER_MODEL_ALIASES (operator-maintained data),
 * the catalog (per-row providerModelId), and discovery (live API list).
 * The resolver only knows STRUCTURAL rules — never specific models.
 */

import {
  resolveProviderApiModelId,
} from '@/core/operability/provider-model-aliases';

export type ApiModelIdResolutionSource =
  | 'discovery_alias_snapshot'   // J1F: fresh-discovered, top priority
  | 'provider_explicit_alias'
  | 'route_explicit_alias'
  | 'catalog_provider_model_id'
  | 'catalog_api_model_id'
  | 'catalog_canonical_model_id'
  | 'discovery_provider_model_id'
  | 'conservative_derivation'
  | 'legacy_native_identity'
  | 'legacy_native_prefix'
  | 'unresolved';

export type ApiModelIdResolutionConfidence =
  | 'exact'             // provider returned this exact id at discovery
  | 'provider_specific' // explicit alias entry
  | 'catalog'           // catalog row carries provider-specific id
  | 'discovery'         // observed via /v1/models
  | 'derived'           // conservative derivation, no positive evidence
  | 'legacy_low'        // naive concat — likely wrong, kept for back-compat in non-strict
  | 'unresolved';       // strict refused to fabricate

export interface ProviderApiModelIdResolutionInput {
  readonly providerId: string;
  readonly nativeProviderId?: string;
  readonly routerId?: string;
  readonly upstreamProviderId?: string;
  readonly logicalModelId: string;
  readonly catalogModelId?: string;
  readonly providerModelId?: string;
  readonly canonicalModelId?: string;
  readonly discoveredApiModelId?: string;
  readonly routeCandidateApiModelId?: string;
  readonly adapterKind?: string;
  /** Strict mode rejects `legacy_low` fallbacks and returns `unresolved`. */
  readonly strict?: boolean;
  /**
   * 01C.1B-J1F — J1F-learned alias snapshot lookup. When set, takes
   * priority OVER `provider_explicit_alias` because discovery-backed
   * evidence is fresher than operator-maintained map entries. The
   * lookup receives (providerId, logicalModelId) and returns the
   * discovered apiModelId + confidence.
   */
  readonly discoverySnapshotLookup?: (input: {
    providerId: string;
    logicalModelId: string;
  }) => { apiModelId: string; confidence: 'exact' | 'high' | 'medium' | 'low'; matchKind: string } | undefined;
}

export interface ProviderApiModelIdResolution {
  readonly logicalModelId: string;
  readonly providerId: string;
  readonly nativeProviderId?: string;
  readonly apiModelId: string;
  readonly source: ApiModelIdResolutionSource;
  readonly confidence: ApiModelIdResolutionConfidence;
  readonly aliasApplied: boolean;
  readonly aliasReason?: string;
  readonly warnings: readonly string[];
}

/**
 * Detect the structural duplicate-prefix bug:
 *   nativeProviderId=anthropic, logicalModelId=anthropic-claude-3.7-sonnet
 *   → naive `anthropic/anthropic-claude-3.7-sonnet` (BAD)
 *
 * Returns true when the logical model id starts with `<nativeProviderId>-`
 * or `<nativeProviderId>_` or `<nativeProviderId>/`. In all these cases,
 * the canonical apiModelId for ROUTERS is `${nativeProviderId}/${stripped}`
 * where `stripped` removes the duplicate.
 */
export function detectsDuplicateProviderPrefix(
  nativeProviderId: string | undefined,
  logicalModelId: string,
): boolean {
  if (!nativeProviderId) return false;
  const native = nativeProviderId.toLowerCase();
  const id = logicalModelId.toLowerCase();
  return (
    id.startsWith(`${native}-`) ||
    id.startsWith(`${native}_`) ||
    id.startsWith(`${native}/`)
  );
}

/**
 * Strip the duplicated nativeProviderId prefix from the logical model id.
 * Used by `conservative_derivation` when:
 *   - native=anthropic, logical=anthropic-claude-3.7-sonnet
 *   → stripped=claude-3.7-sonnet
 *
 * Preserves the rest of the id verbatim (case, dots, hyphens, `:free`,
 * `accounts/.../models/...`, etc.).
 */
export function stripDuplicateProviderPrefix(
  nativeProviderId: string,
  logicalModelId: string,
): string {
  const native = nativeProviderId.toLowerCase();
  const id = logicalModelId;
  const idLower = id.toLowerCase();
  if (idLower.startsWith(`${native}-`)) return id.slice(native.length + 1);
  if (idLower.startsWith(`${native}_`)) return id.slice(native.length + 1);
  if (idLower.startsWith(`${native}/`)) return id.slice(native.length + 1);
  return id;
}

/**
 * Central resolver. See file header for priority ladder.
 *
 * INVARIANTS:
 *   - When `provider === nativeProviderId` and no alias entry exists,
 *     returns `logicalModelId` unchanged with source=legacy_native_identity.
 *   - When `provider !== nativeProviderId` (router/aggregator) and
 *     `logicalModelId` has the duplicate prefix, applies
 *     `conservative_derivation` to strip it.
 *   - When `strict=true` and only `legacy_native_prefix` (naive concat
 *     of `<native>/<logical>` where logical does NOT have the duplicate
 *     prefix) would remain, returns `unresolved`.
 */
export function resolveApiModelId(
  input: ProviderApiModelIdResolutionInput,
): ProviderApiModelIdResolution {
  const warnings: string[] = [];
  const providerId = input.providerId.toLowerCase();
  const nativeProviderId = input.nativeProviderId?.toLowerCase();
  const logicalModelId = input.logicalModelId;

  // 1. provider_explicit_alias FIRST — operator-curated overrides win.
  // J1F learning insight: catalog rows can be noisy (e.g., anthropic
  // stores `anthropic-claude-3.7-sonnet` as id when API expects
  // `claude-3-7-sonnet-latest`). Operator alias map has the canonical
  // API form; discovery snapshot is for UNKNOWN cases.
  const aliased = resolveProviderApiModelId(providerId, logicalModelId);
  if (aliased.aliasUsed) {
    return {
      logicalModelId,
      providerId,
      nativeProviderId,
      apiModelId: aliased.apiModelId,
      source: 'provider_explicit_alias',
      confidence: 'provider_specific',
      aliasApplied: true,
      aliasReason: 'PROVIDER_MODEL_ALIASES entry for (provider, logicalModelId)',
      warnings,
    };
  }

  // 2. discovery_alias_snapshot — J1F evidence-based, beats catalog/derivation
  if (input.discoverySnapshotLookup) {
    const hit = input.discoverySnapshotLookup({ providerId, logicalModelId });
    if (hit) {
      return {
        logicalModelId,
        providerId,
        nativeProviderId,
        apiModelId: hit.apiModelId,
        source: 'discovery_alias_snapshot',
        confidence: hit.confidence === 'exact' ? 'exact' : hit.confidence === 'high' ? 'discovery' : 'derived',
        aliasApplied: true,
        aliasReason: `J1F discovery snapshot match (${hit.matchKind}, ${hit.confidence})`,
        warnings,
      };
    }
  }

  // (provider_explicit_alias and discovery_alias_snapshot already handled above)

  // 3. route_explicit_alias — when router needs the native-stripped form
  // as the catalog key in the alias map (e.g., openrouter has
  // `claude-3.7-sonnet` → `anthropic/claude-3.7-sonnet`).
  if (nativeProviderId && providerId !== nativeProviderId &&
      detectsDuplicateProviderPrefix(nativeProviderId, logicalModelId)) {
    const stripped = stripDuplicateProviderPrefix(nativeProviderId, logicalModelId);
    const routerAlias = resolveProviderApiModelId(providerId, stripped);
    if (routerAlias.aliasUsed) {
      return {
        logicalModelId,
        providerId,
        nativeProviderId,
        apiModelId: routerAlias.apiModelId,
        source: 'route_explicit_alias',
        confidence: 'provider_specific',
        aliasApplied: true,
        aliasReason: `PROVIDER_MODEL_ALIASES entry for router '${providerId}' with native-stripped form '${stripped}'`,
        warnings,
      };
    }
  }

  // 3. catalog_provider_model_id — when the catalog row already
  // carries the provider-specific api id.
  if (input.providerModelId) {
    return {
      logicalModelId,
      providerId,
      nativeProviderId,
      apiModelId: input.providerModelId,
      source: 'catalog_provider_model_id',
      confidence: 'catalog',
      aliasApplied: false,
      warnings,
    };
  }
  if (input.routeCandidateApiModelId) {
    return {
      logicalModelId,
      providerId,
      nativeProviderId,
      apiModelId: input.routeCandidateApiModelId,
      source: 'catalog_api_model_id',
      confidence: 'catalog',
      aliasApplied: false,
      warnings,
    };
  }
  if (input.canonicalModelId) {
    return {
      logicalModelId,
      providerId,
      nativeProviderId,
      apiModelId: input.canonicalModelId,
      source: 'catalog_canonical_model_id',
      confidence: 'catalog',
      aliasApplied: false,
      warnings,
    };
  }

  // 4. discovery_provider_model_id — provider's /v1/models advertised id.
  if (input.discoveredApiModelId) {
    return {
      logicalModelId,
      providerId,
      nativeProviderId,
      apiModelId: input.discoveredApiModelId,
      source: 'discovery_provider_model_id',
      confidence: 'discovery',
      aliasApplied: false,
      warnings,
    };
  }

  // 5. conservative_derivation — handle duplicate prefix structurally.
  //    Native: strip the prefix (anthropic + anthropic-claude → claude)
  //    Router/aggregator: route via `${native}/${stripped}` (e.g., `anthropic/claude-3.7-sonnet`)
  if (nativeProviderId && detectsDuplicateProviderPrefix(nativeProviderId, logicalModelId)) {
    const stripped = stripDuplicateProviderPrefix(nativeProviderId, logicalModelId);
    if (providerId === nativeProviderId) {
      // Native: just use the stripped form.
      return {
        logicalModelId,
        providerId,
        nativeProviderId,
        apiModelId: stripped,
        source: 'conservative_derivation',
        confidence: 'derived',
        aliasApplied: false,
        aliasReason: `stripped duplicate '${nativeProviderId}-' prefix from native logicalModelId`,
        warnings: [
          ...warnings,
          `derived: '${stripped}' from '${logicalModelId}' on native '${nativeProviderId}' — no explicit alias; provider may reject if it expects a versioned id (e.g., '${stripped}-20250219'). Add to PROVIDER_MODEL_ALIASES to pin.`,
        ],
      };
    }
    // Router: namespace by native + stripped form.
    return {
      logicalModelId,
      providerId,
      nativeProviderId,
      apiModelId: `${nativeProviderId}/${stripped}`,
      source: 'conservative_derivation',
      confidence: 'derived',
      aliasApplied: false,
      aliasReason: `router '${providerId}' routes to '${nativeProviderId}/${stripped}' (stripped duplicate prefix)`,
      warnings: [
        ...warnings,
        `derived: '${nativeProviderId}/${stripped}' for router '${providerId}' — router-specific format may differ; add explicit PROVIDER_MODEL_ALIASES entry for '${providerId}' if rejected.`,
      ],
    };
  }

  // 6. legacy_native_identity — provider === native, no prefix issue.
  if (!nativeProviderId || providerId === nativeProviderId) {
    return {
      logicalModelId,
      providerId,
      nativeProviderId,
      apiModelId: logicalModelId,
      source: 'legacy_native_identity',
      confidence: 'derived',
      aliasApplied: false,
      warnings,
    };
  }

  // 7. legacy_native_prefix — naive `${native}/${logical}` for routers
  // when logical does NOT have the duplicate prefix. This is the form
  // that works for some routers when logical is already clean (e.g.,
  // gpt-4o + openrouter → openai/gpt-4o).
  const naive = `${nativeProviderId}/${logicalModelId}`;
  if (input.strict) {
    return {
      logicalModelId,
      providerId,
      nativeProviderId,
      apiModelId: naive,
      source: 'unresolved',
      confidence: 'unresolved',
      aliasApplied: false,
      aliasReason: 'strict mode rejected legacy_native_prefix — no explicit/catalog/discovery evidence for this router',
      warnings: [
        ...warnings,
        `unresolved (strict): no explicit alias for ('${providerId}', '${logicalModelId}'). Naive concat '${naive}' may or may not be accepted; refusing to silently use it.`,
      ],
    };
  }
  return {
    logicalModelId,
    providerId,
    nativeProviderId,
    apiModelId: naive,
    source: 'legacy_native_prefix',
    confidence: 'legacy_low',
    aliasApplied: false,
    aliasReason: 'fallback: naive concat (legacy behavior pre-J1E)',
    warnings: [
      ...warnings,
      `legacy_low: '${naive}' is the naive concat. Add PROVIDER_MODEL_ALIASES entry to elevate confidence.`,
    ],
  };
}
