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
 * survive ExpertPanelStrategy's internal `InternalExecution` remap (a
 * leaner ad-hoc shape distinct from `ModelExecution` — see the interface
 * doc comment) and the coordinator's synthesis, reaching the outgoing
 * `OrchestrationResult.toolArtifacts`, not be dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution } from '@/types';
import { ExpertPanelStrategy } from '../expert-panel-strategy';
import { makeChatResponse, makeContext, makeModel, makeRequest } from './consensus-strategy.fixtures';

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

function fourDistinctProviderModels(): Model[] {
  return [
    makeModel({ id: 'coord-1', provider: 'prov-coord', name: 'Coordinator' }),
    makeModel({ id: 'expert-a', provider: 'prov-a', name: 'Expert A' }),
    makeModel({ id: 'expert-b', provider: 'prov-b', name: 'Expert B' }),
    makeModel({ id: 'expert-c', provider: 'prov-c', name: 'Expert C' }),
  ];
}

describe('ExpertPanelStrategy — tool-call artifact passthrough', () => {
  const prevCrossReview = process.env.EXPERT_PANEL_CROSS_REVIEW;
  beforeEach(() => {
    // Isolate this test from the cross-review phase's extra executeModel
    // call — irrelevant to artifact passthrough and easier to reason about.
    process.env.EXPERT_PANEL_CROSS_REVIEW = 'false';
  });
  afterEach(() => {
    process.env.EXPERT_PANEL_CROSS_REVIEW = prevCrossReview;
  });

  it('carries an expert-surfaced artifact through coordinator synthesis into toolArtifacts', async () => {
    const strategy = new ExpertPanelStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();
    anyStrat.getEligibleModels = () => fourDistinctProviderModels();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/expert-b-generated.png',
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
          role === 'coordinator'
            ? 'Coordinator synthesis integrating all expert domains.'
            : `Expert assessment from ${model.id}`;
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
        if (model.id === 'expert-b') {
          execution.artifacts = [plantedArtifact];
        }
        return execution;
      }
    );

    const result = await strategy.execute(makeRequest(), makeContext(fourDistinctProviderModels()));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
    const expertBExecution = result.modelsUsed.find((e) => e.modelId === 'expert-b');
    expect(expertBExecution?.artifacts).toEqual([plantedArtifact]);
  });
});
