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
 * WarRoomStrategy routes every phase (commander decompose, specialists,
 * critique, rework, synthesis) through the private `executeSingleModel()`
 * helper, which takes `executeModelWithTools()` whenever the per-call
 * request carries `tools` (inherited by spread from the original request in
 * every phase). A specialist's surfaced `ModelExecution.artifacts` must
 * reach `OrchestrationResult.toolArtifacts` via `mergeArtifacts(allExecutions)`.
 *
 * The rework phase is disabled here (WAR_ROOM_ENABLE_REWORK=false) and the
 * critic's response is kept short (<=50 chars) as a second, independent
 * guard — the strategy also skips rework when critique text has no
 * substance — so the test stays focused on the base 4-phase pipeline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution, ModelRole } from '@/types';
import { WarRoomStrategy } from '../war-room-strategy';
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
      id: 'war-commander',
      provider: 'prov-commander',
      name: 'Commander',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    }),
    makeModel({
      id: 'war-synthesizer',
      provider: 'prov-synth',
      name: 'Synthesizer',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    }),
    makeModel({
      id: 'war-critic',
      provider: 'prov-critic',
      name: 'Critic',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    }),
  ];
}

describe('WarRoomStrategy — tool-call artifact passthrough', () => {
  const prevRework = process.env.WAR_ROOM_ENABLE_REWORK;

  beforeEach(() => {
    process.env.WAR_ROOM_ENABLE_REWORK = 'false';
  });

  afterEach(() => {
    if (prevRework === undefined) delete process.env.WAR_ROOM_ENABLE_REWORK;
    else process.env.WAR_ROOM_ENABLE_REWORK = prevRework;
  });

  it('carries a specialist-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new WarRoomStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/war-room-specialist-generated.png',
      role: 'secondary',
    };

    anyStrat.getAdapterForModel = vi.fn(async (model: Model) => ({
      getName: () => model.provider,
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    }));

    let firstSpecialistCall = true;
    anyStrat.executeModelWithTools = vi.fn(
      async (
        _adapter: unknown,
        model: Model,
        _request: ChatRequest,
        role: ModelRole
      ): Promise<ModelExecution> => {
        const base: ModelExecution = {
          modelId: model.id,
          modelName: model.name,
          role,
          request: makeRequest(),
          response: makeChatResponse('placeholder', model.name),
          cost: 0.001,
          durationMs: 50,
          success: true,
        };

        if (role === 'coordinator') {
          base.response = makeChatResponse(
            '[{"id":1,"task":"Investigate approach A"},{"id":2,"task":"Investigate approach B"}]'
          );
          return base;
        }
        if (role === 'secondary') {
          base.response = makeChatResponse(`Specialist output from ${model.id}`);
          if (firstSpecialistCall) {
            firstSpecialistCall = false;
            base.artifacts = [plantedArtifact];
          }
          return base;
        }
        if (role === 'reviewer') {
          // Short response — under the 50-char threshold that gates rework.
          base.response = makeChatResponse('OK');
          return base;
        }
        // 'primary' (synthesis) and any other role.
        base.response = makeChatResponse('Final war-room synthesized answer.');
        return base;
      }
    );

    const request: ChatRequest = {
      ...makeRequest(),
      tools: [{ type: 'function', function: { name: 'generate_media', parameters: {} } }],
    };

    const result = await strategy.execute(request, makeContext(threeDistinctProviderModels()));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
  });
});
