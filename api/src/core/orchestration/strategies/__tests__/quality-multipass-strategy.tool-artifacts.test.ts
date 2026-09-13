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
 * survive QualityMultiPassStrategy's internal `allExecutions` rebuild (a
 * fresh object literal per pass — see the reconstruction in `execute()`)
 * and reach the outgoing `OrchestrationResult.toolArtifacts`, not be
 * dropped.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ArtifactRef, ChatRequest, Model, ModelExecution } from '@/types';
import { QualityMultiPassStrategy } from '../quality-multipass-strategy';
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

function twoDistinctProviderModels(): Model[] {
  return [
    makeModel({ id: 'qm-primary', provider: 'prov-primary', name: 'Primary' }),
    makeModel({ id: 'qm-validator', provider: 'prov-validator', name: 'Validator' }),
  ];
}

describe('QualityMultiPassStrategy — tool-call artifact passthrough', () => {
  it('carries the generation execution artifact through into toolArtifacts', async () => {
    const strategy = new QualityMultiPassStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.emitObserverEvent = vi.fn();
    anyStrat.getEligibleModels = () => twoDistinctProviderModels();

    const plantedArtifact: ArtifactRef = {
      type: 'image',
      url: 'https://example.test/qm-primary-generated.png',
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
        // Both generation and validation route through the same
        // `generateResponse()` helper (role is always 'primary' there) —
        // distinguish by model identity instead.
        const isValidator = model.id === 'qm-validator';
        const content = isValidator
          ? 'QUALITY_SCORE: 100\nISSUES:\n'
          : 'The generated answer, well above the outlier length threshold.';
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
        if (model.id === 'qm-primary') {
          execution.artifacts = [plantedArtifact];
        }
        return execution;
      }
    );

    const result = await strategy.execute(makeRequest(), makeContext(twoDistinctProviderModels()));

    expect(result.toolArtifacts).toBeDefined();
    expect(result.toolArtifacts).toContainEqual(plantedArtifact);
    const primaryExecution = result.modelsUsed.find((e) => e.modelId === 'qm-primary');
    expect(primaryExecution?.artifacts).toEqual([plantedArtifact]);
  });
});
