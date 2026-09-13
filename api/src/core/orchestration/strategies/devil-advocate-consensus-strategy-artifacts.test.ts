// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * DevilAdvocateConsensusStrategy — PR3b (media-artifact-delegation) wiring test.
 *
 * Proves `mergeArtifacts()` (base-strategy.ts, PR1) is now called at the
 * synthesis point in `executeCore()` (and in the `emptyResult()` early-exit)
 * and its output reaches the top-level `OrchestrationResult.toolArtifacts` —
 * accumulated across proposers + critic + synthesizer, not just the
 * synthesizer's own execution. Field placement (top-level, unconditional —
 * matching tier 3a's consensus/competitive/debate-strategy.ts convention) —
 * see the code comments at both `mergeArtifacts(executions)` call sites in
 * devil-advocate-consensus-strategy.ts for the full reasoning.
 *
 * Same hermetic subclass-override pattern as
 * critique-repair-non-regressive.test.ts: no provider/adapter/network/DB
 * touched.
 */
import { describe, it, expect } from 'vitest';
import { DevilAdvocateConsensusStrategy } from './devil-advocate-consensus-strategy';
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

const synthModel = { id: 'synth', name: 'synth-model', provider: 'p1' } as Model;
const devilModel = { id: 'devil', name: 'devil-model', provider: 'p2' } as Model;
const proposer1 = { id: 'prop1', name: 'proposer-1', provider: 'p3' } as Model;
const proposer2 = { id: 'prop2', name: 'proposer-2', provider: 'p4' } as Model;

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

const proposer1Artifact: ArtifactRef = { type: 'video', url: 'https://example.com/p1.mp4' };
const devilArtifact: ArtifactRef = { type: 'document', url: 'https://example.com/critique.pdf' };
const synthArtifact: ArtifactRef = { type: 'image', url: 'https://example.com/synth.png' };

/** sorted[0]=synth, sorted[1]=devil, sorted[2..]=proposers — assembleExecutors
 *  quality-sorts `[synth, devil, proposer1, proposer2]` in that array order
 *  since quality is equal (0.5 default) for all four; array order is stable. */
class ArtifactCarryingStrategy extends DevilAdvocateConsensusStrategy {
  protected getEligibleModels(_context: OrchestrationContext): Model[] {
    return [synthModel, devilModel, proposer1, proposer2];
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
    if (role === 'proposer' && model.id === proposer1.id) {
      return Promise.resolve(makeExec('proposer', 'Proposal from p1.', [proposer1Artifact]));
    }
    if (role === 'proposer') {
      return Promise.resolve(makeExec('proposer', 'Proposal from p2.'));
    }
    if (role === 'critic') {
      return Promise.resolve(makeExec('critic', 'The critique.', [devilArtifact]));
    }
    if (role === 'synthesizer') {
      return Promise.resolve(makeExec('synthesizer', 'The final synthesized answer.', [synthArtifact]));
    }
    return Promise.resolve(makeExec(role, 'unused'));
  }
}

const request = { messages: [{ role: 'user', content: 'Debate the topic' }] } as ChatRequest;
const context = {
  requestId: 'r1',
  models: [synthModel, devilModel, proposer1, proposer2],
  taskType: 'analysis',
} as unknown as OrchestrationContext;

describe("DevilAdvocateConsensusStrategy — artifact accumulation (PR3b)", () => {
  it('surfaces artifacts from proposers, the critic, AND the synthesizer under metadata.toolArtifacts', async () => {
    const strategy = new ArtifactCarryingStrategy();
    const result = await strategy.execute(request, context);

    // Order: proposer executions push first (Promise.allSettled preserves
    // input order), then the critic, then the synthesizer — matching the
    // `executions` accumulation order in executeCore().
    expect(result.toolArtifacts).toEqual([proposer1Artifact, devilArtifact, synthArtifact]);
  });

  it('is an empty array (not omitted) when no execution carries an .artifacts field', async () => {
    class NoArtifactsStrategy extends DevilAdvocateConsensusStrategy {
      protected getEligibleModels(): Model[] {
        return [synthModel, devilModel, proposer1, proposer2];
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
        if (role === 'proposer') return Promise.resolve(makeExec('proposer', 'A proposal.'));
        if (role === 'critic') return Promise.resolve(makeExec('critic', 'A critique.'));
        if (role === 'synthesizer') return Promise.resolve(makeExec('synthesizer', 'Final answer.'));
        return Promise.resolve(makeExec(role, 'unused'));
      }
    }

    const strategy = new NoArtifactsStrategy();
    const result = await strategy.execute(request, context);

    expect(result.toolArtifacts).toEqual([]);
  });

  it('emptyResult() (all proposers produced empty text) still surfaces artifacts from those failed-text executions', async () => {
    class AllEmptyTextStrategy extends DevilAdvocateConsensusStrategy {
      protected getEligibleModels(): Model[] {
        return [synthModel, devilModel, proposer1, proposer2];
      }
      protected getAdapterForModel(): Promise<ProviderAdapter | null> {
        return Promise.resolve(stubAdapter);
      }
      protected executeModel(
        _adapter: ProviderAdapter,
        model: Model,
        _request: ChatRequest,
        role: ModelRole
      ): Promise<ModelExecution> {
        // Every proposer returns EMPTY text (but one still carries a tool
        // artifact) — proposals.length ends up 0, routing through
        // emptyResult() instead of the normal synthesis return.
        if (role === 'proposer' && model.id === proposer1.id) {
          return Promise.resolve(makeExec('proposer', '', [proposer1Artifact]));
        }
        return Promise.resolve(makeExec(role, ''));
      }
    }

    const strategy = new AllEmptyTextStrategy();
    const result = await strategy.execute(request, context);

    expect(result.metadata.error).toBe('all-failed');
    expect(result.toolArtifacts).toEqual([proposer1Artifact]);
  });
});
