// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for the 2026-10-02 provider audit finding that ~800
 * production `models` rows (651 active) hold a `uid` that is the canonical
 * hash of a DIFFERENT (provider_id, id) pair.
 *
 * Root cause: processDiscoveredModels' fallback (taken when a provider's bulk
 * upsert throws) looked rows up with `findFirst({ id })` — no provider filter —
 * and updateExistingModel then `connect`ed the found row to the current
 * provider. `models.id` is only unique per provider (gpt-4o exists under a
 * dozen), so the fallback stole another provider's row, keeping its uid.
 * Afterwards bulkUpsertModels' `ON CONFLICT (uid)` — which recomputed the
 * canonical hash — wrote each source's data into whichever provider's row
 * happened to squat on that hash: openai-native's gpt-4o price landed on
 * cometapi/gpt-4o while openai/gpt-4o only ever received ai302-hub's $0.
 *
 * A row's identity is (provider_id, id); `uid` is an opaque primary key. These
 * tests exercise the real raw-SQL upsert and the real fallback against
 * Postgres (hermetic w.r.t. everything else), like
 * central-model-discovery-bulk-upsert-name-collision.integration.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/database/client';
import { computeModelUid, computeModelUidCandidate } from '@/database/model-uid';
import {
  CentralModelDiscoveryService,
  type DiscoveredModel,
  type DiscoverySource,
} from '@/services/central-model-discovery-service';

const PROVIDER_A = 'uid-identity-probe-a';
const PROVIDER_B = 'uid-identity-probe-b';
const MODEL_ID = 'uid-identity-shared-model';

type BulkUpsertCandidate = {
  model: DiscoveredModel;
  provider: string;
  normalizedModel: DiscoveredModel;
};

type Internals = {
  bulkUpsertModels: (
    models: BulkUpsertCandidate[],
    providerId: string,
    sourceName: string,
    source: DiscoverySource
  ) => Promise<{ new: number; updated: number }>;
  processDiscoveredModels: (
    sourceName: string,
    source: DiscoverySource,
    models: DiscoveredModel[]
  ) => Promise<{ modelsNew: number; modelsUpdated: number; errors: string[] }>;
};

function fakeSource(name: string, providerId: string): DiscoverySource {
  return {
    name,
    type: 'native_api',
    priority: 1,
    providers: [providerId],
    fetcher: async () => [],
  };
}

function discovered(inputPer1M: number, outputPer1M: number): DiscoveredModel {
  return {
    id: MODEL_ID,
    name: MODEL_ID,
    contextWindow: 8192,
    capabilities: ['chat'],
    pricing: { inputCostPer1M: inputPer1M, outputCostPer1M: outputPer1M, currency: 'USD' },
    metadata: {},
  };
}

function candidate(providerId: string, model: DiscoveredModel): BulkUpsertCandidate {
  return { model, provider: providerId, normalizedModel: model };
}

async function createSquattingRow(
  providerId: string,
  uid: string,
  inputCostPer1k: number
): Promise<void> {
  await prisma.model.create({
    data: {
      uid,
      id: MODEL_ID,
      providerId,
      name: MODEL_ID,
      displayName: MODEL_ID,
      contextWindow: 8192,
      maxOutputTokens: 1024,
      inputCostPer1k,
      outputCostPer1k: inputCostPer1k * 3,
      capabilities: ['chat'],
    },
  });
}

describe('central-model-discovery-service: row identity is (provider_id, id), not the canonical uid', () => {
  const service = new CentralModelDiscoveryService();
  const internals = service as unknown as Internals;

  beforeAll(async () => {
    for (const id of [PROVIDER_A, PROVIDER_B]) {
      await prisma.model.deleteMany({ where: { providerId: id } });
      await prisma.provider.deleteMany({ where: { id } });
      await prisma.provider.create({
        data: { id, name: id, displayName: id, status: 'active' },
      });
    }
  });

  beforeEach(async () => {
    await prisma.model.deleteMany({ where: { providerId: { in: [PROVIDER_A, PROVIDER_B] } } });
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: { in: [PROVIDER_A, PROVIDER_B] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [PROVIDER_A, PROVIDER_B] } } });
  });

  it('updates an existing row in place even when its uid is the canonical hash of another pair', async () => {
    // Row (A, MODEL) that squats on the canonical uid of (B, MODEL) — the
    // exact shape ~800 production rows have.
    const squatterUid = computeModelUid(PROVIDER_B, MODEL_ID);
    await createSquattingRow(PROVIDER_A, squatterUid, 0);

    await internals.bulkUpsertModels(
      [candidate(PROVIDER_A, discovered(5, 15))],
      PROVIDER_A,
      'source-a',
      fakeSource('source-a', PROVIDER_A)
    );

    const rows = await prisma.model.findMany({ where: { id: MODEL_ID } });
    // Still exactly one row, still A's, still on the uid it had, now priced —
    // the write landed on the row the (provider, id) pair owns instead of
    // being redirected by the recomputed hash.
    expect(rows).toHaveLength(1);
    expect(rows[0].providerId).toBe(PROVIDER_A);
    expect(rows[0].uid).toBe(squatterUid);
    expect(Number(rows[0].inputCostPer1k)).toBe(0.005);
    expect(Number(rows[0].outputCostPer1k)).toBe(0.015);
  });

  it('a new row whose canonical uid is squatted gets its own salted uid and leaves the squatter untouched', async () => {
    const squatterUid = computeModelUid(PROVIDER_B, MODEL_ID);
    await createSquattingRow(PROVIDER_A, squatterUid, 0.001);

    await internals.bulkUpsertModels(
      [candidate(PROVIDER_B, discovered(2, 6))],
      PROVIDER_B,
      'source-b',
      fakeSource('source-b', PROVIDER_B)
    );

    const squatter = await prisma.model.findUnique({ where: { uid: squatterUid } });
    // A's row is untouched: not overwritten by B's write, not re-parented.
    expect(squatter?.providerId).toBe(PROVIDER_A);
    expect(Number(squatter?.inputCostPer1k)).toBe(0.001);

    const bRow = await prisma.model.findUnique({
      where: { id_providerId: { id: MODEL_ID, providerId: PROVIDER_B } },
    });
    expect(bRow).not.toBeNull();
    expect(bRow?.uid).not.toBe(squatterUid);
    expect(bRow?.uid).toBe(computeModelUidCandidate(PROVIDER_B, MODEL_ID, 1));
    expect(Number(bRow?.inputCostPer1k)).toBe(0.002);

    // A second pass finds B's salted row by (provider, id) and updates it in
    // place — no duplicate, no new uid.
    await internals.bulkUpsertModels(
      [candidate(PROVIDER_B, discovered(3, 9))],
      PROVIDER_B,
      'source-b',
      fakeSource('source-b', PROVIDER_B)
    );
    const bRows = await prisma.model.findMany({
      where: { id: MODEL_ID, providerId: PROVIDER_B },
    });
    expect(bRows).toHaveLength(1);
    expect(bRows[0].uid).toBe(bRow?.uid);
    expect(Number(bRows[0].inputCostPer1k)).toBe(0.003);
  });

  it('the bulk-failure fallback is provider-scoped and never re-parents another provider’s row', async () => {
    // A's row for the shared id, on its own canonical uid.
    const aUid = computeModelUid(PROVIDER_A, MODEL_ID);
    await createSquattingRow(PROVIDER_A, aUid, 0.004);

    // Force the fallback: B's bulk upsert throws, so processDiscoveredModels
    // walks B's models one by one. The old provider-less findFirst({ id })
    // returned A's row here and moved it onto B.
    vi.spyOn(service as unknown as { bulkUpsertModels: () => Promise<never> }, 'bulkUpsertModels')
      .mockRejectedValue(new Error('simulated bulk failure'));

    await internals.processDiscoveredModels(
      'source-b-fallback',
      fakeSource('source-b-fallback', PROVIDER_B),
      [discovered(2, 6)]
    );

    const aRow = await prisma.model.findUnique({ where: { uid: aUid } });
    expect(aRow?.providerId).toBe(PROVIDER_A);
    expect(Number(aRow?.inputCostPer1k)).toBe(0.004);

    const bRow = await prisma.model.findUnique({
      where: { id_providerId: { id: MODEL_ID, providerId: PROVIDER_B } },
    });
    expect(bRow).not.toBeNull();
    expect(Number(bRow?.inputCostPer1k)).toBe(0.002);
  });
});
