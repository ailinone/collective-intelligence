// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DB-backed proof that a discovery sync no longer destroys measured
 * performance — the behaviour PR #420 tried to establish and could not ship,
 * asserted against real PostgreSQL rather than against a string.
 *
 * The SQL under test is `MODEL_UPSERT_PERFORMANCE_SET`, spliced verbatim into
 * the same INSERT … ON CONFLICT shape `bulkUpsertModels` uses, so the assertion
 * exercises the actual expression rather than a paraphrase of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/database/client';
import { computeModelUid } from '@/database/model-uid';
import {
  buildMeasuredPerformanceStamp,
  getDiscoveryPerformancePrior,
  MODEL_UPSERT_PERFORMANCE_SET,
  PERFORMANCE_SOURCE_MEASURED,
  PERFORMANCE_SOURCE_PRIOR,
  resetMeasuredPerformanceBaselineCache,
} from '@/services/model-performance-baseline';

const PROVIDER_ID = 'performance-preservation-probe';
const MODEL_ID = 'performance-preservation-probe/model-1';
const UID = computeModelUid(PROVIDER_ID, MODEL_ID);

/** The ON CONFLICT shape from bulkUpsertModels, reduced to the columns at issue. */
async function runDiscoveryUpsert(incomingPerformance: Record<string, unknown>): Promise<void> {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO models (
        uid, id, provider_id, name, display_name, context_window, max_output_tokens,
        input_cost_per_1k, output_cost_per_1k, capabilities, metadata, performance,
        status, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (uid) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        capabilities = EXCLUDED.capabilities,
        metadata = EXCLUDED.metadata,
        ${MODEL_UPSERT_PERFORMANCE_SET},
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
    `,
    UID,
    MODEL_ID,
    PROVIDER_ID,
    MODEL_ID,
    MODEL_ID,
    8192,
    4096,
    0,
    0,
    JSON.stringify(['chat']),
    JSON.stringify({}),
    JSON.stringify(incomingPerformance),
    'active',
    new Date()
  );
}

async function readPerformance(): Promise<Record<string, unknown>> {
  const row = await prisma.model.findUnique({ where: { uid: UID }, select: { performance: true } });
  return (row?.performance as Record<string, unknown>) ?? {};
}

describe('models upsert — discovery prior vs measured performance', () => {
  beforeAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
    await prisma.provider.create({
      data: {
        id: PROVIDER_ID,
        name: PROVIDER_ID,
        displayName: 'Performance Preservation Probe',
        status: 'active',
      },
    });
  });

  beforeEach(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    resetMeasuredPerformanceBaselineCache();
  });

  afterAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
    resetMeasuredPerformanceBaselineCache();
  });

  it('writes the prior on first discovery', async () => {
    const { calibrated: _c, ...prior } = await getDiscoveryPerformancePrior();

    await runDiscoveryUpsert(prior);

    const stored = await readPerformance();
    expect(stored.source).toBe(PERFORMANCE_SOURCE_PRIOR);
    expect(stored.samples).toBe(0);
    expect(stored).not.toHaveProperty('throughput');
  });

  it('NEVER overwrites a measurement on a later sync', async () => {
    const { calibrated: _c, ...prior } = await getDiscoveryPerformancePrior();
    await runDiscoveryUpsert(prior);

    // A validation run lands a real measurement, below the optimistic prior —
    // which is the case that inverted the ranking when the sync flattened it.
    const measured = {
      latencyMs: 2400,
      quality: 0.41,
      reliability: 0.72,
      ...buildMeasuredPerformanceStamp(await readPerformance(), 9),
    };
    await prisma.model.update({ where: { uid: UID }, data: { performance: measured } });

    await runDiscoveryUpsert(prior);

    const stored = await readPerformance();
    expect(stored.quality).toBe(0.41);
    expect(stored.reliability).toBe(0.72);
    expect(stored.latencyMs).toBe(2400);
    expect(stored.source).toBe(PERFORMANCE_SOURCE_MEASURED);
    expect(stored.samples).toBe(9);
  });

  it('still refreshes a row whose record is only a prior', async () => {
    const { calibrated: _c, ...prior } = await getDiscoveryPerformancePrior();
    await runDiscoveryUpsert(prior);

    await runDiscoveryUpsert({ ...prior, quality: 0.55, reliability: 0.7 });

    const stored = await readPerformance();
    expect(stored.quality).toBe(0.55);
    expect(stored.reliability).toBe(0.7);
  });

  it('treats a legacy provenance-less record as a prior and refreshes it', async () => {
    // Rows written before provenance existed carry the old constant with no
    // marker. Freezing them would pin the exact value this change removes.
    await runDiscoveryUpsert({
      latencyMs: 1000,
      throughput: 100,
      quality: 0.8,
      reliability: 0.95,
    });

    const { calibrated: _c, ...prior } = await getDiscoveryPerformancePrior();
    await runDiscoveryUpsert({ ...prior, quality: 0.62 });

    const stored = await readPerformance();
    expect(stored.quality).toBe(0.62);
    expect(stored.source).toBe(PERFORMANCE_SOURCE_PRIOR);
  });

  it('calibrates the prior on the measured population', async () => {
    // Two measured rows at 0.4 and 0.6 → median 0.5. A never-measured model
    // must land there, not above every real score.
    for (const [suffix, quality, reliability] of [
      ['a', 0.4, 0.6],
      ['b', 0.6, 0.8],
    ] as const) {
      const id = `${MODEL_ID}-${suffix}`;
      await prisma.model.create({
        data: {
          uid: computeModelUid(PROVIDER_ID, id),
          id,
          providerId: PROVIDER_ID,
          name: id,
          displayName: id,
          contextWindow: 8192,
          maxOutputTokens: 4096,
          inputCostPer1k: 0,
          outputCostPer1k: 0,
          capabilities: ['chat'],
          status: 'active',
          metadata: {},
          performance: {
            quality,
            reliability,
            ...buildMeasuredPerformanceStamp({}, 5),
          },
        },
      });
    }

    resetMeasuredPerformanceBaselineCache();
    const prior = await getDiscoveryPerformancePrior();

    expect(prior.calibrated).toBe(true);
    expect(prior.quality).toBeCloseTo(0.5, 6);
    expect(prior.reliability).toBeCloseTo(0.7, 6);
  });
});
