// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Legacy ModelCapability ↔ Capability URI translator.
 *
 * The post-HCRA canonical key for a capability is a URI under
 * `http://ailin.dev/cap/v1/<slug>` (see capability/ontology/seed.ts). The
 * legacy `ModelCapability` union (types/index.ts) is being kept for the
 * migration window; every legacy value's slug equals its enum value, so the
 * translation is a pure prefix add/strip. This module gives the rest of the
 * codebase a single, testable place to do that — no `cap.startsWith(...)` or
 * string-literal concatenation scattered across selectors, scoring, and
 * matrix code.
 *
 * Why a dedicated module instead of inlining:
 *   1. The URI prefix is a structural constant. Hard-coding it in N places
 *      makes a future bump (e.g. v1 → v2) a multi-file refactor.
 *   2. The selector and CapabilitySearchService speak different shapes
 *      (`ModelCapability[]` vs `string[]`). Without a translator, every
 *      caller invents its own conversion and they drift.
 *   3. The reverse direction (`uriToLegacy`) is needed by surfaces that
 *      project HCRA hits back into legacy-typed responses (e.g. /v1/models
 *      compatibility shape). Centralising it ensures both directions agree
 *      on the prefix + slug conventions.
 *
 * Migration status: as long as the slug↔enum equivalence holds (assertion in
 * the matching unit test), this translator is the *only* coupling between
 * legacy and URI worlds. Once the legacy union is dropped, this module
 * becomes a no-op that the type system can remove.
 */

import type { ModelCapability } from '@/types';

/** The canonical capability URI prefix. Update with care — used in DB rows. */
export const CAPABILITY_URI_PREFIX = 'http://ailin.dev/cap/v1/';

const URI_RE = new RegExp(
  `^${CAPABILITY_URI_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(.+)$`,
);

/**
 * Translate a legacy ModelCapability enum value to its canonical URI.
 *
 * Stable for the lifetime of HCRA v1 — the slug equals the enum value.
 */
export function legacyToUri(cap: ModelCapability): string {
  return `${CAPABILITY_URI_PREFIX}${cap}`;
}

/**
 * Bulk variant. Preserves order.
 */
export function legacyArrayToUriArray(caps: readonly ModelCapability[]): string[] {
  return caps.map(legacyToUri);
}

/**
 * Translate a canonical URI back to a legacy ModelCapability slug.
 *
 * Returns null for malformed URIs (non-prefix-matching). Callers that need
 * type narrowing should validate against the legacy union themselves —
 * this function is intentionally permissive about slug content because the
 * ontology may add slugs ahead of the legacy union (e.g. when surfacing
 * a new capability via HCRA before threading it through every type-level
 * consumer).
 */
export function uriToLegacy(uri: string): string | null {
  const m = URI_RE.exec(uri);
  return m ? m[1] : null;
}

/**
 * Same as uriToLegacy but narrows to `ModelCapability` ONLY when the slug
 * is in the legacy union. Returns null for both malformed URIs and URIs
 * pointing to slugs that are not (yet) part of the legacy union.
 *
 * Use this when you need a typed value (e.g. populating the legacy
 * `capabilities` array on a response). Use `uriToLegacy` when you just
 * need the raw slug.
 */
export function uriToTypedLegacy(
  uri: string,
  legacySet: ReadonlySet<ModelCapability>,
): ModelCapability | null {
  const slug = uriToLegacy(uri);
  if (slug === null) return null;
  return legacySet.has(slug as ModelCapability) ? (slug as ModelCapability) : null;
}

/**
 * Best-effort URI-array → legacy-array projection. Drops URIs that don't
 * map to a legacy union member. The caller decides whether dropping is OK
 * (e.g. for telemetry projection it's fine; for routing decisions it's
 * usually not).
 */
export function uriArrayToLegacyArray(
  uris: readonly string[],
  legacySet: ReadonlySet<ModelCapability>,
): ModelCapability[] {
  const out: ModelCapability[] = [];
  for (const uri of uris) {
    const m = uriToTypedLegacy(uri, legacySet);
    if (m !== null) out.push(m);
  }
  return out;
}
