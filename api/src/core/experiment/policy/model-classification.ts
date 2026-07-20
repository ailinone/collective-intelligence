// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Classification — derives (providerId, modelFamily, capabilityClass)
 * from catalog + DB. NEVER hardcoded lists.
 *
 * The policy engine and integrity guard are pure: they take classifications
 * as input. This module is the I/O boundary that turns a runtime modelId
 * into the structural facts the policy logic needs.
 *
 * Source of truth:
 *   - providerId            ← prisma.model.provider.name
 *   - modelFamily           ← PROVIDER_CATALOG[providerId].providerFamily
 *                              OR model.metadata.originalProvider (hub case)
 *   - contextWindow         ← prisma.model.contextWindow
 *   - capabilities          ← prisma.model.capabilities[]
 *   - capabilityTier        ← derived structurally from contextWindow + caps
 *
 * NO model name patterns. NO hardcoded lists. Everything queryable.
 */

import { prisma } from '@/database/client';
import type { Prisma } from '@/generated/prisma';
import { PROVIDER_CATALOG } from '@/providers/catalog/providers.catalog';
import type { ProviderCatalogEntry } from '@/providers/catalog/provider-catalog.types';
import { logger } from '@/utils/logger';
import { isOllamaProviderId } from './arm-evaluation-policy';

const log = logger.child({ component: 'model-classification' });

// ─── Capability tiers (structural, not name-based) ─────────────────────────

export type CapabilityTier = 'frontier' | 'mid' | 'budget' | 'local-frontier';

/**
 * Tier inference is structural:
 *   - local-frontier:  providerId is Ollama AND contextWindow ≥ 32k
 *                      AND capabilities ⊇ {chat, tools}
 *   - frontier:        contextWindow ≥ 100k AND capabilities ⊇ {chat, tools}
 *                      AND inputCostPer1k > 0 (not free-tier dumping ground)
 *   - mid:             contextWindow ≥ 32k OR (contextWindow ≥ 8k AND tools)
 *   - budget:          everything else
 *
 * No tier is derived from model name. Only from capability surface and
 * context window declared in the catalog/DB row.
 */
export function inferCapabilityTier(
  contextWindow: number | null | undefined,
  capabilities: ReadonlyArray<string>,
  inputCostPer1k: number | null | undefined,
  providerId: string,
): CapabilityTier {
  const ctx = contextWindow ?? 0;
  const caps = new Set(capabilities ?? []);
  const cost = inputCostPer1k ?? 0;
  const hasChat = caps.has('chat') || caps.has('text_generation');
  const hasTools = caps.has('tools') || caps.has('function_calling');

  if (isOllamaProviderId(providerId) && ctx >= 32_000 && hasChat) {
    return 'local-frontier';
  }
  if (ctx >= 100_000 && hasChat && hasTools && cost > 0) {
    return 'frontier';
  }
  if (ctx >= 32_000 || (ctx >= 8_000 && hasTools)) {
    return 'mid';
  }
  return 'budget';
}

// ─── Classified model record ───────────────────────────────────────────────

export interface ClassifiedModel {
  readonly modelId: string;
  readonly providerId: string;
  readonly modelFamily: string;
  readonly contextWindow: number;
  readonly capabilities: ReadonlyArray<string>;
  readonly inputCostPer1k: number;
  readonly capabilityTier: CapabilityTier;
  readonly isLocal: boolean;
}

// ─── Catalog index (built once, frozen) ────────────────────────────────────

interface CatalogIndex {
  readonly byProviderId: ReadonlyMap<string, ProviderCatalogEntry>;
  readonly familyByProviderId: ReadonlyMap<string, string>;
  readonly providersByFamily: ReadonlyMap<string, ReadonlyArray<string>>;
}

let catalogIndex: CatalogIndex | null = null;

function buildCatalogIndex(): CatalogIndex {
  const byProviderId = new Map<string, ProviderCatalogEntry>();
  const familyByProviderId = new Map<string, string>();
  const providersByFamily = new Map<string, string[]>();

  for (const entry of PROVIDER_CATALOG) {
    byProviderId.set(entry.providerId, entry);
    familyByProviderId.set(entry.providerId, entry.providerFamily);

    const list = providersByFamily.get(entry.providerFamily) ?? [];
    list.push(entry.providerId);
    providersByFamily.set(entry.providerFamily, list);

    // Aliases also map to the same family
    for (const alias of entry.aliases ?? []) {
      if (!familyByProviderId.has(alias)) {
        familyByProviderId.set(alias, entry.providerFamily);
      }
    }
  }

  return {
    byProviderId,
    familyByProviderId,
    providersByFamily: new Map(
      [...providersByFamily.entries()].map(([k, v]) => [k, Object.freeze(v)] as const),
    ),
  };
}

function ensureCatalogIndex(): CatalogIndex {
  if (catalogIndex === null) {
    catalogIndex = buildCatalogIndex();
  }
  return catalogIndex;
}

/** Reset the in-memory catalog index. Test-only. */
export function _resetCatalogIndexForTests(): void {
  catalogIndex = null;
}

// ─── Resolution: providerId → modelFamily (catalog lookup) ─────────────────

/**
 * Resolve modelFamily from providerId via catalog. Returns null if the
 * providerId is unknown (not in catalog and not an alias).
 *
 * For Ollama silos, returns 'self_hosted'. For unknown providers, returns
 * null — the caller decides how to handle.
 */
export function resolveProviderFamily(providerId: string): string | null {
  if (isOllamaProviderId(providerId)) {
    return 'self_hosted';
  }
  const idx = ensureCatalogIndex();
  return idx.familyByProviderId.get(providerId) ?? null;
}

/** All providerIds (catalog providers) serving the given family. */
export function listProvidersByFamily(family: string): ReadonlyArray<string> {
  const idx = ensureCatalogIndex();
  return idx.providersByFamily.get(family) ?? [];
}

/** Whether the given providerId is registered in the catalog. */
export function isCatalogProvider(providerId: string): boolean {
  const idx = ensureCatalogIndex();
  return idx.byProviderId.has(providerId);
}

// ─── Resolution: modelId → ClassifiedModel (DB lookup with cache) ──────────

interface ClassificationCacheEntry {
  readonly classified: ClassifiedModel;
  readonly cachedAtMs: number;
}

const classificationCache = new Map<string, ClassificationCacheEntry>();
const CLASSIFICATION_TTL_MS = 5 * 60_000; // 5 minutes

/** Reset classification cache. Test-only. */
export function _resetClassificationCacheForTests(): void {
  classificationCache.clear();
}

/**
 * Resolve a single modelId to its full classification.
 *
 * Hits the DB on cache miss. Cache TTL = 5min. Returns null if the model
 * is not present in the DB (caller decides — usually means stale arm
 * declaration).
 */
export async function classifyModelById(modelId: string): Promise<ClassifiedModel | null> {
  const cached = classificationCache.get(modelId);
  if (cached && Date.now() - cached.cachedAtMs < CLASSIFICATION_TTL_MS) {
    return cached.classified;
  }

  try {
    const row = await prisma.model.findFirst({
      where: { id: modelId },
      include: { provider: true },
    });

    if (!row) {
      log.debug({ modelId }, 'classifyModelById: model not found in DB');
      return null;
    }

    const providerId = row.provider.name;
    const familyFromCatalog = resolveProviderFamily(providerId);

    // Hub case: catalog says provider is a hub, but the underlying model
    // belongs to another family. Use metadata.originalProvider when present.
    const metadata = (row.metadata as Prisma.JsonValue) as Record<string, unknown> | null;
    const originalProvider = (metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>).originalProvider
      : null);

    const modelFamily =
      typeof originalProvider === 'string' && originalProvider.length > 0
        ? originalProvider.toLowerCase()
        : familyFromCatalog ?? providerId; // fallback: providerId as family

    const capabilities = Array.isArray(row.capabilities)
      ? (row.capabilities as ReadonlyArray<string>)
      : [];

    const inputCostPer1k =
      typeof row.inputCostPer1k === 'number' ? row.inputCostPer1k : Number(row.inputCostPer1k ?? 0);

    const classified: ClassifiedModel = {
      modelId,
      providerId,
      modelFamily,
      contextWindow: row.contextWindow ?? 0,
      capabilities,
      inputCostPer1k,
      capabilityTier: inferCapabilityTier(row.contextWindow, capabilities, inputCostPer1k, providerId),
      isLocal: isOllamaProviderId(providerId),
    };

    classificationCache.set(modelId, { classified, cachedAtMs: Date.now() });
    return classified;
  } catch (err) {
    log.warn(
      { modelId, error: err instanceof Error ? err.message : String(err) },
      'classifyModelById: DB lookup failed',
    );
    return null;
  }
}

/** Classify multiple models in parallel with deduplication. */
export async function classifyModelsByIds(
  modelIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, ClassifiedModel>> {
  const unique = [...new Set(modelIds)];
  const results = await Promise.all(unique.map((id) => classifyModelById(id)));
  const map = new Map<string, ClassifiedModel>();
  for (let i = 0; i < unique.length; i++) {
    const c = results[i];
    if (c) map.set(unique[i]!, c);
  }
  return map;
}

// ─── Synchronous classification from a known input ─────────────────────────

/**
 * Synchronous classification when the caller already has the raw fields.
 * Use only when the input is trusted (fresh from a DB query in the same
 * scope). The async path is preferred.
 */
export function classifyFromFields(input: {
  modelId: string;
  providerId: string;
  contextWindow: number | null | undefined;
  capabilities: ReadonlyArray<string>;
  inputCostPer1k: number | null | undefined;
  metadataOriginalProvider?: string | null;
}): ClassifiedModel {
  const familyFromCatalog = resolveProviderFamily(input.providerId);
  const modelFamily =
    input.metadataOriginalProvider && input.metadataOriginalProvider.length > 0
      ? input.metadataOriginalProvider.toLowerCase()
      : familyFromCatalog ?? input.providerId;

  return {
    modelId: input.modelId,
    providerId: input.providerId,
    modelFamily,
    contextWindow: input.contextWindow ?? 0,
    capabilities: input.capabilities,
    inputCostPer1k: input.inputCostPer1k ?? 0,
    capabilityTier: inferCapabilityTier(
      input.contextWindow,
      input.capabilities,
      input.inputCostPer1k,
      input.providerId,
    ),
    isLocal: isOllamaProviderId(input.providerId),
  };
}
