// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PR3a — collective-strategy tool-call artifact passthrough.
 *
 * A participant's `ModelExecution.artifacts` (populated when a tool call
 * during that execution surfaced media — see PR1 #476 / PR2 #479) must
 * reach the outgoing `OrchestrationResult.toolArtifacts`, not be dropped.
 *
 * Forces the DynamicModelSelector path to throw (same technique as
 * collective-fallback-modality-filter.test.ts) so `selectModels` falls
 * through to its local `context.models`-scoring branch — the cheapest
 * route to a real `execute()` run without a DB-backed selector.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution } from '@/types';
import { SequentialStrategy } from '../sequential-strategy';
import { makeChatResponse, makeContext, makeModel, makeRequest } from './consensus-strategy.fixtures';

vi.mock('@/core/selection/dynamic-model-selector', () => ({
  getDynamicModelSelector: () => {
    throw new Error('forced failure — test exercises the local fallback branch');
  },
}));

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

function twoDistinctProviderModels(): Model[] {
  return [
    makeModel({
      id: 'seq-analyzer',
      provider: 'prov-analyzer',
      name: 'Analyzer',
      capabilities: ['chat', 'text_generation'],
    }),
    makeModel({
      id: 'seq-executor',
      provider: 'prov-executor',
      name: 'Executor',
      capabilities: ['chat', 'text_generation'],
    }),
  ];
}

describe('SequentialStrategy — tool-call artifact passthrough', () => {
  it('carries the executor-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new SequentialStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/seq-executor-generated.png',
      role: 'primary',
    };

    anyStrat.getAdapterForModel = vi.fn(async (model: Model) => ({
      getName: () => model.provider,
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    }));

    anyStrat.executeModel = vi.fn(
      async (
        _adapter: unknown,
        model: Model,
        request: ChatRequest,
        role: string
      ): Promise<ModelExecution> => {
        const execution: ModelExecution = {
          modelId: model.id,
          modelName: model.name,
          role: role as ModelExecution['role'],
          request,
          response: makeChatResponse(`Response from ${model.id}`, model.name),
          cost: 0.001,
          durationMs: 50,
          success: true,
        };
        if (model.id === 'seq-executor') {
          execution.artifacts = [plantedArtifact];
        }
        return execution;
      }
    );

    const result = await strategy.execute(makeRequest(), makeContext(twoDistinctProviderModels()));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
    const executorExecution = result.modelsUsed.find((e) => e.modelId === 'seq-executor');
    expect(executorExecution?.artifacts).toEqual([plantedArtifact]);
  });
});
