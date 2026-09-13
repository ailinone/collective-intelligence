// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PR-batch2 — collective-strategy tool-call artifact passthrough.
 *
 * SwarmExploreStrategy's explorer phase is tool-aware
 * (`executeModelWithTools()` when the request carries `tools`); the
 * aggregator call is plain `executeModel()`. An explorer's surfaced
 * `ModelExecution.artifacts` must reach `OrchestrationResult.toolArtifacts`
 * via `mergeArtifacts(executions)`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution } from '@/types';
import { SwarmExploreStrategy } from '../swarm-explore-strategy';
import { makeChatResponse, makeContext, makeModel, makeRequest } from './consensus-strategy.fixtures';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

function threeDistinctProviderModels(): Model[] {
  return [
    makeModel({
      id: 'swarm-aggregator',
      provider: 'prov-agg',
      name: 'Aggregator',
      capabilities: ['chat', 'text_generation'],
    }),
    makeModel({
      id: 'swarm-explorer-1',
      provider: 'prov-e1',
      name: 'Explorer One',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    }),
    makeModel({
      id: 'swarm-explorer-2',
      provider: 'prov-e2',
      name: 'Explorer Two',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    }),
  ];
}

describe('SwarmExploreStrategy — tool-call artifact passthrough', () => {
  it('carries an explorer-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new SwarmExploreStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/swarm-explorer-1-generated.png',
      role: 'explorer',
    };

    anyStrat.getAdapterForModel = vi.fn(async (model: Model) => ({
      getName: () => model.provider,
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    }));

    anyStrat.executeModelWithTools = vi.fn(
      async (_adapter: unknown, model: Model): Promise<ModelExecution> => {
        const execution: ModelExecution = {
          modelId: model.id,
          modelName: model.name,
          role: 'explorer',
          request: makeRequest(),
          response: makeChatResponse(`Exploration from ${model.id}`, model.name),
          cost: 0.001,
          durationMs: 50,
          success: true,
        };
        if (model.id === 'swarm-explorer-1') {
          execution.artifacts = [plantedArtifact];
        }
        return execution;
      }
    );

    anyStrat.executeModel = vi.fn(
      async (_adapter: unknown, model: Model, _request: ChatRequest, role: string): Promise<ModelExecution> => ({
        modelId: model.id,
        modelName: model.name,
        role: role as ModelExecution['role'],
        request: makeRequest(),
        response: makeChatResponse(`Synthesis from ${model.id}`, model.name),
        cost: 0.002,
        durationMs: 60,
        success: true,
      })
    );

    const request: ChatRequest = {
      ...makeRequest(),
      tools: [{ type: 'function', function: { name: 'generate_media', parameters: {} } }],
    };

    const result = await strategy.execute(request, makeContext(threeDistinctProviderModels()));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
    const explorerExecution = result.modelsUsed.find((e) => e.modelId === 'swarm-explorer-1');
    expect(explorerExecution?.artifacts).toEqual([plantedArtifact]);
  });
});
