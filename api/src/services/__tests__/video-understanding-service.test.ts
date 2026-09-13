// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * VideoUnderstandingService composition tests.
 *
 * These assert the CONTRACT that makes `video_understanding` /
 * `video_to_text` / `video_transcription` honest capabilities rather than
 * relabelled speech-to-text:
 *   - the audio track reaches the real STT pipeline as demuxed WAV, never as
 *     the caller's raw container bytes;
 *   - frames reach the real vision pipeline;
 *   - a missing ffmpeg toolchain is reported as an unmet dependency;
 *   - partial failures degrade into explicit `warnings[]`, never into filler.
 *
 * ffmpeg itself is mocked here — the real binary is exercised by
 * `services/media/__tests__/ffmpeg-media-toolkit.live.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const probeMedia = vi.fn();
const extractAudioTrack = vi.fn();
const extractFrames = vi.fn();
const getMediaToolkitCapability = vi.fn();

vi.mock('@/services/media/ffmpeg-media-toolkit', async () => {
  const actual = await vi.importActual<typeof import('@/services/media/ffmpeg-media-toolkit')>(
    '@/services/media/ffmpeg-media-toolkit'
  );
  return {
    ...actual,
    probeMedia: (...args: unknown[]) => probeMedia(...args),
    extractAudioTrack: (...args: unknown[]) => extractAudioTrack(...args),
    extractFrames: (...args: unknown[]) => extractFrames(...args),
    getMediaToolkitCapability: (...args: unknown[]) => getMediaToolkitCapability(...args),
  };
});

const { MediaProcessingError, MediaToolkitUnavailableError } = await import(
  '@/services/media/ffmpeg-media-toolkit'
);
const { VideoUnderstandingService, VideoAnalysisUnavailableError } = await import(
  '@/services/video-understanding-service'
);
import type { AudioOrchestrationService } from '@/services/audio-orchestration-service';
import type { CapabilityExecutionService } from '@/services/capability-execution-service';
import type { OrchestrationContext } from '@/types';

const USER_CONTEXT = {
  requestId: 'req-1',
  organizationId: 'org-1',
  userId: 'user-1',
  models: [],
  taskType: 'general',
  contextSize: 0,
} as unknown as OrchestrationContext;

const VIDEO_BYTES = Buffer.from('pretend-this-is-an-mp4-container');
const DEMUXED_WAV = Buffer.from('RIFF....WAVEdemuxed-audio');

function chatResponse(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }] };
}

function buildAudioService(overrides: Partial<AudioOrchestrationService> = {}) {
  return {
    transcribeAudio: vi.fn().mockResolvedValue({
      text: 'hello from the audio track',
      language: 'en',
      duration: 12,
      modelUsed: 'stt-model-x',
      provider: 'stt-provider-x',
      durationMs: 100,
    }),
    ...overrides,
  } as unknown as AudioOrchestrationService;
}

function buildExecutionService(overrides: Record<string, unknown> = {}) {
  return {
    executeVisionRequest: vi.fn().mockResolvedValue({
      success: true,
      response: chatResponse('a person waving at the camera'),
      modelUsed: 'vision-model-y',
      providerUsed: 'vision-provider-y',
    }),
    executeWithCapabilities: vi.fn().mockResolvedValue({
      success: true,
      response: chatResponse('Someone greets the viewer and says hello.'),
      modelUsed: 'fusion-model-z',
      providerUsed: 'fusion-provider-z',
    }),
    ...overrides,
  } as unknown as CapabilityExecutionService;
}

function buildService(
  audio: AudioOrchestrationService = buildAudioService(),
  execution: CapabilityExecutionService = buildExecutionService()
) {
  return {
    service: new VideoUnderstandingService(audio, () => execution),
    audio,
    execution,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  probeMedia.mockResolvedValue({
    durationSec: 12,
    formatName: 'mov,mp4,m4a',
    sizeBytes: 1234,
    streams: [
      { codecType: 'video', codecName: 'h264', width: 320, height: 180 },
      { codecType: 'audio', codecName: 'aac' },
    ],
    hasVideo: true,
    hasAudio: true,
  });
  extractAudioTrack.mockResolvedValue({
    buffer: DEMUXED_WAV,
    filename: 'audio.wav',
    mimeType: 'audio/wav',
    sampleRateHz: 16_000,
    channels: 1,
  });
  extractFrames.mockResolvedValue([
    {
      index: 0,
      timestampSec: 0,
      timestampMeasured: true,
      buffer: Buffer.from('frame-zero'),
      mimeType: 'image/jpeg',
    },
    {
      index: 1,
      timestampSec: 5,
      timestampMeasured: true,
      buffer: Buffer.from('frame-one'),
      mimeType: 'image/jpeg',
    },
  ]);
  getMediaToolkitCapability.mockResolvedValue({ available: true });
});

describe('VideoUnderstandingService — understanding mode', () => {
  it('sends the DEMUXED audio to STT, not the raw container bytes', async () => {
    const { service, audio } = buildService();

    await service.analyzeVideo({
      videoBuffer: VIDEO_BYTES,
      filename: 'clip.mp4',
      mode: 'understanding',
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    const transcribe = vi.mocked(audio.transcribeAudio);
    expect(transcribe).toHaveBeenCalledTimes(1);
    const call = transcribe.mock.calls[0][0];
    // This is the whole regression: the OLD dispatcher passed VIDEO_BYTES here.
    expect(call.audioBuffer).toBe(DEMUXED_WAV);
    expect(call.audioBuffer).not.toBe(VIDEO_BYTES);
    expect(call.filename).toBe('audio.wav');
  });

  it('routes every sampled frame through the real vision pipeline', async () => {
    const { service, execution } = buildService();

    const result = await service.analyzeVideo({
      videoBuffer: VIDEO_BYTES,
      filename: 'clip.mp4',
      mode: 'understanding',
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(vi.mocked(execution.executeVisionRequest)).toHaveBeenCalledTimes(2);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0].description).toBe('a person waving at the camera');
    expect(result.frames[0].timestampSec).toBe(0);
    expect(result.frames[0].approximateTimestamp).toBe(false);
    expect(result.frames[1].timestampSec).toBe(5);
    expect(result.frames[0].provider).toBe('vision-provider-y');
  });

  it('fuses transcript and frames, and cites BOTH sources in the prompt', async () => {
    const { service, execution } = buildService();

    const result = await service.analyzeVideo({
      videoBuffer: VIDEO_BYTES,
      filename: 'clip.mp4',
      mode: 'understanding',
      prompt: 'What is happening?',
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(result.summary).toBe('Someone greets the viewer and says hello.');
    expect(result.summaryModelUsed).toBe('fusion-model-z');

    const fusion = vi.mocked(execution.executeWithCapabilities).mock.calls[0];
    const userMessage = String(fusion[0][1].content);
    expect(userMessage).toContain('hello from the audio track');
    expect(userMessage).toContain('a person waving at the camera');
    expect(userMessage).toContain('What is happening?');
    // The synthesis model is told not to claim it watched the video.
    expect(String(fusion[0][0].content)).toContain('do not claim to have watched');
  });

  it('reports the container facts it actually measured', async () => {
    const { service } = buildService();

    const result = await service.analyzeVideo({
      videoBuffer: VIDEO_BYTES,
      filename: 'clip.mp4',
      mode: 'understanding',
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(result.media).toMatchObject({
      durationSec: 12,
      hasVideoStream: true,
      hasAudioStream: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      framesSampled: 2,
    });
  });
});

describe('VideoUnderstandingService — transcript mode', () => {
  it('does not sample frames by default', async () => {
    const { service, execution } = buildService();

    const result = await service.analyzeVideo({
      videoBuffer: VIDEO_BYTES,
      filename: 'clip.mp4',
      mode: 'transcript',
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(extractFrames).not.toHaveBeenCalled();
    expect(vi.mocked(execution.executeWithCapabilities)).not.toHaveBeenCalled();
    expect(result.frames).toEqual([]);
    expect(result.summary).toBeUndefined();
    expect(result.transcript?.text).toBe('hello from the audio track');
  });

  it('samples frames when visual context is explicitly requested', async () => {
    const { service } = buildService();

    const result = await service.analyzeVideo({
      videoBuffer: VIDEO_BYTES,
      filename: 'clip.mp4',
      mode: 'transcript',
      includeVisualContext: true,
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(extractFrames).toHaveBeenCalledTimes(1);
    expect(result.frames).toHaveLength(2);
    // Still no fusion — that belongs to `video_understanding`.
    expect(result.summary).toBeUndefined();
  });

  it('distinguishes "no audio to transcribe" from "transcription failed"', async () => {
    probeMedia.mockResolvedValue({
      durationSec: 6,
      streams: [{ codecType: 'video', codecName: 'h264' }],
      hasVideo: true,
      hasAudio: false,
    });
    const { service } = buildService();

    await expect(
      service.analyzeVideo({
        videoBuffer: VIDEO_BYTES,
        filename: 'clip.mp4',
        mode: 'transcript',
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
      // The caller's next action differs: re-upload a file that has audio,
      // versus retry a transcription that failed.
    ).rejects.toMatchObject({ dependency: 'media_streams' });
  });

  it('fails when the audio track cannot be transcribed', async () => {
    const audio = buildAudioService({
      transcribeAudio: vi.fn().mockRejectedValue(new Error('no STT provider configured')),
    } as Partial<AudioOrchestrationService>);
    const { service } = buildService(audio);

    await expect(
      service.analyzeVideo({
        videoBuffer: VIDEO_BYTES,
        filename: 'clip.mp4',
        mode: 'transcript',
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
    ).rejects.toBeInstanceOf(VideoAnalysisUnavailableError);
  });
});

describe('VideoUnderstandingService — failure honesty', () => {
  it('surfaces a missing ffmpeg toolchain as an unmet dependency', async () => {
    probeMedia.mockRejectedValue(new MediaToolkitUnavailableError('ffprobe', 'not on PATH'));
    const { service } = buildService();

    await expect(
      service.analyzeVideo({
        videoBuffer: VIDEO_BYTES,
        filename: 'clip.mp4',
        mode: 'understanding',
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
    ).rejects.toMatchObject({
      name: 'VideoAnalysisUnavailableError',
      dependency: 'ffmpeg',
    });
  });

  it('rejects a payload that is not a media container', async () => {
    probeMedia.mockRejectedValue(new MediaProcessingError('Invalid data found'));
    const { service } = buildService();

    await expect(
      service.analyzeVideo({
        videoBuffer: VIDEO_BYTES,
        filename: 'clip.mp4',
        mode: 'understanding',
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
    ).rejects.toMatchObject({ dependency: 'media_container' });
  });

  it('rejects an empty payload before touching ffmpeg', async () => {
    const { service } = buildService();

    await expect(
      service.analyzeVideo({
        videoBuffer: Buffer.alloc(0),
        filename: 'clip.mp4',
        mode: 'understanding',
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
    ).rejects.toMatchObject({ dependency: 'input' });
    expect(probeMedia).not.toHaveBeenCalled();
  });

  it('warns instead of inventing a transcript when there is no audio stream', async () => {
    probeMedia.mockResolvedValue({
      durationSec: 6,
      streams: [{ codecType: 'video', codecName: 'h264' }],
      hasVideo: true,
      hasAudio: false,
    });
    const { service, audio } = buildService();

    const result = await service.analyzeVideo({
      videoBuffer: VIDEO_BYTES,
      filename: 'clip.mp4',
      mode: 'understanding',
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(vi.mocked(audio.transcribeAudio)).not.toHaveBeenCalled();
    expect(result.transcript).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('no audio stream');
    // The visual half still ran, so the request is served, not failed.
    expect(result.frames).toHaveLength(2);
  });

  it('records a per-frame warning when the vision pipeline fails on one frame', async () => {
    const execution = buildExecutionService({
      executeVisionRequest: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          response: chatResponse('first frame content'),
          modelUsed: 'vision-model-y',
          providerUsed: 'vision-provider-y',
        })
        .mockResolvedValueOnce({ success: false, error: 'vision provider rate limited' }),
    });
    const { service } = buildService(buildAudioService(), execution);

    const result = await service.analyzeVideo({
      videoBuffer: VIDEO_BYTES,
      filename: 'clip.mp4',
      mode: 'understanding',
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(result.frames).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('rate limited');
  });

  it('fails when neither signal could be produced', async () => {
    const audio = buildAudioService({
      transcribeAudio: vi.fn().mockRejectedValue(new Error('stt down')),
    } as Partial<AudioOrchestrationService>);
    extractFrames.mockRejectedValue(new MediaProcessingError('decode failed'));
    const { service } = buildService(audio);

    await expect(
      service.analyzeVideo({
        videoBuffer: VIDEO_BYTES,
        filename: 'clip.mp4',
        mode: 'understanding',
        userContext: USER_CONTEXT,
        requestId: 'req-1',
      })
    ).rejects.toMatchObject({ dependency: 'speech_to_text+vision' });
  });

  it('does not fabricate a summary when synthesis fails', async () => {
    const execution = buildExecutionService({
      executeWithCapabilities: vi
        .fn()
        .mockResolvedValue({ success: false, error: 'no analysis model available' }),
    });
    const { service } = buildService(buildAudioService(), execution);

    const result = await service.analyzeVideo({
      videoBuffer: VIDEO_BYTES,
      filename: 'clip.mp4',
      mode: 'understanding',
      userContext: USER_CONTEXT,
      requestId: 'req-1',
    });

    expect(result.summary).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('Cross-modal synthesis failed');
    // The raw signals survive, so the caller still gets real data.
    expect(result.transcript?.text).toBe('hello from the audio track');
    expect(result.frames).toHaveLength(2);
  });
});

describe('VideoUnderstandingService — readiness', () => {
  it('reports the toolkit reason without throwing', async () => {
    getMediaToolkitCapability.mockResolvedValue({
      available: false,
      reason: '"ffmpeg" was not found on PATH',
    });
    const { service } = buildService();

    await expect(service.getReadiness()).resolves.toEqual({
      available: false,
      reason: '"ffmpeg" was not found on PATH',
    });
  });
});
