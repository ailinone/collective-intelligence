// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DB-backed regression suite for the SILENT 100-ROW RECENCY WINDOW.
 *
 * `ModelRepository.searchModels` applies `take: criteria.limit || 100` on top of
 * `ORDER BY created_at DESC`. Every caller that used it to build a candidate
 * pool — or, worse, to resolve an EXPLICIT model reference by name — was really
 * looking at "the 100 most recently discovered rows". Measured on the video pool
 * (audit 2026-07-17): 97 of 494 models, all from the newest-onboarded providers.
 *
 * These tests stand up a real catalog of 150 rows with staggered `created_at`,
 * then pin the three properties the fix depends on:
 *   1. the window is real (searchModels truncates at 100),
 *   2. searchModelsComplete reaches the whole catalog,
 *   3. findModelsByIdOrName resolves a model that sits OUTSIDE the window —
 *      which is what makes an explicit `model: "…"` request work for anything
 *      but the newest 100 rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/database/client';
import { computeModelUid } from '@/database/model-uid';
import { ModelRepository } from '@/services/model-repository';
import { getModelSelectionCache } from '@/core/selection/model-selection-cache';
import type { ModelCapability } from '@/types';

const PROVIDER_ID = 'recency-window-probe';
const CAPABILITY = 'text_to_speech' as ModelCapability;
const TOTAL_MODELS = 150;
const DEFAULT_WINDOW = 100;

/** Deterministic id for the Nth seeded model (0 = OLDEST). */
const modelIdFor = (index: number): string =>
  `recency-window-probe/model-${String(index).padStart(3, '0')}`;

/** The oldest row — outside the 100-row recency window by construction. */
const OLDEST_MODEL_ID = modelIdFor(0);

describe('ModelRepository — 100-row recency window', () => {
  let repository: ModelRepository;

  beforeAll(async () => {
    repository = new ModelRepository();

    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });

    await prisma.provider.create({
      data: {
        id: PROVIDER_ID,
        name: PROVIDER_ID,
        displayName: 'Recency Window Probe',
        status: 'active',
      },
    });

    // created_at ascending with the index, so index 0 is the OLDEST row and
    // lands at position 150 of an `ORDER BY created_at DESC` scan.
    const base = Date.UTC(2020, 0, 1);
    await prisma.model.createMany({
      data: Array.from({ length: TOTAL_MODELS }, (_, index) => {
        const id = modelIdFor(index);
        return {
          uid: computeModelUid(PROVIDER_ID, id),
          id,
          providerId: PROVIDER_ID,
          name: id,
          displayName: id,
          contextWindow: 8192,
          maxOutputTokens: 4096,
          inputCostPer1k: 0,
          outputCostPer1k: 0,
          capabilities: [CAPABILITY],
          performance: {},
          status: 'active',
          metadata: {},
          createdAt: new Date(base + index * 60_000),
        };
      }),
    });
  });

  afterAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
    getModelSelectionCache().clear();
  });

  it('searchModels truncates at 100 rows and drops the oldest models', async () => {
    // This is the defect being guarded against, asserted as a fact so the test
    // above it cannot pass vacuously.
    const rows = await repository.searchModels({
      capabilities: [CAPABILITY],
      status: 'active',
      providers: [PROVIDER_ID],
    });

    expect(rows).toHaveLength(DEFAULT_WINDOW);
    expect(rows.map((m) => m.id)).not.toContain(OLDEST_MODEL_ID);
  });

  it('searchModelsComplete reaches the entire catalog, window or not', async () => {
    const rows = await repository.searchModelsComplete({
      capabilities: [CAPABILITY],
      status: 'active',
      providers: [PROVIDER_ID],
    });

    expect(rows).toHaveLength(TOTAL_MODELS);
    expect(rows.map((m) => m.id)).toContain(OLDEST_MODEL_ID);
  });

  it('findModelsByIdOrName resolves a model outside the 100 most recent', async () => {
    const byId = await repository.findModelsByIdOrName(OLDEST_MODEL_ID);

    expect(byId).toHaveLength(1);
    expect(byId[0]?.id).toBe(OLDEST_MODEL_ID);
    expect(byId[0]?.capabilities).toContain(CAPABILITY);
  });

  it('findModelsByIdOrName resolves by name as well as id', async () => {
    // Seeded rows use the same string for `id` and `name`; the point of the
    // assertion is that the OR branch is exercised against the full table and
    // not against a pre-truncated in-memory list.
    const byName = await repository.findModelsByIdOrName(modelIdFor(7));

    expect(byName.map((m) => m.name)).toContain(modelIdFor(7));
  });

  it('returns an empty list for an id that exists nowhere in the catalog', async () => {
    const rows = await repository.findModelsByIdOrName('definitely-not-a-real-model-xyz');

    expect(rows).toEqual([]);
  });
});
