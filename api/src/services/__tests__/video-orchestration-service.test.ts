// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VideoOrchestrationService — LOTE AS (2026-09-06).
 *
 * Regression coverage for the three fixes in "video attribute plumbing":
 *
 *   1. The dead options bag: `duration`/`aspectRatio`/`size`/`audio`/
 *      `resolution`/`generateAudio` used to reach `adapter.videoGenerate()`
 *      ONLY as top-level `VideoGenRequest` fields, while the NESTED
 *      `request.options` bag — which RunwayML (`options.duration`,
 *      `options.ratio`) and BytePlus (`opts.resolution`,
 *      `opts.generate_audio`) actually read from — carried only
 *      `{n, response_format, video}`. Those adapter reads were therefore
 *      dead code. These tests assert the full bag now reaches the adapter.
 *   2. BytePlus's real, vendor-documented Seedance soundtrack switch
 *      (`generate_audio`) becomes reachable end-to-end via the new
 *      `generateAudio` option.
 *   3. The new `resolution` option reaches BytePlus's real RESOLUTIONS gate.
 *   4. Attribute-aware selection: a candidate whose catalog-declared
 *      `videoCapabilityAttributes` conflict with the request is excluded
 *      BEFORE ranking; a candidate with no declared attributes is not.
 *
 * Mocking pattern mirrors vision-orchestration-service.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { Model, OrchestrationContext } from '@/types';

const searchModelsComplete = vi.fn();
const findModelsByIdOrName = vi.fn();

vi.mock('@/services/model-repository', () => ({
  ModelRepository: class {
    searchModelsComplete = searchModelsComplete;
    findModelsByIdOrName = findModelsByIdOrName;
  },
}));

const resolveAdapterForModel = vi.fn();
vi.mock('@/providers/provider-registry', () => ({
  getProviderRegistry: () => ({ resolveAdapterForModel }),
}));

vi.mock('@/providers/provider-operability', () => ({
  isAdapterMethodImplemented: () => true,
}));

// vi.mock() factories are hoisted above ALL other top-level statements
// (including a preceding `const`/`class`), so anything the factory
// references directly must itself be created inside `vi.hoisted()` — a
// plain `const x = vi.fn()` above the call only works when every reference
// to it is deferred inside a closure (see the ModelRepository/registry
// mocks above); `MediaToolkitUnavailableError` is exported as a bare class
// reference, which is evaluated immediately, so it needs the real fix.
const { probeMedia, extendVideoToDuration, muxAudioIntoVideo, FakeMediaToolkitUnavailableError } =
  vi.hoisted(() => {
    class FakeMediaToolkitUnavailableError extends Error {
      readonly dependency: string;
      constructor(dependency: string) {
        super(`Media toolkit dependency "${dependency}" is not available`);
        this.name = 'MediaToolkitUnavailableError';
        this.dependency = dependency;
      }
    }
    return {
      probeMedia: vi.fn(),
      extendVideoToDuration: vi.fn(),
      muxAudioIntoVideo: vi.fn(),
      FakeMediaToolkitUnavailableError,
    };
  });
vi.mock('@/services/media/ffmpeg-media-toolkit', () => ({
  probeMedia,
  extendVideoToDuration,
  muxAudioIntoVideo,
  MediaToolkitUnavailableError: FakeMediaToolkitUnavailableError,
}));

import { VideoOrchestrationService } from '../video-orchestration-service';

const USER_CONTEXT = {
  organizationId: 'org_test',
  userId: 'user_test',
} as unknown as OrchestrationContext;

function makeModel(overrides: Partial<Model> = {}): Model {
  const id = (overrides.id as string) ?? 'video-fixture';
  return {
    id,
    name: id,
    displayName: id,
    provider: 'fixture-provider',
    capabilities: ['video_generation'],
    contextWindow: 0,
    maxOutputTokens: 0,
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.02,
    status: 'active',
    ...overrides,
  } as unknown as Model;
}

const OK_VIDEO_RESPONSE = {
  video: [{ url: 'https://example.com/generated.mp4' }],
  format: 'mp4',
  raw: {},
};

/** Wires a single candidate model through a fixed adapter mock. */
function wireSingle(model: Model, videoGenerate: Mock): void {
  searchModelsComplete.mockResolvedValue([model]);
  resolveAdapterForModel.mockReturnValue({
    adapter: { videoGenerate, getName: () => model.provider },
    operability: {},
  });
}

describe('VideoOrchestrationService', () => {
  let service: VideoOrchestrationService;

  beforeEach(() => {
    vi.clearAllMocks();
    muxAudioIntoVideo.mockReset();
    // The soundtrack-composition path fetches the generated video's bytes
    // (from the PROVIDER-returned URL) before muxing — stub it so the
    // composition tests below never make a real network call.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('fake-video-bytes').buffer,
      })
    );
    service = new VideoOrchestrationService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('dead options bag fix (item 1)', () => {
    it('forwards duration/aspectRatio into the nested options bag RunwayML reads (options.duration / options.ratio)', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(makeModel({ id: 'runway-fixture', provider: 'runwayml-fixture' }), videoGenerate);

      await service.generateVideo({
        prompt: 'a cat riding a bike',
        duration: 7,
        aspectRatio: '16:9',
        userContext: USER_CONTEXT,
        requestId: 'req_1',
      });

      expect(videoGenerate).toHaveBeenCalledTimes(1);
      const [, request] = videoGenerate.mock.calls[0];
      // Top-level fields (read directly by openai/openai-compatible-hub adapters).
      expect(request.duration).toBe(7);
      expect(request.aspectRatio).toBe('16:9');
      // Nested bag — RunwayML's real (previously dead) reads.
      expect(request.options.duration).toBe(7);
      expect(request.options.ratio).toBe('16:9');
    });

    it('forwards video at the top level too, not only nested (byteplus/google/openai read request.video)', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(
        makeModel({
          id: 'v2v-fixture',
          provider: 'fixture-provider',
          capabilities: ['video_to_video', 'video_generation'],
        }),
        videoGenerate
      );

      await service.generateVideo({
        prompt: 'restyle this clip',
        video: 'https://example.com/source.mp4',
        userContext: USER_CONTEXT,
        requestId: 'req_2',
      });

      const [, request] = videoGenerate.mock.calls[0];
      expect(request.video).toBe('https://example.com/source.mp4');
      expect(request.options.video).toBe('https://example.com/source.mp4');
    });
  });

  describe('soundtrack + resolution plumbing (items 2 and 3)', () => {
    it('forwards resolution and generateAudio into the nested options bag BytePlus reads (opts.resolution / opts.generate_audio)', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(makeModel({ id: 'byteplus-fixture', provider: 'byteplus' }), videoGenerate);

      await service.generateVideo({
        prompt: 'a dog surfing, 4k, with a soundtrack',
        resolution: '4K',
        generateAudio: true,
        userContext: USER_CONTEXT,
        requestId: 'req_3',
      });

      const [, request] = videoGenerate.mock.calls[0];
      expect(request.options.resolution).toBe('4K');
      expect(request.options.generate_audio).toBe(true);
      // Google Veo's own adapter reads the camelCase form of the same option.
      expect(request.options.generateAudio).toBe(true);
    });

    it('does not populate generateAudio-derived fields when the caller never requested a soundtrack', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(makeModel({ id: 'byteplus-fixture-2', provider: 'byteplus' }), videoGenerate);

      await service.generateVideo({
        prompt: 'a plain clip',
        userContext: USER_CONTEXT,
        requestId: 'req_4',
      });

      const [, request] = videoGenerate.mock.calls[0];
      expect(request.options.generate_audio).toBeUndefined();
      expect(request.options.generateAudio).toBeUndefined();
    });

    it('is a no-op for an adapter that does not read resolution/generateAudio at all', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(
        makeModel({ id: 'generic-fixture', provider: 'generic-fixture-provider' }),
        videoGenerate
      );

      const result = await service.generateVideo({
        prompt: 'plain video, no soundtrack feature on this provider',
        resolution: '4K',
        generateAudio: true,
        userContext: USER_CONTEXT,
        requestId: 'req_5',
      });

      expect(videoGenerate).toHaveBeenCalledTimes(1);
      expect(result.videos[0]?.url).toBe('https://example.com/generated.mp4');
    });
  });

  describe('attribute-aware selection (item 4)', () => {
    it('excludes a candidate whose declared maxResolution cannot satisfy the request (siliconflow: 720p ceiling)', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      const tooLowRes = makeModel({ id: 'silicon-model', provider: 'siliconflow' });
      const unknownAttrs = makeModel({ id: 'unknown-model', provider: 'totally-fake-provider-xyz' });
      searchModelsComplete.mockResolvedValue([tooLowRes, unknownAttrs]);
      resolveAdapterForModel.mockImplementation((model: Model) => ({
        adapter: { videoGenerate, getName: () => model.provider },
        operability: {},
      }));

      await service.generateVideo({
        prompt: 'an ultra hd video',
        resolution: '4K',
        userContext: USER_CONTEXT,
        requestId: 'req_6',
      });

      expect(videoGenerate).toHaveBeenCalledTimes(1);
      const [selectedModel] = videoGenerate.mock.calls[0];
      expect(selectedModel.provider).toBe('totally-fake-provider-xyz');
    });

    it('rejects a soundtrack request against a provider with verified nativeAudioSupport: false (runwayml)', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      const noAudio = makeModel({ id: 'runway-model', provider: 'runwayml' });
      const unknownAttrs = makeModel({ id: 'unknown-model-2', provider: 'totally-fake-provider-xyz' });
      searchModelsComplete.mockResolvedValue([noAudio, unknownAttrs]);
      resolveAdapterForModel.mockImplementation((model: Model) => ({
        adapter: { videoGenerate, getName: () => model.provider },
        operability: {},
      }));

      await service.generateVideo({
        prompt: 'a video with a generated soundtrack',
        generateAudio: true,
        userContext: USER_CONTEXT,
        requestId: 'req_7',
      });

      expect(videoGenerate).toHaveBeenCalledTimes(1);
      const [selectedModel] = videoGenerate.mock.calls[0];
      expect(selectedModel.provider).toBe('totally-fake-provider-xyz');
    });

    it('does NOT exclude a candidate with no declared videoCapabilityAttributes, even for an extreme request (fail-open on missing data)', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(
        makeModel({ id: 'unknown-model-3', provider: 'totally-fake-provider-xyz' }),
        videoGenerate
      );

      await service.generateVideo({
        prompt: 'anything at all',
        resolution: '16K',
        duration: 9999,
        aspectRatio: '99:1',
        generateAudio: true,
        userContext: USER_CONTEXT,
        requestId: 'req_8',
      });

      expect(videoGenerate).toHaveBeenCalledTimes(1);
    });

    it('does NOT exclude a candidate whose declared attributes are compatible (byteplus: 4K + native audio)', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(makeModel({ id: 'byteplus-model', provider: 'byteplus' }), videoGenerate);

      await service.generateVideo({
        prompt: 'a 4k clip with a soundtrack',
        resolution: '4K',
        generateAudio: true,
        userContext: USER_CONTEXT,
        requestId: 'req_9',
      });

      expect(videoGenerate).toHaveBeenCalledTimes(1);
    });

    it('throws pool-exhaustion when every candidate is excluded on attributes (no silent success)', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(makeModel({ id: 'silicon-model-2', provider: 'siliconflow' }), videoGenerate);

      await expect(
        service.generateVideo({
          prompt: 'an ultra hd video only siliconflow could theoretically serve',
          resolution: '4K',
          userContext: USER_CONTEXT,
          requestId: 'req_10',
        })
      ).rejects.toThrow(/No runnable models available/);
      expect(videoGenerate).not.toHaveBeenCalled();
    });
  });

  /**
   * Package A (2026-09-09) — soundtrack COMPOSITION, the completion of the
   * `generateAudio` story for providers with no native soundtrack feature.
   * `generateAudio`/`resolution` (LOTE AS) only reach a vendor's OWN native
   * switch; a provider the catalog documents as having NO such feature
   * (runwayml, siliconflow: `nativeAudioSupport: false`) just silently ships
   * a mute video when audio is requested — UNLESS the caller also supplies
   * `soundtrackAudioBase64`, in which case this composes a real soundtrack in
   * via `ffmpeg-media-toolkit.ts#muxAudioIntoVideo` as a best-effort second
   * step (mirrors `image_upscale`'s "second specialized tool" pattern).
   */
  describe('soundtrack composition (Package A)', () => {
    it('composes a soundtrack when the winning model has no native audio support', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(makeModel({ id: 'runway-model', provider: 'runwayml' }), videoGenerate);
      muxAudioIntoVideo.mockResolvedValue({
        buffer: Buffer.from('composed-mp4-bytes'),
        mimeType: 'video/mp4',
      });

      const result = await service.generateVideo({
        prompt: 'a video with audio, no native support on this provider',
        generateAudio: true,
        soundtrackAudioBase64: Buffer.from('fake-audio').toString('base64'),
        userContext: USER_CONTEXT,
        requestId: 'req_compose_1',
      });

      expect(muxAudioIntoVideo).toHaveBeenCalledTimes(1);
      expect(result.audioComposed).toBe(true);
      expect(result.audioRequirementUnmet).toBeUndefined();
      // The video in the result IS the composed one (data URL of the muxed bytes).
      expect(result.videos[0]?.url).toContain('data:video/mp4;base64,');
      expect(result.videos[0]?.url).toContain(Buffer.from('composed-mp4-bytes').toString('base64'));
    });

    it('does not attempt composition when the model already has confirmed native audio support', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(makeModel({ id: 'byteplus-model', provider: 'byteplus' }), videoGenerate);

      const result = await service.generateVideo({
        prompt: 'a 4k clip with a soundtrack',
        generateAudio: true,
        soundtrackAudioBase64: Buffer.from('fake-audio').toString('base64'),
        userContext: USER_CONTEXT,
        requestId: 'req_compose_2',
      });

      expect(muxAudioIntoVideo).not.toHaveBeenCalled();
      expect(result.audioComposed).toBeUndefined();
      expect(result.audioRequirementUnmet).toBeUndefined();
    });

    it('reports audioRequirementUnmet when audio is requested but no soundtrack asset was supplied', async () => {
      // A provider with UNDECLARED attributes, not 'runwayml' — the
      // attribute pre-filter correctly EXCLUDES a CONFIRMED-no-audio
      // provider when no soundtrack is supplied to compensate (no asset ==
      // no way to satisfy the request at all), so a request that reaches
      // this far with `audioRequirementUnmet` pending must have landed on a
      // candidate whose audio support is merely UNKNOWN, not confirmed-false.
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(
        makeModel({ id: 'unknown-audio-model', provider: 'totally-fake-provider-xyz' }),
        videoGenerate
      );

      const result = await service.generateVideo({
        prompt: 'a video with audio, no soundtrack asset supplied',
        generateAudio: true,
        userContext: USER_CONTEXT,
        requestId: 'req_compose_3',
      });

      expect(muxAudioIntoVideo).not.toHaveBeenCalled();
      expect(result.audioRequirementUnmet).toBe(true);
      expect(result.audioComposed).toBeUndefined();
      // The original (silent) video is still returned — never fabricated.
      expect(result.videos[0]?.url).toBe('https://example.com/generated.mp4');
    });

    it('falls back to the original video and reports the failure when composition throws', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(makeModel({ id: 'runway-model-3', provider: 'runwayml' }), videoGenerate);
      muxAudioIntoVideo.mockRejectedValue(new Error('ffmpeg exited with code 1'));

      const result = await service.generateVideo({
        prompt: 'a video with audio',
        generateAudio: true,
        soundtrackAudioBase64: Buffer.from('fake-audio').toString('base64'),
        userContext: USER_CONTEXT,
        requestId: 'req_compose_4',
      });

      expect(muxAudioIntoVideo).toHaveBeenCalledTimes(1);
      expect(result.audioComposed).toBe(false);
      expect(result.audioRequirementUnmet).toBe(true);
      // Never fabricated — the original (silent) video is still returned.
      expect(result.videos[0]?.url).toBe('https://example.com/generated.mp4');
    });

    it('never attempts composition when audio was not requested at all', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(makeModel({ id: 'runway-model-4', provider: 'runwayml' }), videoGenerate);

      const result = await service.generateVideo({
        prompt: 'a plain silent video',
        soundtrackAudioBase64: Buffer.from('fake-audio').toString('base64'),
        userContext: USER_CONTEXT,
        requestId: 'req_compose_5',
      });

      expect(muxAudioIntoVideo).not.toHaveBeenCalled();
      expect(result.audioComposed).toBeUndefined();
      expect(result.audioRequirementUnmet).toBeUndefined();
    });
  });

  /**
   * Bug 2 (production incident, 2026-09-08): a real "Gere um video..."
   * request against ailin.chat timed out ~2 minutes later with a generic
   * "Server Connection Error". Prod logs showed empiriolabs/wan-3-0 polling
   * for the full 300000ms budget while the fallback search's OWN deadline
   * was logged as 30000ms — the per-candidate poll had no idea how much of
   * the search's budget was left, so it ran ~10x past it, and the pool's
   * other 143 candidates were never attempted.
   *
   * The fix threads the fallback search's deadline down to
   * `adapter.videoGenerate`'s `options.orchestrationDeadlineAt`, so an
   * adapter whose call can internally wait/poll (see
   * openai-compatible-hub-adapter.ts's pollVideoTask and
   * byteplus-adapter.ts's submitAndPollGenerationTask) can bound itself by
   * it instead of running past the search's own declared budget.
   */
  describe('Bug 2 fix: orchestrationDeadlineAt threading (2026-09-08)', () => {
    it('forwards the fallback search deadline into request.options.orchestrationDeadlineAt', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);
      wireSingle(makeModel({ id: 'deadline-fixture', provider: 'fixture-provider' }), videoGenerate);

      const before = Date.now();
      await service.generateVideo({
        prompt: 'ocean waves at sunset',
        userContext: USER_CONTEXT,
        requestId: 'req_bug2_deadline',
      });

      const [, request] = videoGenerate.mock.calls[0];
      // Default strategy → resolveFallbackDeadlineMs's 30000ms branch — the
      // EXACT number logged in the 2026-09-08 production incident
      // ("deadlineMs":30000).
      expect(request.options.orchestrationDeadlineAt).toBeGreaterThan(before + 29000);
      expect(request.options.orchestrationDeadlineAt).toBeLessThan(before + 31000);
    });

    it('a candidate that hangs far past its fair share is cut off in time for the search to still try the next candidate (regression, live-proven on empiriolabs/wan-3-0)', async () => {
      vi.useFakeTimers();
      try {
        // Mirrors the REAL fixed adapters' contract post-fix: bound the
        // internal wait to `min(ownPollBudgetMs, orchestrationDeadlineAt -
        // now)` instead of blindly waiting the fixed budget (300000ms,
        // matching HUB_VIDEO_POLL_TIMEOUT_MS's production default)
        // regardless of how much search time is actually left.
        const OWN_POLL_BUDGET_MS = 300_000;
        const slow = vi.fn(
          (_model: Model, request: { options?: Record<string, unknown> }) =>
            new Promise((_resolve, reject) => {
              const deadlineAt = request.options?.orchestrationDeadlineAt as number;
              const waitMs = Math.min(OWN_POLL_BUDGET_MS, Math.max(0, deadlineAt - Date.now()));
              setTimeout(
                () => reject(new Error('slow candidate exhausted its bounded poll budget')),
                waitMs
              );
            })
        );
        const fast = vi.fn().mockResolvedValue(OK_VIDEO_RESPONSE);

        const slowModel = makeModel({ id: 'slow-model', provider: 'slow-provider' });
        const fastModel = makeModel({ id: 'fast-model', provider: 'fast-provider' });
        searchModelsComplete.mockResolvedValue([slowModel, fastModel]);
        resolveAdapterForModel.mockImplementation((m: Model) => ({
          adapter: {
            videoGenerate: m.provider === 'slow-provider' ? slow : fast,
            getName: () => m.provider,
          },
          operability: {},
        }));

        const resultPromise = service.generateVideo({
          prompt: 'ocean waves at sunset',
          userContext: USER_CONTEXT,
          requestId: 'req_bug2_regression',
        });

        await vi.runAllTimersAsync();
        const result = await resultPromise;

        // Both candidates were tried — the hanging one did NOT consume the
        // whole search and starve the other, unlike the pre-fix production
        // incident (143 candidates never attempted).
        expect(slow).toHaveBeenCalledTimes(1);
        expect(fast).toHaveBeenCalledTimes(1);
        expect(result.provider).toBe('fast-provider');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * Duration-chaining completion (2026-09-09). Closes the routing-audit gap:
   * `canSatisfyVideoAttributes` only rejects a candidate whose DECLARED
   * duration ceiling conflicts with the request, and only 5 providers have
   * that attribute populated — every other candidate is admitted fail-open
   * with no guarantee it actually delivers the requested length. These
   * tests prove the full chain: a request asks for a specific duration, the
   * winning model silently under-delivers, and the service probes the real
   * output and invokes the ffmpeg composition step automatically to close
   * the gap — never silently shipping a short clip as an unqualified
   * "success", and never claiming the requirement was met/unmet without
   * evidence.
   */
  describe('duration reconciliation + automatic extend (tool chaining)', () => {
    // A data: URL response needs no network fetch to resolve to bytes,
    // keeping this suite hermetic.
    const SHORT_CLIP_B64 = Buffer.from('fake-short-clip-bytes').toString('base64');
    const SHORT_CLIP_RESPONSE = {
      video: [{ url: `data:video/mp4;base64,${SHORT_CLIP_B64}` }],
      format: 'mp4',
      raw: {},
    };

    it('end-to-end: a 30s request against a model that silently delivers 8s is extended automatically to meet it', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(SHORT_CLIP_RESPONSE);
      wireSingle(makeModel({ id: 'short-clip-model', provider: 'fixture-provider' }), videoGenerate);
      probeMedia.mockResolvedValue({ durationSec: 8, hasVideo: true, hasAudio: false, streams: [] });
      const EXTENDED_B64 = Buffer.from('fake-extended-30s-clip').toString('base64');
      extendVideoToDuration.mockResolvedValue({
        buffer: Buffer.from(EXTENDED_B64, 'base64'),
        mimeType: 'video/mp4',
        loopsApplied: 3,
      });

      const result = await service.generateVideo({
        prompt: 'a 30 second video in 4K with a soundtrack',
        duration: 30,
        resolution: '4K',
        userContext: USER_CONTEXT,
        requestId: 'req_extend_1',
      });

      expect(extendVideoToDuration).toHaveBeenCalledTimes(1);
      const [, , extendOptions] = extendVideoToDuration.mock.calls[0];
      expect(extendOptions).toMatchObject({ targetDurationSec: 30 });
      expect(result.durationExtended).toBe(true);
      expect(result.durationRequirementUnmet).toBeUndefined();
      // The final artifact IS the extended one, not the original short clip.
      expect(result.videos[0]?.url).toBe(`data:video/mp4;base64,${EXTENDED_B64}`);
    });

    it('does not touch a clip whose actual duration already meets the request (within tolerance)', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(SHORT_CLIP_RESPONSE);
      wireSingle(makeModel({ id: 'exact-clip-model', provider: 'fixture-provider' }), videoGenerate);
      // 29.6s against a 30s request: 0.4s shortfall, well under the 1s/10% floor.
      probeMedia.mockResolvedValue({ durationSec: 29.6, hasVideo: true, hasAudio: false, streams: [] });

      const result = await service.generateVideo({
        prompt: 'a 30 second video',
        duration: 30,
        userContext: USER_CONTEXT,
        requestId: 'req_extend_2',
      });

      expect(extendVideoToDuration).not.toHaveBeenCalled();
      expect(result.durationExtended).toBeUndefined();
      expect(result.durationRequirementUnmet).toBeUndefined();
      expect(result.videos[0]?.url).toBe(`data:video/mp4;base64,${SHORT_CLIP_B64}`);
    });

    it('reports durationRequirementUnmet (never fabricates success) when extension fails', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(SHORT_CLIP_RESPONSE);
      wireSingle(makeModel({ id: 'unfixable-clip-model', provider: 'fixture-provider' }), videoGenerate);
      probeMedia.mockResolvedValue({ durationSec: 5, hasVideo: true, hasAudio: false, streams: [] });
      extendVideoToDuration.mockRejectedValue(new FakeMediaToolkitUnavailableError('ffmpeg'));

      const result = await service.generateVideo({
        prompt: 'a 30 second video',
        duration: 30,
        userContext: USER_CONTEXT,
        requestId: 'req_extend_3',
      });

      expect(result.durationRequirementUnmet).toBe(true);
      expect(result.durationExtended).toBeUndefined();
      // The ORIGINAL (still-short) clip ships — never a fabricated result.
      expect(result.videos[0]?.url).toBe(`data:video/mp4;base64,${SHORT_CLIP_B64}`);
    });

    it('never probes or extends when the caller requested no duration at all', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(SHORT_CLIP_RESPONSE);
      wireSingle(makeModel({ id: 'no-duration-model', provider: 'fixture-provider' }), videoGenerate);

      const result = await service.generateVideo({
        prompt: 'just a video, whatever length',
        userContext: USER_CONTEXT,
        requestId: 'req_extend_4',
      });

      expect(probeMedia).not.toHaveBeenCalled();
      expect(extendVideoToDuration).not.toHaveBeenCalled();
      expect(result.durationExtended).toBeUndefined();
      expect(result.durationRequirementUnmet).toBeUndefined();
    });

    it('treats an unverifiable duration as unknown, not unmet, when the probe itself fails', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(SHORT_CLIP_RESPONSE);
      wireSingle(makeModel({ id: 'unprobeable-model', provider: 'fixture-provider' }), videoGenerate);
      probeMedia.mockRejectedValue(new Error('ffprobe returned unparseable JSON'));

      const result = await service.generateVideo({
        prompt: 'a 30 second video',
        duration: 30,
        userContext: USER_CONTEXT,
        requestId: 'req_extend_5',
      });

      // No evidence of a shortfall was ever obtained — must not claim unmet.
      expect(result.durationRequirementUnmet).toBeUndefined();
      expect(result.durationExtended).toBeUndefined();
      expect(extendVideoToDuration).not.toHaveBeenCalled();
    });

    it('skips the fetch-based probe entirely for a candidate with declared, vendor-verified duration attributes (zai: 5|10s enum)', async () => {
      const videoGenerate = vi.fn().mockResolvedValue(SHORT_CLIP_RESPONSE);
      wireSingle(makeModel({ id: 'zai-model', provider: 'zai' }), videoGenerate);

      const result = await service.generateVideo({
        prompt: 'a 10 second video',
        duration: 10,
        userContext: USER_CONTEXT,
        requestId: 'req_extend_7',
      });

      // zai's catalog entry declares allowedDurationsSeconds: [5, 10] —
      // canSatisfyVideoAttributes already admitted this candidate as
      // compatible, so the real, network-fetching probe is skipped entirely
      // rather than re-verifying a vendor-documented, already-trusted value.
      expect(probeMedia).not.toHaveBeenCalled();
      expect(extendVideoToDuration).not.toHaveBeenCalled();
      expect(result.durationExtended).toBeUndefined();
      expect(result.durationRequirementUnmet).toBeUndefined();
    });

    it('never attempts extension for an async job handle with no retrievable bytes', async () => {
      const videoGenerate = vi.fn().mockResolvedValue({
        video: [{ id: 'async-job-123' }],
        format: 'mp4',
        raw: {},
      });
      wireSingle(makeModel({ id: 'async-model', provider: 'fixture-provider' }), videoGenerate);

      const result = await service.generateVideo({
        prompt: 'a 30 second video',
        duration: 30,
        userContext: USER_CONTEXT,
        requestId: 'req_extend_6',
      });

      expect(probeMedia).not.toHaveBeenCalled();
      expect(extendVideoToDuration).not.toHaveBeenCalled();
      expect(result.durationRequirementUnmet).toBeUndefined();
      expect(result.videos[0]?.id).toBe('async-job-123');
    });
  });
});
