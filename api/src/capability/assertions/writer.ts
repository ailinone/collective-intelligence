// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability Assertion Writer (ADR-022, Sprint 2)
 *
 * Persists `CapabilitySignal[]` emitted by refactored fetchers into the
 * append-only `model_capability_assertions` table.
 *
 * Supersedence model
 * ------------------
 * Discovery runs every N hours. Each run for a given fetcher emits a fresh
 * full snapshot of that fetcher's view of the model. We do NOT want to
 * accumulate one new row per (model, capability, source) every cycle —
 * that would balloon the table and confuse the freshness decay in the
 * materialiser (multiple "fresh" assertions all backed by the same probe).
 *
 * Strategy: identify a fetcher's prior contribution by
 *   (model_uid, source_detail->>'fetcher')
 * and mark all of those as superseded BEFORE inserting the new batch.
 * `superseded_by` is left NULL because the new rows haven't been INSERTed
 * yet (self-referencing cycle); the supersede timestamp alone is enough
 * for the materialiser's `WHERE superseded_at IS NULL` partial index.
 *
 * Why `source_detail->>'fetcher'` (a JSONB key) instead of a real column:
 * - Avoids a schema migration for what is effectively a versioned origin
 *   discriminator that only the writer/materialiser need.
 * - Keeps the L11-style audit trail intact: source_detail already records
 *   which API field/endpoint produced the claim.
 *
 * URI mapping
 * -----------
 * Fetchers emit ModelCapability slugs (legacy enum values). The writer maps
 * them to canonical URIs via LEGACY_CAPABILITY_TO_URI. Unmapped slugs are
 * dropped with a warning — the seed should cover all 60 known values, so
 * an unmapped slug means the fetcher invented a new one and the ontology
 * needs an entry.
 */

import type { CapabilitySignal } from '@/services/model-capability-merger';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';
import { prisma } from '@/database/client';
import type { PrismaClient } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'assertion-writer' });

export interface ModelAssertionBatch {
  /** Deterministic surrogate PK of the row in `models` (md5-derived). */
  modelUid: string;
  /** Signals emitted by the fetcher for this model. May be empty. */
  signals: readonly CapabilitySignal[];
}

export interface WriteAssertionOptions {
  /**
   * Origin tag, e.g. `"nanogpt-fetcher@v2"`. Used as the supersedence key
   * so re-running the same fetcher invalidates ITS own prior rows without
   * touching rows from other fetchers (helicone oracle, llm extractor, etc.).
   */
  origin: string;
  /** TTL in days — overrides per-source default (used in freshness decay). */
  ttlDays?: number;
}

export interface WriteAssertionStats {
  modelsTouched: number;
  rowsInserted: number;
  rowsSuperseded: number;
  signalsDropped: number;
}

/**
 * Default TTL by source — sources that get re-probed frequently can afford
 * shorter TTLs (less stale data); expensive probes (LLM, oracle) age longer.
 */
const DEFAULT_TTL_DAYS_BY_SOURCE: Readonly<Record<CapabilitySignal['source'], number>> = Object.freeze({
  'provider-declared': 30,
  'helicone-oracle': 30,
  'modality-derived': 60,
  'parameter-derived': 60,
  'name-regex': 90,
});

type PrismaRunner = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

/**
 * Write assertions for a batch of models.
 *
 * The caller typically invokes this immediately after upserting the
 * corresponding rows in `models` (FK target) within the same discovery
 * cycle. We don't wrap in our own transaction by design: the surrounding
 * discovery pipeline already batches Prisma writes, and a partial failure
 * here is recoverable (the next discovery run will supersede + reinsert).
 */
export async function writeAssertions(
  batch: readonly ModelAssertionBatch[],
  opts: WriteAssertionOptions,
  runner: PrismaRunner = prisma,
): Promise<WriteAssertionStats> {
  const stats: WriteAssertionStats = {
    modelsTouched: 0,
    rowsInserted: 0,
    rowsSuperseded: 0,
    signalsDropped: 0,
  };

  if (batch.length === 0) return stats;

  const rows: Array<{
    modelUid: string;
    uri: string;
    source: CapabilitySignal['source'];
    confidence: number;
    detail: Record<string, unknown>;
    ttlDays: number;
  }> = [];

  const touchedModels = new Set<string>();

  for (const { modelUid, signals } of batch) {
    for (const signal of signals) {
      const uri = LEGACY_CAPABILITY_TO_URI[signal.capability];
      if (!uri) {
        stats.signalsDropped += 1;
        log.warn(
          { capability: signal.capability, modelUid, source: signal.source },
          'No URI mapping for capability — dropping assertion. Add to ontology seed.',
        );
        continue;
      }
      rows.push({
        modelUid,
        uri,
        source: signal.source,
        confidence: signal.confidence ?? defaultConfidenceForSource(signal.source),
        detail: { ...(signal.detail ?? {}), fetcher: opts.origin },
        ttlDays: opts.ttlDays ?? DEFAULT_TTL_DAYS_BY_SOURCE[signal.source] ?? 30,
      });
      touchedModels.add(modelUid);
    }
  }

  stats.modelsTouched = touchedModels.size;
  if (rows.length === 0) return stats;

  const uniqueModelUids = Array.from(touchedModels);

  // Step 1 — supersede prior rows from THIS origin for THESE models.
  const supersedeResult = await runner.$executeRawUnsafe(
    `UPDATE model_capability_assertions
     SET superseded_at = NOW()
     WHERE superseded_at IS NULL
       AND model_uid = ANY($1::varchar[])
       AND source_detail->>'fetcher' = $2`,
    uniqueModelUids,
    opts.origin,
  );
  stats.rowsSuperseded = Number(supersedeResult ?? 0);

  // Step 2 — bulk insert fresh rows via UNNEST (single round-trip).
  const insertResult = await runner.$executeRawUnsafe(
    `INSERT INTO model_capability_assertions
       (model_uid, capability_uri, source, source_detail, confidence, ttl_days)
     SELECT * FROM UNNEST(
       $1::varchar[],
       $2::text[],
       $3::text[],
       $4::jsonb[],
       $5::real[],
       $6::int[]
     ) AS t(model_uid, capability_uri, source, source_detail, confidence, ttl_days)`,
    rows.map((r) => r.modelUid),
    rows.map((r) => r.uri),
    rows.map((r) => r.source),
    rows.map((r) => JSON.stringify(r.detail)),
    rows.map((r) => r.confidence),
    rows.map((r) => r.ttlDays),
  );
  stats.rowsInserted = Number(insertResult ?? 0);

  return stats;
}

function defaultConfidenceForSource(source: CapabilitySignal['source']): number {
  switch (source) {
    case 'provider-declared': return 1.0;
    case 'helicone-oracle':   return 0.95;
    case 'modality-derived':  return 0.85;
    case 'parameter-derived': return 0.75;
    case 'name-regex':        return 0.4;
    default:                  return 0.5;
  }
}
