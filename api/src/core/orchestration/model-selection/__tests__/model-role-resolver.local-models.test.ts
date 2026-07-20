// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Local/Ollama models are first-class candidates.
 *
 * - allowLocal=true (default): local candidates enter ranking
 * - requireLocal=true: cloud candidates are filtered out
 * - allowLocal=false: local candidates are filtered out
 * - preferLocal: local gets a rank boost but cloud still eligible
 *
 * Provider detection uses LOCAL_PROVIDER_TOKENS ('ollama', 'xinference',
 * 'own-model', 'self-hosted', ...). No hardcoded model names.
 */
import { describe, it, expect } from 'vitest';
import {
  ModelRoleResolver,
  isLocalProvider,
} from '../model-role-resolver';
import { makeCandidate, makeModel } from './role-resolver.fixtures';
import type { ModelCapability } from '@/types';

describe('ModelRoleResolver — local / Ollama', () => {
  it('isLocalProvider matches known local provider id tokens', () => {
    expect(isLocalProvider('ollama')).toBe(true);
    expect(isLocalProvider('xinference')).toBe(true);
    expect(isLocalProvider('own-model')).toBe(true);
    expect(isLocalProvider('self-hosted')).toBe(true);
    expect(isLocalProvider('localai')).toBe(true);
    expect(isLocalProvider('cloud-provider')).toBe(false);
  });

  it('local candidates participate by default (allowLocal undefined ⇒ allowed)', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: [
        makeCandidate({ id: 'cloud-1', model: makeModel({ id: 'cloud-1', provider: 'cloud-a' }) }),
        makeCandidate({ id: 'cloud-2', model: makeModel({ id: 'cloud-2', provider: 'cloud-b' }) }),
        makeCandidate({
          id: 'local-x',
          isLocal: true,
          model: makeModel({
            id: 'local-x',
            provider: 'ollama',
            capabilities: ['chat', 'text_generation', 'reasoning'] as ModelCapability[],
            contextWindow: 32000,
            performance: { latencyMs: 200, throughput: 80, quality: 0.7, reliability: 0.9 },
          }),
        }),
      ],
      constraints: {},
    });
    expect(r.selected.some((c) => c.isLocal)).toBe(true);
  });

  it('requireLocal=true filters out cloud candidates', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: [
        makeCandidate({ id: 'cloud-1', model: makeModel({ id: 'cloud-1', provider: 'cloud-a' }) }),
        makeCandidate({
          id: 'local-1',
          isLocal: true,
          model: makeModel({ id: 'local-1', provider: 'ollama', contextWindow: 32000 }),
        }),
      ],
      constraints: { requireLocal: true },
    });
    expect(r.selected.every((c) => c.isLocal)).toBe(true);
    expect(r.rejected.some((rej) => rej.modelId === 'cloud-1' && rej.reason === 'not_local')).toBe(true);
  });

  it('allowLocal=false filters out local candidates', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'participant',
      candidatePool: [
        makeCandidate({ id: 'cloud-1', model: makeModel({ id: 'cloud-1', provider: 'cloud-a' }) }),
        makeCandidate({ id: 'cloud-2', model: makeModel({ id: 'cloud-2', provider: 'cloud-b' }) }),
        makeCandidate({ id: 'cloud-3', model: makeModel({ id: 'cloud-3', provider: 'cloud-c' }) }),
        makeCandidate({
          id: 'local-1',
          isLocal: true,
          model: makeModel({ id: 'local-1', provider: 'ollama' }),
        }),
      ],
      constraints: { allowLocal: false },
    });
    expect(r.selected.every((c) => !c.isLocal)).toBe(true);
    expect(r.rejected.some((rej) => rej.modelId === 'local-1' && rej.reason === 'local_disallowed')).toBe(true);
  });

  it('preferLocal boosts local candidates in ranking', async () => {
    const resolver = new ModelRoleResolver();
    const cloud = makeCandidate({
      id: 'cloud-mid',
      model: makeModel({
        id: 'cloud-mid',
        provider: 'cloud-a',
        capabilities: ['chat', 'text_generation'] as ModelCapability[],
        contextWindow: 32000,
        performance: { latencyMs: 1000, throughput: 100, quality: 0.7, reliability: 0.9 },
      }),
    });
    const local = makeCandidate({
      id: 'local-mid',
      isLocal: true,
      model: makeModel({
        id: 'local-mid',
        provider: 'ollama',
        capabilities: ['chat', 'text_generation'] as ModelCapability[],
        contextWindow: 32000,
        performance: { latencyMs: 1000, throughput: 100, quality: 0.7, reliability: 0.9 },
      }),
    });
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'fallback_single',
      candidatePool: [cloud, local],
      constraints: { preferLocal: true },
    });
    expect(r.selected[0]?.model.id).toBe('local-mid');
  });
});
