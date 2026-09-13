// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-P — Shared role-specific pool builder tests.
 *
 * Pins:
 *   - every pool is derived from the FULL catalog (no 100/256/512 recency
 *     window): 150 eligible rows yield 150 shared candidates
 *   - judge pool = active chat rows with ctx >= 16k, synthesizer = ctx >= 32k
 *   - non-active statuses and non-chat rows never enter a pool, even though
 *     the catalog cache carries them
 *   - ordering is deterministic regardless of catalog array order
 *   - role candidate stats include sourceUniverseCount per role
 *   - a catalog read failure is fatal (hard precondition of the planner)
 */
import { describe, it, expect } from 'vitest';
import {
  buildConsensusRoleSpecificCandidatePools,
  JUDGE_MIN_CONTEXT_WINDOW,
  SYNTHESIZER_MIN_CONTEXT_WINDOW,
} from '../role-specific-candidate-pool-builder';
import type { CandidateCatalogSource } from '../role-specific-candidate-pool-builder';
import type { Model } from '@/types';
import { makeModel } from './role-resolver.fixtures';

const CATALOG_SIZE = 150;
const CONTEXT_WINDOWS = [8_000, 16_000, 32_000, 128_000] as const;

function makeCatalog(rows: readonly Model[]): CandidateCatalogSource {
  return { listCatalogModels: async () => rows };
}

/** 150 active chat rows spread across 5 providers and 4 context sizes,
 *  with a quality gradient so quality-first ordering is observable. */
function eligibleRows(): Model[] {
  return Array.from({ length: CATALOG_SIZE }, (_, i) =>
    makeModel({
      id: `m-${String(i).padStart(3, '0')}`,
      provider: `prov-${i % 5}`,
      contextWindow: CONTEXT_WINDOWS[i % CONTEXT_WINDOWS.length],
      performance: {
        latencyMs: 1000,
        throughput: 100,
        quality: (i % 10) / 10,
        reliability: 0.9,
      },
    })
  );
}

/** Deterministic Fisher-Yates with a fixed LCG seed. */
function shuffled<T>(rows: readonly T[], seed = 42): T[] {
  const out = [...rows];
  let state = seed;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ids = (pool: readonly Model[] | undefined) => (pool ?? []).map((m) => m.id);

describe('buildConsensusRoleSpecificCandidatePools', () => {
  it('derives every pool from the full catalog: 150 eligible rows yield 150 shared candidates', async () => {
    const rows = eligibleRows();
    const pools = await buildConsensusRoleSpecificCandidatePools({ catalog: makeCatalog(rows) });

    expect(pools.sharedPool).toHaveLength(CATALOG_SIZE);
    expect(pools.sharedPool.length).toBeGreaterThan(100);
    expect(pools.participantPool).toBeUndefined();
    expect(pools.fallbackPool).toBeUndefined();

    const judgeEligible = rows.filter((m) => m.contextWindow >= JUDGE_MIN_CONTEXT_WINDOW);
    const synthEligible = rows.filter((m) => m.contextWindow >= SYNTHESIZER_MIN_CONTEXT_WINDOW);
    expect(pools.judgePool).toHaveLength(judgeEligible.length);
    expect(pools.synthesizerPool).toHaveLength(synthEligible.length);
    expect(new Set(ids(pools.judgePool))).toEqual(new Set(ids(judgeEligible)));
    expect(new Set(ids(pools.synthesizerPool))).toEqual(new Set(ids(synthEligible)));
  });

  it('keeps only status=active rows with the chat capability, even though the catalog carries the rest', async () => {
    const rows: Model[] = [
      makeModel({ id: 'active-chat', provider: 'p' }),
      makeModel({ id: 'deprecated-chat', provider: 'p', status: 'deprecated' }),
      makeModel({ id: 'maintenance-chat', provider: 'p', status: 'maintenance' }),
      makeModel({ id: 'disabled-chat', provider: 'p', status: 'disabled' }),
      makeModel({ id: 'preview-chat', provider: 'p', status: 'preview' }),
      makeModel({ id: 'legacy-chat', provider: 'p', status: 'legacy' }),
      makeModel({ id: 'active-embedding', provider: 'p', capabilities: ['embeddings'] }),
      makeModel({ id: 'active-no-caps', provider: 'p', capabilities: [] }),
    ];
    const pools = await buildConsensusRoleSpecificCandidatePools({ catalog: makeCatalog(rows) });

    expect(ids(pools.sharedPool)).toEqual(['active-chat']);
    expect(ids(pools.judgePool)).toEqual(['active-chat']);
    expect(ids(pools.synthesizerPool)).toEqual(['active-chat']);
  });

  it('orders pools deterministically regardless of catalog array order', async () => {
    const rows = eligibleRows();
    const a = await buildConsensusRoleSpecificCandidatePools({ catalog: makeCatalog(rows) });
    const b = await buildConsensusRoleSpecificCandidatePools({
      catalog: makeCatalog(shuffled(rows)),
    });
    const c = await buildConsensusRoleSpecificCandidatePools({
      catalog: makeCatalog(shuffled(rows, 7)),
    });

    expect(ids(b.sharedPool)).toEqual(ids(a.sharedPool));
    expect(ids(c.sharedPool)).toEqual(ids(a.sharedPool));
    expect(ids(b.judgePool)).toEqual(ids(a.judgePool));
    expect(ids(c.judgePool)).toEqual(ids(a.judgePool));
    expect(ids(b.synthesizerPool)).toEqual(ids(a.synthesizerPool));
    expect(ids(c.synthesizerPool)).toEqual(ids(a.synthesizerPool));
  });

  it('sorts shared by (provider, id) and judge/synthesizer by quality desc then (provider, id)', async () => {
    const rows = eligibleRows();
    const pools = await buildConsensusRoleSpecificCandidatePools({
      catalog: makeCatalog(shuffled(rows)),
    });

    // Plain code-unit comparison, the same the builder uses (no locale).
    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    const byProviderThenId = (x: Model, y: Model) => cmp(x.provider, y.provider) || cmp(x.id, y.id);
    expect(ids(pools.sharedPool)).toEqual(ids([...rows].sort(byProviderThenId)));

    for (const pool of [pools.judgePool!, pools.synthesizerPool!]) {
      for (let i = 1; i < pool.length; i++) {
        const prev = pool[i - 1];
        const cur = pool[i];
        const qPrev = prev.performance.quality;
        const qCur = cur.performance.quality;
        expect(qPrev).toBeGreaterThanOrEqual(qCur);
        if (qPrev === qCur) {
          expect(byProviderThenId(prev, cur)).toBeLessThan(0);
        }
      }
    }
  });

  it('emits roleCandidateStats with sourceUniverseCount per role', async () => {
    const rows = eligibleRows();
    const pools = await buildConsensusRoleSpecificCandidatePools({
      catalog: makeCatalog(rows),
      maxCostPer1kJudge: 0.05,
    });

    expect(pools.roleCandidateStats.participant).toEqual({
      sourceUniverseCount: CATALOG_SIZE,
      source: 'shared_pool',
    });
    expect(pools.roleCandidateStats.fallback).toEqual({
      sourceUniverseCount: CATALOG_SIZE,
      source: 'shared_pool',
    });
    expect(pools.roleCandidateStats.judge).toEqual({
      sourceUniverseCount: pools.judgePool!.length,
      source: 'role_specific_pool',
      minContextWindow: JUDGE_MIN_CONTEXT_WINDOW,
      maxCostPer1k: 0.05,
    });
    expect(pools.roleCandidateStats.synthesizer).toEqual({
      sourceUniverseCount: pools.synthesizerPool!.length,
      source: 'role_specific_pool',
      minContextWindow: SYNTHESIZER_MIN_CONTEXT_WINDOW,
    });
  });

  it('returns empty pools (not a throw) when the catalog has no eligible rows', async () => {
    const pools = await buildConsensusRoleSpecificCandidatePools({ catalog: makeCatalog([]) });
    expect(pools.sharedPool).toEqual([]);
    expect(pools.judgePool).toEqual([]);
    expect(pools.synthesizerPool).toEqual([]);
    expect(pools.roleCandidateStats.participant.sourceUniverseCount).toBe(0);
  });

  it('propagates a catalog read failure (the catalog is a hard precondition of the planner)', async () => {
    const catalog: CandidateCatalogSource = {
      async listCatalogModels() {
        throw new Error('catalog completely down');
      },
    };
    await expect(buildConsensusRoleSpecificCandidatePools({ catalog })).rejects.toThrow(
      'catalog completely down'
    );
  });

  it('does not mutate the catalog rows or the catalog array it was given', async () => {
    const rows = eligibleRows();
    const snapshot = JSON.stringify(rows);
    const order = ids(rows);
    await buildConsensusRoleSpecificCandidatePools({ catalog: makeCatalog(rows) });
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(ids(rows)).toEqual(order);
  });

  it('builds pools over a 110k-row catalog with ~50% eligible rows in bounded time', async () => {
    const total = 110_000;
    const rows: Model[] = Array.from({ length: total }, (_, i) =>
      makeModel({
        id: `bench-${i}`,
        provider: `prov-${i % 40}`,
        capabilities: i % 2 === 0 ? ['chat', 'text_generation'] : ['embeddings'],
        contextWindow: CONTEXT_WINDOWS[i % CONTEXT_WINDOWS.length],
        performance: { latencyMs: 1, throughput: 1, quality: (i % 100) / 100, reliability: 1 },
      })
    );
    const started = performance.now();
    const pools = await buildConsensusRoleSpecificCandidatePools({ catalog: makeCatalog(rows) });
    const elapsedMs = performance.now() - started;

    expect(pools.sharedPool).toHaveLength(total / 2);
    // Loose bound: the point is to catch an accidental O(n^2) regression,
    // not to pin CI hardware timing.
    expect(elapsedMs).toBeLessThan(5_000);
    console.info(
      `[pool-builder bench] ${total} rows -> ${pools.sharedPool.length} shared in ${elapsedMs.toFixed(0)}ms`
    );
  });
});
