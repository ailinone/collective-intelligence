// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * video-generation-structured-attributes.test.ts — LOTE AS finding #3
 * (2026-09-06), updated for Package A (2026-09-09).
 *
 * Before the original fix, `executeMediaGenerationStage`'s video branch
 * called `context.invoker.generateVideo({ prompt, responseFormat: 'url' })`
 * — only two fields — even though the triage LLM was (per the system
 * prompt) meant to extract duration/resolution/aspect-ratio/audio intent
 * from the user's free-text request. `TriageStage` now carries `duration`/
 * `resolution`/`aspectRatio`/`audioRequested` as structured, optional
 * fields, and this test proves they actually reach `generateVideo()` instead
 * of being silently dropped on the floor between triage and the invoker.
 *
 * 2026-09-09 update: the ORIGINAL version of this test locked in two bugs
 * that shipped the same day as the original fix, from an uncoordinated
 * LATER commit that added a proper `resolution`/`generateAudio` channel to
 * the invoker without this call site being updated to use it:
 *   1. `stage.resolution` was stuffed into the free-form `size` field
 *      instead of the dedicated `resolution` field BytePlus/Google actually
 *      read — BytePlus ignores `size` entirely, so a triage-extracted "4K"
 *      never reached it.
 *   2. `stage.audioRequested` was forwarded under the invoker's OWN
 *      `audioRequested` field, which `VideoOrchestrationService` never
 *      reads (that plumbing landed under the name `generateAudio` instead)
 *      — every triage-extracted `audio_requested: true` was silently
 *      dropped before reaching the service.
 * Both are fixed; this test now asserts the CORRECT field names, and adds
 * coverage for the new deterministic extraction fallback (when the triage
 * LLM omits a field but the literal generation prompt states it explicitly).
 */
import { describe, it, expect, vi } from 'vitest';
import { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type {
  AilinArtifact,
  ChatRequest,
  ChatResponse,
  OrchestrationContext,
  TriageStage,
} from '@/types';
import type { CapabilityInvoker, VideoGenInvokeOptions } from '@/core/orchestration/capability-invoker';

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

type ExecuteMediaGenerationStage = (
  modality: 'image' | 'video' | 'audio' | 'file',
  stage: TriageStage,
  stageIndex: number,
  artifactIndex: number,
  context: OrchestrationContext,
  accumulatedContext: string,
  originalRequest: ChatRequest
) => Promise<{
  artifact?: AilinArtifact;
  execution?: unknown;
  cost: number;
  summaryText: string;
  syntheticResponse: ChatResponse;
}>;

function baseStage(overrides: Partial<TriageStage> = {}): TriageStage {
  return {
    name: 'video_generation',
    strategy: 'single',
    modelRoles: [],
    requiredCapabilities: ['video_generation'],
    maxTokens: 1024,
    generationPrompt: 'A drone shot of a mountain range at sunrise.',
    ...overrides,
  };
}

function baseRequest(): ChatRequest {
  return { messages: [{ role: 'user', content: 'make me a video' }] };
}

describe('executeMediaGenerationStage — video attribute forwarding', () => {
  it('forwards duration/resolution/aspectRatio/audioRequested into generateVideo()', async () => {
    const engine = makeEngine();
    const generateVideo = vi.fn(async (_options: VideoGenInvokeOptions) => ({
      videos: [{ url: 'https://example.com/video.mp4' }],
      provider: 'test-provider',
      model: 'test-model',
    }));
    const invoker = { generateVideo } as unknown as CapabilityInvoker;
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker,
    };

    const stage = baseStage({
      duration: 30,
      resolution: '4K',
      aspectRatio: '16:9',
      audioRequested: true,
    });

    const outcome = await (
      engine as unknown as { executeMediaGenerationStage: ExecuteMediaGenerationStage }
    ).executeMediaGenerationStage('video', stage, 0, 0, context, '', baseRequest());

    expect(generateVideo).toHaveBeenCalledTimes(1);
    const callArgs = generateVideo.mock.calls[0][0];
    // `resolution` (not `size`) and `generateAudio` (not `audioRequested`) —
    // see the 2026-09-09 update note above for why.
    expect(callArgs).toMatchObject({
      prompt: 'A drone shot of a mountain range at sunrise.',
      responseFormat: 'url',
      duration: 30,
      aspectRatio: '16:9',
      resolution: '4K',
      generateAudio: true,
    });
    expect((callArgs as Record<string, unknown>).size).toBeUndefined();
    expect((callArgs as Record<string, unknown>).audioRequested).toBeUndefined();
    expect(outcome.artifact?.error).toBeUndefined();
  });

  it('omits the structured fields entirely (undefined) when neither the triage stage nor the prompt text state them, instead of fabricating defaults', async () => {
    const engine = makeEngine();
    const generateVideo = vi.fn(async (_options: VideoGenInvokeOptions) => ({
      videos: [{ url: 'https://example.com/video.mp4' }],
      provider: 'test-provider',
      model: 'test-model',
    }));
    const invoker = { generateVideo } as unknown as CapabilityInvoker;
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker,
    };

    // "A drone shot of a mountain range at sunrise." has no extractable
    // duration/resolution/aspect-ratio/audio signal either — the
    // deterministic fallback must not fabricate one.
    const stage = baseStage(); // no duration/resolution/aspectRatio/audioRequested

    await (
      engine as unknown as { executeMediaGenerationStage: ExecuteMediaGenerationStage }
    ).executeMediaGenerationStage('video', stage, 0, 0, context, '', baseRequest());

    const callArgs = generateVideo.mock.calls[0][0];
    expect(callArgs.duration).toBeUndefined();
    expect(callArgs.aspectRatio).toBeUndefined();
    expect(callArgs.resolution).toBeUndefined();
    expect(callArgs.generateAudio).toBeUndefined();
  });

  it('falls back to deterministic extraction from the prompt text when the triage LLM omitted the structured fields (Package A, 2026-09-09)', async () => {
    const engine = makeEngine();
    const generateVideo = vi.fn(async (_options: VideoGenInvokeOptions) => ({
      videos: [{ url: 'https://example.com/video.mp4' }],
      provider: 'test-provider',
      model: 'test-model',
    }));
    const invoker = { generateVideo } as unknown as CapabilityInvoker;
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker,
    };

    // The triage LLM extracted nothing this time, but the literal generation
    // prompt it wrote DOES state duration/resolution/audio explicitly.
    const stage = baseStage({
      generationPrompt: 'A 30 second 4K video of a mountain range at sunrise, with a soundtrack.',
    });

    await (
      engine as unknown as { executeMediaGenerationStage: ExecuteMediaGenerationStage }
    ).executeMediaGenerationStage('video', stage, 0, 0, context, '', baseRequest());

    const callArgs = generateVideo.mock.calls[0][0];
    expect(callArgs.duration).toBe(30);
    expect(callArgs.resolution).toBe('4K');
    expect(callArgs.generateAudio).toBe(true);
  });

  it('lets the triage LLM-extracted fields win over the deterministic fallback when both are present', async () => {
    const engine = makeEngine();
    const generateVideo = vi.fn(async (_options: VideoGenInvokeOptions) => ({
      videos: [{ url: 'https://example.com/video.mp4' }],
      provider: 'test-provider',
      model: 'test-model',
    }));
    const invoker = { generateVideo } as unknown as CapabilityInvoker;
    const context: OrchestrationContext = {
      organizationId: 'org-test',
      requestId: 'req-test',
      models: [],
      taskType: 'general',
      contextSize: 0,
      invoker,
    };

    // Triage explicitly extracted duration=15; the prompt text ALSO mentions
    // "30 second" — the explicit triage field must win, not the extraction.
    const stage = baseStage({
      duration: 15,
      generationPrompt: 'A 30 second 4K video of a mountain range at sunrise.',
    });

    await (
      engine as unknown as { executeMediaGenerationStage: ExecuteMediaGenerationStage }
    ).executeMediaGenerationStage('video', stage, 0, 0, context, '', baseRequest());

    const callArgs = generateVideo.mock.calls[0][0];
    expect(callArgs.duration).toBe(15);
    // resolution was never set by triage, so extraction still fills it in.
    expect(callArgs.resolution).toBe('4K');
  });
});
