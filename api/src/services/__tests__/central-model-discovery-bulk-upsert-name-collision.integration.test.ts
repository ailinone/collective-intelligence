// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for a real production incident (ci_worker logs,
 * 2026-09-04, component `central-discovery`): bulkUpsertModels' raw-SQL
 * `INSERT ... ON CONFLICT (uid) DO UPDATE` only arbitrates Postgres unique
 * violations on the `uid` primary key (models_pkey). `models` carries a
 * SECOND unique constraint, `models_provider_id_name_key`
 * (`@@unique([providerId, name])` in schema.prisma), that the same ON
 * CONFLICT clause cannot see — a single INSERT statement may only nominate
 * one arbiter.
 *
 * In production, two DIFFERENT discovered ids under the SAME provider
 * legitimately landing on the SAME `name` (a hub/aggregator re-listing a
 * model under a new id, or an upstream rename) — surfaced concurrently
 * either by two discovery sources racing inside the same
 * discoverAllModels() Promise.all, or by two ci_api replicas whose
 * independent at-boot discovery runs overlapped — crashed the bulk INSERT
 * with "duplicate key value violates unique constraint
 * models_provider_id_name_key" (Prisma P2010 / Postgres 23505). The
 * retry-based fallback (createNewModel's exponential backoff, see
 * "Model creation failed after max retries" in the logs) assumed this was a
 * transient same-id race and kept retrying the SAME losing insert, which is
 * deterministic for a genuine different-id/same-name collision — it only
 * ever "self-healed" when the competing id happened to drop out of a LATER
 * discovery pass on its own. That is the "gradual reactivation" symptom
 * that led to this investigation.
 *
 * The fix pre-checks (providerId, name) ownership under a Postgres advisory
 * transaction lock (keyed per provider, blocking so a racing batch waits
 * and observes the committed row instead of crashing) before building the
 * INSERT, and redirects any candidate whose name is already claimed by a
 * different id onto that row's uid — turning the collision into an UPDATE
 * instead of a crash — while deduping the rarer case of two brand-new ids
 * colliding within the SAME batch.
 *
 * Hermetic w.r.t. everything EXCEPT Postgres: no fetchers, no HTTP, no
 * mocked prisma — this exercises the real advisory-lock + raw-SQL path
 * against a real database (two genuinely concurrent DB round trips), which
 * a mocked-prisma unit test cannot prove.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/database/client';
import {
  CentralModelDiscoveryService,
  type DiscoveredModel,
  type DiscoverySource,
} from '@/services/central-model-discovery-service';

const PROVIDER_ID = 'bulk-upsert-name-collision-probe';
const NAME_PREFIX = 'collision-probe-model';

type BulkUpsertCandidate = {
  model: DiscoveredModel;
  provider: string;
  normalizedModel: DiscoveredModel;
};

type BulkUpsertFn = (
  models: BulkUpsertCandidate[],
  providerId: string,
  sourceName: string,
  source: DiscoverySource
) => Promise<{ new: number; updated: number }>;

function getBulkUpsertModels(): BulkUpsertFn {
  const service = new CentralModelDiscoveryService();
  return (
    service as unknown as { bulkUpsertModels: BulkUpsertFn }
  ).bulkUpsertModels.bind(service);
}

function fakeSource(name: string): DiscoverySource {
  return {
    name,
    type: 'native_api',
    priority: 1,
    providers: [PROVIDER_ID],
    fetcher: async () => [],
  };
}

function candidate(id: string, name: string, contextWindow: number): BulkUpsertCandidate {
  const discovered: DiscoveredModel = {
    id,
    name,
    contextWindow,
    capabilities: ['chat'],
    pricing: { inputCostPer1M: 1, outputCostPer1M: 2, currency: 'USD' },
    metadata: {},
  };
  return { model: discovered, provider: PROVIDER_ID, normalizedModel: discovered };
}

describe('central-model-discovery-service: bulkUpsertModels (provider_id, name) collision', () => {
  beforeAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
    await prisma.provider.create({
      data: {
        id: PROVIDER_ID,
        name: PROVIDER_ID,
        displayName: 'Bulk Upsert Name Collision Probe',
        status: 'active',
      },
    });
  });

  beforeEach(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
  });

  afterAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
  });

  it('two concurrent batches racing on the same (providerId, name) do not throw and converge to one row', async () => {
    const bulkUpsertModels = getBulkUpsertModels();
    const name = `${NAME_PREFIX}-single-pair`;
    const idA = `${name}-id-a`;
    const idB = `${name}-id-b`;

    // Fired concurrently: two real, independent DB round trips over separate
    // pool connections — the same shape as two discovery sources (or two
    // ci_api replicas) racing on provider X, not a simulated interleave.
    const results = await Promise.all([
      bulkUpsertModels([candidate(idA, name, 8192)], PROVIDER_ID, 'source-a', fakeSource('source-a')),
      bulkUpsertModels(
        [candidate(idB, name, 16384)],
        PROVIDER_ID,
        'source-b',
        fakeSource('source-b')
      ),
    ]);

    // Neither call rejected — no "duplicate key value violates
    // models_provider_id_name_key" reached the caller.
    expect(results).toHaveLength(2);

    const rows = await prisma.model.findMany({ where: { providerId: PROVIDER_ID, name } });
    expect(rows).toHaveLength(1);
    expect([idA, idB]).toContain(rows[0].id);

    // Forward progress: the row this converged to is a normal, updatable
    // model afterwards — not left half-written or orphaned. A later
    // discovery pass for the id it now owns lands cleanly and is counted as
    // an update, proving the write was not silently lost.
    const winningId = rows[0].id;
    const followUp = await bulkUpsertModels(
      [candidate(winningId, name, 32768)],
      PROVIDER_ID,
      'source-follow-up',
      fakeSource('source-follow-up')
    );
    expect(followUp.updated).toBe(1);
    expect(followUp.new).toBe(0);

    const refreshed = await prisma.model.findUnique({ where: { uid: rows[0].uid } });
    expect(refreshed?.contextWindow).toBe(32768);
  });

  it('many concurrent colliding pairs across a whole discovery pass all converge without error', async () => {
    const bulkUpsertModels = getBulkUpsertModels();
    const pairCount = 8;
    const calls: Array<Promise<{ new: number; updated: number }>> = [];
    const names: string[] = [];

    for (let i = 0; i < pairCount; i++) {
      const name = `${NAME_PREFIX}-pair-${i}`;
      names.push(name);
      calls.push(
        bulkUpsertModels(
          [candidate(`${name}-id-a`, name, 8192)],
          PROVIDER_ID,
          'source-a',
          fakeSource('source-a')
        )
      );
      calls.push(
        bulkUpsertModels(
          [candidate(`${name}-id-b`, name, 16384)],
          PROVIDER_ID,
          'source-b',
          fakeSource('source-b')
        )
      );
    }

    await expect(Promise.all(calls)).resolves.toHaveLength(pairCount * 2);

    for (const name of names) {
      const rows = await prisma.model.findMany({ where: { providerId: PROVIDER_ID, name } });
      expect(rows).toHaveLength(1);
    }
  });

  it('two brand-new ids in the SAME batch sharing a name do not crash the batch — one is skipped, not both dropped', async () => {
    const bulkUpsertModels = getBulkUpsertModels();
    const name = `${NAME_PREFIX}-intra-batch`;
    const idA = `${name}-id-a`;
    const idB = `${name}-id-b`;

    const result = await bulkUpsertModels(
      [candidate(idA, name, 8192), candidate(idB, name, 16384)],
      PROVIDER_ID,
      'source-single-batch',
      fakeSource('source-single-batch')
    );

    expect(result.new).toBe(1);

    const rows = await prisma.model.findMany({ where: { providerId: PROVIDER_ID, name } });
    expect(rows).toHaveLength(1);
    expect([idA, idB]).toContain(rows[0].id);
  });

  it('two different NEW ids in one batch that both alias an EXISTING owner do not double-affect the same row in one statement', async () => {
    // Postgres rejects an INSERT ... ON CONFLICT statement that would
    // affect the same conflict target (uid) twice ("ON CONFLICT DO UPDATE
    // command cannot affect row a second time"). If two incoming ids both
    // redirect onto the SAME existing name-owner, the fix must only emit
    // ONE row for that uid, not two.
    const bulkUpsertModels = getBulkUpsertModels();
    const name = `${NAME_PREFIX}-double-redirect`;
    const ownerId = `${name}-owner`;
    const aliasA = `${name}-alias-a`;
    const aliasB = `${name}-alias-b`;

    await bulkUpsertModels(
      [candidate(ownerId, name, 8192)],
      PROVIDER_ID,
      'source-seed',
      fakeSource('source-seed')
    );

    const result = await bulkUpsertModels(
      [candidate(aliasA, name, 16384), candidate(aliasB, name, 32768)],
      PROVIDER_ID,
      'source-both-aliases',
      fakeSource('source-both-aliases')
    );

    expect(result.new).toBe(0);
    expect(result.updated).toBe(1);

    const rows = await prisma.model.findMany({ where: { providerId: PROVIDER_ID, name } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ownerId);
  });

  it('an unrelated (different name) candidate in the same provider is unaffected by a concurrent collision', async () => {
    const bulkUpsertModels = getBulkUpsertModels();
    const collidingName = `${NAME_PREFIX}-unrelated-collision`;
    const soloId = `${NAME_PREFIX}-unrelated-solo`;

    const results = await Promise.all([
      bulkUpsertModels(
        [candidate(`${collidingName}-id-a`, collidingName, 8192)],
        PROVIDER_ID,
        'source-a',
        fakeSource('source-a')
      ),
      bulkUpsertModels(
        [candidate(`${collidingName}-id-b`, collidingName, 16384)],
        PROVIDER_ID,
        'source-b',
        fakeSource('source-b')
      ),
      bulkUpsertModels(
        [candidate(soloId, soloId, 4096)],
        PROVIDER_ID,
        'source-c',
        fakeSource('source-c')
      ),
    ]);

    expect(results).toHaveLength(3);

    const soloRow = await prisma.model.findUnique({
      where: { id_providerId: { id: soloId, providerId: PROVIDER_ID } },
    });
    expect(soloRow?.contextWindow).toBe(4096);
  });
});
