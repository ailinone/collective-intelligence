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
 * AgenticStrategy's degenerate-plan fallback (planner produced no usable
 * workflow steps) calls `executeModelWithTools()` unconditionally for the
 * direct execution — the simplest real path to exercise here. The full
 * workflow's `llm_call` steps go through the same helper when the request
 * carries `tools`, folding into the same `executions` array consumed by
 * `mergeArtifacts()`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution } from '@/types';
import { AgenticStrategy } from '../agentic-strategy';
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

describe('AgenticStrategy — tool-call artifact passthrough', () => {
  it('carries the direct-execution-fallback artifact through into toolArtifacts', async () => {
    const strategy = new AgenticStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/agentic-fallback-generated.png',
      role: 'primary',
    };

    const planner = makeModel({ id: 'agentic-planner', provider: 'prov-planner' });

    anyStrat.getAdapterForModel = vi.fn(async () => ({
      getName: () => 'prov-planner',
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    }));

    // Planner call: return content that fails JSON.parse, so `steps`
    // stays empty and the strategy takes its direct-execution fallback.
    anyStrat.executeModelWithRetry = vi.fn(
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
        response: makeChatResponse('not valid json', model.name),
        cost: 0.001,
        durationMs: 40,
        success: true,
      })
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
        response: makeChatResponse(`Direct fallback answer from ${model.id}`, model.name),
        cost: 0.002,
        durationMs: 60,
        success: true,
        artifacts: [plantedArtifact],
      })
    );

    const result = await strategy.execute(makeRequest(), makeContext([planner]));

    expect(result.metadata.fallback).toBe(true);
    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
  });
});
