// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * MediaPlannerStrategy (LOTE AT, Part 2) — bounded turn-loop tests.
 *
 * All underlying capability calls are mocked via constructor DI
 * (`capabilityDispatcher`, `mediaConsensusExecutor`) and via
 * `context.invoker` — nothing here touches a real provider, the DB, or
 * network. `persistMediaPlanRun` is mocked at the module level so the test
 * never touches Prisma/the DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AilinArtifact, ChatRequest, Model, OrchestrationContext } from '@/types';
import type { CapabilityInvoker } from '@/core/orchestration/capability-invoker';
import type { CapabilityModeResult } from '@/routes/capabilities/capabilities-routes';
import type { MediaConsensusExecutor, MediaConsensusResultLike } from '../media-planner-types';

const persistMediaPlanRunMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../media-planner-repository', () => ({
  persistMediaPlanRun: (...args: unknown[]) => persistMediaPlanRunMock(...args),
}));

// Import AFTER the mock is registered.
const { MediaPlannerStrategy } = await import('../media-planner-strategy');

function makeModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    id: overrides.id,
    providerId: overrides.providerId ?? `provider-${overrides.id}`,
    provider: overrides.provider ?? `provider-${overrides.id}`,
    name: overrides.name ?? overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    contextWindow: overrides.contextWindow ?? 128000,
    maxOutputTokens: overrides.maxOutputTokens ?? 4096,
    inputCostPer1k: overrides.inputCostPer1k ?? 0.001,
    outputCostPer1k: overrides.outputCostPer1k ?? 0.002,
    capabilities: overrides.capabilities ?? ['video_generation'],
    performance: overrides.performance ?? {
      latencyMs: 1000,
      throughput: 100,
      quality: 0.9,
      reliability: 0.95,
    },
    status: overrides.status ?? 'active',
    balanceStatus: overrides.balanceStatus ?? 'has-credits',
    metadata: overrides.metadata,
  };
}

function makeRequest(text: string): ChatRequest {
  return { model: 'auto', messages: [{ role: 'user', content: text }] };
}

function makeInvoker(overrides: Partial<CapabilityInvoker> = {}): CapabilityInvoker {
  return {
    chat: vi.fn().mockRejectedValue(new Error('chat() not stubbed for this test')),
    transcribe: vi.fn().mockRejectedValue(new Error('not implemented')),
    synthesize: vi.fn().mockRejectedValue(new Error('not implemented')),
    translate: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateVideo: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateImage: vi.fn().mockRejectedValue(new Error('not implemented')),
    generateFile: vi.fn().mockRejectedValue(new Error('not implemented')),
    ...overrides,
  };
}

function makeContext(
  models: Model[],
  invoker: CapabilityInvoker,
  overrides: Partial<OrchestrationContext> = {}
): OrchestrationContext {
  return {
    organizationId: 'org-test',
    userId: 'user-test',
    requestId: 'req-test',
    models,
    taskType: 'creative',
    contextSize: 1000,
    invoker,
    ...overrides,
  };
}

/** Wraps a JSON-serializable planner action as a chat() response. */
function chatJson(value: unknown) {
  return {
    id: 'r',
    object: 'chat.completion' as const,
    created: 0,
    model: 'planner-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as const, content: JSON.stringify(value) },
        finish_reason: 'stop' as const,
        logprobs: null,
      },
    ],
  };
}

beforeEach(() => {
  persistMediaPlanRunMock.mockClear();
});

describe('MediaPlannerStrategy — metadata', () => {
  it('exposes strategy id/name "media-planner"', () => {
    const strategy = new MediaPlannerStrategy();
    const metadata = strategy.getMetadata();
    expect(metadata.id).toBe('media-planner');
    expect(metadata.name).toBe('media-planner');
  });
});

describe('MediaPlannerStrategy — happy path (30s/4K/audio+soundtrack example)', () => {
  it('generates via MediaConsensusExecutor, then reports an unmet soundtrack constraint (no music_generation capability)', async () => {
    const invokerChat = vi
      .fn()
      // Turn 0: decompose into a video-generation action with constraints.
      .mockResolvedValueOnce(
        chatJson({
          kind: 'generate',
          capability: 'video_generation',
          prompt: 'a 30 second 4k sunrise video with audio',
          constraints: {
            durationSec: { minSec: 30 },
            resolution: { width: 3840, height: 2160 },
            requireAudioTrack: true,
          },
        })
      )
      // Turn 1: no music_generation capability exists — final with unmetConstraints.
      .mockResolvedValueOnce(
        chatJson({
          kind: 'final',
          content: 'Here is your 30s 4K video. A musical soundtrack could not be added.',
          unmetConstraints: ['musical soundtrack — no music_generation capability exists'],
        })
      );

    const invoker = makeInvoker({ chat: invokerChat });
    const models: Model[] = [makeModel({ id: 'video-model', capabilities: ['video_generation'] })];
    const context = makeContext(models, invoker);

    const bestArtifact: AilinArtifact = {
      modality: 'video',
      stage_name: 'media-plan-turn-0',
      stage_index: 0,
      url: 'https://example.test/video.mp4',
      provider: 'test-provider',
      model: 'video-model',
    };
    const consensusResult: MediaConsensusResultLike = {
      bestCandidateIndex: 0,
      bestArtifact,
      candidates: [{}, {}],
      totalJudgeCostUsd: 0,
      totalDurationMs: 10,
      degraded: false,
    };
    const mediaConsensusExecutor: MediaConsensusExecutor = {
      execute: vi.fn().mockResolvedValue(consensusResult),
    };

    const strategy = new MediaPlannerStrategy({ mediaConsensusExecutor });
    const result = await strategy.execute(makeRequest('a 30 second 4k sunrise video with audio'), context);

    expect(mediaConsensusExecutor.execute).toHaveBeenCalledTimes(1);
    const calledWith = (mediaConsensusExecutor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledWith.capability).toBe('video_generation');
    expect(calledWith.constraints?.requireAudioTrack).toBe(true);

    expect(result.strategyUsed).toBe('media-planner');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts?.[0]).toEqual(bestArtifact);
    expect(result.metadata.unmetConstraints).toEqual([
      'musical soundtrack — no music_generation capability exists',
    ]);
    expect(result.metadata.stopReason).toBe('final');
    expect(result.metadata.degraded).toBeUndefined();
    expect(persistMediaPlanRunMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a final action missing unmetConstraints (structurally enforced by zod)', async () => {
    const invokerChat = vi.fn().mockResolvedValueOnce(
      chatJson({ kind: 'final', content: 'done' /* unmetConstraints omitted on purpose */ })
    );
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const strategy = new MediaPlannerStrategy({ maxTurns: 1 });
    const result = await strategy.execute(makeRequest('generate an image'), context);

    // The parse failure is recorded as an error turn — the loop then runs
    // out of its 1-turn budget without ever reaching a valid `final` action.
    expect(result.metadata.stopReason).toBe('turn_cap_exhausted');
    const plan = result.metadata.plan as Array<{ outcome: { type: string } }>;
    expect(plan[0].outcome.type).toBe('error');
  });
});

describe('MediaPlannerStrategy — turn-cap / budget exhaustion', () => {
  it('stops after maxTurns when the planner never emits a final action', async () => {
    const invokerChat = vi.fn().mockResolvedValue(
      chatJson({ kind: 'capability_call', capability: 'pdf_understanding', body: {} })
    );
    const invoker = makeInvoker({ chat: invokerChat });
    const context = makeContext([], invoker);

    const capabilityDispatcher = vi.fn().mockResolvedValue({
      result: { data: {}, executionPath: 'tool_pipeline' } satisfies CapabilityModeResult,
      fallbackUsed: false,
    });

    const strategy = new MediaPlannerStrategy({ maxTurns: 2, capabilityDispatcher });
    const result = await strategy.execute(makeRequest('summarize this pdf'), context);

    expect(invokerChat).toHaveBeenCalledTimes(2);
    expect(capabilityDispatcher).toHaveBeenCalledTimes(2);
    expect(capabilityDispatcher.mock.calls[0][0]).toMatchObject({ id: 'pdf_understanding' });
    expect(result.metadata.stopReason).toBe('turn_cap_exhausted');
    expect(result.metadata.degraded).toBe(true);
    expect(result.metadata.unmetConstraints).toContain(
      'planner stopped: turn budget exhausted before a final response was produced'
    );
    expect(result.qualityScore).toBe(0);
  });
});

describe('MediaPlannerStrategy — native joint-collapse (§3.3)', () => {
  it('short-circuits MediaConsensusStrategy when a catalog model natively satisfies every constraint', async () => {
    const invokerChat = vi
      .fn()
      .mockResolvedValueOnce(
        chatJson({
          kind: 'generate',
          capability: 'video_generation',
          prompt: 'a 30 second 4k video with audio',
          constraints: {
            durationSec: { minSec: 30 },
            resolution: { width: 3840, height: 2160 },
            requireAudioTrack: true,
          },
        })
      )
      .mockResolvedValueOnce(chatJson({ kind: 'final', content: 'done', unmetConstraints: [] }));

    const jointModel = makeModel({
      id: 'joint-audio-video-model',
      capabilities: ['video_generation'],
      metadata: {
        capabilityAttributes: {
          nativeAudioSupport: true,
          supportsJointAudioVideo: true,
          maxDurationSec: 60,
          maxResolution: { width: 3840, height: 2160 },
        },
      },
    });

    const generateVideo = vi.fn().mockResolvedValue({
      videos: [{ url: 'https://example.test/joint.mp4' }],
      provider: 'test-provider',
      model: 'joint-audio-video-model',
    });
    const invoker = makeInvoker({ chat: invokerChat, generateVideo });
    const context = makeContext([jointModel], invoker);

    const mediaConsensusExecutor: MediaConsensusExecutor = { execute: vi.fn() };

    const strategy = new MediaPlannerStrategy({ mediaConsensusExecutor });
    const result = await strategy.execute(makeRequest('a 30 second 4k video with audio'), context);

    expect(mediaConsensusExecutor.execute).not.toHaveBeenCalled();
    expect(generateVideo).toHaveBeenCalledTimes(1);
    expect(generateVideo.mock.calls[0][0]).toMatchObject({ model: 'joint-audio-video-model' });
    expect(result.artifacts).toHaveLength(1);

    const plan = result.metadata.plan as Array<{ outcome: { type: string } }>;
    expect(plan[0].outcome.type).toBe('native_collapse');
  });
});
