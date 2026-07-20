// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * HCRA Ontology Reseed (idempotent, NO backfill)
 *
 * Re-runs the ontology UPSERT + broader/narrower edge refresh so that
 * additions to ONTOLOGY_SEED (new concepts, new reverse edges) propagate
 * into `capability_ontology`. Unlike hcra-sprint1-bootstrap, this does NOT
 * touch model_capability_assertions — fetchers remain the source of truth
 * for assertions, and the materialiser reconstructs the projection.
 *
 * Usage:
 *   DATABASE_URL="postgresql://ci_user:ci_password@localhost:5434/ci_db" \
 *     npx tsx scripts/hcra-reseed-ontology.ts
 */

import { Pool } from 'pg';
import { ONTOLOGY_SEED } from '../src/capability/ontology/seed';

const URI_PREFIX = 'http://ailin.dev/cap/v1/';
const uri = (slug: string): string => `${URI_PREFIX}${slug}`;

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const startedAt = Date.now();
  try {
    console.log(`[hcra-reseed] upserting ${ONTOLOGY_SEED.length} ontology entries...`);
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

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log(
      `[hcra-reseed] done in ${elapsedSec}s — upserted=${ONTOLOGY_SEED.length} edges=${edges}`,
    );

    const { rows: agentsCheck } = await pool.query<{ broader: string[]; narrower: string[] }>(
      `SELECT broader, narrower FROM capability_ontology WHERE uri = $1;`,
      [uri('agents')],
    );
    const { rows: toolUseCheck } = await pool.query<{ narrower: string[] }>(
      `SELECT narrower FROM capability_ontology WHERE uri = $1;`,
      [uri('tool_use')],
    );
    const { rows: codingCheck } = await pool.query<{ narrower: string[] }>(
      `SELECT narrower FROM capability_ontology WHERE uri = $1;`,
      [uri('coding')],
    );
    console.log('[hcra-reseed] sanity:');
    console.log('  agents.broader        =', agentsCheck[0]?.broader);
    console.log('  tool_use.narrower (has agents?) =', toolUseCheck[0]?.narrower?.includes(uri('agents')));
    console.log('  coding.narrower   (has testing?)=', codingCheck[0]?.narrower?.includes(uri('testing')));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[hcra-reseed] FAILED:', err);
  process.exit(1);
});
