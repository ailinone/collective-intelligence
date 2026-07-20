// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1R2 — Model-centric serving-providers lookup.
 *
 * Given a logical model id, returns every catalog row whose normalized
 * name matches — across all providers. This is the **catalog** half of
 * the multi-route fanout (the taxonomy half stays in
 * `provider-routing-taxonomy.ts`).
 *
 * Pure-data contract:
 *   - Input: logicalModelId + capability requirement (default 'chat')
 *   - Output: list of `{ providerId, apiModelId, adapterKind?, source,
 *     confidence }` entries
 *
 * The function NEVER calls a provider HTTP endpoint. It only reads the
 * local catalog (Prisma `model` table). When called outside a Prisma
 * context (unit tests), pass a `lookupCatalogRows` adapter.
 */

import {
  compareModelIds,
  buildCatalogMatchPatterns,
  buildCatalogContainsTerms,
} from './model-name-normalizer';

export interface ServingProviderEntry {
  readonly providerId: string;
  readonly apiModelId: string;
  readonly modelId?: string;
  readonly adapterKind?: string;
  readonly source: 'model_catalog';
  /**
   * - `exact`: catalog row name equals logical id (case-insensitive)
   * - `alias`: catalog row name has a safe-tail alias (e.g., logical
   *   `llama-3.2-11b` matches catalog `llama-3.2-11b-vision-instruct`)
   * - `normalized`: catalog row name matches after vendor-prefix +
   *   separator normalization
   * - `probable`: NOT used in J1R2 (reserved for future fuzzy matching)
   */
  readonly confidence: 'exact' | 'alias' | 'normalized' | 'probable';
  /** Catalog `capabilities` array (chat / text_generation / streaming / …). */
  readonly capabilities: readonly string[];
  /** True if the entry has explicit chat capability. */
  readonly chatCapable: boolean;
}

export interface CatalogRow {
  readonly providerId: string;
  readonly providerName?: string;
  readonly modelId: string;
  readonly name: string;
  readonly capabilities: readonly string[];
}

export type LookupCatalogRows = (input: {
  readonly patterns: readonly string[];
  /**
   * 01C.1B-J1R2 — broader substring terms (typically the dotless +
   * dotted core). Adapter ORs these into a `name ILIKE %term%` clause
   * alongside the exact-equality `patterns`. The post-filter in
   * `lookupServingProvidersFromCatalog` discards false positives via
   * `compareModelIds`.
   */
  readonly containsTerms?: readonly string[];
  readonly limit?: number;
}) => Promise<readonly CatalogRow[]>;

export interface LookupServingProvidersInput {
  readonly logicalModelId: string;
  readonly nativeProviderId?: string;
  readonly requireCapability?: 'chat' | 'text_generation' | 'embedding' | 'any';
  readonly maxResults?: number;
  /** Inject your own catalog query. In production this is backed by Prisma. */
  readonly lookupCatalogRows: LookupCatalogRows;
}

/**
 * Resolve the catalog rows that serve a given logical model, mapping
 * each to a `ServingProviderEntry`. Returns an empty list when the
 * catalog has nothing for this id (taxonomy-only fallback applies).
 *
 * Capability filter: when `requireCapability` is `'chat'` (default),
 * only rows whose `capabilities[]` includes `'chat'` are returned.
 */
export async function lookupServingProvidersFromCatalog(
  input: LookupServingProvidersInput,
): Promise<readonly ServingProviderEntry[]> {
  const logicalModelId = input.logicalModelId;
  const requireCapability = input.requireCapability ?? 'chat';
  const maxResults = input.maxResults ?? 200;
  const patterns = buildCatalogMatchPatterns(logicalModelId);
  if (patterns.length === 0) return [];
  const containsTerms = buildCatalogContainsTerms(logicalModelId);

  const rows = await input.lookupCatalogRows({ patterns, containsTerms, limit: maxResults });
  const seen = new Set<string>();
  const out: ServingProviderEntry[] = [];

  for (const row of rows) {
    // Capability filter — strict: row must explicitly carry the
    // requested capability OR `text_generation` (chat-compatible) when
    // requireCapability='chat'.
    const caps = row.capabilities ?? [];
    const chatCapable =
      caps.includes('chat') || caps.includes('text_generation') || caps.includes('text-generation');
    if (requireCapability === 'chat' && !chatCapable) continue;
    if (requireCapability === 'embedding' && !caps.includes('embedding')) continue;
    if (requireCapability === 'text_generation' && !caps.includes('text_generation') && !caps.includes('text-generation')) continue;

    // Confidence based on name compare.
    const cmp = compareModelIds(logicalModelId, row.name);
    if (cmp === 'no_match') continue;

    // Dedup by providerId + name + capability set (collapse near-dupes).
    const key = `${(row.providerName ?? row.providerId).toLowerCase()}::${row.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      providerId: (row.providerName ?? row.providerId).toLowerCase(),
      apiModelId: row.name,
      modelId: row.modelId,
      source: 'model_catalog',
      confidence: cmp === 'exact' ? 'exact' : cmp === 'alias' ? 'alias' : 'normalized',
      capabilities: caps,
      chatCapable,
    });
    if (out.length >= maxResults) break;
  }

  // Stable sort: exact > normalized > alias > probable; then providerId asc.
  const rank: Record<ServingProviderEntry['confidence'], number> = {
    exact: 0,
    normalized: 1,
    alias: 2,
    probable: 3,
  };
  out.sort((a, b) => {
    const r = rank[a.confidence] - rank[b.confidence];
    if (r !== 0) return r;
    return a.providerId.localeCompare(b.providerId);
  });

  return out;
}

/**
 * Public adapter type used by callers (consensus-plan-dry-run-service).
 * Builds a closure over the Prisma client so the builder remains free
 * of DB knowledge.
 */
export type ServingProvidersLookup = (input: {
  readonly logicalModelId: string;
  readonly nativeProviderId?: string;
  readonly requireCapability?: 'chat' | 'text_generation' | 'embedding' | 'any';
}) => Promise<readonly ServingProviderEntry[]>;
