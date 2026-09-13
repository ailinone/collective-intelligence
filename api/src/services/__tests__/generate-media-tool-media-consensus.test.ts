// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `generate_media` tool handler — media-generation-delegation plan, PR2.
 *
 * The whole point of `generate_media` (registered in
 * `registerToolsInRegistry()`, chat-request-processor.ts) is that it routes
 * through `MediaConsensusStrategy.execute()` — N independent candidates, a
 * deterministic quality gate, best pick — instead of a naive single-shot
 * call directly against `VideoOrchestrationService` /
 * `ImagesOrchestrationService` (the way the older `generate_video` tool
 * does). This suite mocks exactly at that boundary
 * (`MediaConsensusStrategy`) and asserts the handler genuinely calls
 * `.execute()` on it, with the shape `MediaConsensusRequest` expects — NOT
 * the raw orchestration services directly.
 *
 * Also covers the artifact half of PR2: a successful `MediaConsensusResult`
 * must populate `ToolResult.artifact` (PR1 plumbing,
 * advanced-tool-execution-service.ts) so it can survive into
 * `ModelExecution.artifacts` once `executeModelWithTools` runs this tool
 * (see execute-model-with-tools-quorum.test.ts for that half, driven against
 * a synthetic tool rather than this real one).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';

// vi.mock's factory is hoisted above this whole file, so it can only safely
// close over variables named with the `mock` prefix (vitest's own
// convention/requirement for hoisted factories). A real ES `class` (not an
// arrow function or a `vi.fn().mockImplementation(arrowFn)`) is used for the
// constructor itself — an arrow function has no [[Construct]] behavior, and
// an earlier version of this test that used one silently produced an
// instance whose `execute` was never wired to the spy (`new` "succeeded" but
// didn't run the arrow body as a constructor).
const mockExecute = vi.fn();
const mockConstructorCalls: unknown[] = [];

vi.mock('@/core/orchestration/strategies/media-consensus-strategy', () => {
  class MockMediaConsensusStrategy {
    constructor(deps: unknown) {
      mockConstructorCalls.push(deps);
    }
    execute(request: unknown) {
      return mockExecute(request);
    }
  }
  return { MediaConsensusStrategy: MockMediaConsensusStrategy };
});

// Real service classes (constructor-only, no network calls) — genuinely
// injected into MediaConsensusStrategy, exactly like capabilities-routes.ts
// does. Not mocked: the point of the test is that the HANDLER never calls
// their generation methods directly, and it doesn't need to for that
// assertion to hold.
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

describe('generate_media tool handler', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockConstructorCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is registered strategyExecutionMode:"quorumOnly" and safeForStrategies:false', async () => {
    await ensureToolsRegistered();
    const registration = toolRegistry.get('generate_media');
    expect(registration?.safeForStrategies).toBe(false);
    expect(registration?.strategyExecutionMode).toBe('quorumOnly');
  });

  it('routes image generation through MediaConsensusStrategy.execute(), not a raw orchestration service call', async () => {
    await ensureToolsRegistered();
    mockExecute.mockResolvedValueOnce({
      bestCandidateIndex: 0,
      bestArtifact: {
        modality: 'image',
        stage_name: 'generate_media_tool',
        stage_index: 0,
        url: 'https://example.com/best-image.png',
        provider: 'test-provider',
        model: 'test-model',
      },
      candidates: [{}, {}],
      totalJudgeCostUsd: 0,
      totalDurationMs: 5,
      degraded: false,
    });

    const result = await toolRegistry.execute(
      'generate_media',
      { type: 'image', prompt: 'a red bicycle' },
      'call_1',
      { workingDirectory: process.cwd(), log: makeLog(), organizationId: 'org_1', userId: 'user_1' }
    );

    // The boundary assertion: MediaConsensusStrategy was constructed and its
    // execute() was actually called with the right shape.
    expect(mockConstructorCalls).toHaveLength(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [call] = mockExecute.mock.calls;
    expect(call[0]).toMatchObject({
      capability: 'image_generation',
      prompt: 'a red bicycle',
    });

    expect(result.success).toBe(true);
    expect(result.artifact).toEqual({
      type: 'image',
      url: 'https://example.com/best-image.png',
      meta: {
        provider: 'test-provider',
        model: 'test-model',
        candidateIndex: 0,
        degraded: false,
      },
    });
  });

  it('routes video generation through MediaConsensusStrategy.execute() with capability:"video_generation"', async () => {
    await ensureToolsRegistered();
    mockExecute.mockResolvedValueOnce({
      bestCandidateIndex: 1,
      bestArtifact: {
        modality: 'video',
        stage_name: 'generate_media_tool',
        stage_index: 0,
        url: 'https://example.com/best-video.mp4',
        provider: 'test-provider',
        model: 'test-model',
      },
      candidates: [{}, {}],
      totalJudgeCostUsd: 0,
      totalDurationMs: 5,
      degraded: false,
    });

    const result = await toolRegistry.execute(
      'generate_media',
      { type: 'video', prompt: 'a cat riding a bike' },
      'call_2',
      { workingDirectory: process.cwd(), log: makeLog() }
    );

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [call] = mockExecute.mock.calls;
    expect(call[0]).toMatchObject({ capability: 'video_generation', prompt: 'a cat riding a bike' });
    expect(result.success).toBe(true);
    expect(result.artifact?.type).toBe('video');
    expect(result.artifact?.url).toBe('https://example.com/best-video.mp4');
  });

  it('fails cleanly without calling MediaConsensusStrategy when "type" is missing/invalid', async () => {
    await ensureToolsRegistered();
    const result = await toolRegistry.execute(
      'generate_media',
      { prompt: 'no type given' },
      'call_3',
      { workingDirectory: process.cwd(), log: makeLog() }
    );
    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('fails cleanly without calling MediaConsensusStrategy when "prompt" is empty', async () => {
    await ensureToolsRegistered();
    const result = await toolRegistry.execute(
      'generate_media',
      { type: 'image', prompt: '' },
      'call_4',
      { workingDirectory: process.cwd(), log: makeLog() }
    );
    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('surfaces a degraded/no-candidate MediaConsensusResult as a failed ToolResult without a fabricated artifact', async () => {
    await ensureToolsRegistered();
    mockExecute.mockResolvedValueOnce({
      bestCandidateIndex: undefined,
      bestArtifact: undefined,
      candidates: [{}],
      totalJudgeCostUsd: 0,
      totalDurationMs: 5,
      degraded: true,
      degradedReason: 'all_candidates_outliers',
    });

    const result = await toolRegistry.execute(
      'generate_media',
      { type: 'image', prompt: 'a red bicycle' },
      'call_5',
      { workingDirectory: process.cwd(), log: makeLog() }
    );

    expect(result.success).toBe(false);
    expect(result.artifact).toBeUndefined();
  });
});
