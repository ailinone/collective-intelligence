// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-I3B — Tests for runRoleViaRouteCascade helper.
 *
 * Pure-function-with-injected-deps tests. All provider calls + adapter
 * resolution are mocked. No network. No DB.
 *
 * Pins:
 *   - First route success → 1 attempt, wasRouteFallback=false
 *   - First fails, second succeeds → 2 attempts, wasRouteFallback=true on 2nd
 *   - All routes fail → aggregateFailure='all_routes_failed'
 *   - Empty approvedRoutes → 'no_approved_route_candidates' (no provider call)
 *   - missing both approvedRoutes + builderInjections → throws
 *   - operabilitySink called on success AND failure
 *   - LiveChatOperability key composed correctly per route
 *   - wasModelFallback always false (cascade never swaps model)
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runRoleViaRouteCascade,
  isRouteInPlan,
} from '../route-cascade-runtime-adapter';
import type { ApprovedRouteCandidate } from '../route-candidates';
import type { Model, ChatRequest, ModelExecution } from '@/types';

function makeRoute(over: Partial<ApprovedRouteCandidate> & { providerId: string }): ApprovedRouteCandidate {
  return {
    routeId: `${over.providerId}::api::oai`,
    logicalModelId: 'gpt-4o',
    apiModelId: 'gpt-4o',
    providerId: over.providerId,
    adapterKind: 'openai-compatible-chat',
    endpointKind: 'chat',
    equivalenceKind: 'exact_same_model',
    liveReady: true,
    source: 'native_provider',
    ...over,
  };
}

function makeModel(): Model {
  return {
    id: 'gpt-4o', name: 'gpt-4o', provider: 'openai',
    capabilities: ['chat'], contextWindow: 8000,
    inputCostPer1k: 0.005, outputCostPer1k: 0.015,
    description: 'test',
  } as Model;
}

const dummyRequest = { model: 'gpt-4o', messages: [{ role: 'user', content: 'X' }] } as ChatRequest;
const dummyAdapter = { getName: () => 'mock', chatCompletion: async () => ({}) } as never;
const dummyExecution = (modelId: string): ModelExecution => ({
  modelId,
  modelName: modelId,
  role: 'voter',
  request: dummyRequest,
  response: {
    id: 'r', object: 'chat.completion', created: 0, model: modelId,
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } as never,
  startedAt: Date.now(),
  completedAt: Date.now(),
  tokensUsed: 2,
  cost: 0.0001,
  successful: true,
});

describe('runRoleViaRouteCascade — first route succeeds', () => {
  it('returns success with 1 attempt and wasRouteFallback=false', async () => {
    const resolveAdapter = vi.fn(async () => dummyAdapter);
    const executeChat = vi.fn(async () => dummyExecution('gpt-4o'));
    const result = await runRoleViaRouteCascade({
      role: 'voter',
      logicalModel: makeModel(),
      request: dummyRequest,
      approvedRoutes: [makeRoute({ providerId: 'openai' }), makeRoute({ providerId: 'openrouter' })],
      resolveAdapter,
      executeChat,
    });
    expect(result.success).toBe(true);
    expect(result.execution).not.toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].wasRouteFallback).toBe(false);
    expect(result.attempts[0].wasModelFallback).toBe(false);
    expect(result.winningRoute?.providerId).toBe('openai');
    expect(executeChat).toHaveBeenCalledTimes(1);
  });
});

describe('runRoleViaRouteCascade — route fallback', () => {
  it('first fails, second succeeds → 2 attempts, wasRouteFallback=true on attempt 2', async () => {
    const resolveAdapter = vi.fn(async () => dummyAdapter);
    let callIdx = 0;
    const executeChat = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) {
        throw new Error('HTTP 401 invalid_api_key');
      }
      return dummyExecution('gpt-4o');
    });
    const result = await runRoleViaRouteCascade({
      role: 'voter',
      logicalModel: makeModel(),
      request: dummyRequest,
      approvedRoutes: [makeRoute({ providerId: 'openai' }), makeRoute({ providerId: 'openrouter' })],
      resolveAdapter,
      executeChat,
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].ok).toBe(false);
    expect(result.attempts[0].wasRouteFallback).toBe(false);
    expect(result.attempts[1].ok).toBe(true);
    expect(result.attempts[1].wasRouteFallback).toBe(true);
    expect(result.winningRoute?.providerId).toBe('openrouter');
  });

  it('cascades through 4 error kinds before succeeding', async () => {
    const errors = ['HTTP 402 insufficient credits', 'HTTP 401 invalid key', 'HTTP 429 rate limited', 'HTTP 400 model not supported'];
    let idx = 0;
    const executeChat = vi.fn(async () => {
      if (idx < errors.length) {
        const err = errors[idx];
        idx++;
        throw new Error(err);
      }
      return dummyExecution('gpt-4o');
    });
    const result = await runRoleViaRouteCascade({
      role: 'voter',
      logicalModel: makeModel(),
      request: dummyRequest,
      approvedRoutes: ['a', 'b', 'c', 'd', 'e'].map((p) => makeRoute({ providerId: p })),
      resolveAdapter: async () => dummyAdapter,
      executeChat,
      policy: {
        orderBy: ['liveReady'],
        maxRouteAttempts: 5,
        allowOutOfPlanRoutes: false,
        allowModelFallback: false,
        allowRouterFallback: true,
        requireLiveReadyForCriticalRoles: true,
      },
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toHaveLength(5);
    expect(result.attempts.slice(0, 4).every((a) => !a.ok)).toBe(true);
    expect(result.attempts[4].ok).toBe(true);
  });
});

describe('runRoleViaRouteCascade — all routes fail', () => {
  it('returns aggregateFailure=all_routes_failed when every route errors', async () => {
    const result = await runRoleViaRouteCascade({
      role: 'judge',
      logicalModel: makeModel(),
      request: dummyRequest,
      approvedRoutes: ['a', 'b'].map((p) => makeRoute({ providerId: p })),
      resolveAdapter: async () => dummyAdapter,
      executeChat: async () => { throw new Error('HTTP 401 invalid'); },
      policy: {
        orderBy: ['liveReady'],
        maxRouteAttempts: 2,
        allowOutOfPlanRoutes: false,
        allowModelFallback: false,
        allowRouterFallback: true,
        requireLiveReadyForCriticalRoles: true,
      },
    });
    expect(result.success).toBe(false);
    expect(result.aggregateFailure).toBe('all_routes_failed');
    expect(result.execution).toBeNull();
    expect(result.attempts).toHaveLength(2);
  });
});

describe('runRoleViaRouteCascade — empty / missing routes', () => {
  it('empty approvedRoutes returns no_approved_route_candidates', async () => {
    const result = await runRoleViaRouteCascade({
      role: 'judge',
      logicalModel: makeModel(),
      request: dummyRequest,
      approvedRoutes: [],
      resolveAdapter: async () => dummyAdapter,
      executeChat: async () => { throw new Error('should not run'); },
    });
    expect(result.success).toBe(false);
    expect(result.aggregateFailure).toBe('no_approved_route_candidates');
    expect(result.attempts).toEqual([]);
  });

  it('missing both approvedRoutes AND builderInjections throws structured error', async () => {
    await expect(
      runRoleViaRouteCascade({
        role: 'judge',
        logicalModel: makeModel(),
        request: dummyRequest,
        resolveAdapter: async () => dummyAdapter,
        executeChat: async () => { throw new Error('should not run'); },
      }),
    ).rejects.toThrow(/no_approved_route_candidates/);
  });
});

describe('runRoleViaRouteCascade — adapter resolution failure', () => {
  it('treats adapter=null as a failed attempt (continues cascade)', async () => {
    const resolveAdapter = vi.fn(async () => null);
    const executeChat = vi.fn(async () => { throw new Error('should not be called when adapter null'); });
    const result = await runRoleViaRouteCascade({
      role: 'voter',
      logicalModel: makeModel(),
      request: dummyRequest,
      approvedRoutes: ['a', 'b'].map((p) => makeRoute({ providerId: p })),
      resolveAdapter,
      executeChat,
      policy: {
        orderBy: ['liveReady'],
        maxRouteAttempts: 2,
        allowOutOfPlanRoutes: false,
        allowModelFallback: false,
        allowRouterFallback: true,
        requireLiveReadyForCriticalRoles: true,
      },
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toHaveLength(2);
    expect(executeChat).not.toHaveBeenCalled();  // adapter resolution failed each time
  });
});

describe('runRoleViaRouteCascade — operability sink', () => {
  it('invokes sink on success AND failure with correct (route, ok) shape', async () => {
    const sinkCalls: Array<{ providerId: string; ok: boolean }> = [];
    let idx = 0;
    const executeChat = async () => {
      idx++;
      if (idx === 1) throw new Error('HTTP 401 invalid');
      return dummyExecution('gpt-4o');
    };
    await runRoleViaRouteCascade({
      role: 'voter',
      logicalModel: makeModel(),
      request: dummyRequest,
      approvedRoutes: [makeRoute({ providerId: 'a' }), makeRoute({ providerId: 'b' })],
      resolveAdapter: async () => dummyAdapter,
      executeChat,
      operabilitySink: ({ route, ok }) => {
        sinkCalls.push({ providerId: route.providerId, ok });
      },
    });
    expect(sinkCalls).toEqual([
      { providerId: 'a', ok: false },
      { providerId: 'b', ok: true },
    ]);
  });
});

describe('runRoleViaRouteCascade — recordAttempt sink', () => {
  it('invokes recordAttempt for each attempt', async () => {
    const attempts: Array<{ ok: boolean; wasRouteFallback: boolean }> = [];
    let idx = 0;
    const executeChat = async () => {
      idx++;
      if (idx === 1) throw new Error('HTTP 429 rate');
      return dummyExecution('gpt-4o');
    };
    await runRoleViaRouteCascade({
      role: 'voter',
      logicalModel: makeModel(),
      request: dummyRequest,
      approvedRoutes: [makeRoute({ providerId: 'a' }), makeRoute({ providerId: 'b' })],
      resolveAdapter: async () => dummyAdapter,
      executeChat,
      recordAttempt: (a) => attempts.push({ ok: a.ok, wasRouteFallback: a.wasRouteFallback }),
    });
    expect(attempts).toEqual([
      { ok: false, wasRouteFallback: false },
      { ok: true, wasRouteFallback: true },
    ]);
  });
});

describe('isRouteInPlan — out-of-plan guard helper', () => {
  it('returns true when routeId matches', () => {
    const approved = [makeRoute({ providerId: 'openai' })];
    expect(isRouteInPlan({ routeId: 'openai::api::oai', providerId: 'openai', apiModelId: 'gpt-4o' }, approved)).toBe(true);
  });

  it('returns true when providerId + apiModelId match (even if routeId differs)', () => {
    const approved = [makeRoute({ providerId: 'openai' })];
    expect(isRouteInPlan({ routeId: 'other::id', providerId: 'openai', apiModelId: 'gpt-4o' }, approved)).toBe(true);
  });

  it('returns false when neither routeId nor (providerId+apiModelId) match', () => {
    const approved = [makeRoute({ providerId: 'openai' })];
    expect(isRouteInPlan({ routeId: 'x', providerId: 'anthropic', apiModelId: 'claude-3' }, approved)).toBe(false);
  });
});
