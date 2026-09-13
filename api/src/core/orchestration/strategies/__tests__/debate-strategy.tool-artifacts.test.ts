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
 * survive DebateStrategy's opening/debate rounds + moderator synthesis and
 * reach the outgoing `OrchestrationResult.toolArtifacts`, not be dropped.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution } from '@/types';
import { DebateStrategy } from '../debate-strategy';
import { makeChatResponse, makeContext, makeModel, makeRequest } from './consensus-strategy.fixtures';

// Inlined (not imported+referenced) — vi.mock factories are hoisted above
// imports, so referencing an imported helper here throws a TDZ error.
vi.mock('@/core/coordination/ensemble-coordinator-shadow', () => ({
  runEnsembleInShadow: async () => null,
}));
vi.mock('@/core/coordination/ensemble-coordinator-client', () => ({
  buildEnsembleRequest: (..._args: unknown[]) => ({}),
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

function threeDistinctProviderModels(): Model[] {
  return [
    makeModel({ id: 'debater-a', provider: 'prov-a', name: 'Debater A' }),
    makeModel({ id: 'debater-b', provider: 'prov-b', name: 'Debater B' }),
    makeModel({ id: 'debater-c', provider: 'prov-c', name: 'Debater C' }),
  ];
}

describe('DebateStrategy — tool-call artifact passthrough', () => {
  it('carries a debater-surfaced artifact through moderator synthesis into toolArtifacts', async () => {
    const strategy = new DebateStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();
    anyStrat.getEligibleModels = () => threeDistinctProviderModels();

    const plantedArtifact: ArtifactRef = {
      type: 'video',
      url: 'https://example.test/debater-b-generated.mp4',
      role: 'debater',
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
        const content =
          role === 'coordinator' ? 'Moderator synthesis of the debate.' : `Position from ${model.id}`;
        const execution: ModelExecution = {
          modelId: model.id,
          modelName: model.name,
          role: role as ModelExecution['role'],
          request,
          response: makeChatResponse(content, model.name),
          cost: 0.001,
          durationMs: 50,
          success: true,
        };
        if (model.id === 'debater-b') {
          execution.artifacts = [plantedArtifact];
        }
        return execution;
      }
    );

    const result = await strategy.execute(makeRequest(), makeContext(threeDistinctProviderModels()));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
    const debaterBExecution = result.modelsUsed.find((e) => e.modelId === 'debater-b');
    expect(debaterBExecution?.artifacts).toEqual([plantedArtifact]);
  }, 15000);
});
