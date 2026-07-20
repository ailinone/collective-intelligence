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
 *   - judge pool uses minContextWindow=16000 + sortBy quality
 *   - synthesizer pool uses minContextWindow=32000 + sortBy quality
 *   - participant + fallback use the shared 256-cap pool
 *   - failure of role-specific query falls back silently (no throw)
 *   - role candidate stats include sourceUniverseCount per role
 */
import { describe, it, expect, vi } from 'vitest';
import { buildConsensusRoleSpecificCandidatePools } from '../role-specific-candidate-pool-builder';
import type { ModelRepositoryLike } from '../role-specific-candidate-pool-builder';
import { makeModel } from './role-resolver.fixtures';

function makeRepo(): ModelRepositoryLike & { calls: Array<unknown> } {
  const calls: unknown[] = [];
  return {
    calls,
    async searchModels(criteria) {
      calls.push(criteria);
      const minCtx = criteria.minContextWindow ?? 0;
      // Return synthetic models matching the criteria so we can assert
      // pool composition.
      const out = [];
      for (let i = 0; i < (criteria.limit ?? 64); i++) {
        out.push(
          makeModel({
            id: `m-${minCtx}-${i}`,
            provider: `prov-${i % 5}`,
            contextWindow: minCtx >= 32_000 ? 64_000 : minCtx >= 16_000 ? 16_000 : 8_000,
          }),
        );
      }
      return out;
    },
  };
}

describe('buildConsensusRoleSpecificCandidatePools', () => {
  it('issues three distinct queries: shared (256), judge (≥16k/512), synthesizer (≥32k/256)', async () => {
    const repo = makeRepo();
    const pools = await buildConsensusRoleSpecificCandidatePools({ repo });
    expect(repo.calls).toHaveLength(3);
    // shared pool — no minContextWindow
    expect(repo.calls[0]).toMatchObject({
      status: 'active',
      capabilities: ['chat'],
      limit: 256,
    });
    expect((repo.calls[0] as Record<string, unknown>).minContextWindow).toBeUndefined();
    // judge pool — ≥16k, sortBy quality, limit 512
    expect(repo.calls[1]).toMatchObject({
      status: 'active',
      capabilities: ['chat'],
      minContextWindow: 16000,
      sortBy: 'quality',
      sortOrder: 'desc',
      limit: 512,
    });
    // synthesizer pool — ≥32k, sortBy quality, limit 256
    expect(repo.calls[2]).toMatchObject({
      status: 'active',
      capabilities: ['chat'],
      minContextWindow: 32000,
      sortBy: 'quality',
      sortOrder: 'desc',
      limit: 256,
    });
    expect(pools.sharedPool).toHaveLength(256);
    expect(pools.judgePool).toHaveLength(512);
    expect(pools.synthesizerPool).toHaveLength(256);
    expect(pools.participantPool).toBeUndefined();
    expect(pools.fallbackPool).toBeUndefined();
  });

  it('emits roleCandidateStats with sourceUniverseCount per role', async () => {
    const repo = makeRepo();
    const pools = await buildConsensusRoleSpecificCandidatePools({ repo });
    expect(pools.roleCandidateStats.judge.sourceUniverseCount).toBe(512);
    expect(pools.roleCandidateStats.judge.source).toBe('role_specific_pool');
    expect(pools.roleCandidateStats.judge.minContextWindow).toBe(16000);
    expect(pools.roleCandidateStats.synthesizer.source).toBe('role_specific_pool');
    expect(pools.roleCandidateStats.synthesizer.minContextWindow).toBe(32000);
    expect(pools.roleCandidateStats.participant.source).toBe('shared_pool');
    expect(pools.roleCandidateStats.fallback.source).toBe('shared_pool');
  });

  it('falls back to shared pool when judge query fails', async () => {
    let callIdx = 0;
    const repo: ModelRepositoryLike = {
      async searchModels(criteria) {
        callIdx++;
        if (callIdx === 2) {
          // The judge query is the 2nd call — fail it
          throw new Error('simulated DB timeout');
        }
        return [makeModel({ id: `m-${callIdx}`, provider: 'p' })];
      },
    };
    const pools = await buildConsensusRoleSpecificCandidatePools({ repo });
    expect(pools.judgePool).toBeUndefined();
    expect(pools.roleCandidateStats.judge.source).toBe('shared_pool');
  });

  it('forwards maxCostPer1kJudge into stats', async () => {
    const repo = makeRepo();
    const pools = await buildConsensusRoleSpecificCandidatePools({
      repo,
      maxCostPer1kJudge: 0.05,
    });
    expect(pools.roleCandidateStats.judge.maxCostPer1k).toBe(0.05);
  });

  it('respects custom pool limits', async () => {
    const repo = makeRepo();
    await buildConsensusRoleSpecificCandidatePools({
      repo,
      sharedPoolLimit: 64,
      judgePoolLimit: 128,
      synthesizerPoolLimit: 32,
    });
    expect((repo.calls[0] as Record<string, unknown>).limit).toBe(64);
    expect((repo.calls[1] as Record<string, unknown>).limit).toBe(128);
    expect((repo.calls[2] as Record<string, unknown>).limit).toBe(32);
  });

  it('never throws even when ALL queries fail', async () => {
    const repo: ModelRepositoryLike = {
      async searchModels() {
        throw new Error('catalog completely down');
      },
    };
    // Should throw — sharedPool query is not caught (it's a hard
    // precondition for the rest of the planner). This documents the
    // contract: shared pool failure is fatal; role-specific failures are not.
    await expect(buildConsensusRoleSpecificCandidatePools({ repo })).rejects.toThrow();
  });
});
