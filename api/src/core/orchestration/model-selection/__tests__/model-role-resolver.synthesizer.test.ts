// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * synthesizer role — context window + instruction following dominate.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '../model-role-resolver';
import { makeCandidate, makeModel } from './role-resolver.fixtures';
import type { ModelCapability } from '@/types';

describe('ModelRoleResolver — synthesizer', () => {
  it('enforces contextWindowMin >= 32000', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'synthesizer',
      candidatePool: [
        makeCandidate({
          id: 'small-ctx',
          model: makeModel({ id: 'small-ctx', contextWindow: 8000, provider: 'p1' }),
        }),
        makeCandidate({
          id: 'large-ctx',
          model: makeModel({ id: 'large-ctx', contextWindow: 128000, provider: 'p2' }),
        }),
      ],
      constraints: {},
    });
    expect(r.selected[0]?.model.id).toBe('large-ctx');
    expect(r.rejected.some((rej) => rej.modelId === 'small-ctx' && rej.reason === 'context_window_too_small')).toBe(true);
  });

  it('returns exactly 1 candidate by default', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'synthesizer',
      candidatePool: [
        makeCandidate({ id: 'a', model: makeModel({ id: 'a', contextWindow: 128000, provider: 'p1' }) }),
        makeCandidate({ id: 'b', model: makeModel({ id: 'b', contextWindow: 128000, provider: 'p2' }) }),
        makeCandidate({ id: 'c', model: makeModel({ id: 'c', contextWindow: 128000, provider: 'p3' }) }),
      ],
      constraints: {},
    });
    expect(r.selected.length).toBe(1);
  });

  it('honors excludeModelIds to support independence from participants', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'synthesizer',
      candidatePool: [
        makeCandidate({ id: 'used-as-participant-a', model: makeModel({ id: 'used-as-participant-a', contextWindow: 128000, provider: 'p1' }) }),
        makeCandidate({ id: 'fresh-synth', model: makeModel({ id: 'fresh-synth', contextWindow: 128000, provider: 'p2' }) }),
      ],
      constraints: { excludeModelIds: ['used-as-participant-a'] },
    });
    expect(r.selected[0]?.model.id).toBe('fresh-synth');
    expect(r.rejected.some((rej) => rej.modelId === 'used-as-participant-a' && rej.reason === 'excluded_model')).toBe(true);
  });

  it('prefers candidates with reasoning + instruction_following capability', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'synthesizer',
      candidatePool: [
        makeCandidate({
          id: 'plain',
          model: makeModel({
            id: 'plain',
            provider: 'p1',
            contextWindow: 128000,
            capabilities: ['chat', 'text_generation'] as ModelCapability[],
            performance: { latencyMs: 1000, throughput: 100, quality: 0.85, reliability: 0.92 },
          }),
        }),
        makeCandidate({
          id: 'reasoning-instructable',
          model: makeModel({
            id: 'reasoning-instructable',
            provider: 'p2',
            contextWindow: 128000,
            capabilities: ['chat', 'text_generation', 'reasoning', 'instruction_following'] as ModelCapability[],
            performance: { latencyMs: 1000, throughput: 100, quality: 0.85, reliability: 0.92 },
          }),
        }),
      ],
      constraints: {},
    });
    expect(r.selected[0]?.model.id).toBe('reasoning-instructable');
  });
});
