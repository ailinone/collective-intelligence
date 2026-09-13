// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DB-backed regression suite: the consensus pool builder must see the WHOLE
 * active chat catalog, not a recency window.
 *
 * Before this suite's fix the builder queried `searchModels` with limits
 * (256/512/256, 10_000 for injection) on top of the repository's default
 * `ORDER BY created_at DESC`, so a catalog with more than N eligible rows
 * silently lost its oldest models from every consensus pool. This seeds 150
 * active chat rows with staggered `created_at` (plus a few deprecated rows the
 * catalog cache still carries) and pins that every pool receives all 150,
 * including the OLDEST one, and none of the deprecated ones.
 *
 * Sibling of services/__tests__/model-repository-recency-window.integration.test.ts,
 * which pins the window itself at the repository level.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/database/client';
import { computeModelUid } from '@/database/model-uid';
import {
  getAllCatalogModels,
  invalidateCatalogCache,
  refreshCatalogCacheAhead,
} from '@/services/model-catalog-service';
import { buildConsensusRoleSpecificCandidatePools } from '@/core/orchestration/model-selection/role-specific-candidate-pool-builder';
import type { Model } from '@/types';

const PROVIDER_ID = 'pool-window-probe';
const ACTIVE_MODELS = 150;
const DEPRECATED_MODELS = 5;
const LEGACY_WINDOW = 100;

/** Deterministic id for the Nth seeded model (0 = OLDEST). */
const modelIdFor = (index: number): string =>
  `pool-window-probe/model-${String(index).padStart(3, '0')}`;
const deprecatedIdFor = (index: number): string => `pool-window-probe/deprecated-${index}`;

const OLDEST_MODEL_ID = modelIdFor(0);

const fromProbe = (pool: readonly Model[] | undefined) =>
  (pool ?? []).filter((m) => m.providerId === PROVIDER_ID);

describe('buildConsensusRoleSpecificCandidatePools: full catalog, no recency window', () => {
  beforeAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });

    await prisma.provider.create({
      data: {
        id: PROVIDER_ID,
        name: PROVIDER_ID,
        displayName: 'Pool Window Probe',
        status: 'active',
      },
    });

    // created_at ascending with the index, so index 0 is the OLDEST row and
    // would be the first casualty of any newest-first window.
    const base = Date.UTC(2020, 0, 1);
    const row = (id: string, index: number, status: 'active' | 'deprecated') => ({
      uid: computeModelUid(PROVIDER_ID, id),
      id,
      providerId: PROVIDER_ID,
      name: id,
      displayName: id,
      // Above both role thresholds so judge + synthesizer see all 150 too.
      contextWindow: 64_000,
      maxOutputTokens: 4096,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
      capabilities: ['chat', 'text_generation'],
      performance: {},
      status,
      metadata: {},
      createdAt: new Date(base + index * 60_000),
    });
    await prisma.model.createMany({
      data: [
        ...Array.from({ length: ACTIVE_MODELS }, (_, i) => row(modelIdFor(i), i, 'active')),
        ...Array.from({ length: DEPRECATED_MODELS }, (_, i) =>
          row(deprecatedIdFor(i), ACTIVE_MODELS + i, 'deprecated')
        ),
      ],
    });

    // Rebuild straight from Postgres and republish, instead of letting the
    // cold path hydrate a stale pre-seed snapshot out of Redis.
    await refreshCatalogCacheAhead();
  });

  afterAll(async () => {
    await prisma.model.deleteMany({ where: { providerId: PROVIDER_ID } });
    await prisma.provider.deleteMany({ where: { id: PROVIDER_ID } });
    invalidateCatalogCache();
  });

  it('every pool receives all 150 active rows, including the oldest one', async () => {
    const pools = await buildConsensusRoleSpecificCandidatePools({
      catalog: { listCatalogModels: getAllCatalogModels },
    });

    for (const pool of [pools.sharedPool, pools.judgePool, pools.synthesizerPool]) {
      const probeRows = fromProbe(pool);
      expect(probeRows).toHaveLength(ACTIVE_MODELS);
      expect(probeRows.length).toBeGreaterThan(LEGACY_WINDOW);
      expect(probeRows.map((m) => m.id)).toContain(OLDEST_MODEL_ID);
    }

    expect(pools.roleCandidateStats.participant.sourceUniverseCount).toBe(pools.sharedPool.length);
    expect(pools.roleCandidateStats.judge.sourceUniverseCount).toBe(pools.judgePool!.length);
    expect(pools.roleCandidateStats.synthesizer.sourceUniverseCount).toBe(
      pools.synthesizerPool!.length
    );
  });

  it('deprecated rows stay out of every pool even though the catalog cache carries them', async () => {
    const catalog = await getAllCatalogModels();
    const deprecatedInCatalog = catalog.filter(
      (m) => m.providerId === PROVIDER_ID && m.status === 'deprecated'
    );
    // The premise: the cache is status != 'disabled', so deprecated rows ARE in it.
    expect(deprecatedInCatalog).toHaveLength(DEPRECATED_MODELS);

    const pools = await buildConsensusRoleSpecificCandidatePools({
      catalog: { listCatalogModels: getAllCatalogModels },
    });
    for (const pool of [pools.sharedPool, pools.judgePool, pools.synthesizerPool]) {
      const statuses = new Set(fromProbe(pool).map((m) => m.status));
      expect(statuses).toEqual(new Set(['active']));
    }
  });
});
