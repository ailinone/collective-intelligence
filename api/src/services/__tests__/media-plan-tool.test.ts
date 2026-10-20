// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `media_plan` tool handler (2026-10-02) — explicit tool access to the FULL
 * MediaPlannerStrategy, reusing the orchestration engine's memoized strategy
 * via `runMediaPlannerRequest` (see orchestration-engine.ts). Mocks exactly
 * at that boundary (the engine singleton) and asserts:
 *
 *  - registration policy: safeForStrategies:false + quorumOnly (same
 *    quorum-gated auto-execution policy as generate_media — the planner fans
 *    out into MULTIPLE billable generations per invocation);
 *  - the engine boundary is genuinely exercised (routed / not-routed /
 *    degraded outcomes shape the ToolResult correctly);
 *  - args validation happens BEFORE the engine is touched;
 *  - the MEDIA_PLANNER_ENABLED flag stays inside the engine's
 *    resolveMediaPlanRouting choke point — the handler never decides
 *    flag policy itself (it only surfaces `routed:false` as
 *    media_planner_not_applicable).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';

const mockRunMediaPlannerRequest = vi.fn();

vi.mock('@/core/orchestration/orchestration-engine', () => ({
  getOrchestrationEngine: () => ({
    runMediaPlannerRequest: (...args: unknown[]) => mockRunMediaPlannerRequest(...args),
  }),
}));

// The handler resolves `OrchestrationContext.models` from the model catalog.
// Mocked to keep the suite hermetic (no DB/catalog access).
const getAllCatalogModelsMock = vi.fn(async () => []);
vi.mock('@/services/model-catalog-service', () => ({
  getAllCatalogModels: (...args: unknown[]) => getAllCatalogModelsMock(...args),
}));

import { registerToolsInRegistry } from '../chat-request-processor';
import { toolRegistry } from '@/core/tools/tool-registry';

function makeLog(): Logger {
  const noop = () => undefined;
  const log = {
    info: vi.fn(noop),
    warn: vi.fn(noop),
    error: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    fatal: vi.fn(noop),
    child: () => log,
    level: 'info',
  };
  return log as unknown as Logger;
}

async function ensureToolsRegistered(): Promise<void> {
  registerToolsInRegistry();
  await vi.waitFor(() => {
    if (!toolRegistry.isInitialized()) throw new Error('tool registry not yet initialized');
  });
}

function makePlannerResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    strategyUsed: 'agentic',
    modelsUsed: [],
    finalResponse: {
      id: 'resp_1',
      object: 'chat.completion',
      created: 1,
      model: 'auto',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'plan executed' },
          finish_reason: 'stop',
        },
      ],
    },
    totalCost: 0.25,
    totalDuration: 1500,
    metadata: {},
    artifacts: [
      {
        modality: 'image',
        stage_name: 'stage_1',
        stage_index: 0,
        url: 'https://example.com/planned-image.png',
        provider: 'test-provider',
        model: 'test-model',
      },
    ],
    ...overrides,
  };
}

describe('media_plan tool handler', () => {
  beforeEach(() => {
    mockRunMediaPlannerRequest.mockReset();
    getAllCatalogModelsMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is registered strategyExecutionMode:"quorumOnly" and safeForStrategies:false', async () => {
    await ensureToolsRegistered();
    const registration = toolRegistry.get('media_plan');
    expect(registration?.safeForStrategies).toBe(false);
    expect(registration?.strategyExecutionMode).toBe('quorumOnly');
  });

  it('routes through the engine runMediaPlannerRequest boundary and maps the planner result', async () => {
    await ensureToolsRegistered();
    mockRunMediaPlannerRequest.mockResolvedValueOnce({
      routed: true,
      reason: 'multiple capabilities detected: video_generation, image_generation',
      detectedCapabilities: ['video_generation', 'image_generation'],
      result: makePlannerResult(),
    });

    const result = await toolRegistry.execute(
      'media_plan',
      { prompt: 'a 10 second 1080p video of a red bicycle with a soundtrack' },
      'call_1',
      { workingDirectory: process.cwd(), log: makeLog(), organizationId: 'org_1', userId: 'user_1' }
    );

    expect(mockRunMediaPlannerRequest).toHaveBeenCalledTimes(1);
    const [request, context] = mockRunMediaPlannerRequest.mock.calls[0] as [
      { messages: { role: string; content: string }[] },
      { organizationId: string; requestId: string; taskType: string },
    ];
    expect(request.messages).toEqual([
      { role: 'user', content: 'a 10 second 1080p video of a red bicycle with a soundtrack' },
    ]);
    expect(context.organizationId).toBe('org_1');
    expect(context.requestId).toBe('media_plan-call_1');

    expect(result.success).toBe(true);
    expect(result.cost).toBe(0.25);
    expect(result.artifact).toEqual({
      type: 'image',
      url: 'https://example.com/planned-image.png',
      meta: { provider: 'test-provider', model: 'test-model' },
    });
    const output = JSON.parse(result.output ?? '{}') as {
      routedReason: string;
      detectedCapabilities: string[];
      unmetConstraints: unknown[];
    };
    expect(output.routedReason).toContain('multiple capabilities');
    expect(output.detectedCapabilities).toEqual(['video_generation', 'image_generation']);
    expect(output.unmetConstraints).toEqual([]);
  });

  it('surfaces routed:false as a failed media_planner_not_applicable ToolResult', async () => {
    await ensureToolsRegistered();
    mockRunMediaPlannerRequest.mockResolvedValueOnce({
      routed: false,
      reason: 'MEDIA_PLANNER_ENABLED is false',
      detectedCapabilities: [],
    });

    const result = await toolRegistry.execute(
      'media_plan',
      { prompt: 'generate an image' },
      'call_2',
      { workingDirectory: process.cwd(), log: makeLog(), organizationId: 'org_1' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('media_planner_not_applicable: MEDIA_PLANNER_ENABLED is false');
    expect(result.artifact).toBeUndefined();
  });

  it('fails cleanly without touching the engine when "prompt" is missing/empty', async () => {
    await ensureToolsRegistered();

    const noPrompt = await toolRegistry.execute('media_plan', {}, 'call_3', {
      workingDirectory: process.cwd(),
      log: makeLog(),
    });
    const emptyPrompt = await toolRegistry.execute('media_plan', { prompt: '' }, 'call_4', {
      workingDirectory: process.cwd(),
      log: makeLog(),
    });

    expect(noPrompt.success).toBe(false);
    expect(emptyPrompt.success).toBe(false);
    expect(mockRunMediaPlannerRequest).not.toHaveBeenCalled();
  });

  it('maps declared modalities onto OrchestrationContext.requiredCapabilities (unknown strings skipped)', async () => {
    await ensureToolsRegistered();
    mockRunMediaPlannerRequest.mockResolvedValueOnce({
      routed: true,
      reason: 'multiple capabilities detected',
      detectedCapabilities: ['video_generation', 'web_search'],
      result: makePlannerResult(),
    });

    await toolRegistry.execute(
      'media_plan',
      { prompt: 'compose it', modalities: ['video', 'web', 'nonsense-modality', 42] },
      'call_6',
      { workingDirectory: process.cwd(), log: makeLog(), organizationId: 'org_1' }
    );

    const [, context] = mockRunMediaPlannerRequest.mock.calls[0] as [
      unknown,
      { requiredCapabilities: string[] },
    ];
    expect(context.requiredCapabilities).toEqual(['video_generation', 'web_search']);
  });

  it('surfaces a degraded planner execution as a failed ToolResult without a fabricated artifact', async () => {
    await ensureToolsRegistered();
    mockRunMediaPlannerRequest.mockResolvedValueOnce({
      routed: true,
      reason: 'multiple capabilities detected: video_generation',
      detectedCapabilities: ['video_generation'],
      result: makePlannerResult({
        metadata: { degraded: true },
        finalResponse: {
          id: 'resp_2',
          object: 'chat.completion',
          created: 1,
          model: 'auto',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '[DEGRADED] planner could not satisfy constraints',
              },
              finish_reason: 'stop',
            },
          ],
        },
        artifacts: [],
      }),
    });

    const result = await toolRegistry.execute(
      'media_plan',
      { prompt: 'an impossible composition' },
      'call_5',
      { workingDirectory: process.cwd(), log: makeLog(), organizationId: 'org_1' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('[DEGRADED]');
    expect(result.artifact).toBeUndefined();
  });
});
