// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * GAP-A12 — REAL-Postgres proof that live discovery populates `capability_uris`.
 *
 * The unit suite (discovery-emitter.test.ts) pins the ablation and the fail-soft
 * behaviour against mocks. This file exists because the gap register's own
 * `validationRequired` says the fix "requires a live Postgres + a real discovery
 * pass to implement and test safely" — mocks cannot prove:
 *
 *   - the `capability_uri` FK onto `capability_ontology` actually accepts what
 *     the emitter produces,
 *   - the writer's supersede-by-origin is genuinely idempotent across repeated
 *     discovery cycles (the failure mode would be unbounded row growth),
 *   - the materialiser then projects those rows into `models.capability_uris`,
 *     which is the column `CapabilitySearchService`'s `requireCaps` filter
 *     queries with `@>` — the whole point of the gap.
 *
 * Run:
 *   DATABASE_URL=postgresql://…/ci_db_track1 \
 *     npx vitest run --config vitest.integration.config.ts \
 *     src/capability/assertions/__tests__/discovery-emitter.integration.test.ts
 *
 * The suite SKIPS (loudly) rather than fails when no Postgres is reachable, so
 * it stays safe in credential-less CI while still being a real proof locally.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  emitDiscoveryAssertions,
  __resetOntologyUriCacheForTests,
  type DiscoveryAssertionModel,
} from '../discovery-emitter';
import { materialiseAllCapabilities } from '../materialiser';
import { ONTOLOGY_SEED } from '@/capability/ontology/seed';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';

const DATABASE_URL = process.env.DATABASE_URL;
const PROVIDER_ID = 'gap-a12-itest-provider';
const URI_PREFIX = 'http://ailin.dev/cap/v1/';

/**
 * Minimal `PrismaRunner` over a pg pool. The emitter and writer only need
 * `$executeRawUnsafe` / `$queryRawUnsafe` with `$n` placeholders, which is
 * exactly pg's own protocol — so this exercises the real SQL (UNNEST insert,
 * supersede UPDATE, ontology SELECT) without dragging the Prisma singleton's
 * boot-time config validation into the test.
 */
function pgRunner(pool: pg.Pool) {
  return {
    $executeRawUnsafe: async (sql: string, ...params: unknown[]): Promise<number> => {
      const res = await pool.query(sql, params as never[]);
      return res.rowCount ?? 0;
    },
    $queryRawUnsafe: async <T>(sql: string, ...params: unknown[]): Promise<T> => {
      const res = await pool.query(sql, params as never[]);
      return res.rows as T;
    },
  };
}

let pool: pg.Pool | undefined;
let reachable = false;

async function canConnect(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  const probe = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await probe.query('SELECT 1');
    await probe.query('SELECT 1 FROM model_capability_assertions LIMIT 0');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

async function seedOntology(p: pg.Pool): Promise<void> {
  for (const entry of ONTOLOGY_SEED) {
    await p.query(
      `INSERT INTO capability_ontology (
         uri, schema_version, preferred_label, labels, synonyms, description,
         broader, narrower, category, status, updated_at
       ) VALUES ($1, 1, $2, $3::jsonb, $4::text[], $5,
                 ARRAY[]::text[], ARRAY[]::text[], $6, 'active', NOW())
       ON CONFLICT (uri) DO NOTHING`,
      [
        `${URI_PREFIX}${entry.slug}`,
        entry.preferredLabel,
        JSON.stringify(entry.labels),
        entry.synonyms,
        entry.description,
        entry.category,
      ]
    );
  }
}

/** Mirrors what `bulkUpsertModels` writes, so the fixture is the real shape. */
async function upsertModel(
  p: pg.Pool,
  uid: string,
  id: string,
  capabilities: string[],
  metadata: Record<string, unknown>
): Promise<void> {
  await p.query(
    `INSERT INTO models (uid, id, provider_id, name, display_name, context_window,
       max_output_tokens, input_cost_per_1k, output_cost_per_1k, capabilities,
       metadata, performance, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,4096,1024,0,0,$6::jsonb,$7::jsonb,'{}'::jsonb,'active',NOW())
     ON CONFLICT (uid) DO UPDATE SET capabilities = EXCLUDED.capabilities,
                                     metadata = EXCLUDED.metadata,
                                     capability_uris = '{}'::text[],
                                     updated_at = NOW()`,
    [uid, id, PROVIDER_ID, id, id, JSON.stringify(capabilities), JSON.stringify(metadata)]
  );
}

async function cleanupFixtures(p: pg.Pool): Promise<void> {
  // model_capability_assertions cascades from models; models cascades from providers.
  await p.query('DELETE FROM providers WHERE id = $1', [PROVIDER_ID]);
}

beforeAll(async () => {
  reachable = await canConnect();
  if (!reachable) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await seedOntology(pool);
  await cleanupFixtures(pool);
  await pool.query(
    `INSERT INTO providers (id, name, display_name, status, updated_at)
     VALUES ($1, $2, $3, 'active', NOW()) ON CONFLICT (id) DO NOTHING`,
    [PROVIDER_ID, PROVIDER_ID, PROVIDER_ID]
  );
}, 120_000);

afterAll(async () => {
  if (pool) {
    await cleanupFixtures(pool).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
});

beforeEach(() => {
  __resetOntologyUriCacheForTests();
});

const suite = describe.skipIf(!DATABASE_URL);

suite('GAP-A12 · discovery assertions against a real Postgres', () => {
  it('reaches a database with the HCRA schema (guard — otherwise nothing below proves anything)', () => {
    expect(
      reachable,
      `DATABASE_URL is set but unreachable or missing model_capability_assertions: ${DATABASE_URL}`
    ).toBe(true);
  });

  it('writes assertions with real per-capability source attribution', async () => {
    if (!reachable || !pool) return;
    const uid = 'a12itest0000000000000000001';
    await upsertModel(
      pool,
      uid,
      'itest/vision-declared',
      ['chat', 'vision', 'reasoning'],
      { input_modalities: ['text', 'image'], capabilities: ['chat'] }
    );

    const models: DiscoveryAssertionModel[] = [
      {
        modelUid: uid,
        signal: {
          modelId: 'itest/vision-declared',
          finalCapabilities: ['chat', 'vision', 'reasoning'],
          declaredCapabilities: ['chat'],
          metadata: { capabilities: ['chat'], input_modalities: ['text', 'image'] },
        },
      },
    ];

    const stats = await emitDiscoveryAssertions(models, {
      sourceName: 'itest-source',
      providerId: PROVIDER_ID,
      runner: pgRunner(pool) as never,
    });

    expect(stats.skipped).toBeNull();
    expect(stats.rowsInserted).toBe(3);
    expect(stats.signalsDroppedUnknownUri).toBe(0);
    expect(stats.signalsDroppedUnmapped).toBe(0);

    const { rows } = await pool.query<{ capability_uri: string; source: string }>(
      `SELECT capability_uri, source FROM model_capability_assertions
       WHERE model_uid = $1 AND superseded_at IS NULL ORDER BY capability_uri`,
      [uid]
    );
    const bySource = Object.fromEntries(rows.map((r) => [r.capability_uri, r.source]));

    expect(bySource[LEGACY_CAPABILITY_TO_URI.chat]).toBe('provider-declared');
    expect(bySource[LEGACY_CAPABILITY_TO_URI.vision]).toBe('modality-derived');
    expect(bySource[LEGACY_CAPABILITY_TO_URI.reasoning]).toBe('name-regex');
  });

  it('is idempotent across repeated discovery cycles — no unbounded row growth', async () => {
    if (!reachable || !pool) return;
    const uid = 'a12itest0000000000000000002';
    await upsertModel(pool, uid, 'itest/idempotent', ['chat'], {});

    const models: DiscoveryAssertionModel[] = [
      {
        modelUid: uid,
        signal: {
          modelId: 'itest/idempotent',
          finalCapabilities: ['chat'],
          declaredCapabilities: ['chat'],
          metadata: { capabilities: ['chat'] },
        },
      },
    ];
    const opts = {
      sourceName: 'itest-source',
      providerId: PROVIDER_ID,
      runner: pgRunner(pool) as never,
    };

    await emitDiscoveryAssertions(models, opts);
    __resetOntologyUriCacheForTests();
    const second = await emitDiscoveryAssertions(models, opts);

    // Second cycle supersedes the first cycle's row before inserting its own.
    expect(second.rowsSuperseded).toBe(1);

    const active = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_capability_assertions
       WHERE model_uid = $1 AND superseded_at IS NULL`,
      [uid]
    );
    expect(active.rows[0]?.n).toBe('1');
  });

  it('keeps a second discovery source as INDEPENDENT evidence rather than clobbering the first', async () => {
    if (!reachable || !pool) return;
    const uid = 'a12itest0000000000000000003';
    await upsertModel(pool, uid, 'itest/two-sources', ['chat'], {});

    const models: DiscoveryAssertionModel[] = [
      {
        modelUid: uid,
        signal: {
          modelId: 'itest/two-sources',
          finalCapabilities: ['chat'],
          declaredCapabilities: ['chat'],
          metadata: { capabilities: ['chat'] },
        },
      },
    ];
    const base = { providerId: PROVIDER_ID, runner: pgRunner(pool) as never };

    await emitDiscoveryAssertions(models, { ...base, sourceName: 'source-a' });
    __resetOntologyUriCacheForTests();
    await emitDiscoveryAssertions(models, { ...base, sourceName: 'source-b' });

    const { rows } = await pool.query<{ fetcher: string }>(
      `SELECT source_detail->>'fetcher' AS fetcher FROM model_capability_assertions
       WHERE model_uid = $1 AND superseded_at IS NULL ORDER BY 1`,
      [uid]
    );
    expect(rows.map((r) => r.fetcher)).toEqual([
      'discovery:source-a@v1',
      'discovery:source-b@v1',
    ]);
  });

  it('END-TO-END: assertions written by discovery materialise into models.capability_uris', async () => {
    if (!reachable || !pool) return;
    const uid = 'a12itest0000000000000000004';
    await upsertModel(pool, uid, 'itest/e2e-projection', ['chat', 'vision'], {
      input_modalities: ['text', 'image'],
    });

    // Precondition: this is the state GAP-A12 describes — a model discovery has
    // persisted, whose canonical capability projection is still empty.
    const before = await pool.query<{ capability_uris: string[] }>(
      'SELECT capability_uris FROM models WHERE uid = $1',
      [uid]
    );
    expect(before.rows[0]?.capability_uris).toEqual([]);

    await emitDiscoveryAssertions(
      [
        {
          modelUid: uid,
          signal: {
            modelId: 'itest/e2e-projection',
            finalCapabilities: ['chat', 'vision'],
            declaredCapabilities: ['chat', 'vision'],
            metadata: { capabilities: ['chat', 'vision'], input_modalities: ['text', 'image'] },
          },
        },
      ],
      { sourceName: 'itest-source', providerId: PROVIDER_ID, runner: pgRunner(pool) as never }
    );

    await materialiseAllCapabilities(pool);

    const after = await pool.query<{
      capability_uris: string[];
      capability_confidence: Record<string, number>;
      capability_sources: Record<string, string[]>;
    }>(
      'SELECT capability_uris, capability_confidence, capability_sources FROM models WHERE uid = $1',
      [uid]
    );
    const row = after.rows[0];

    expect(row?.capability_uris).toContain(LEGACY_CAPABILITY_TO_URI.chat);
    expect(row?.capability_uris).toContain(LEGACY_CAPABILITY_TO_URI.vision);
    // provider-declared (weight 0.95 × confidence 1.0) must land high, not at
    // the name-regex noise floor.
    expect(row?.capability_confidence?.[LEGACY_CAPABILITY_TO_URI.chat]).toBeGreaterThan(0.5);
    expect(row?.capability_sources?.[LEGACY_CAPABILITY_TO_URI.chat]).toContain(
      'provider-declared'
    );
  });

  it('GAP-A13: an empirical probe verdict is promoted into capability_uris', async () => {
    if (!reachable || !pool) return;
    const { recordProbeAssertion } = await import('../probe-emitter');
    const uid = 'a12itest0000000000000000005';
    // A model whose catalog/discovery evidence says NOTHING about tools —
    // exactly the case the selector defers to the runtime probe.
    await upsertModel(pool, uid, 'itest/tools-unknown', ['chat'], { capabilities: ['chat'] });

    const before = await pool.query<{ caps: string[] }>(
      'SELECT capability_uris AS caps FROM models WHERE uid = $1',
      [uid]
    );
    expect(before.rows[0]?.caps ?? []).not.toContain(
      LEGACY_CAPABILITY_TO_URI.function_calling
    );

    const outcome = await recordProbeAssertion({
      providerId: PROVIDER_ID,
      modelId: 'itest/tools-unknown',
      capability: 'function_calling',
      supported: true,
      runner: pgRunner(pool) as never,
    });
    expect(outcome).toBe('written');

    // The DB must actually accept the new source value (chk_mca_source).
    const assertion = await pool.query<{ source: string; asserted_value: boolean }>(
      `SELECT source, asserted_value FROM model_capability_assertions
        WHERE model_uid = $1 AND superseded_at IS NULL`,
      [uid]
    );
    expect(assertion.rows[0]?.source).toBe('runtime-probe');
    expect(assertion.rows[0]?.asserted_value).toBe(true);

    await materialiseAllCapabilities(pool);

    const after = await pool.query<{
      caps: string[];
      conf: Record<string, number>;
      sources: Record<string, string[]>;
    }>(
      `SELECT capability_uris AS caps, capability_confidence AS conf,
              capability_sources AS sources FROM models WHERE uid = $1`,
      [uid]
    );
    // This is the promotion: a demonstrated capability now satisfies the
    // ordinary fail-closed hard filter, with no catalog `tools` flag involved.
    expect(after.rows[0]?.caps).toContain(LEGACY_CAPABILITY_TO_URI.function_calling);
    expect(
      after.rows[0]?.conf?.[LEGACY_CAPABILITY_TO_URI.function_calling]
    ).toBeGreaterThan(0.9);
    expect(after.rows[0]?.sources?.[LEGACY_CAPABILITY_TO_URI.function_calling]).toContain(
      'runtime-probe'
    );
  });

  it('GAP-A13: re-probing the same model supersedes rather than accumulates', async () => {
    if (!reachable || !pool) return;
    const { recordProbeAssertion } = await import('../probe-emitter');
    const uid = 'a12itest0000000000000000006';
    await upsertModel(pool, uid, 'itest/reprobed', ['chat'], { capabilities: ['chat'] });

    const opts = {
      providerId: PROVIDER_ID,
      modelId: 'itest/reprobed',
      capability: 'function_calling',
      runner: pgRunner(pool) as never,
    };
    await recordProbeAssertion({ ...opts, supported: true });
    await recordProbeAssertion({ ...opts, supported: false });

    const rows = await pool.query<{ n: string; asserted_value: boolean }>(
      `SELECT count(*)::text AS n, bool_and(asserted_value) AS asserted_value
         FROM model_capability_assertions
        WHERE model_uid = $1 AND superseded_at IS NULL`,
      [uid]
    );
    expect(rows.rows[0]?.n).toBe('1');
    // The LATEST verdict is the one left active.
    expect(rows.rows[0]?.asserted_value).toBe(false);
  });

  it('the projection is queryable by the `@>` containment filter capability search uses', async () => {
    if (!reachable || !pool) return;
    // This is the actual failure GAP-A12 describes: `requireCaps` does
    // `capability_uris @> $n::text[]`, and containment against an empty array
    // never matches — so a model discovered after the last manual backfill was
    // invisible to capability search no matter what it could do.
    const { rows } = await pool.query<{ uid: string }>(
      `SELECT uid FROM models
       WHERE provider_id = $1 AND capability_uris @> $2::text[]`,
      [PROVIDER_ID, [LEGACY_CAPABILITY_TO_URI.vision]]
    );
    expect(rows.map((r) => r.uid)).toContain('a12itest0000000000000000004');
  });
});
