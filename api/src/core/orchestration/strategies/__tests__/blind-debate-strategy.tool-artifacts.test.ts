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
 * BlindDebateStrategy fans respondents out via `executeModelWithTools()`
 * (when the request carries `tools`) and synthesizes via a plain
 * `executeModel()` adjudicator call.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution, Tool } from '@/types';
import { BlindDebateStrategy } from '../blind-debate-strategy';
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

function threeDistinctProviderModels(): Model[] {
  return [
    makeModel({ id: 'bd-adjudicator', provider: 'prov-a', name: 'Adjudicator' }),
    makeModel({ id: 'bd-respondent-1', provider: 'prov-b', name: 'Respondent 1' }),
    makeModel({ id: 'bd-respondent-2', provider: 'prov-c', name: 'Respondent 2' }),
  ];
}

describe('BlindDebateStrategy — tool-call artifact passthrough', () => {
  it('carries a respondent-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new BlindDebateStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();
    anyStrat.isReasoningEnabled = () => false;
    anyStrat.formatReasoningForSynthesizer = () => '';

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/blind-debate-respondent-generated.png',
      role: 'respondent',
    };

    anyStrat.getAdapterForModel = vi.fn(async (model: Model) => ({
      getName: () => model.provider,
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    }));

    anyStrat.executeModelWithTools = vi.fn(
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
          response: makeChatResponse(
            `Independent response from ${model.id} that is long enough to pass filters.`,
            model.name
          ),
          cost: 0.001,
          durationMs: 50,
          success: true,
        };
        if (model.id === 'bd-respondent-1') {
          execution.artifacts = [plantedArtifact];
        }
        return execution;
      }
    );

    anyStrat.executeModel = vi.fn(
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
        response: makeChatResponse(`Adjudicated answer from ${model.id}`, model.name),
        cost: 0.002,
        durationMs: 60,
        success: true,
      })
    );

    const request: ChatRequest = { ...makeRequest(), tools: [GENERATE_MEDIA_TOOL] };
    const result = await strategy.execute(request, makeContext(threeDistinctProviderModels()));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
    const respondentExecution = result.modelsUsed.find((e) => e.modelId === 'bd-respondent-1');
    expect(respondentExecution?.artifacts).toEqual([plantedArtifact]);
  });
});
