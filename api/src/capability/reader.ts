// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Reader Adapter (ADR-022, Sprint 3)
 *
 * The seam through which downstream code (orchestration, selection,
 * routing, transparency, adapters) reads a model's effective capability
 * set during the migration window.
 *
 * Why an adapter and not a hard cutover
 * -------------------------------------
 * 21 modules currently read `models.capabilities` (the legacy JSONB
 * string[]). Replacing each call site at once is risky: the noisy-OR
 * materialiser is very recent (days), some models still have only the
 * sprint1-backfill name-regex assertions, and consumers have subtly
 * different expectations (some want a Set lookup, some want array order
 * preserved, some want every claim regardless of confidence).
 *
 * Strategy: route reads through this module. Today it returns
 *   `model.capabilityUris` (mapped back to legacy slugs) UNION
 *   `model.capabilities` (legacy)
 * with an explicit confidence-aware variant for consumers ready for it.
 *
 * Once `models.capabilities` is dropped, we delete the legacy branch
 * here without touching consumer call sites.
 *
 * Confidence-aware reads
 * ----------------------
 * `getEffectiveCapabilitiesWithConfidence()` exposes the materialised
 * fusion (`capability_confidence` JSONB) so high-stakes consumers
 * (canary gate, bandit reward shaping) can downweight weak claims
 * instead of treating "vision via name-regex@0.04" identical to
 * "vision via provider-declared@0.95".
 *
 * Read modes
 * ----------
 * - `'union'`   — union of HCRA + legacy slugs. Default. Maximum recall,
 *                 matches today's behavior closely.
 * - `'hcra'`    — HCRA only. Strictest. Use when callers have explicitly
 *                 opted into the new layer.
 * - `'legacy'`  — legacy column only. Escape hatch for debugging.
 */

import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';
import type { ModelCapability } from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'capability-reader' });

/** Reverse of LEGACY_CAPABILITY_TO_URI: URI → slug. Lazy-built on first access. */
let URI_TO_LEGACY_CACHE: Readonly<Record<string, ModelCapability>> | null = null;

export function uriToLegacy(uri: string): ModelCapability | undefined {
  if (URI_TO_LEGACY_CACHE === null) {
    URI_TO_LEGACY_CACHE = Object.freeze(
      Object.fromEntries(
        Object.entries(LEGACY_CAPABILITY_TO_URI).map(([slug, u]) => [u, slug as ModelCapability]),
      ),
    );
  }
  return URI_TO_LEGACY_CACHE[uri];
}

export function legacyToUri(capability: ModelCapability | string): string | undefined {
  return LEGACY_CAPABILITY_TO_URI[capability];
}

/**
 * Minimal shape of a model row from the consumer's perspective. Anything
 * that has these fields can be passed in (Prisma row, hand-built object,
 * cached selection, etc.) — we never reach back into the database.
 */
export interface CapabilityReadable {
  capabilities?: readonly string[] | null;
  capabilityUris?: readonly string[] | null;
  /** Materialised JSONB: `{ "<uri>": <confidence in [0,1]> }`. */
  capabilityConfidence?: Record<string, number> | null;
  /** Materialised JSONB: `{ "<uri>": ["provider-declared", ...] }`. */
  capabilitySources?: Record<string, readonly string[]> | null;
}

export type ReadMode = 'union' | 'hcra' | 'legacy';

/**
 * Returns the globally-configured read mode, driven by `HCRA_READ_MODE`.
 * Callers in the hot path should pass this into `hasCapability`/etc. so
 * rollout mode is a single env flip rather than a deploy. Invalid values
 * log once and fall back to `'union'`.
 */
let CACHED_DEFAULT_MODE: ReadMode | null = null;
export function getDefaultReadMode(): ReadMode {
  if (CACHED_DEFAULT_MODE !== null) return CACHED_DEFAULT_MODE;
  const raw = (process.env.HCRA_READ_MODE ?? 'union').toLowerCase();
  if (raw === 'union' || raw === 'hcra' || raw === 'legacy') {
    CACHED_DEFAULT_MODE = raw;
  } else {
    log.warn({ raw }, 'Invalid HCRA_READ_MODE; falling back to union');
    CACHED_DEFAULT_MODE = 'union';
  }
  return CACHED_DEFAULT_MODE;
}
/** Test-only: reset cached mode so a new env var takes effect. */
export function __resetDefaultReadModeForTests(): void {
  CACHED_DEFAULT_MODE = null;
}

export interface CapabilityReadOptions {
  /** Defaults to `'union'` for safe rollout. */
  mode?: ReadMode;
  /**
   * Drop capabilities whose materialised fused confidence is below this.
   * Has no effect on legacy reads (no per-cap confidence available).
   * Default: 0 (keep everything).
   */
  minConfidence?: number;
}

export interface CapabilityWithProvenance {
  /** Legacy slug (for back-compat with consumers that key on the union string). */
  capability: ModelCapability;
  /** Canonical URI. */
  uri: string;
  /** Fused confidence in [0,1]. `null` if only known via legacy column. */
  confidence: number | null;
  /** Sources, strongest-first. Empty if only known via legacy column. */
  sources: string[];
  /** Where the slug was found. */
  origin: 'hcra' | 'legacy' | 'both';
}

/**
 * Get the effective capability slugs for a model. Returns `string[]` to
 * match every existing call site that does `new Set(model.capabilities)`.
 *
 * The set is deduplicated and order is not guaranteed — callers that
 * relied on order were already broken (Prisma JSONB has no guarantee).
 */
export function getEffectiveCapabilities(
  model: CapabilityReadable,
  opts: CapabilityReadOptions = {},
): ModelCapability[] {
  const mode = opts.mode ?? 'union';
  const minConfidence = opts.minConfidence ?? 0;
  const out = new Set<ModelCapability>();

  const includeHcra = mode === 'hcra' || mode === 'union';
  const includeLegacy = mode === 'legacy' || mode === 'union';

  if (includeHcra) {
    for (const uri of model.capabilityUris ?? []) {
      if (minConfidence > 0) {
        const conf = model.capabilityConfidence?.[uri];
        if (typeof conf === 'number' && conf < minConfidence) continue;
      }
      const slug = uriToLegacy(uri);
      if (slug) out.add(slug);
      else if (process.env.HCRA_DEBUG_UNMAPPED === '1') {
        log.warn({ uri }, 'capability_uri has no legacy slug mapping');
      }
    }
  }
  if (includeLegacy) {
    for (const cap of model.capabilities ?? []) {
      if (typeof cap === 'string' && cap.length > 0) out.add(cap as ModelCapability);
    }
  }

  return [...out];
}

/**
 * Boolean check optimized for hot-path predicates ("does this model
 * support function_calling?"). Avoids constructing the full Set when the
 * caller only needs one yes/no.
 */
export function hasCapability(
  model: CapabilityReadable,
  capability: ModelCapability | string,
  opts: CapabilityReadOptions = {},
): boolean {
  const mode = opts.mode ?? 'union';
  const minConfidence = opts.minConfidence ?? 0;
  const targetUri = LEGACY_CAPABILITY_TO_URI[capability];

  if (mode !== 'legacy' && targetUri) {
    const uris = model.capabilityUris ?? [];
    for (const uri of uris) {
      if (uri !== targetUri) continue;
      if (minConfidence > 0) {
        const conf = model.capabilityConfidence?.[uri];
        if (typeof conf === 'number' && conf < minConfidence) return false;
      }
      return true;
    }
  }
  if (mode !== 'hcra' && model.capabilities) {
    for (const cap of model.capabilities) {
      if (cap === capability) return true;
    }
  }
  return false;
}

/**
 * Confidence-aware read for consumers that can act on weighted evidence:
 * - L5/L10 bandits — reward shaping by capability strength.
 * - L6 canary gate — abort gate when load-bearing capability is weakly attested.
 * - L11 routing event store — explanation strings ("chose model X because
 *   vision@0.92 from helicone-oracle and modality-derived").
 */
export function getEffectiveCapabilitiesWithConfidence(
  model: CapabilityReadable,
  opts: CapabilityReadOptions = {},
): CapabilityWithProvenance[] {
  const mode = opts.mode ?? 'union';
  const minConfidence = opts.minConfidence ?? 0;
  const byUri = new Map<string, CapabilityWithProvenance>();

  if (mode !== 'legacy') {
    for (const uri of model.capabilityUris ?? []) {
      const conf = model.capabilityConfidence?.[uri];
      if (typeof conf === 'number' && conf < minConfidence) continue;
      const slug = uriToLegacy(uri);
      if (!slug) continue;
      byUri.set(uri, {
        capability: slug,
        uri,
        confidence: typeof conf === 'number' ? conf : null,
        sources: [...(model.capabilitySources?.[uri] ?? [])],
        origin: 'hcra',
      });
    }
  }

  if (mode !== 'hcra') {
    for (const cap of model.capabilities ?? []) {
      const slug = cap as ModelCapability;
      const uri = LEGACY_CAPABILITY_TO_URI[slug];
      if (!uri) continue;
      const existing = byUri.get(uri);
      if (existing) {
        existing.origin = 'both';
      } else {
        byUri.set(uri, {
          capability: slug,
          uri,
          confidence: null,
          sources: [],
          origin: 'legacy',
        });
      }
    }
  }

  return [...byUri.values()];
}
