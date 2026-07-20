// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HCRA Sprint 1 Bootstrap Runner
 *
 * One-shot CLI: seeds the capability ontology, then backfills assertions
 * for every existing model. Idempotent — safe to re-run.
 *
 * Uses raw `pg` (not Prisma) to avoid the Prisma 7 adapter setup overhead
 * for a one-shot script. The seed/backfill modules already use $executeRaw,
 * so the SQL is identical to what Prisma would emit.
 *
 * Usage (local dev):
 *   DATABASE_URL="postgresql://ci_user:ci_password@localhost:5434/ci_db" \
 *     npx tsx scripts/hcra-sprint1-bootstrap.ts
 */

import { Pool } from 'pg';
import { ONTOLOGY_SEED, LEGACY_CAPABILITY_TO_URI } from '../src/capability/ontology/seed';

const URI_PREFIX = 'http://ailin.dev/cap/v1/';
const uri = (slug: string): string => `${URI_PREFIX}${slug}`;

const BACKFILL_ORIGIN = 'sprint1-backfill';
const BACKFILL_CONFIDENCE = 0.2;
const BACKFILL_TTL_DAYS = 90;

async function seedOntology(pool: Pool): Promise<{ upserted: number; edges: number }> {
  for (const entry of ONTOLOGY_SEED) {
    await pool.query(
      `INSERT INTO capability_ontology (
        uri, schema_version, preferred_label, labels, synonyms,
        description, broader, narrower, category, status, updated_at
      ) VALUES ($1, 1, $2, $3::jsonb, $4::text[], $5, ARRAY[]::text[], ARRAY[]::text[], $6, 'active', NOW())
      ON CONFLICT (uri) DO UPDATE SET
        preferred_label = EXCLUDED.preferred_label,
        labels          = EXCLUDED.labels,
        synonyms        = EXCLUDED.synonyms,
        description     = EXCLUDED.description,
        category        = EXCLUDED.category,
        updated_at      = NOW();`,
      [
        uri(entry.slug),
        entry.preferredLabel,
        JSON.stringify(entry.labels),
        entry.synonyms,
        entry.description,
        entry.category,
      ],
    );
  }

  let edges = 0;
  for (const entry of ONTOLOGY_SEED) {
    edges += entry.broader.length + entry.narrower.length;
    await pool.query(
      `UPDATE capability_ontology
       SET broader = $1::text[], narrower = $2::text[], updated_at = NOW()
       WHERE uri = $3;`,
      [entry.broader, entry.narrower, uri(entry.slug)],
    );
  }

  return { upserted: ONTOLOGY_SEED.length, edges };
}

interface BackfillStats {
  modelsProcessed: number;
  modelsSkipped: number;
  assertionsWritten: number;
  unmappedCapabilities: Map<string, number>;
}

async function backfill(pool: Pool): Promise<BackfillStats> {
  const stats: BackfillStats = {
    modelsProcessed: 0,
    modelsSkipped: 0,
    assertionsWritten: 0,
    unmappedCapabilities: new Map(),
  };

  await pool.query(
    `DELETE FROM model_capability_assertions
     WHERE source = 'name-regex' AND source_detail->>'origin' = $1;`,
    [BACKFILL_ORIGIN],
  );

  const BATCH = 500;
  let offset = 0;
  for (;;) {
    const { rows } = await pool.query<{ uid: string; capabilities: unknown }>(
      `SELECT uid, capabilities FROM models ORDER BY uid LIMIT $1 OFFSET $2;`,
      [BATCH, offset],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const legacy = Array.isArray(row.capabilities)
        ? (row.capabilities as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      if (legacy.length === 0) {
        stats.modelsSkipped += 1;
        continue;
      }

      const uris: string[] = [];
      for (const slug of legacy) {
        const u = LEGACY_CAPABILITY_TO_URI[slug];
        if (!u) {
          stats.unmappedCapabilities.set(slug, (stats.unmappedCapabilities.get(slug) ?? 0) + 1);
          continue;
        }
        uris.push(u);
      }
      if (uris.length === 0) {
        stats.modelsSkipped += 1;
        continue;
      }

      await pool.query(
        `INSERT INTO model_capability_assertions (
          model_uid, capability_uri, source, source_detail,
          confidence, asserted_value, observed_at, ttl_days
        )
        SELECT $1, u.uri, 'name-regex', $2::jsonb, $3, TRUE, NOW(), $4
        FROM UNNEST($5::text[]) AS u(uri);`,
        [row.uid, JSON.stringify({ origin: BACKFILL_ORIGIN }), BACKFILL_CONFIDENCE, BACKFILL_TTL_DAYS, uris],
      );

      const sourcesObj: Record<string, string[]> = {};
      const confObj: Record<string, number> = {};
      for (const u of uris) {
        sourcesObj[u] = ['name-regex'];
        confObj[u] = BACKFILL_CONFIDENCE;
      }
      await pool.query(
        `UPDATE models
         SET capability_uris = $1::text[],
             capability_sources = $2::jsonb,
             capability_confidence = $3::jsonb,
             capability_updated_at = NOW()
         WHERE uid = $4;`,
        [uris, JSON.stringify(sourcesObj), JSON.stringify(confObj), row.uid],
      );

      stats.modelsProcessed += 1;
      stats.assertionsWritten += uris.length;
    }

    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  return stats;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const startedAt = Date.now();

  try {
    console.log('[hcra-bootstrap] seeding capability_ontology...');
    const seedStats = await seedOntology(pool);
    console.log(`[hcra-bootstrap] ontology: upserted=${seedStats.upserted} edges=${seedStats.edges}`);

    console.log('[hcra-bootstrap] backfilling model_capability_assertions...');
    const stats = await backfill(pool);
    console.log(
      `[hcra-bootstrap] backfill: models_processed=${stats.modelsProcessed} ` +
        `models_skipped=${stats.modelsSkipped} ` +
        `assertions_written=${stats.assertionsWritten}`,
    );

    if (stats.unmappedCapabilities.size > 0) {
      console.log('[hcra-bootstrap] UNMAPPED capability slugs (add to ONTOLOGY_SEED):');
      const sorted = Array.from(stats.unmappedCapabilities.entries()).sort((a, b) => b[1] - a[1]);
      for (const [slug, count] of sorted) {
        console.log(`  ${slug.padEnd(40)} (in ${count} models)`);
      }
    } else {
      console.log('[hcra-bootstrap] all legacy capabilities mapped to URIs ✓');
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[hcra-bootstrap] done in ${elapsed}s`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[hcra-bootstrap] FAILED:', err);
  process.exit(1);
});
