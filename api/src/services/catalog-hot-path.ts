// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { Prisma } from '@/generated/prisma/index.js';
import type { Model } from '@/types';

// ── Phase 6 Fix 2: catalog hot-path field allowlist ──────────────────
// The catalog cache loads ALL non-disabled rows (~64k) every 60s. Without
// a select clause, Prisma loaded every column including heavy JSONB
// (capabilitySources, capabilityConfidence) and the capabilityUris array
// — ~100MB wire payload that mapPrismaModel never reads. Production runs
// observed 13.9s for this query while EXPLAIN ANALYZE projected 7.9ms,
// confirming wire-size + JSON-parse as the bottleneck (not the index).
//
// CATALOG_HOT_PATH_SELECT enforces a closed allowlist: any field added to
// mapPrismaModel below MUST also be added here, and vice versa. The
// invariant test in __tests__/model-catalog-service-select.test.ts asserts
// this by checking that every read in mapPrismaModel has a matching key.
//
// Why allowlist (select:) instead of omit:? The codebase has a history of
// adding heavy JSONB/array columns to Model (capabilityUris 2026-04-20,
// lifecycleStatus 2026-04-24, capabilityConfidence 2026-04-22). An omit:
// list would silently re-regress every time a heavy column is added.
// select: forces every schema migration to confront the catalog cost.
//
// EXTRACTED from model-catalog-service.ts (2026-09, SAB candidate-index
// work) into its own module specifically so it can be imported WITHOUT
// pulling in `@/database/client` — that module eagerly constructs the
// shared, production-sized PrismaClient connection pool as a MODULE-LOAD
// side effect (`let prismaInstance: PrismaClient = global.__prisma ??
// createPrismaClient();` at top level), which is exactly the wrong thing to
// happen a second time inside a worker_threads worker that deliberately
// wants its OWN small, dedicated pool (see
// `core/selection/sab-candidate-index/worker.ts`'s module doc for the full
// reasoning). model-catalog-service.ts re-exports these three symbols for
// backward compatibility — nothing about its own behavior changes.
export const CATALOG_HOT_PATH_SELECT = {
  id: true,
  providerId: true,
  name: true,
  displayName: true,
  contextWindow: true,
  maxOutputTokens: true,
  inputCostPer1k: true,
  outputCostPer1k: true,
  capabilities: true,
  performance: true,
  status: true,
  metadata: true,
  lastSyncedAt: true,
  provider: { select: { name: true } },
} as const satisfies Prisma.ModelSelect;

export type CatalogHotPathRecord = Prisma.ModelGetPayload<{ select: typeof CATALOG_HOT_PATH_SELECT }>;

export function mapPrismaModel(record: CatalogHotPathRecord): Model {
  // Handle Prisma Json field - can be array, object with 'set' property, or other formats
  let capabilities: string[] = [];
  if (Array.isArray(record.capabilities)) {
    capabilities = record.capabilities as string[];
  } else if (record.capabilities && typeof record.capabilities === 'object') {
    const capabilitiesObj = record.capabilities as Record<string, unknown>;
    if (Array.isArray(capabilitiesObj.set)) {
      capabilities = capabilitiesObj.set as string[];
    }
  }

  const rawPerformance = (record.performance as Record<string, unknown> | null) ?? {};
  const performance = {
    latencyMs: Number(rawPerformance.latencyMs ?? 0),
    throughput: Number(rawPerformance.throughput ?? 0),
    quality: Number(rawPerformance.quality ?? 0),
    reliability: Number(rawPerformance.reliability ?? 0),
  } satisfies Model['performance'];

  // SOTA dynamic-discovery (2026-04-27): merge the Prisma row's `lastSyncedAt`
  // into the model metadata so downstream consumers (notably /v1/models) can
  // surface `discoveryTimestamp` without a Model-interface schema change.
  // The fetcher-supplied `discoverySource` is already persisted inside
  // metadata at write time (central-model-discovery-service.ts).
  const baseMetadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : undefined;

  const metadataWithSyncStamp: Record<string, unknown> | undefined =
    record.lastSyncedAt instanceof Date
      ? { ...(baseMetadata ?? {}), lastSyncedAt: record.lastSyncedAt.toISOString() }
      : baseMetadata;

  return {
    id: record.id,
    providerId: record.providerId,
    provider: record.provider.name,
    name: record.name,
    displayName: record.displayName,
    contextWindow: record.contextWindow,
    maxOutputTokens: record.maxOutputTokens,
    inputCostPer1k: Number(record.inputCostPer1k),
    outputCostPer1k: Number(record.outputCostPer1k),
    capabilities: capabilities as Model['capabilities'],
    performance,
    status: (record.status as Model['status']) ?? 'active',
    metadata: metadataWithSyncStamp,
  };
}

/**
 * Fleet-wide Redis key the elected `catalog-cache-refresh` BullMQ job
 * publishes the full mapped catalog snapshot to (see
 * model-catalog-service.ts's `publishCatalogSnapshotToRedis`/
 * `hydrateCatalogCacheFromRedis`). The SAB candidate-index worker
 * (`sab-candidate-index/worker.ts`) reads the SAME key as its own
 * Redis-first fetch source, so it never independently multiplies the
 * fleet-wide "every replica hits Postgres" query this key's own election
 * mechanism exists to prevent — see that worker's module doc.
 */
export const CATALOG_REDIS_KEY = 'catalog:hot-path:snapshot:v1';

/**
 * Small companion key published right AFTER the snapshot above by the same
 * elected process. Readers fetch this (a few hundred bytes) before deciding
 * whether to GET + JSON.parse the >100 MB snapshot at all: the elected job
 * republishes every tick whether or not anything changed, so a timestamp
 * or version counter would never let a reader skip; only a fingerprint of
 * the published CONTENT can. Lives here (not in model-catalog-service.ts) so
 * the SAB candidate-index worker can reuse it without importing
 * `@/database/client` (same reason CATALOG_REDIS_KEY lives here).
 */
export const CATALOG_REDIS_META_KEY = `${CATALOG_REDIS_KEY}:meta`;

export interface CatalogSnapshotMeta {
  /** sha256 over the snapshot's rows, order-insensitive (see
   *  model-catalog-service.ts's serializeCatalogSnapshot for why). */
  fingerprint: string;
  rowCount: number;
  generatedAt: number;
}

/** null for an absent or malformed payload: callers treat both as "changed",
 *  which keeps a reader on this version compatible with a producer that still
 *  publishes only the bare snapshot. */
export function parseCatalogSnapshotMeta(raw: string | null): CatalogSnapshotMeta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const { fingerprint, rowCount, generatedAt } = parsed as Record<string, unknown>;
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) return null;
    if (typeof rowCount !== 'number' || !Number.isFinite(rowCount)) return null;
    if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt)) return null;
    return { fingerprint, rowCount, generatedAt };
  } catch {
    return null;
  }
}
