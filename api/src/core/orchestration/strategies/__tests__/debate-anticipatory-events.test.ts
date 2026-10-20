// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CI-CHAT-0004 — no anticipatory per-debater observer events.
 *
 * The opening round used to emit one `model_response` event PER DEBATER in a
 * separate up-front pass ("Analyst N of M is forming their opening position")
 * decoupled from any model call — narration claiming a cognitive state no
 * model had entered. The fix pairs each event with its own dispatch and uses
 * text describing only the dispatched action.
 *
 * Assertions: (1) no narration claims an internal state ("forming") ahead of
 * an invocation; (2) per-debater events remain 1:1 with actually-executed
 * debaters; (3) the events name the debater that is actually being called.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatRequest, Model, ModelExecution } from '@/types';
import { DebateStrategy } from '../debate-strategy';
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

describe('DebateStrategy — opening round event fidelity (CI-CHAT-0004)', () => {
  it('pairs each per-debater model_response with a real dispatch and claims no un-entered state', async () => {
    const strategy = new DebateStrategy();
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.log = silentLogger;
    anyStrat.isReasoningEnabled = () => false;
    anyStrat.selectPromptVariant = () => null;
    const emitSpy = vi.fn();
    anyStrat.emitObserverEvent = emitSpy;
    anyStrat.getAdapterForModel = vi.fn(async (model: Model) => ({
      getName: () => model.provider,
      chatCompletion: async () => makeChatResponse('unused'),
      calculateCost: () => 0.001,
    }));
    const execSpy = vi.fn(
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
        response: makeChatResponse(role === 'coordinator' ? 'Synthesis.' : `Position ${model.id}`, model.name),
        cost: 0.001,
        durationMs: 5,
        success: true,
      })
    );
    anyStrat.executeModel = execSpy;

    const context = makeContext([
      makeModel({ id: 'debater-a', provider: 'prov-a', name: 'Debater A' }),
      makeModel({ id: 'debater-b', provider: 'prov-b', name: 'Debater B' }),
    ]);
    const request = makeRequest();
    // Drive the private opening round directly — same seam the artifact
    // passthrough test uses for strategy-level unit coverage.
    const result = await (strategy as unknown as {
      conductOpeningRound: (
        r: ChatRequest,
        d: unknown[],
        c: typeof context,
        id: string
      ) => Promise<{ round: { positions: unknown[] }; executions: ModelExecution[] }>;
    }).conductOpeningRound(
      request,
      [
        {
          name: 'Debater A',
          adapter: {},
          model: makeModel({ id: 'debater-a', provider: 'prov-a', name: 'Debater A' }),
          positions: [],
        },
        {
          name: 'Debater B',
          adapter: {},
          model: makeModel({ id: 'debater-b', provider: 'prov-b', name: 'Debater B' }),
          positions: [],
        },
      ],
      context,
      'test-req'
    );

    expect(result.executions.length).toBe(2);

    // emitObserverEvent(context, event) — the event payload is the 2nd arg.
    const modelResponseEmits = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[1] as { type?: string })?.type === 'model_response'
    );
    // One event per executed debater — 1:1 pairing, no phantom participants.
    expect(modelResponseEmits.length).toBe(2);
    const executedNames = new Set(result.executions.map((e) => e.modelName));
    for (const call of modelResponseEmits) {
      const evt = call[1] as { summary?: string; modelName?: string };
      // No narration claims an internal cognitive state ahead of the model.
      expect(evt.summary?.toLowerCase()).not.toContain('forming');
      // The named debater is one that actually ran.
      expect(executedNames.has(evt.modelName ?? '')).toBe(true);
    }
  });
});

