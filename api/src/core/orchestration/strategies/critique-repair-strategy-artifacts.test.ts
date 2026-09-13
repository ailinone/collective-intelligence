// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CritiqueRepairStrategy — PR3b (media-artifact-delegation) wiring test.
 *
 * Proves `mergeArtifacts()` (base-strategy.ts, PR1) is now called at the
 * strategy's synthesis point and its output reaches the top-level
 * `OrchestrationResult.toolArtifacts` — accumulated across EVERY phase's
 * `ModelExecution` (generator, critic, repairer), not just whichever
 * execution ends up behind `bestResponse`. Field placement (top-level,
 * unconditional — matching tier 3a's consensus/competitive/
 * debate-strategy.ts convention) — see the code comment at the
 * `mergeArtifacts(executions)` call site in critique-repair-strategy.ts for
 * the full reasoning.
 *
 * Sibling pattern to critique-repair-non-regressive.test.ts: subclass +
 * override the protected exec seams, no provider/adapter/network/DB touched.
 */
import { describe, it, expect } from 'vitest';
import { CritiqueRepairStrategy } from './critique-repair-strategy';
import type {
  ArtifactRef,
  ChatRequest,
  ChatResponse,
  Model,
  ModelExecution,
  ModelRole,
  OrchestrationContext,
} from '@/types';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';

const genModel = { id: 'gen', name: 'gen-model', provider: 'p1' } as Model;
const criticModel = { id: 'crit', name: 'critic-model', provider: 'p2' } as Model;

const stubAdapter = { getName: () => 'stub' } as unknown as ProviderAdapter;

function makeExec(role: ModelRole, content: string, artifacts?: ArtifactRef[]): ModelExecution {
  const response = {
    id: `resp-${role}`,
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null },
    ],
  } as unknown as ChatResponse;
  return {
    modelId: role,
    modelName: role,
    role,
    request: {} as ChatRequest,
    response,
    cost: 0,
    durationMs: 0,
    success: true,
    artifacts,
  };
}

const primaryArtifact: ArtifactRef = { type: 'image', url: 'https://example.com/primary.png' };
const criticArtifact: ArtifactRef = { type: 'file', url: 'https://example.com/critic-notes.pdf' };

/**
 * Scores the FIRST critique at/above the quality target so the loop exits
 * after one iteration (primary generation + one critique, no repair) —
 * keeps the wiring test focused on artifact accumulation, not the repair
 * gate (already covered by critique-repair-non-regressive.test.ts).
 */
class ArtifactCarryingStrategy extends CritiqueRepairStrategy {
  protected getEligibleModels(_context: OrchestrationContext): Model[] {
    return [genModel, criticModel];
  }

  protected getAdapterForModel(
    _model: Model,
    _context: OrchestrationContext
  ): Promise<ProviderAdapter | null> {
    return Promise.resolve(stubAdapter);
  }

  protected selfCritiqueLoop(): Promise<ModelExecution> {
    return Promise.resolve(makeExec('primary', 'Initial answer.', [primaryArtifact]));
  }

  protected executeModelWithRetry(
    _adapter: ProviderAdapter,
    _model: Model,
    _request: ChatRequest,
    role: ModelRole
  ): Promise<ModelExecution> {
    if (role === 'critic') {
      return Promise.resolve(
        makeExec(
          'critic',
          JSON.stringify({ quality_score: 0.95, issues: [] }),
          [criticArtifact]
        )
      );
    }
    return Promise.resolve(makeExec(role, 'unused'));
  }
}

const request = { messages: [{ role: 'user', content: 'Solve the task' }] } as ChatRequest;
const context = {
  requestId: 'r1',
  models: [genModel, criticModel],
  taskType: 'code-generation',
} as unknown as OrchestrationContext;

describe('CritiqueRepairStrategy — artifact accumulation (PR3b)', () => {
  it('surfaces artifacts from BOTH the generator and critic phases under metadata.toolArtifacts', async () => {
    const strategy = new ArtifactCarryingStrategy();
    const result = await strategy.execute(request, context);

    expect(result.toolArtifacts).toEqual([primaryArtifact, criticArtifact]);
  });

  it('is an empty array (not omitted) when no execution carries an .artifacts field', async () => {
    class NoArtifactsStrategy extends CritiqueRepairStrategy {
      protected getEligibleModels(): Model[] {
        return [genModel, criticModel];
      }
      protected getAdapterForModel(): Promise<ProviderAdapter | null> {
        return Promise.resolve(stubAdapter);
      }
      protected selfCritiqueLoop(): Promise<ModelExecution> {
        return Promise.resolve(makeExec('primary', 'Initial answer.'));
      }
      protected executeModelWithRetry(
        _adapter: ProviderAdapter,
        _model: Model,
        _request: ChatRequest,
        role: ModelRole
      ): Promise<ModelExecution> {
        if (role === 'critic') {
          return Promise.resolve(
            makeExec('critic', JSON.stringify({ quality_score: 0.95, issues: [] }))
          );
        }
        return Promise.resolve(makeExec(role, 'unused'));
      }
    }

    const strategy = new NoArtifactsStrategy();
    const result = await strategy.execute(request, context);

    expect(result.toolArtifacts).toEqual([]);
  });
});
