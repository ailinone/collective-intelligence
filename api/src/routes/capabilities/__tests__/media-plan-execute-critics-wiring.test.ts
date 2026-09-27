// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-level wiring test: `POST /v1/capabilities/media-plan/execute` must
 * construct `MediaConsensusStrategy` with the critics `buildMediaCritics()`
 * returns, when `MEDIA_PLANNER_JUDGE_ENABLED` is on (Section A, 2026-09-23).
 *
 * IMPORTANT: `config` (`api/src/config/index.ts`) is `deepFreeze`d at
 * module load — `config.mediaPlanner.judgeEnabled = true` in a test body
 * would throw (or silently no-op) rather than take effect. The env var
 * MUST be set BEFORE `@/config` (and anything that imports it, including
 * `capabilities-routes.ts`) is first imported by this process. This file
 * therefore sets `process.env.MEDIA_PLANNER_JUDGE_ENABLED` and
 * `process.env.MEDIA_PLANNER_ENABLED` at the very top, before any import —
 * it only ever exercises the "enabled" path.
 */
process.env.MEDIA_PLANNER_ENABLED = 'true';
process.env.MEDIA_PLANNER_JUDGE_ENABLED = 'true';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
    request.user = {
      userId: 'user-media-plan-test',
      organizationId: 'org-media-plan-test',
      roles: ['user'],
      email: 'test@example.test',
      name: 'Test User',
    };
  }),
}));
vi.mock('@/services/anonymous-quota-gate', () => ({
  rejectAnonymousGuestKeyPreHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/services/free-tier-quota-gate', () => ({
  rejectChatFreeTierKeyPreHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/api/middleware/tenant-isolation-middleware', () => ({
  requireTenantContext: () => vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/services/model-catalog-service', () => ({
  getAllCatalogModels: vi.fn().mockResolvedValue([]),
}));
// `buildMediaCritics` (mocked below) is the only consumer of the provider
// registry on this code path, and it too is mocked — but the route still
// calls the REAL `getProviderRegistry()` to build the arg it passes in, so
// a fake registry object is enough to avoid the real
// "Provider registry not initialized" throw in this DB/provider-free
// route-test harness.
vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: vi.fn().mockReturnValue({}),
}));
// `createOrchestrationContext` (route handler) never sets `context.invoker`
// for this route, so `MediaPlannerStrategy.callPlannerModel()` always falls
// back to the real `getCapabilityExecutionService()` singleton to decide
// each turn's action (media-planner-strategy.ts:541-554). Left unmocked,
// that singleton would attempt a genuine LLM chat completion, which never
// resolves in this network-free unit-test harness and hangs the request
// until the global test timeout. Mock it to resolve immediately with a
// single valid `final` planner action so the strategy terminates after its
// first turn — matches the pattern `media-planner-strategy.test.ts` uses
// (a fast, deterministic stand-in for the planner's own reasoning call),
// adapted to a module-level `vi.mock` since this is a route-level test
// rather than one that can inject `context.invoker` directly.
vi.mock('@/services/capability-execution-service', () => ({
  getCapabilityExecutionService: vi.fn().mockReturnValue({
    executeWithCapabilities: vi.fn().mockResolvedValue({
      success: true,
      response: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: 'final',
                content: 'done',
                unmetConstraints: [],
              }),
            },
          },
        ],
      },
    }),
  }),
}));

const mockConstructorCalls: unknown[] = [];
vi.mock('@/core/orchestration/strategies/media-consensus-strategy', () => {
  class MockMediaConsensusStrategy {
    constructor(deps: unknown) {
      mockConstructorCalls.push(deps);
    }
    execute() {
      return Promise.resolve({
        bestCandidateIndex: undefined,
        bestArtifact: undefined,
        candidates: [],
        totalJudgeCostUsd: 0,
        totalDurationMs: 1,
        degraded: true,
        degradedReason: 'no_candidates',
      });
    }
  }
  return { MediaConsensusStrategy: MockMediaConsensusStrategy };
});

const buildMediaCriticsMock = vi.fn();
vi.mock('@/core/orchestration/strategies/media-critics-factory', () => ({
  buildMediaCritics: (...args: unknown[]) => buildMediaCriticsMock(...args),
}));

describe('POST /v1/capabilities/media-plan/execute — critics wiring (MEDIA_PLANNER_JUDGE_ENABLED=true)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const { registerCapabilitiesRoutes } = await import('../capabilities-routes');
    server = Fastify();
    await registerCapabilitiesRoutes(server);
    await server.ready();
  }, 30_000);

  afterAll(async () => {
    await server.close();
    delete process.env.MEDIA_PLANNER_ENABLED;
    delete process.env.MEDIA_PLANNER_JUDGE_ENABLED;
  });

  beforeEach(() => {
    mockConstructorCalls.length = 0;
    buildMediaCriticsMock.mockReset();
  });

  it('wires the critics + reason returned by buildMediaCritics into MediaConsensusStrategy', async () => {
    const fakeCritics = [{ role: 'spec_compliance', evaluator: { mode: 'llm_judge', id: 'x', evaluate: vi.fn() } }];
    buildMediaCriticsMock.mockResolvedValue({ critics: fakeCritics, qualityJudgingUnavailableReason: undefined });

    await server.inject({
      method: 'POST',
      url: '/v1/capabilities/media-plan/execute',
      payload: { messages: [{ role: 'user', content: 'make a video and a picture of a cat' }] },
    });

    expect(buildMediaCriticsMock).toHaveBeenCalledTimes(1);
    expect(mockConstructorCalls).toHaveLength(1);
    const deps = mockConstructorCalls[0] as {
      critics: unknown;
      qualityJudgingUnavailableReason: unknown;
    };
    expect(deps.critics).toBe(fakeCritics);
    expect(deps.qualityJudgingUnavailableReason).toBeUndefined();
  });

  it('wires an empty critics array + the degrade reason through when buildMediaCritics reports no judge model resolved', async () => {
    const degradeReason = 'quality judging unavailable: no vision-capable judge model configured';
    buildMediaCriticsMock.mockResolvedValue({ critics: [], qualityJudgingUnavailableReason: degradeReason });

    await server.inject({
      method: 'POST',
      url: '/v1/capabilities/media-plan/execute',
      payload: { messages: [{ role: 'user', content: 'make a video and a picture of a cat' }] },
    });

    expect(buildMediaCriticsMock).toHaveBeenCalledTimes(1);
    expect(mockConstructorCalls).toHaveLength(1);
    const deps = mockConstructorCalls[0] as {
      critics: unknown;
      qualityJudgingUnavailableReason: unknown;
    };
    expect(deps.critics).toEqual([]);
    expect(deps.qualityJudgingUnavailableReason).toBe(degradeReason);
  });
});
