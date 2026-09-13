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
 * ResearchSynthesizeStrategy's researcher phase is tool-aware
 * (`executeModelWithTools()` when the request carries `tools`); the
 * ranker/synthesizer calls are plain `executeModel()`. A researcher's
 * surfaced `ModelExecution.artifacts` must reach
 * `OrchestrationResult.toolArtifacts` via `mergeArtifacts(executions)`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution } from '@/types';
import { ResearchSynthesizeStrategy } from '../research-synthesize-strategy';
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
      id: 'rs-synthesizer',
      provider: 'prov-synth',
      name: 'Synthesizer',
      capabilities: ['chat', 'text_generation'],
    }),
    makeModel({
      id: 'rs-researcher-1',
      provider: 'prov-r1',
      name: 'Researcher One',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    }),
    makeModel({
      id: 'rs-researcher-2',
      provider: 'prov-r2',
      name: 'Researcher Two',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    }),
  ];
}

describe('ResearchSynthesizeStrategy — tool-call artifact passthrough', () => {
  it('carries a researcher-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new ResearchSynthesizeStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/rs-researcher-1-generated.png',
      role: 'researcher',
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
          role: 'researcher',
          request: makeRequest(),
          response: makeChatResponse(`Findings from ${model.id}`, model.name),
          cost: 0.001,
          durationMs: 50,
          success: true,
        };
        if (model.id === 'rs-researcher-1') {
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
        response: makeChatResponse(`Output from ${model.id}`, model.name),
        cost: 0.001,
        durationMs: 50,
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
    const researcherExecution = result.modelsUsed.find((e) => e.modelId === 'rs-researcher-1');
    expect(researcherExecution?.artifacts).toEqual([plantedArtifact]);
  });
});
