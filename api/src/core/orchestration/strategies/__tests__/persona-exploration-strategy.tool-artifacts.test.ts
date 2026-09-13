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
 * PersonaExplorationStrategy's persona/explorer phase is tool-aware
 * (`executeModelWithTools()` when the request carries `tools`); the
 * aggregator call goes through `executeModelWithRetry()` (plain
 * `executeModel()` under the hood, never tools). A persona's surfaced
 * `ModelExecution.artifacts` must reach `OrchestrationResult.toolArtifacts`
 * via `mergeArtifacts(prep.executions)`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution } from '@/types';
import { PersonaExplorationStrategy } from '../persona-exploration-strategy';
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

function twoDistinctProviderModels(): Model[] {
  return [
    makeModel({
      id: 'persona-aggregator',
      provider: 'prov-agg',
      name: 'Aggregator',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    }),
    makeModel({
      id: 'persona-explorer',
      provider: 'prov-explorer',
      name: 'Explorer',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    }),
  ];
}

describe('PersonaExplorationStrategy — tool-call artifact passthrough', () => {
  it('carries a persona-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new PersonaExplorationStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/persona-explorer-generated.png',
      role: 'explorer',
    };

    anyStrat.getAdapterForModel = vi.fn(async (model: Model) => ({
      getName: () => model.provider,
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    }));

    let firstExplorerCall = true;
    anyStrat.executeModelWithTools = vi.fn(
      async (_adapter: unknown, model: Model): Promise<ModelExecution> => {
        const execution: ModelExecution = {
          modelId: model.id,
          modelName: model.name,
          role: 'explorer',
          request: makeRequest(),
          response: makeChatResponse(`Persona perspective from ${model.id}`, model.name),
          cost: 0.001,
          durationMs: 50,
          success: true,
        };
        // Plant the artifact on exactly one persona call so the assertion is
        // unambiguous regardless of round-robin model assignment order.
        if (firstExplorerCall) {
          firstExplorerCall = false;
          execution.artifacts = [plantedArtifact];
        }
        return execution;
      }
    );

    anyStrat.executeModelWithRetry = vi.fn(
      async (_adapter: unknown, model: Model): Promise<ModelExecution> => ({
        modelId: model.id,
        modelName: model.name,
        role: 'aggregator',
        request: makeRequest(),
        response: makeChatResponse('Aggregated perspectives', model.name),
        cost: 0.002,
        durationMs: 80,
        success: true,
      })
    );

    const request: ChatRequest = {
      ...makeRequest(),
      tools: [{ type: 'function', function: { name: 'generate_media', parameters: {} } }],
    };

    const result = await strategy.execute(request, makeContext(twoDistinctProviderModels()));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
  });
});
