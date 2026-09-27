// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `generate_media` tool handler — critics wiring when
 * MEDIA_PLANNER_JUDGE_ENABLED=true (Section A, 2026-09-23).
 *
 * Kept in its OWN file (not added to generate-media-tool-media-consensus.test.ts)
 * because `config` is `deepFreeze`d at module load
 * (api/src/config/index.ts) — the env var below must be set before
 * `@/config` (and anything importing it, including chat-request-processor.ts)
 * is first imported in this process/module graph.
 *
 * IMPORTANT: `chat-request-processor` and `tool-registry` are loaded via a
 * DYNAMIC `await import(...)` inside `beforeAll`, not a static top-level
 * `import`, and for the same reason: ES module semantics hoist static
 * imports so the imported module's top-level code runs before this file's
 * own top-level statements — including the `process.env...` assignment
 * above, even though it is textually first. A static import here would
 * therefore load `@/config` (transitively, via chat-request-processor.ts)
 * BEFORE the env var is set, baking in `judgeEnabled: false` regardless of
 * this file's intent. Task 8's route-level test
 * (media-plan-execute-critics-wiring.test.ts) uses the same dynamic-import
 * pattern for the same reason.
 */
process.env.MEDIA_PLANNER_JUDGE_ENABLED = 'true';

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Logger } from 'pino';

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

const buildMediaCriticsMock = vi.fn();
vi.mock('@/core/orchestration/strategies/media-critics-factory', () => ({
  buildMediaCritics: (...args: unknown[]) => buildMediaCriticsMock(...args),
}));

// `getProviderRegistry()` is called by the real handler to build the arg it
// passes into `buildMediaCritics` (mocked above), but the registry itself is
// never touched inside this test's process (no DB/provider init happens in
// this hermetic unit-test harness) — mock it to a stub object so the real
// "Provider registry not initialized" throw never fires, same pattern as
// Task 8's route test (media-plan-execute-critics-wiring.test.ts).
vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: vi.fn().mockReturnValue({}),
}));

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

describe('generate_media tool handler — critics wiring (MEDIA_PLANNER_JUDGE_ENABLED=true)', () => {
  let toolRegistry: typeof import('@/core/tools/tool-registry').toolRegistry;

  beforeAll(async () => {
    const { registerToolsInRegistry } = await import('../chat-request-processor');
    ({ toolRegistry } = await import('@/core/tools/tool-registry'));
    registerToolsInRegistry();
    await vi.waitFor(() => {
      if (!toolRegistry.isInitialized()) throw new Error('tool registry not yet initialized');
    });
  }, 30_000);

  beforeEach(() => {
    mockExecute.mockReset();
    mockConstructorCalls.length = 0;
    buildMediaCriticsMock.mockReset();
  });

  afterAll(() => {
    delete process.env.MEDIA_PLANNER_JUDGE_ENABLED;
  });

  it('wires the critics returned by buildMediaCritics into MediaConsensusStrategy', async () => {
    const fakeCritics = [
      { role: 'spec_compliance', evaluator: { mode: 'llm_judge', id: 'c1', evaluate: vi.fn() } },
      { role: 'artifact_quality', evaluator: { mode: 'llm_judge', id: 'c2', evaluate: vi.fn() } },
      { role: 'tone', evaluator: { mode: 'llm_judge', id: 'c3', evaluate: vi.fn() } },
    ];
    buildMediaCriticsMock.mockResolvedValueOnce({
      critics: fakeCritics,
      qualityJudgingUnavailableReason: undefined,
    });

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
      totalJudgeCostUsd: 0.03,
      totalDurationMs: 5,
      degraded: false,
    });

    await toolRegistry.execute(
      'generate_media',
      { type: 'image', prompt: 'a red bicycle' },
      'call_critics',
      { workingDirectory: process.cwd(), log: makeLog(), organizationId: 'org_1', userId: 'user_1' }
    );

    expect(buildMediaCriticsMock).toHaveBeenCalledTimes(1);
    expect(mockConstructorCalls).toHaveLength(1);
    expect((mockConstructorCalls[0] as { critics: unknown }).critics).toBe(fakeCritics);
  });

  it('wires an empty critics array + the degrade reason through when buildMediaCritics reports no judge model resolved', async () => {
    const degradeReason = 'quality judging unavailable: no vision-capable judge model configured';
    buildMediaCriticsMock.mockResolvedValueOnce({
      critics: [],
      qualityJudgingUnavailableReason: degradeReason,
    });

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

    await toolRegistry.execute(
      'generate_media',
      { type: 'image', prompt: 'a red bicycle' },
      'call_critics_degraded',
      { workingDirectory: process.cwd(), log: makeLog(), organizationId: 'org_1', userId: 'user_1' }
    );

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
