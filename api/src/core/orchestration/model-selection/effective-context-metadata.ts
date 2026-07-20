// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R4C §7 — Effective context metadata.
 *
 * Pure helper. Resolves the "effective" contextWindow + maxOutputTokens
 * for a (providerId, routeId, apiModelId, canonicalModelId) tuple,
 * applying audit-trailed overrides on top of catalog values WITHOUT
 * mutating the raw catalog.
 *
 * Precedence (most specific wins):
 *   1. routeId + providerId + apiModelId    (exact)
 *   2. providerId + apiModelId
 *   3. providerId + canonicalModelId
 *   4. canonicalModelId
 *   5. catalog value
 *   6. conservativeFallback
 *
 * Safety rules:
 *   - low-confidence overrides cannot REDUCE a larger catalog value
 *     (only medium/high confidence can shrink the effective window).
 *   - effectiveContextWindow MUST be ≥ 1024.
 *   - effectiveMaxOutputTokens (when provided) MUST be ≥ 256.
 *   - Deterministic given identical inputs.
 *
 * Pure: no I/O. The overrides array is supplied by the caller (read
 * from the backfill artifact OR fetched from a future override store).
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type ContextMetadataSource =
  | 'catalog'
  | 'provider_spec'
  | 'inventory_evidence'
  | 'manual_verified'
  | 'public_doc'
  | 'router_metadata'
  | 'conservative_inference';

export type ContextMetadataConfidence = 'high' | 'medium' | 'low';

export interface ContextMetadataOverride {
  readonly providerId?: string;
  readonly routeId?: string;
  readonly apiModelId?: string;
  readonly canonicalModelId?: string;
  readonly catalogContextWindow?: number;
  readonly effectiveContextWindow: number;
  readonly catalogMaxOutputTokens?: number;
  readonly effectiveMaxOutputTokens?: number;
  readonly source: ContextMetadataSource;
  readonly confidence: ContextMetadataConfidence;
  readonly reason: string;
  readonly capturedAt?: string;
  readonly stage: '01C.1B-J1D-R4C';
}

export interface EffectiveContextMetadata {
  readonly providerId?: string;
  readonly routeId?: string;
  readonly apiModelId?: string;
  readonly canonicalModelId?: string;
  readonly catalogContextWindow?: number;
  readonly effectiveContextWindow: number;
  readonly catalogMaxOutputTokens?: number;
  readonly effectiveMaxOutputTokens?: number;
  readonly source: ContextMetadataSource;
  readonly confidence: ContextMetadataConfidence;
  readonly overrideApplied: boolean;
  readonly reason: string;
  readonly matchKind:
    | 'route_provider_api'
    | 'provider_api'
    | 'provider_canonical'
    | 'canonical'
    | 'catalog'
    | 'conservative_fallback';
}

export interface ContextMetadataKeyInput {
  readonly providerId?: string;
  readonly routeId?: string;
  readonly apiModelId?: string;
  readonly canonicalModelId?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────

const MIN_VALID_CONTEXT_WINDOW = 1024;
const MIN_VALID_MAX_OUTPUT_TOKENS = 256;
const DEFAULT_CONSERVATIVE_FALLBACK_CONTEXT_WINDOW = 4096;

const CONFIDENCE_RANK: Record<ContextMetadataConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function lower(v: string | undefined | null): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Build a deterministic key for a metadata lookup. Used by callers that
 * want to memoize the resolution per (provider, route, model).
 */
export function buildContextMetadataKey(input: ContextMetadataKeyInput): string {
  return [
    lower(input.providerId),
    lower(input.routeId),
    lower(input.apiModelId),
    lower(input.canonicalModelId),
  ].join('|');
}

function isValidContextWindow(n: number | undefined): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n >= MIN_VALID_CONTEXT_WINDOW;
}

function isValidMaxOutputTokens(n: number | undefined): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n >= MIN_VALID_MAX_OUTPUT_TOKENS;
}

/**
 * Score an override's match specificity. Higher = more specific.
 *   - route + provider + api : 8
 *   - provider + api         : 4
 *   - provider + canonical   : 3
 *   - canonical only         : 2
 *   - provider only          : 1
 *   - none                   : 0
 */
function matchSpecificity(
  o: ContextMetadataOverride,
  q: ContextMetadataKeyInput,
): number {
  const qProvider = lower(q.providerId);
  const qRoute = lower(q.routeId);
  const qApi = lower(q.apiModelId);
  const qCanon = lower(q.canonicalModelId);
  const oProvider = lower(o.providerId);
  const oRoute = lower(o.routeId);
  const oApi = lower(o.apiModelId);
  const oCanon = lower(o.canonicalModelId);

  // Reject overrides whose declared fields don't match the query
  if (oProvider && qProvider && oProvider !== qProvider) return -1;
  if (oRoute && qRoute && oRoute !== qRoute) return -1;
  if (oApi && qApi && oApi !== qApi) return -1;
  if (oCanon && qCanon && oCanon !== qCanon) return -1;

  if (oRoute && oProvider && oApi) return 8;
  if (oProvider && oApi) return 4;
  if (oProvider && oCanon) return 3;
  if (oCanon) return 2;
  if (oProvider) return 1;
  return 0;
}

function matchKindFromScore(score: number): EffectiveContextMetadata['matchKind'] {
  switch (score) {
    case 8: return 'route_provider_api';
    case 4: return 'provider_api';
    case 3: return 'provider_canonical';
    case 2: return 'canonical';
    default: return 'canonical';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface ResolveEffectiveContextInput extends ContextMetadataKeyInput {
  readonly catalogContextWindow?: number;
  readonly catalogMaxOutputTokens?: number;
  readonly overrides?: readonly ContextMetadataOverride[];
  readonly conservativeFallbackContextWindow?: number;
  readonly conservativeFallbackMaxOutputTokens?: number;
}

/**
 * Resolve the most-specific override that applies to the query.
 * Falls through to catalog value, then to conservative fallback.
 *
 * Pure: identical inputs → identical output. The function never mutates
 * its inputs.
 */
export function resolveEffectiveContextMetadata(
  input: ResolveEffectiveContextInput,
): EffectiveContextMetadata {
  const overrides = input.overrides ?? [];

  // Find the highest-specificity matching override.
  let bestScore = -1;
  let best: ContextMetadataOverride | undefined;
  for (const o of overrides) {
    const score = matchSpecificity(o, input);
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }

  const catalogCtx = input.catalogContextWindow;
  const catalogMaxOut = input.catalogMaxOutputTokens;

  if (best && bestScore >= 0) {
    // Apply safety rule: low-confidence cannot REDUCE a larger catalog
    // value. Medium/high confidence MAY adjust downward.
    let effectiveCtx = best.effectiveContextWindow;
    if (best.confidence === 'low' && isValidContextWindow(catalogCtx)) {
      effectiveCtx = Math.max(effectiveCtx, catalogCtx!);
    }
    // Validate window magnitude.
    if (!isValidContextWindow(effectiveCtx)) {
      // Override is structurally invalid → fall through to catalog.
    } else {
      let effectiveMaxOut = best.effectiveMaxOutputTokens;
      if (typeof effectiveMaxOut === 'number') {
        // If override gives a max_out smaller than catalog and conf is low,
        // keep the larger value.
        if (best.confidence === 'low' && isValidMaxOutputTokens(catalogMaxOut)) {
          effectiveMaxOut = Math.max(effectiveMaxOut, catalogMaxOut!);
        }
        if (!isValidMaxOutputTokens(effectiveMaxOut)) {
          effectiveMaxOut = catalogMaxOut;
        }
      } else if (isValidMaxOutputTokens(catalogMaxOut)) {
        effectiveMaxOut = catalogMaxOut;
      }
      return {
        providerId: input.providerId,
        routeId: input.routeId,
        apiModelId: input.apiModelId,
        canonicalModelId: input.canonicalModelId,
        catalogContextWindow: catalogCtx,
        effectiveContextWindow: effectiveCtx,
        catalogMaxOutputTokens: catalogMaxOut,
        effectiveMaxOutputTokens: effectiveMaxOut,
        source: best.source,
        confidence: best.confidence,
        overrideApplied: true,
        reason: best.reason,
        matchKind: matchKindFromScore(bestScore),
      };
    }
  }

  if (isValidContextWindow(catalogCtx)) {
    return {
      providerId: input.providerId,
      routeId: input.routeId,
      apiModelId: input.apiModelId,
      canonicalModelId: input.canonicalModelId,
      catalogContextWindow: catalogCtx,
      effectiveContextWindow: catalogCtx!,
      catalogMaxOutputTokens: catalogMaxOut,
      effectiveMaxOutputTokens: isValidMaxOutputTokens(catalogMaxOut) ? catalogMaxOut : undefined,
      source: 'catalog',
      confidence: 'medium',
      overrideApplied: false,
      reason: 'catalog metadata used; no override matched',
      matchKind: 'catalog',
    };
  }

  // Conservative fallback (catalog missing/invalid).
  const fallbackCtx =
    input.conservativeFallbackContextWindow ?? DEFAULT_CONSERVATIVE_FALLBACK_CONTEXT_WINDOW;
  const fallbackMaxOut = input.conservativeFallbackMaxOutputTokens;
  return {
    providerId: input.providerId,
    routeId: input.routeId,
    apiModelId: input.apiModelId,
    canonicalModelId: input.canonicalModelId,
    catalogContextWindow: catalogCtx,
    effectiveContextWindow: fallbackCtx,
    catalogMaxOutputTokens: catalogMaxOut,
    effectiveMaxOutputTokens: isValidMaxOutputTokens(fallbackMaxOut) ? fallbackMaxOut : undefined,
    source: 'conservative_inference',
    confidence: 'low',
    overrideApplied: false,
    reason: 'no override and catalog contextWindow invalid; conservative fallback',
    matchKind: 'conservative_fallback',
  };
}

// Re-export for callers that want to check confidence ranks themselves.
export { CONFIDENCE_RANK as CONTEXT_METADATA_CONFIDENCE_RANK };
