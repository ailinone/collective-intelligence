// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Batch1 — collective-strategy tool-call artifact passthrough.
 *
 * A participant's `ModelExecution.artifacts` (populated when a tool call
 * during that execution surfaced media — see PR1 #476 / PR2 #479) must
 * reach the outgoing `OrchestrationResult.toolArtifacts`, not be dropped.
 *
 * CostCascadeStrategy's `tryModel()` calls `executeModelWithTools()` when
 * the request carries `tools`. Its internal `ExecutionAttempt` shape needed
 * an `artifacts` field added so the rung's artifact survives into the
 * `allExecutions: ModelExecution[]` handed to `mergeArtifacts()`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution, Tool } from '@/types';
import { CostCascadeStrategy } from '../cost-cascade-strategy';
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

const GENERATE_MEDIA_TOOL: Tool = {
  type: 'function',
  function: { name: 'generate_media', parameters: {} },
};

function longEnoughResponse(id: string): string {
  return `This is a sufficiently detailed and structured answer produced by ${id}, with enough length and substance to clear the cost-cascade strategy's default quality threshold on the very first rung.`;
}

describe('CostCascadeStrategy — tool-call artifact passthrough', () => {
  it('carries the winning rung tool-call-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new CostCascadeStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/cost-cascade-rung1-generated.png',
      role: 'primary',
    };

    const cheapModel = makeModel({
      id: 'cascade-cheap',
      provider: 'prov-cheap',
      name: 'Cheap Model',
      inputCostPer1k: 0.0001,
      outputCostPer1k: 0.0001,
    });
    const expensiveModel = makeModel({
      id: 'cascade-expensive',
      provider: 'prov-expensive',
      name: 'Expensive Model',
      inputCostPer1k: 0.01,
      outputCostPer1k: 0.02,
    });

    anyStrat.getAdapterForModel = vi.fn(async (model: Model) => ({
      getName: () => model.provider,
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.0001,
    }));

    anyStrat.executeModelWithTools = vi.fn(
      async (
        _adapter: unknown,
        model: Model,
        request: ChatRequest,
        role: string
      ): Promise<ModelExecution> => ({
        modelId: model.id,
        modelName: model.name,
        role: role as ModelExecution['role'],
        request,
        response: makeChatResponse(longEnoughResponse(model.id), model.name),
        cost: 0.0001,
        durationMs: 50,
        success: true,
        artifacts: model.id === 'cascade-cheap' ? [plantedArtifact] : undefined,
      })
    );

    const request: ChatRequest = { ...makeRequest(), tools: [GENERATE_MEDIA_TOOL] };
    const result = await strategy.execute(request, makeContext([cheapModel, expensiveModel]));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
  });
});
