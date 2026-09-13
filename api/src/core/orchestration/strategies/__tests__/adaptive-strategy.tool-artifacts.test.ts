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
 * AdaptiveStrategy is a META/ROUTER strategy: `execute()` never builds its
 * own `ModelExecution`s in the common case — it delegates to a sibling
 * strategy (`getSiblingStrategy()`, injected by the orchestration engine)
 * and returns THAT strategy's response/cost/quality. Before this change it
 * silently dropped `toolArtifacts` on that passthrough: the sibling's
 * `OrchestrationResult.toolArtifacts` (or, for a sibling not yet wired,
 * its raw `ModelExecution.artifacts`) never reached Adaptive's own
 * returned result.
 *
 * The fix recomputes `mergeArtifacts(result.modelsUsed)` from the
 * delegate's OWN ModelExecutions rather than reading `result.toolArtifacts`
 * — correct regardless of whether the delegate strategy has itself been
 * wired to set `toolArtifacts` yet, since `executeModelWithTools()` (PR2)
 * already populates `ModelExecution.artifacts` independently of that.
 *
 * Also covers the (rare) direct-execution fallback branch, used only when
 * no sibling strategy is injected.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, ChatResponse, Model, ModelExecution } from '@/types';
import { AdaptiveStrategy } from '../adaptive-strategy';
import { makeChatResponse, makeContext, makeModel, makeRequest } from './consensus-strategy.fixtures';

vi.mock('@/core/learning/auto-learning-system', () => ({
  autoLearningSystem: {
    getStrategyRecommendation: async () => null,
  },
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

describe('AdaptiveStrategy — tool-call artifact passthrough (router)', () => {
  it('recomputes toolArtifacts from the delegate strategy ModelExecutions instead of dropping them', async () => {
    const strategy = new AdaptiveStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/adaptive-delegate-generated.png',
      role: 'primary',
    };

    const delegateExecution: ModelExecution = {
      modelId: 'delegate-model',
      modelName: 'Delegate Model',
      role: 'primary',
      request: makeRequest(),
      response: makeChatResponse('Delegate answer'),
      cost: 0.003,
      durationMs: 80,
      success: true,
      artifacts: [plantedArtifact],
    };

    const fakeSibling = {
      execute: vi.fn(
        async (): Promise<{
          finalResponse: ChatResponse;
          totalCost: number;
          qualityScore: number;
          modelsUsed: ModelExecution[];
          // Deliberately OMITTED: toolArtifacts. Simulates a sibling
          // strategy that hasn't been wired to set it yet — the router's
          // own recompute must not depend on the delegate having done so.
          strategyUsed: string;
          totalDuration: number;
          metadata: Record<string, unknown>;
        }> => ({
          finalResponse: delegateExecution.response,
          totalCost: delegateExecution.cost,
          qualityScore: 0.9,
          modelsUsed: [delegateExecution],
          strategyUsed: 'debate',
          totalDuration: 100,
          metadata: {},
        })
      ),
    };
    anyStrat.getSiblingStrategy = () => fakeSibling;

    const model = makeModel({ id: 'adaptive-model', provider: 'prov-adaptive' });
    const result = await strategy.execute(makeRequest(), makeContext([model]));

    expect(fakeSibling.execute).toHaveBeenCalled();
    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
  });

  it('wires toolArtifacts on the direct-execution fallback when no sibling is available', async () => {
    const strategy = new AdaptiveStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();
    anyStrat.getSiblingStrategy = () => undefined;

    const plantedArtifact: ArtifactRef = {
      type: 'video',
      url: 'https://example.test/adaptive-fallback-generated.mp4',
      role: 'primary',
    };

    const model = makeModel({ id: 'adaptive-fallback-model', provider: 'prov-fallback' });

    anyStrat.getAdapterForModel = vi.fn(async () => ({
      getName: () => 'prov-fallback',
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    }));

    anyStrat.executeModelWithTools = vi.fn(
      async (
        _adapter: unknown,
        m: Model,
        request: ChatRequest,
        role: string
      ): Promise<ModelExecution> => ({
        modelId: m.id,
        modelName: m.name,
        role: role as ModelExecution['role'],
        request,
        response: makeChatResponse(`Fallback answer from ${m.id}`, m.name),
        cost: 0.001,
        durationMs: 50,
        success: true,
        artifacts: [plantedArtifact],
      })
    );

    const request: ChatRequest = {
      ...makeRequest(),
      tools: [{ type: 'function', function: { name: 'generate_media', parameters: {} } }],
    };
    const result = await strategy.execute(request, makeContext([model]));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
  });
});
