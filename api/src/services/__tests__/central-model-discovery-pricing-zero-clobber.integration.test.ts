// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for a live production incident found during the 2026-09-28
 * provider audit: bulkUpsertModels' raw-SQL `ON CONFLICT (uid) DO UPDATE SET
 * input_cost_per_1k = EXCLUDED.input_cost_per_1k` (and the two equivalent
 * fallback paths in createNewModel/updateExistingModel) unconditionally
 * overwrote a model's price with whatever the LATEST discovery source
 * reported — including 0 when that source simply has no per-model pricing
 * data (most hub/aggregator `/models` listings don't return one, and
 * `pricing.inputCostPer1M ?? 0` collapses "unknown" to the same value as
 * "genuinely free").
 *
 * Confirmed live: `ai302-hub` lists OpenAI-owned models (gpt-4o, gpt-5, o1,
 * ...) which `determineModelProvider()`/`readProviderFromMetadata()`
 * deliberately consolidate under provider_id='openai' (the same row
 * `openai-native` — which DOES compute a real tiered price via
 * OpenAIModelFetcher.estimateModelSpecs — writes to). Because discovery
 * sources run concurrently (Promise.all in discoverAllModels), whichever one
 * lands last wins the raw-SQL upsert. ai302-hub has no pricing for these
 * models, so its 0 silently overwrote openai-native's real price across the
 * ENTIRE openai catalog (77/143 models zeroed, including every flagship
 * chat/reasoning model) — a routing-cost and billing-accuracy incident, not
 * just a display bug.
 *
 * The fix: a confirmed non-zero price must never regress to "unknown" (0)
 * just because a later source didn't report one; it only ever updates to
 * another OBSERVED non-zero value. This test exercises the real raw-SQL
 * upsert path (bulkUpsertModels) the same way
 * central-model-discovery-bulk-upsert-name-collision.integration.test.ts
 * does — hermetic w.r.t. everything except Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/database/client';
import {
  CentralModelDiscoveryService,
  type DiscoveredModel,
  type DiscoverySource,
} from '@/services/central-model-discovery-service';

const PROVIDER_ID = 'pricing-zero-clobber-probe';
const NAME_PREFIX = 'pricing-clobber-model';

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

function candidate(
  id: string,
  name: string,
  pricing: { inputCostPer1M: number; outputCostPer1M: number }
): BulkUpsertCandidate {
  const discovered: DiscoveredModel = {
    id,
    name,
    contextWindow: 8192,
    capabilities: ['chat'],
    pricing: { ...pricing, currency: 'USD' },
    metadata: {},
  };
  return { model: discovered, provider: PROVIDER_ID, normalizedModel: discovered };
}

describe('central-model-discovery-service: bulkUpsertModels zero-price clobber guard', () => {
  beforeAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
    await prisma.provider.create({
      data: {
        id: PROVIDER_ID,
        name: PROVIDER_ID,
        displayName: 'Pricing Zero Clobber Probe',
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

  it('a later source with no pricing data does not zero out an already-confirmed non-zero price', async () => {
    const bulkUpsertModels = getBulkUpsertModels();
    const name = `${NAME_PREFIX}-gpt-4o-analog`;
    const id = `${name}-id`;

    // openai-native-analog: real tiered price, confirmed first.
    await bulkUpsertModels(
      [candidate(id, name, { inputCostPer1M: 5, outputCostPer1M: 15 })],
      PROVIDER_ID,
      'native-source',
      fakeSource('native-source')
    );

    let row = await prisma.model.findUnique({
      where: { id_providerId: { id, providerId: PROVIDER_ID } },
    });
    expect(Number(row?.inputCostPer1k)).toBe(0.005);
    expect(Number(row?.outputCostPer1k)).toBe(0.015);

    // ai302-hub-analog: same (providerId, id) — consolidated onto the same
    // row — but this source has no per-model pricing at all, so it collapses
    // to 0 upstream, exactly like ai302-hub's real /models response.
    await bulkUpsertModels(
      [candidate(id, name, { inputCostPer1M: 0, outputCostPer1M: 0 })],
      PROVIDER_ID,
      'hub-source-no-pricing',
      fakeSource('hub-source-no-pricing')
    );

    row = await prisma.model.findUnique({
      where: { id_providerId: { id, providerId: PROVIDER_ID } },
    });
    // The real price must survive — this is the actual bug: before the fix,
    // this would read 0/0, silently making a real paid flagship model look
    // free to both cost-aware routing and billing/cost-accounting.
    expect(Number(row?.inputCostPer1k)).toBe(0.005);
    expect(Number(row?.outputCostPer1k)).toBe(0.015);
  });

  it('a genuinely free model (0/0 from its only source) is left at 0, not force-priced', async () => {
    const bulkUpsertModels = getBulkUpsertModels();
    const name = `${NAME_PREFIX}-genuinely-free`;
    const id = `${name}-id`;

    await bulkUpsertModels(
      [candidate(id, name, { inputCostPer1M: 0, outputCostPer1M: 0 })],
      PROVIDER_ID,
      'only-source',
      fakeSource('only-source')
    );

    const row = await prisma.model.findUnique({
      where: { id_providerId: { id, providerId: PROVIDER_ID } },
    });
    expect(Number(row?.inputCostPer1k)).toBe(0);
    expect(Number(row?.outputCostPer1k)).toBe(0);
  });

  it('a real price change (non-zero to a different non-zero value) still applies', async () => {
    const bulkUpsertModels = getBulkUpsertModels();
    const name = `${NAME_PREFIX}-repriced`;
    const id = `${name}-id`;

    await bulkUpsertModels(
      [candidate(id, name, { inputCostPer1M: 5, outputCostPer1M: 15 })],
      PROVIDER_ID,
      'source-a',
      fakeSource('source-a')
    );
    await bulkUpsertModels(
      [candidate(id, name, { inputCostPer1M: 2.5, outputCostPer1M: 10 })],
      PROVIDER_ID,
      'source-b',
      fakeSource('source-b')
    );

    const row = await prisma.model.findUnique({
      where: { id_providerId: { id, providerId: PROVIDER_ID } },
    });
    expect(Number(row?.inputCostPer1k)).toBe(0.0025);
    expect(Number(row?.outputCostPer1k)).toBe(0.01);
  });
});
