// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#752 — ParallelStrategy narrates fan-out failures to the observer.
 *
 * A failed fan-out member (HTTP 4xx/5xx, timeout, empty response) was only
 * visible in the debug log and the aggregate succeeded/failed counts; the
 * observer never received a per-model failure event. Pins:
 *   - one model_failed event per failed execution, with the structured
 *     facts (provider/role/errorCode from the shared failure taxonomy)
 *   - emitted BEFORE the all-failed throw, so a total failure is narrated too
 *
 * Uses the same technique as parallel-strategy.tool-artifacts.test.ts:
 * force the DynamicModelSelector path to throw so `selectModels` falls
 * through to its local `context.models`-scoring branch. Runs under
 * vitest.orchestration.config.ts (hermetic, no aggregator needed).
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatRequest, Model, ModelExecution, ObserverEvent } from '@/types';
import { ParallelStrategy } from '../parallel-strategy';
import { makeChatResponse, makeContext, makeModel, makeRequest } from './consensus-strategy.fixtures';

vi.mock('@/core/selection/dynamic-model-selector', () => ({
  getDynamicModelSelector: () => {
    throw new Error('forced failure — test exercises the local fallback branch');
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

type ObserverEmitSpy = ReturnType<typeof vi.fn>;

function modelFailedEvents(spy: ObserverEmitSpy): ObserverEvent[] {
  // emitObserverEvent(context, event) — event is the second argument.
  return spy.mock.calls
    .map((call) => call[1] as ObserverEvent)
    .filter((event) => event.type === 'model_failed');
}

function wireParallel(executeModelImpl: (
  _adapter: unknown,
  model: Model,
  request: ChatRequest,
  role: string
) => Promise<ModelExecution>): { strategy: ParallelStrategy; emitSpy: ObserverEmitSpy } {
  const strategy = new ParallelStrategy();
  const anyStrat = strategy as unknown as Record<string, unknown>;
  anyStrat.log = silentLogger;
  const emitSpy: ObserverEmitSpy = vi.fn();
  anyStrat.emitObserverEvent = emitSpy;
  anyStrat.getAdapterForModel = vi.fn(async (model: Model) => ({
    getName: () => model.provider,
    chatCompletion: async () => makeChatResponse('unused'),
    calculateCost: () => 0.001,
  }));
  anyStrat.executeModel = vi.fn(executeModelImpl);
  return { strategy, emitSpy };
}

function execution(
  model: Model,
  request: ChatRequest,
  role: string,
  success: boolean,
  error?: string
): ModelExecution {
  return {
    modelId: model.id,
    modelName: model.name,
    role: role as ModelExecution['role'],
    request,
    response: makeChatResponse(success ? `Response from ${model.id}` : '', model.name),
    cost: success ? 0.001 : 0,
    durationMs: 50,
    success,
    ...(error ? { error } : {}),
  };
}

const twoModels = (): Model[] => [
  makeModel({ id: 'par-a', provider: 'prov-a', name: 'Par A' }),
  makeModel({ id: 'par-b', provider: 'prov-b', name: 'Par B' }),
];

describe('ci#752 — parallel model_failed observer event', () => {
  it('ObserverEvent union accepts a well-formed model_failed event (contract)', () => {
    // Compile-time: `type: 'model_failed'` must be assignable to the union,
    // and the ci#752-only fields (provider/role/errorCode/attempt) must exist.
    const event: ObserverEvent = {
      type: 'model_failed',
      timestamp: Date.now(),
      strategy: 'parallel',
      modelId: 'par-b',
      modelName: 'Par B',
      provider: 'prov-b',
      role: 'secondary',
      errorCode: 'rate_limited',
      attempt: 1,
      summary: 'A participant failed: HTTP 429 Too Many Requests.',
    };
    expect(event.type).toBe('model_failed');
  });

  it('emits model_failed for the failed fan-out member with structured facts', async () => {
    const models = twoModels();
    const { strategy, emitSpy } = wireParallel((_adapter, model, request, role) =>
      Promise.resolve(execution(model, request, role, model.id !== 'par-b', 'HTTP 429 Too Many Requests'))
    );

    await strategy.execute(makeRequest(), makeContext(models));

    const failures = modelFailedEvents(emitSpy);
    expect(failures).toHaveLength(1);
    expect(failures[0].modelId).toBe('par-b');
    expect(failures[0].provider).toBe('prov-b');
    expect(failures[0].role).toBe('secondary');
    // errorCode reuses the shared provider-failure taxonomy (failures/).
    expect(failures[0].errorCode).toBe('rate_limited');
    // Narration context: how many participants are still continuing (N-1).
    expect(failures[0].metadata?.remaining).toBe(1);
    // The healthy model must not be narrated as a failure.
    expect(failures[0].modelId).not.toBe('par-a');
  });

  it('narrates a TOTAL fan-out failure too (emitted before the all-failed throw)', async () => {
    const models = twoModels();
    const { strategy, emitSpy } = wireParallel((_adapter, model, request, role) =>
      Promise.resolve(
        execution(model, request, role, false, 'Provider returned empty assistant response')
      )
    );
    // No healthy retry pool: pin the retry re-selection to the same (dead) pair.
    const anyStrat = strategy as unknown as Record<string, unknown>;
    anyStrat.selectModels = vi.fn(async () => [
      { model: models[0], adapter: { getName: () => 'prov-a' } },
      { model: models[1], adapter: { getName: () => 'prov-b' } },
    ]);

    await expect(strategy.execute(makeRequest(), makeContext(models))).rejects.toThrow(
      /All parallel executions failed/
    );

    const failures = modelFailedEvents(emitSpy);
    expect(failures.map((f) => f.modelId).sort()).toEqual(['par-a', 'par-b']);
  });
});
