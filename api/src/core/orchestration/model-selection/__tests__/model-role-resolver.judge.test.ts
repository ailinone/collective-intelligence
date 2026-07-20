// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * judge role — JSON output required, low cost preferred, independent.
 */
import { describe, it, expect } from 'vitest';
import { ModelRoleResolver } from '../model-role-resolver';
import { makeCandidate, makeModel } from './role-resolver.fixtures';
import type { ModelCapability } from '@/types';

describe('ModelRoleResolver — judge', () => {
  it('requires JSON output capability when constraint set', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: [
        makeCandidate({
          id: 'plain-chat',
          model: makeModel({
            id: 'plain-chat',
            provider: 'p1',
            contextWindow: 64000,
            capabilities: ['chat', 'text_generation'] as ModelCapability[],
          }),
        }),
        makeCandidate({
          id: 'json-capable',
          model: makeModel({
            id: 'json-capable',
            provider: 'p2',
            contextWindow: 64000,
            capabilities: ['chat', 'text_generation', 'json_mode', 'function_calling'] as ModelCapability[],
          }),
        }),
      ],
      constraints: { requireJsonOutput: true },
    });
    expect(r.selected[0]?.model.id).toBe('json-capable');
    expect(r.rejected.some((rej) => rej.modelId === 'plain-chat' && rej.reason === 'json_output_not_supported')).toBe(true);
  });

  it('prefers lower-cost candidates when quality is comparable', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: [
        makeCandidate({
          id: 'cheap',
          estimatedCostPerCallUsd: 0.0005,
          model: makeModel({
            id: 'cheap',
            provider: 'p-cheap',
            contextWindow: 64000,
            capabilities: ['chat', 'text_generation', 'json_mode', 'function_calling'] as ModelCapability[],
            inputCostPer1k: 0.0001,
            outputCostPer1k: 0.0004,
            performance: { latencyMs: 500, throughput: 200, quality: 0.85, reliability: 0.93 },
          }),
        }),
        makeCandidate({
          id: 'expensive',
          estimatedCostPerCallUsd: 0.05,
          model: makeModel({
            id: 'expensive',
            provider: 'p-pricey',
            contextWindow: 64000,
            capabilities: ['chat', 'text_generation', 'json_mode'] as ModelCapability[],
            inputCostPer1k: 0.01,
            outputCostPer1k: 0.04,
            performance: { latencyMs: 500, throughput: 200, quality: 0.85, reliability: 0.93 },
          }),
        }),
      ],
      constraints: { requireJsonOutput: true, maxCostUsd: 0.1 },
    });
    expect(r.selected[0]?.model.id).toBe('cheap');
  });

  it('selectionSource=dynamic, no hardcoded model id used', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: [
        makeCandidate({
          id: 'json-able',
          model: makeModel({
            id: 'json-able',
            provider: 'p',
            capabilities: ['chat', 'text_generation', 'json_mode'] as ModelCapability[],
            contextWindow: 64000,
          }),
        }),
      ],
      constraints: { requireJsonOutput: true },
    });
    expect(r.trace.selectionSource).toBe('dynamic');
    expect(r.trace.hardcodedModelUsed).toBe(false);
    expect(r.trace.criteria.some((c) => c.toLowerCase().includes('requirejsonoutput'))).toBe(true);
  });

  it('returns empty selection (no fake judge) when no JSON-capable candidate available', async () => {
    const resolver = new ModelRoleResolver();
    const r = await resolver.resolve({
      taskProfile: { taskType: 'analysis' },
      strategyName: 'consensus',
      role: 'judge',
      candidatePool: [
        makeCandidate({
          id: 'plain-only',
          model: makeModel({
            id: 'plain-only',
            provider: 'p',
            capabilities: ['chat', 'text_generation'] as ModelCapability[],
            contextWindow: 64000,
          }),
        }),
      ],
      constraints: { requireJsonOutput: true },
    });
    expect(r.selected.length).toBe(0);
    expect(r.trace.notes).toContain('no_candidate_satisfies_constraints');
  });
});
