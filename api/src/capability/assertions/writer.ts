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
 * Idempotency (2026-09-20 fix)
 * ----------------------------
 * The strategy above describes the *intent* but the original implementation
 * didn't actually check whether anything changed before superseding+
 * reinserting — every run reasserted the fetcher's entire snapshot
 * unconditionally. With `model-discovery-hourly` running every 60 minutes,
 * that grew `model_capability_assertions` from ~0 to 62.8M rows in 13 days
 * (99.66% superseded dead weight; root-caused to commit e21b464f, "wire
 * HCRA assertions into live discovery"). Before superseding+inserting, we
 * now compare each new signal against the currently-active assertion for
 * the same (model_uid, capability_uri, source): if confidence and
 * assertedValue are unchanged, we only touch `observed_at` on the existing
 * row (resets freshness decay, zero table growth) instead of superseding
 * and inserting a new one. Only a genuine change or a brand-new triple goes
 * through the supersede+insert path.
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
  /**
   * Polarity of every claim in this batch. Defaults to `true` ("the model HAS
   * this capability"), which is what discovery and every backfill emit.
   *
   * `false` records a NEGATIVE observation — currently only written by the
   * runtime capability probe, which can prove a model rejects tool-calling.
   * Note the materialiser does not yet consume negation (its noisy-OR fuses
   * positive evidence only, and its own header flags decisive negation as
   * "Sprint 3+ wiring"), so a `false` row is an audit-trail and
   * cross-validation record today, not a suppression signal. It is written
   * anyway because the observation is real and discarding it would leave the
   * probe's most decisive verdict unrecorded.
   */
  assertedValue?: boolean;
}

export interface WriteAssertionStats {
  modelsTouched: number;
  rowsInserted: number;
  rowsSuperseded: number;
  /** Rows whose observed_at was refreshed in place because nothing changed. */
  rowsTouched: number;
  signalsDropped: number;
}

/**
 * Default TTL by source — sources that get re-probed frequently can afford
 * shorter TTLs (less stale data); expensive probes (LLM, oracle) age longer.
 */
const DEFAULT_TTL_DAYS_BY_SOURCE: Readonly<Record<CapabilitySignal['source'], number>> =
  Object.freeze({
    'provider-declared': 30,
    'helicone-oracle': 30,
    'modality-derived': 60,
    'parameter-derived': 60,
    'name-regex': 90,
    // Matches the function-calling probe's own 7-day Redis TTL. An empirical
    // verdict is the freshest evidence we have, but it is also the most
    // perishable — a provider can enable tool-calling on a model between two
    // probes — so it ages out on the same clock the probe itself uses.
    'runtime-probe': 7,
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
  runner: PrismaRunner = prisma
): Promise<WriteAssertionStats> {
  const stats: WriteAssertionStats = {
    modelsTouched: 0,
    rowsInserted: 0,
    rowsSuperseded: 0,
    rowsTouched: 0,
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
          'No URI mapping for capability — dropping assertion. Add to ontology seed.'
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
  const assertedValue = opts.assertedValue ?? true;

  // Fetch this origin's currently-active contribution for these models so
  // we can skip rows that haven't actually changed (see idempotency note
  // in the module docstring above).
  const activeRows = (await runner.$queryRawUnsafe(
    `SELECT model_uid, capability_uri, source, confidence, asserted_value
     FROM model_capability_assertions
     WHERE superseded_at IS NULL
       AND model_uid = ANY($1::varchar[])
       AND source_detail->>'fetcher' = $2`,
    uniqueModelUids,
    opts.origin
  )) as Array<{
    model_uid: string;
    capability_uri: string;
    source: string;
    confidence: number;
    asserted_value: boolean;
  }>;

  const activeByKey = new Map<string, { confidence: number; assertedValue: boolean }>();
  for (const row of activeRows) {
    activeByKey.set(assertionKey(row.model_uid, row.capability_uri, row.source), {
      confidence: row.confidence,
      assertedValue: row.asserted_value,
    });
  }

  const unchangedRows: typeof rows = [];
  const changedRows: typeof rows = [];
  for (const row of rows) {
    const active = activeByKey.get(assertionKey(row.modelUid, row.uri, row.source));
    const isUnchanged =
      active !== undefined &&
      active.assertedValue === assertedValue &&
      Math.abs(active.confidence - row.confidence) < CONFIDENCE_EPSILON;
    (isUnchanged ? unchangedRows : changedRows).push(row);
  }

  // Unchanged: just refresh observed_at so freshness decay resets without
  // growing the table (no supersede, no new row).
  if (unchangedRows.length > 0) {
    const touchResult = await runner.$executeRawUnsafe(
      `UPDATE model_capability_assertions
       SET observed_at = NOW()
       WHERE superseded_at IS NULL
         AND source_detail->>'fetcher' = $1
         AND (model_uid, capability_uri, source) IN (
           SELECT * FROM UNNEST($2::varchar[], $3::text[], $4::text[])
         )`,
      opts.origin,
      unchangedRows.map((r) => r.modelUid),
      unchangedRows.map((r) => r.uri),
      unchangedRows.map((r) => r.source)
    );
    stats.rowsTouched = Number(touchResult ?? 0);
  }

  if (changedRows.length === 0) return stats;

  // Step 1 — supersede prior rows for THESE (model, capability, source)
  // triples only — scoped, not a blanket supersede of every row this
  // origin has ever touched (that would also catch the unchanged ones).
  const supersedeResult = await runner.$executeRawUnsafe(
    `UPDATE model_capability_assertions
     SET superseded_at = NOW()
     WHERE superseded_at IS NULL
       AND source_detail->>'fetcher' = $1
       AND (model_uid, capability_uri, source) IN (
         SELECT * FROM UNNEST($2::varchar[], $3::text[], $4::text[])
       )`,
    opts.origin,
    changedRows.map((r) => r.modelUid),
    changedRows.map((r) => r.uri),
    changedRows.map((r) => r.source)
  );
  stats.rowsSuperseded = Number(supersedeResult ?? 0);

  // Step 2 — bulk insert fresh rows via UNNEST (single round-trip).
  const insertResult = await runner.$executeRawUnsafe(
    `INSERT INTO model_capability_assertions
       (model_uid, capability_uri, source, source_detail, confidence, ttl_days, asserted_value)
     SELECT *, $7::boolean FROM UNNEST(
       $1::varchar[],
       $2::text[],
       $3::text[],
       $4::jsonb[],
       $5::real[],
       $6::int[]
     ) AS t(model_uid, capability_uri, source, source_detail, confidence, ttl_days)`,
    changedRows.map((r) => r.modelUid),
    changedRows.map((r) => r.uri),
    changedRows.map((r) => r.source),
    changedRows.map((r) => JSON.stringify(r.detail)),
    changedRows.map((r) => r.confidence),
    changedRows.map((r) => r.ttlDays),
    assertedValue
  );
  stats.rowsInserted = Number(insertResult ?? 0);

  return stats;
}

/** Float confidence round-trips through Postgres `real` (float4); tolerate rounding. */
const CONFIDENCE_EPSILON = 1e-6;

function assertionKey(modelUid: string, capabilityUri: string, source: string): string {
  return `${modelUid} ${capabilityUri} ${source}`;
}

function defaultConfidenceForSource(source: CapabilitySignal['source']): number {
  switch (source) {
    case 'runtime-probe':
      return 1.0;
    case 'provider-declared':
      return 1.0;
    case 'helicone-oracle':
      return 0.95;
    case 'modality-derived':
      return 0.85;
    case 'parameter-derived':
      return 0.75;
    case 'name-regex':
      return 0.4;
    default:
      return 0.5;
  }
}
