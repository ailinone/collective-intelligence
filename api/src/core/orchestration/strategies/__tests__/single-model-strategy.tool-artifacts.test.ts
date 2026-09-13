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
 * Mirrors sequential-strategy.tool-artifacts.test.ts (PR3a): a participant's
 * `ModelExecution.artifacts` (populated when a tool call surfaced media —
 * see PR1 #476 / PR2 #479) must reach the outgoing
 * `OrchestrationResult.toolArtifacts`, not be dropped.
 *
 * SingleModelStrategy is the simplest possible carrier: a single model
 * executing with tools (`executeModelWithTools`, taken when the request
 * carries `tools`) is exactly the shape the `generate_media` quorum-gated
 * tool targets. `selectBestModel()` is overridden directly so the test
 * never touches DynamicModelSelector or the DB.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, ModelExecution } from '@/types';
import { SingleModelStrategy } from '../single-model-strategy';
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

describe('SingleModelStrategy — tool-call artifact passthrough', () => {
  it('carries the tool-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new SingleModelStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const model = makeModel({
      id: 'single-model-tools',
      provider: 'prov-single',
      name: 'Single Tool Model',
      capabilities: ['chat', 'text_generation', 'function_calling'],
    });
    const adapter = {
      getName: () => model.provider,
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    };
    anyStrat.selectBestModel = vi.fn(async () => ({ model, adapter }));

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/single-model-generated.png',
      role: 'primary',
    };

    anyStrat.executeModelWithTools = vi.fn(
      async (): Promise<ModelExecution> => ({
        modelId: model.id,
        modelName: model.name,
        role: 'primary',
        request: makeRequest(),
        response: makeChatResponse('Response produced via tool call'),
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
    expect(anyStrat.executeModelWithTools).toHaveBeenCalled();
  });
});
