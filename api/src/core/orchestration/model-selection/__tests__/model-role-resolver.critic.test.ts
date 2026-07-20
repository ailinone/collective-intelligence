// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * critic role — prefers reasoning + code_review caps; supports
 * independence via excludeModelIds.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '../model-role-resolver';
import { makeCandidate, makeModel } from './role-resolver.fixtures';
import type { ModelCapability } from '@/types';

describe('ModelRoleResolver — critic', () => {
  it('prefers reasoning over plain chat for critic role', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'code-generation' },
      strategyName: 'consensus',
      role: 'critic',
      candidatePool: [
        makeCandidate({
          id: 'plain',
          model: makeModel({
            id: 'plain',
            provider: 'p1',
            contextWindow: 64000,
            capabilities: ['chat', 'text_generation'] as ModelCapability[],
            performance: { latencyMs: 1000, throughput: 100, quality: 0.85, reliability: 0.92 },
          }),
        }),
        makeCandidate({
          id: 'reviewer',
          model: makeModel({
            id: 'reviewer',
            provider: 'p2',
            contextWindow: 64000,
            capabilities: ['chat', 'text_generation', 'reasoning', 'code_review'] as ModelCapability[],
            performance: { latencyMs: 1000, throughput: 100, quality: 0.85, reliability: 0.92 },
          }),
        }),
      ],
      constraints: {},
    });
    expect(r.selected[0]?.model.id).toBe('reviewer');
  });

  it('respects excludeModelIds (critic should not overlap with participants)', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'critic',
      candidatePool: [
        makeCandidate({ id: 'participant-1', model: makeModel({ id: 'participant-1', contextWindow: 64000, provider: 'p1' }) }),
        makeCandidate({ id: 'fresh-critic', model: makeModel({ id: 'fresh-critic', contextWindow: 64000, provider: 'p2' }) }),
      ],
      constraints: { excludeModelIds: ['participant-1'] },
    });
    expect(r.selected[0]?.model.id).toBe('fresh-critic');
  });
});
