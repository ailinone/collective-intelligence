// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Section E (2026-09-23 MediaPlanner completion design) — the chat/triage
 * pipeline safety net into MediaPlannerStrategy.
 */
import { describe, it, expect } from 'vitest';
import { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import { MediaPlannerStrategy } from '@/core/orchestration/strategies/media-planner-strategy';
import type { ProviderRegistry } from '@/providers/provider-registry';
import { vi, beforeEach } from 'vitest';
import type { ChatRequest, OrchestrationContext, OrchestrationResult, TriageDecision } from '@/types';

vi.mock('@/core/orchestration/strategies/media-planner-gate', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/core/orchestration/strategies/media-planner-gate')
  >();
  return {
    ...actual,
    evaluateMediaPlannerGate: vi.fn(actual.evaluateMediaPlannerGate),
    resolveEffectiveMediaPlannerEnabled: vi.fn(),
  };
});

import {
  evaluateMediaPlannerGate,
  resolveEffectiveMediaPlannerEnabled,
} from '@/core/orchestration/strategies/media-planner-gate';

type MaybeRoute = (
  request: ChatRequest,
  context: OrchestrationContext,
  requestId: string
) => Promise<OrchestrationResult | undefined>;

function callMaybeRoute(
  engine: OrchestrationEngine,
  request: ChatRequest,
  context: OrchestrationContext
): Promise<OrchestrationResult | undefined> {
  return (
    engine as unknown as { maybeRouteToMediaPlannerSafetyNet: MaybeRoute }
  ).maybeRouteToMediaPlannerSafetyNet(request, context, 'req-test');
}

function baseContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    requestId: 'req-test',
    models: [],
    requiredCapabilities: [],
    ...overrides,
  } as OrchestrationContext;
}

function makeEngine(): OrchestrationEngine {
  return new OrchestrationEngine({
    providerRegistry: {
      getAllModels: async () => [],
      findModel: async () => null,
      findModelByName: async () => null,
      getProviderNames: () => [],
    } as unknown as ProviderRegistry,
    enableTriaging: false,
  });
}

function getStrategy(engine: OrchestrationEngine): MediaPlannerStrategy {
  return (
    engine as unknown as { getMediaPlannerStrategy: () => MediaPlannerStrategy }
  ).getMediaPlannerStrategy();
}

describe('OrchestrationEngine.getMediaPlannerStrategy', () => {
  it('lazily constructs a MediaPlannerStrategy instance', () => {
    const engine = makeEngine();
    const strategy = getStrategy(engine);
    expect(strategy).toBeInstanceOf(MediaPlannerStrategy);
  });

  it('memoizes the instance across calls', () => {
    const engine = makeEngine();
    const first = getStrategy(engine);
    const second = getStrategy(engine);
    expect(first).toBe(second);
  });
});

describe('OrchestrationEngine.maybeRouteToMediaPlannerSafetyNet', () => {
  const gateSpy = vi.mocked(evaluateMediaPlannerGate);
  const enabledSpy = vi.mocked(resolveEffectiveMediaPlannerEnabled);

  beforeEach(() => {
    gateSpy.mockClear();
    enabledSpy.mockReset();
  });

  it('returns undefined WITHOUT calling the gate or the effective-flag resolver for a plain, successfully-triaged non-media request', async () => {
    const engine = makeEngine();
    const context = baseContext({
      requiredCapabilities: ['reasoning'],
      triage: { intent: 'general', complexity: 'low', source: 'llm' } as TriageDecision,
    });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(result).toBeUndefined();
    expect(enabledSpy).not.toHaveBeenCalled();
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('returns undefined when media-shaped but the effective flag (global+canary) is off', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(false);
    const context = baseContext({ requiredCapabilities: ['image_generation'] });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'generate an image of a cat' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(result).toBeUndefined();
    expect(enabledSpy).toHaveBeenCalledWith('org-1');
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('routes into MediaPlannerStrategy when media-shaped, the effective flag is on, and the gate says route', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    const context = baseContext({ requiredCapabilities: ['image_generation', 'video_generation'] });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'generate a 30s 4k video AND a matching poster image' }],
    };

    const strategy = getStrategy(engine);
    const mockResult: OrchestrationResult = {
      strategyUsed: 'single',
      modelsUsed: [],
      finalResponse: {
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: 'auto',
        choices: [],
      },
      totalCost: 0,
      totalDuration: 0,
      metadata: {},
    };
    const executeSpy = vi.spyOn(strategy, 'execute').mockResolvedValue(mockResult);

    const result = await callMaybeRoute(engine, request, context);

    expect(executeSpy).toHaveBeenCalledWith(request, context);
    expect(result).toBe(mockResult);
  });

  it('does NOT route into MediaPlannerStrategy when the gate declines even though the flag is on', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    const context = baseContext({ requiredCapabilities: ['image_generation'] });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'generate an image of a cat' }],
    };
    const strategy = getStrategy(engine);
    const executeSpy = vi.spyOn(strategy, 'execute');

    const result = await callMaybeRoute(engine, request, context);

    // Single media capability with no multi-capability/attribute constraint
    // is the gate's own documented "stay on the direct route" case.
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('is also evaluated when triage fell back to heuristics, even with no media capability pre-detected', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    const context = baseContext({
      requiredCapabilities: [],
      triage: { intent: 'general', complexity: 'low', source: 'heuristic' } as TriageDecision,
    });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'just chatting, nothing media-related here' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(enabledSpy).toHaveBeenCalledWith('org-1');
    expect(gateSpy).toHaveBeenCalledWith(request, context);
    expect(result).toBeUndefined();
  });
});

describe('OrchestrationEngine.maybeRouteToMediaPlannerSafetyNet — explicit failure path', () => {
  const gateSpy = vi.mocked(evaluateMediaPlannerGate);
  const enabledSpy = vi.mocked(resolveEffectiveMediaPlannerEnabled);

  beforeEach(() => {
    gateSpy.mockClear();
    enabledSpy.mockReset();
  });

  it('returns a structured [DEGRADED] response when heuristic triage found no media capability but the gate independently detects one', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    gateSpy.mockReturnValue({
      route: false,
      reason: 'single media-generation capability with no explicit attribute constraint',
      detectedCapabilities: ['video_generation'],
      detectedConstraints: {},
    });
    const context = baseContext({
      requiredCapabilities: [],
      triage: { intent: 'general', complexity: 'low', source: 'heuristic' } as TriageDecision,
    });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'make me a short clip, you know the vibe' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(result).toBeDefined();
    expect(result?.metadata.degraded).toBe(true);
    expect(result?.metadata.degraded_reason).toBe(
      'media_shaped_request_capabilities_unresolved'
    );
    expect(result?.finalResponse.choices[0].message.content).toContain('[DEGRADED]');
  });

  it('does NOT degrade when triage already resolved a media capability (planTouchesMediaGeneration true)', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    gateSpy.mockReturnValue({
      route: false,
      reason: 'single media-generation capability with no explicit attribute constraint',
      detectedCapabilities: ['video_generation'],
      detectedConstraints: {},
    });
    const context = baseContext({
      requiredCapabilities: ['video_generation'],
      triage: { intent: 'general', complexity: 'low', source: 'heuristic' } as TriageDecision,
    });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'generate a video of a sunset' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(result).toBeUndefined();
  });

  it('does NOT degrade when the gate detects no media keywords at all', async () => {
    const engine = makeEngine();
    enabledSpy.mockResolvedValue(true);
    gateSpy.mockReturnValue({
      route: false,
      reason: 'no media-generation capability detected',
      detectedCapabilities: [],
      detectedConstraints: {},
    });
    const context = baseContext({
      requiredCapabilities: [],
      triage: { intent: 'general', complexity: 'low', source: 'heuristic' } as TriageDecision,
    });
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'just chatting, nothing media-related here' }],
    };

    const result = await callMaybeRoute(engine, request, context);

    expect(result).toBeUndefined();
  });
});

describe('OrchestrationEngine.execute — MediaPlanner safety net resilience', () => {
  // Task 8 IMPORTANT ADDITION: prove that execute()'s try/catch around the
  // safety-net call site actually swallows a throw from
  // maybeRouteToMediaPlannerSafetyNet(), instead of letting it propagate and
  // fail what would otherwise be a normal chat completion. This exercises
  // the REAL execute() flow (not a re-implementation of the try/catch) —
  // forcing the throw via a spy on the private method, which is simpler and
  // more robust than contriving a context shape that reaches the gate logic
  // naturally, since the goal here is purely to prove the surrounding
  // try/catch, not to re-test the gate's own routing decisions (already
  // covered above).
  it('does not propagate when maybeRouteToMediaPlannerSafetyNet throws, and falls through to the normal chat pipeline', async () => {
    const engine = makeEngine();
    const logErrorSpy = vi.spyOn(
      (engine as unknown as { log: { error: (...args: unknown[]) => void } }).log,
      'error'
    );
    vi.spyOn(
      engine as unknown as { maybeRouteToMediaPlannerSafetyNet: MaybeRoute },
      'maybeRouteToMediaPlannerSafetyNet'
    ).mockRejectedValue(new Error('boom-safety-net'));

    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
    };

    let thrown: unknown;
    let result: OrchestrationResult | undefined;
    try {
      result = await engine.execute(request, 'org-1', 'user-1');
    } catch (error) {
      thrown = error;
    }

    // The core resilience claim: execute() must resolve, not reject, even
    // though its safety-net call rejected.
    expect(thrown).toBeUndefined();
    expect(result).toBeDefined();
    // It fell through to the ordinary chat pipeline (single-strategy dispatch),
    // not a MediaPlanner-produced result — proving the catch block treated
    // the throw exactly like an undefined (not-routed) return.
    expect(result?.strategyUsed).toBe('single');

    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'MediaPlanner safety net threw; continuing with normal chat pipeline'
    );
  }, 15000);
});
