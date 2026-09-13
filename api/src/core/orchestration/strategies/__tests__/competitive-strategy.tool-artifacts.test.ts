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
 * survive CompetitiveStrategy's merge synthesis and reach the outgoing
 * `OrchestrationResult.toolArtifacts`, not be silently dropped.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution } from '@/types';
import { CompetitiveStrategy } from '../competitive-strategy';
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

function fourDistinctProviderModels(): Model[] {
  return [
    makeModel({ id: 'comp-a', provider: 'prov-a', name: 'Comp A' }),
    makeModel({ id: 'comp-b', provider: 'prov-b', name: 'Comp B' }),
    makeModel({ id: 'comp-c', provider: 'prov-c', name: 'Comp C' }),
    makeModel({ id: 'arb-1', provider: 'prov-arb', name: 'Arbiter' }),
  ];
}

describe('CompetitiveStrategy — tool-call artifact passthrough', () => {
  it('carries a competitor-surfaced artifact through merge synthesis into toolArtifacts', async () => {
    const strategy = new CompetitiveStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();
    anyStrat.getEligibleModels = () => fourDistinctProviderModels();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/comp-b-generated.png',
      role: 'primary',
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
            ? 'Merged answer combining all competitor responses.'
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
        // Only comp-b's own execution carries the tool-surfaced artifact —
        // exactly the shape `executeModelWithTools()` produces (PR2).
        if (model.id === 'comp-b') {
          execution.artifacts = [plantedArtifact];
        }
        return execution;
      }
    );

    const result = await strategy.execute(makeRequest(), makeContext(fourDistinctProviderModels()));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
    // The artifact must not have been dropped from the underlying execution either.
    const compBExecution = result.modelsUsed.find((e) => e.modelId === 'comp-b');
    expect(compBExecution?.artifacts).toEqual([plantedArtifact]);
  });
});
