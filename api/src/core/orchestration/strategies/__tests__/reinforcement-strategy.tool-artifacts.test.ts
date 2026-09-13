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
 * ReinforcementStrategy executes exactly one selected model, taking
 * `executeModelWithTools()` when the request carries `tools` (same
 * `hasTools` gate as SingleModelStrategy). The resulting
 * `ModelExecution.artifacts` must reach `OrchestrationResult.toolArtifacts`
 * via `mergeArtifacts([execution])`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, ModelExecution } from '@/types';
import { ReinforcementStrategy } from '../reinforcement-strategy';
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

describe('ReinforcementStrategy — tool-call artifact passthrough', () => {
  it('carries the tool-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new ReinforcementStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const modelA = makeModel({
      id: 'reinforce-a',
      provider: 'prov-a',
      name: 'Reinforce A',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    });
    const modelB = makeModel({
      id: 'reinforce-b',
      provider: 'prov-b',
      name: 'Reinforce B',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    });

    anyStrat.getAdapterForModel = vi.fn(async (model: { provider?: string }) => ({
      getName: () => model.provider,
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    }));

    const plantedArtifact: ArtifactRef = {
      type: 'video',
      url: 'https://example.test/reinforcement-generated.mp4',
      role: 'primary',
    };

    anyStrat.executeModelWithTools = vi.fn(
      async (): Promise<ModelExecution> => ({
        modelId: modelA.id,
        modelName: modelA.name,
        role: 'primary',
        request: makeRequest(),
        response: makeChatResponse('Response produced via tool call'),
        cost: 0.002,
        durationMs: 60,
        success: true,
        artifacts: [plantedArtifact],
      })
    );

    const request: ChatRequest = {
      ...makeRequest(),
      tools: [{ type: 'function', function: { name: 'generate_media', parameters: {} } }],
    };

    const result = await strategy.execute(request, makeContext([modelA, modelB]));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
    expect(anyStrat.executeModelWithTools).toHaveBeenCalled();
  });
});
