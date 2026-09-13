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
 * survive MassiveParallelStrategy's internal `InternalExecution` remap (a
 * leaner ad-hoc shape distinct from `ModelExecution` — see the interface
 * doc comment) and reach the outgoing `OrchestrationResult.toolArtifacts`,
 * not be dropped.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution } from '@/types';
import { MassiveParallelStrategy } from '../massive-parallel-strategy';
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

function fiveDistinctProviderModels(): Model[] {
  return [
    makeModel({ id: 'mp-a', provider: 'prov-a', name: 'MP A' }),
    makeModel({ id: 'mp-b', provider: 'prov-b', name: 'MP B' }),
    makeModel({ id: 'mp-c', provider: 'prov-c', name: 'MP C' }),
    makeModel({ id: 'mp-d', provider: 'prov-d', name: 'MP D' }),
    makeModel({ id: 'mp-e', provider: 'prov-e', name: 'MP E' }),
  ];
}

describe('MassiveParallelStrategy — tool-call artifact passthrough', () => {
  it('carries a participant-surfaced artifact through the merge synthesis into toolArtifacts', async () => {
    const strategy = new MassiveParallelStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();
    anyStrat.getEligibleModels = () => fiveDistinctProviderModels();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/mp-b-generated.png',
      role: 'secondary',
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
          role === 'arbitrator'
            ? 'Merged answer combining all parallel responses.'
            : `Response from ${model.id}`;
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
        if (model.id === 'mp-b') {
          execution.artifacts = [plantedArtifact];
        }
        return execution;
      }
    );

    const result = await strategy.execute(makeRequest(), makeContext(fiveDistinctProviderModels()));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
    const mpBExecution = result.modelsUsed.find((e) => e.modelId === 'mp-b');
    expect(mpBExecution?.artifacts).toEqual([plantedArtifact]);
  });
});
