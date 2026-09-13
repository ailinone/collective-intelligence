// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CollaborativeStrategy — PR3b (media-artifact-delegation) wiring test.
 *
 * Proves `mergeArtifacts()` (base-strategy.ts, PR1) is now called at the
 * strategy's synthesis point and its output reaches the top-level
 * `OrchestrationResult.toolArtifacts` — accumulated across EVERY phase
 * (primary, reviewer, refinement, validator), not just the phase whose text
 * ends up as `finalResponse`. Field placement (top-level, unconditional —
 * matching tier 3a's consensus/competitive/debate-strategy.ts convention,
 * reconciled here rather than the initial `metadata.toolArtifacts` nesting)
 * — see the code comment at the `mergeArtifacts(executions)` call site in
 * collaborative-strategy.ts for the full reasoning.
 *
 * `selectModels()` is PRIVATE in CollaborativeStrategy (unlike the protected
 * exec seams the other two PR3b strategies expose), so it can't be
 * subclass-overridden. Instead: `request.model = 'auto'` skips the
 * user-specified-model branch (`getUserSpecifiedModelFlag` returns false for
 * 'auto'), and the DynamicModelSelector import is mocked to throw so
 * `selectModels()` deterministically falls through to its already-hermetic
 * fallback path (`getEligibleModels()` + `getAdapterForModel()`, both
 * protected and overridden below) — same technique used by
 * single-model-strategy.precomputed-selection.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/core/selection/dynamic-model-selector', () => ({
  getDynamicModelSelector: () => ({
    selectModels: () => {
      throw new Error('mocked: force CollaborativeStrategy.selectModels() fallback path');
    },
  }),
}));

import { CollaborativeStrategy } from './collaborative-strategy';
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

const primaryModel = {
  id: 'primary',
  name: 'primary-model',
  provider: 'p1',
  performance: { quality: 0.9 },
} as unknown as Model;
const reviewerModel = {
  id: 'reviewer',
  name: 'reviewer-model',
  provider: 'p2',
  performance: { quality: 0.8 },
} as unknown as Model;
const validatorModel = {
  id: 'validator',
  name: 'validator-model',
  provider: 'p3',
  performance: { quality: 0.7, latencyMs: 500 },
} as unknown as Model;

const stubAdapter = { getName: () => 'stub' } as unknown as ProviderAdapter;

function makeExec(role: ModelRole, content: string, artifacts?: ArtifactRef[]): ModelExecution {
  const response = {
    id: `resp-${role}-${Math.random()}`,
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
const validatorArtifact: ArtifactRef = { type: 'file', url: 'https://example.com/report.pdf' };

class ArtifactCarryingStrategy extends CollaborativeStrategy {
  protected getEligibleModels(_context: OrchestrationContext): Model[] {
    return [primaryModel, reviewerModel, validatorModel];
  }

  protected getAdapterForModel(
    _model: Model,
    _context: OrchestrationContext
  ): Promise<ProviderAdapter | null> {
    return Promise.resolve(stubAdapter);
  }

  protected executeModel(
    _adapter: ProviderAdapter,
    model: Model,
    _request: ChatRequest,
    role: ModelRole
  ): Promise<ModelExecution> {
    if (role === 'primary') {
      return Promise.resolve(makeExec('primary', 'Initial solution.', [primaryArtifact]));
    }
    if (role === 'reviewer') {
      // No improvement keywords → PHASE 3 refinement is skipped, so only
      // primary + reviewer + quality-checker executions accumulate.
      return Promise.resolve(makeExec('reviewer', 'Looks good, no changes needed.'));
    }
    if (role === 'quality-checker') {
      return Promise.resolve(makeExec('quality-checker', 'PASS. Meets requirements.', [
        validatorArtifact,
      ]));
    }
    return Promise.resolve(makeExec(role, `unused-${model.id}`));
  }
}

const request = {
  model: 'auto',
  messages: [{ role: 'user', content: 'Write a function.' }],
} as ChatRequest;
const context = {
  requestId: 'r1',
  models: [primaryModel, reviewerModel, validatorModel],
  taskType: 'code-generation',
} as unknown as OrchestrationContext;

describe('CollaborativeStrategy — artifact accumulation (PR3b)', () => {
  it('surfaces artifacts from BOTH the primary and quality-checker phases under metadata.toolArtifacts', async () => {
    const strategy = new ArtifactCarryingStrategy();
    const result = await strategy.execute(request, context);

    // Order: primary pushed first, reviewer second, quality-checker last —
    // matching the `executions` accumulation order in execute().
    expect(result.toolArtifacts).toEqual([primaryArtifact, validatorArtifact]);
  });

  it('is an empty array (not omitted) when no execution carries an .artifacts field', async () => {
    class NoArtifactsStrategy extends CollaborativeStrategy {
      protected getEligibleModels(): Model[] {
        return [primaryModel, reviewerModel, validatorModel];
      }
      protected getAdapterForModel(): Promise<ProviderAdapter | null> {
        return Promise.resolve(stubAdapter);
      }
      protected executeModel(
        _adapter: ProviderAdapter,
        _model: Model,
        _request: ChatRequest,
        role: ModelRole
      ): Promise<ModelExecution> {
        if (role === 'primary') return Promise.resolve(makeExec('primary', 'Initial solution.'));
        if (role === 'reviewer') return Promise.resolve(makeExec('reviewer', 'Looks good.'));
        if (role === 'quality-checker') {
          return Promise.resolve(makeExec('quality-checker', 'PASS.'));
        }
        return Promise.resolve(makeExec(role, 'unused'));
      }
    }

    const strategy = new NoArtifactsStrategy();
    const result = await strategy.execute(request, context);

    // Internal OrchestrationResult.toolArtifacts is always set by
    // mergeArtifacts() (possibly []) — only the wire-facing projection
    // (AilinMetadata.tool_artifacts, in chat-request-processor.ts) omits it
    // when empty.
    expect(result.toolArtifacts).toEqual([]);
  });
});
