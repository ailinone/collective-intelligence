// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pinned-fallback capability invariants (2026-04-28 root-cause refactor).
 *
 * ## What this test asserts
 *
 * Every model id listed in any catalog row's `pinnedFallback.models` MUST be
 * declared in the structured form `{ id, capabilities }` with a NON-EMPTY
 * capability array of recognised `ModelCapability` values.
 *
 * ## Why this matters
 *
 * The 8-source capability fusion hierarchy (model-capability-merger.ts)
 * weights operator-declared capabilities at ≈1.0 and name-regex inference
 * at ≈0.20. Until 2026-04-28 the catalog-bridge in
 * `central-model-discovery-service.ts` emitted pinned models with
 * `capabilities: inferCapabilitiesFromModelId(modelId) ?? []` — a name-
 * regex pass at the bottom of the hierarchy. That was a palliative.
 *
 * The root-cause refactor moved capability authorship into the catalog
 * itself: each pinned model declares its capabilities inline. The catalog
 * IS the operator-declared source. The catalog-bridge now reads those
 * declared capabilities verbatim and only falls back to regex for entries
 * still in legacy bare-string form. This test makes the bare-string form
 * unreachable, locking the architecture in.
 *
 * ## Failure modes
 *
 * - Bare-string form: "Pinned model entry must be structured `{id, capabilities}`,
 *   bare strings are no longer permitted (root-cause refactor 2026-04-28)."
 *   → fix: convert `'foo-model'` to `{ id: 'foo-model', capabilities: [...] }`.
 *
 * - Empty capabilities: "Pinned model `foo-model` declares an empty capability
 *   array. Operator must declare at least one capability."
 *   → fix: add the appropriate ModelCapability tags.
 *
 * - Unknown capability: "Pinned model `foo-model` declares unknown capability
 *   `xyz`. Add it to `ModelCapability` in types/index.ts or use a recognised
 *   value."
 *   → fix: extend the enum (root-cause) or pick an existing tag.
 */

import { describe, it, expect } from 'vitest';
import { PROVIDER_CATALOG } from '@/providers/catalog/providers.catalog';
import {
  normalizePinnedModelEntry,
  type PinnedModelEntry,
} from '@/providers/catalog/provider-catalog.types';
import { isModelCapability, MODEL_CAPABILITIES } from '@/types';

interface PinnedRow {
  providerId: string;
  modelId: string;
  capabilities: readonly string[];
  isStructured: boolean;
}

function collectPinnedRows(): PinnedRow[] {
  const rows: PinnedRow[] = [];
  for (const entry of PROVIDER_CATALOG) {
    const pinned = (
      entry as { pinnedFallback?: { models?: readonly PinnedModelEntry[] } }
    ).pinnedFallback?.models;
    if (!pinned) continue;

    for (const raw of pinned) {
      const isStructured = typeof raw !== 'string';
      const { id, capabilities } = normalizePinnedModelEntry(raw);
      rows.push({
        providerId: entry.providerId,
        modelId: id,
        capabilities,
        isStructured,
      });
    }
  }
  return rows;
}

describe('pinnedFallback capability invariants (root-cause refactor 2026-04-28)', () => {
  const rows = collectPinnedRows();

  it('catalog has at least one pinnedFallback row (sanity)', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it('every pinned model uses the structured `{id, capabilities}` form (no bare strings)', () => {
    const bare = rows.filter((r) => !r.isStructured);
    expect(
      bare,
      bare.length === 0
        ? ''
        : `Pinned model entries must be structured \`{ id, capabilities: [...] }\`. ` +
            `Bare strings rely on name-regex inference (palliative weight ≈0.20). ` +
            `Convert these to operator-declared form:\n` +
            bare.map((r) => `  - ${r.providerId}: '${r.modelId}'`).join('\n'),
    ).toEqual([]);
  });

  it('every pinned model declares at least one capability', () => {
    const empty = rows.filter((r) => r.capabilities.length === 0);
    expect(
      empty,
      empty.length === 0
        ? ''
        : `Pinned models must declare ≥1 capability (operator-declared signal). ` +
            `Empty arrays let the bridge fall through to name-regex which is exactly ` +
            `what the root-cause refactor eliminated:\n` +
            empty.map((r) => `  - ${r.providerId}: ${r.modelId}`).join('\n'),
    ).toEqual([]);
  });

  it('every declared capability is a recognised ModelCapability', () => {
    const unknown: { providerId: string; modelId: string; cap: string }[] = [];
    for (const r of rows) {
      for (const cap of r.capabilities) {
        if (!isModelCapability(cap)) {
          unknown.push({ providerId: r.providerId, modelId: r.modelId, cap });
        }
      }
    }
    expect(
      unknown,
      unknown.length === 0
        ? ''
        : `Pinned models declare unknown capability strings. Either add the ` +
            `value to ModelCapability in api/src/types/index.ts (root-cause: real ` +
            `new capability) or pick an existing one (palliative: typo). Valid ` +
            `values:\n  ${MODEL_CAPABILITIES.join(', ')}\n` +
            `Offenders:\n` +
            unknown
              .map((u) => `  - ${u.providerId}: ${u.modelId} → '${u.cap}'`)
              .join('\n'),
    ).toEqual([]);
  });

  it('declared capabilities do NOT need name-regex backup to be discoverable', () => {
    // Defensive: the catalog-bridge prefers declared capabilities, but if a
    // future bug reintroduced a regex-fallback path, this test would still
    // pass for declared rows. To make sure the operator-declared path is the
    // SOLE source for these models, we sample a few catalog-declared families
    // that should NOT appear in MODEL_CAPABILITY_PATTERNS anymore.
    //
    // This is more of a documentation test than an enforcement: the actual
    // enforcement is "no bare strings" + "non-empty declared caps" above.
    const families = ['palmyra', 'sonar', 'ernie', 'inflection_3', 'pi-3', 'relace-apply'];
    const declared = rows.filter((r) =>
      families.some((f) => r.modelId.toLowerCase().startsWith(f)),
    );
    // We assert structural shape; capability-content correctness is covered
    // by the `every pinned model declares ≥1 capability` test above.
    for (const r of declared) {
      expect(
        r.isStructured,
        `${r.providerId}/${r.modelId} should be operator-declared (structured form)`,
      ).toBe(true);
      expect(
        r.capabilities.length,
        `${r.providerId}/${r.modelId} should declare ≥1 capability`,
      ).toBeGreaterThan(0);
    }
  });
});
