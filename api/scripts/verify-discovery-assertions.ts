// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GAP-A12 live verification — proves that a REAL discovery pass populates the
 * HCRA capability projection, with no manual backfill script in the loop.
 *
 * This is the repeatable form of the evidence the gap register asks for. It
 * runs the production code path end to end:
 *
 *   CentralModelDiscoveryService.discoverFromSource(<source>)
 *     → bulkUpsertModels()            (models land in `models`)
 *     → emitDiscoveryAssertions()     (GAP-A12 — the link that was missing)
 *     → materialiseAllCapabilities()  (projection into models.capability_uris)
 *     → `capability_uris @> ARRAY[...]`  (the query capability search performs)
 *
 * and asserts, against the database, that a provider touched by discovery ends
 * the run with a non-empty projection. Before GAP-A12 this script would report
 * `assertionsAfter = 0` for every provider onboarded after the last manual
 * backfill.
 *
 * Usage:
 *   DATABASE_URL=postgresql://…  OPENAI_API_KEY=…  TEST_MOCK_PROVIDERS=false \
 *     npx tsx scripts/verify-discovery-assertions.ts catalog-openai catalog-anthropic
 *
 * With no arguments it lists the discovery sources that are actually
 * registered (which depends on which credentials are present) and exits — use
 * that to pick a source rather than guessing a name.
 *
 * Exit code is non-zero if a requested source discovered models but produced
 * no assertions, so this is usable as a CI gate once credentials exist.
 */

import { Pool } from 'pg';
import { getCentralModelDiscoveryService } from '../src/services/central-model-discovery-service';
import { materialiseAllCapabilities } from '../src/capability/assertions/materialiser';

interface ProviderSnapshot {
  models: number;
  assertions: number;
  modelsWithUris: number;
}

async function snapshot(pool: Pool, providerIds: readonly string[]): Promise<ProviderSnapshot> {
  if (providerIds.length === 0) return { models: 0, assertions: 0, modelsWithUris: 0 };
  const { rows } = await pool.query<{ models: string; assertions: string; with_uris: string }>(
    `SELECT
       (SELECT count(*) FROM models WHERE provider_id = ANY($1::varchar[]))::text AS models,
       (SELECT count(*) FROM model_capability_assertions a
          JOIN models m ON m.uid = a.model_uid
         WHERE m.provider_id = ANY($1::varchar[])
           AND a.superseded_at IS NULL
           AND a.source_detail->>'fetcher' LIKE 'discovery:%')::text AS assertions,
       (SELECT count(*) FROM models
         WHERE provider_id = ANY($1::varchar[])
           AND array_length(capability_uris, 1) > 0)::text AS with_uris`,
    [providerIds as string[]]
  );
  const r = rows[0];
  return {
    models: Number(r?.models ?? 0),
    assertions: Number(r?.assertions ?? 0),
    modelsWithUris: Number(r?.with_uris ?? 0),
  };
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let failures = 0;

  try {
    const ontology = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM capability_ontology'
    );
    const ontologyRows = Number(ontology.rows[0]?.n ?? 0);
    console.log(`[verify] capability_ontology rows: ${ontologyRows}`);
    if (ontologyRows === 0) {
      console.error(
        '[verify] FATAL: ontology is empty — every assertion would be dropped by the FK guard.\n' +
          '         Run: npx tsx scripts/hcra-reseed-ontology.ts'
      );
      process.exitCode = 1;
      return;
    }

    const service = await getCentralModelDiscoveryService();
    const stats = await service.getStats();
    const available = Object.keys(stats.providersBySource).sort();

    if (requested.length === 0) {
      console.log(`[verify] ${available.length} discovery sources registered:`);
      for (const name of available) {
        console.log(`  - ${name}  → providers: ${stats.providersBySource[name]?.join(', ')}`);
      }
      console.log('\n[verify] re-run with one or more source names to probe them.');
      return;
    }

    for (const sourceName of requested) {
      const providerIds = stats.providersBySource[sourceName] ?? [];
      if (!available.includes(sourceName)) {
        console.error(`[verify] source '${sourceName}' is NOT registered — skipping.`);
        failures += 1;
        continue;
      }

      const before = await snapshot(pool, providerIds);
      console.log(
        `\n[verify] ── ${sourceName} (providers: ${providerIds.join(', ') || 'none declared'})`
      );
      console.log(
        `[verify] before: models=${before.models} discovery-assertions=${before.assertions} models-with-uris=${before.modelsWithUris}`
      );

      const started = Date.now();
      const result = await service.discoverFromSource(sourceName);
      const elapsed = Date.now() - started;

      if (!result) {
        console.error(`[verify] discovery returned null for '${sourceName}' (see logs above).`);
        failures += 1;
        continue;
      }
      console.log(
        `[verify] discovered=${result.modelsDiscovered} new=${result.modelsNew} updated=${result.modelsUpdated} in ${elapsed}ms` +
          (result.errors.length ? ` errors=${result.errors.length}` : '')
      );

      const afterWrite = await snapshot(pool, providerIds);
      console.log(`[verify] after discovery: discovery-assertions=${afterWrite.assertions}`);

      const m = await materialiseAllCapabilities(pool);
      console.log(
        `[verify] materialise: modelsWritten=${m.modelsWritten} capabilitiesEmitted=${m.capabilitiesEmitted} in ${m.elapsedMs}ms`
      );

      const after = await snapshot(pool, providerIds);
      console.log(
        `[verify] after: models=${after.models} discovery-assertions=${after.assertions} models-with-uris=${after.modelsWithUris}`
      );

      if (result.modelsDiscovered > 0 && after.assertions === 0) {
        console.error(
          `[verify] FAIL: '${sourceName}' discovered ${result.modelsDiscovered} models but wrote ZERO discovery assertions — GAP-A12 is not closed for this path.`
        );
        failures += 1;
      } else if (result.modelsDiscovered > 0 && after.modelsWithUris === 0) {
        console.error(
          `[verify] FAIL: assertions exist but no model has a materialised capability_uris projection.`
        );
        failures += 1;
      } else if (result.modelsDiscovered > 0) {
        const sample = await pool.query<{ id: string; caps: string[] }>(
          `SELECT id, capability_uris AS caps FROM models
            WHERE provider_id = ANY($1::varchar[]) AND array_length(capability_uris, 1) > 0
            ORDER BY updated_at DESC LIMIT 3`,
          [providerIds as string[]]
        );
        for (const row of sample.rows) {
          console.log(`[verify]   sample ${row.id} → ${row.caps.length} capability URIs`);
        }
        console.log(`[verify] PASS: ${sourceName}`);
      } else {
        console.log(`[verify] SKIP verdict: source discovered 0 models (no credential?).`);
      }
    }
  } finally {
    await pool.end().catch(() => undefined);
  }

  if (failures > 0) {
    console.error(`\n[verify] ${failures} source(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\n[verify] all requested sources verified.');
  }
}

main().catch((err) => {
  console.error('[verify] FAILED:', err);
  process.exit(1);
});
