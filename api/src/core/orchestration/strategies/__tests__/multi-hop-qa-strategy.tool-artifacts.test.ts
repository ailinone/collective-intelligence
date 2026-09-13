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
 * MultiHopQAStrategy's "answerer" hops call `executeModelWithTools()`
 * when the request carries `tools`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution, Tool } from '@/types';
import { MultiHopQAStrategy } from '../multi-hop-qa-strategy';
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

describe('MultiHopQAStrategy — tool-call artifact passthrough', () => {
  it('carries an answerer-hop-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new MultiHopQAStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();
    anyStrat.isReasoningEnabled = () => false;
    anyStrat.withReasoningPrompt = (prompt: string) => prompt;
    anyStrat.formatReasoningForSynthesizer = () => '';

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/multi-hop-answerer-generated.png',
      role: 'answerer',
    };

    const models = [
      makeModel({ id: 'mh-decomposer', provider: 'prov-a', name: 'Decomposer' }),
      makeModel({ id: 'mh-answerer', provider: 'prov-b', name: 'Answerer' }),
    ];

    anyStrat.getAdapterForModel = vi.fn(async (model: Model) => ({
      getName: () => model.provider,
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    }));

    // Decomposer + synthesizer both go through executeModelWithRetry.
    // Branch on `role` to return the right shaped content for each call.
    anyStrat.executeModelWithRetry = vi.fn(
      async (
        _adapter: unknown,
        model: Model,
        request: ChatRequest,
        role: string
      ): Promise<ModelExecution> => {
        const content =
          role === 'decomposer'
            ? JSON.stringify({ questions: [{ id: 'q1', question: 'Sub-question 1?', depends_on: [] }] })
            : `Synthesized final answer from ${model.id}`;
        return {
          modelId: model.id,
          modelName: model.name,
          role: role as ModelExecution['role'],
          request,
          response: makeChatResponse(content, model.name),
          cost: 0.001,
          durationMs: 40,
          success: true,
        };
      }
    );

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
        response: makeChatResponse(`Answer from ${model.id}`, model.name),
        cost: 0.002,
        durationMs: 50,
        success: true,
        artifacts: [plantedArtifact],
      })
    );

    const request: ChatRequest = { ...makeRequest(), tools: [GENERATE_MEDIA_TOOL] };
    const result = await strategy.execute(request, makeContext(models));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
    const answererExecution = result.modelsUsed.find((e) => e.role === 'answerer');
    expect(answererExecution?.artifacts).toEqual([plantedArtifact]);
  });
});
