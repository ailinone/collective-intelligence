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
 * HierarchicalStrategy is a single-manager passthrough (worker delegation
 * is not implemented — see the class doc) that calls
 * `executeModelWithTools()` whenever the request carries `tools`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution, Tool } from '@/types';
import { HierarchicalStrategy } from '../hierarchical-strategy';
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

describe('HierarchicalStrategy — tool-call artifact passthrough', () => {
  it('carries the manager tool-call-surfaced artifact through into toolArtifacts', async () => {
    const strategy = new HierarchicalStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();

    const plantedArtifact: ArtifactRef = {
      type: 'video',
      url: 'https://example.test/hierarchical-generated.mp4',
      role: 'primary',
    };

    const model = makeModel({ id: 'manager-model', provider: 'prov-manager' });

    anyStrat.getAdapterForModel = vi.fn(async () => ({
      getName: () => 'prov-manager',
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
        response: makeChatResponse(`Response from ${m.id}`, m.name),
        cost: 0.001,
        durationMs: 50,
        success: true,
        artifacts: [plantedArtifact],
      })
    );

    const request: ChatRequest = { ...makeRequest(), tools: [GENERATE_MEDIA_TOOL] };
    const result = await strategy.execute(request, makeContext([model]));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
  });
});
