// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * video-understanding-service.ts — real execution for the video-input family.
 *
 * Capabilities served: `video_understanding`, `video_to_text`,
 * `video_transcription`.
 *
 * Before this service those three ids were routed straight into
 * `AudioOrchestrationService.transcribeAudio()` with the caller's raw upload.
 * A `.mp4` is a container, not an audio stream, so the STT provider either
 * rejected it or transcribed nothing, and NOTHING in the request ever reached
 * a vision model — the visual half of "video understanding" did not exist.
 *
 * What happens now, all of it real work on the caller's bytes:
 *   1. `ffprobe` describes the container (duration, streams).
 *   2. The audio track is demuxed to 16 kHz mono WAV and handed to the EXISTING
 *      `speech_to_text` pipeline (`AudioOrchestrationService.transcribeAudio`),
 *      which is the Level-1, provider-backed transcription path.
 *   3. Representative frames are sampled and handed, one by one, to the
 *      EXISTING vision pipeline (`CapabilityExecutionService
 *      .executeVisionRequest`), which routes them through the orchestration
 *      engine to a model that actually declares `vision`.
 *   4. For `video_understanding` the transcript and the per-frame observations
 *      are fused by a final orchestration call into one coherent answer.
 *
 * Honesty rules enforced here
 * ───────────────────────────
 *  - No model or provider is named anywhere in this file. Every model comes
 *    from the dynamic selection already implemented downstream.
 *  - Nothing is invented on failure. A missing ffmpeg toolchain, an absent
 *    audio track, or a frame the vision pipeline could not describe each
 *    surface as a typed error or an explicit `warnings[]` entry, never as
 *    filler text.
 *  - Frame timestamps are MEASURED, read back from ffmpeg's `showinfo`
 *    filter. Only when ffmpeg reports none does the service fall back to the
 *    nominal sampling grid, and it then sets `approximateTimestamp: true`.
 */

import { logger } from '@/utils/logger';
import { AudioOrchestrationService } from '@/services/audio-orchestration-service';
import {
  getCapabilityExecutionService,
  type CapabilityExecutionService,
} from '@/services/capability-execution-service';
import {
  extractAudioTrack,
  extractFrames,
  getMediaToolkitCapability,
  MediaProcessingError,
  MediaToolkitUnavailableError,
  probeMedia,
  type FrameSamplingMode,
  type MediaProbeResult,
} from '@/services/media/ffmpeg-media-toolkit';
import type { OrchestrationContext } from '@/types';

const log = logger.child({ service: 'video-understanding' });

// ─── Public types ───────────────────────────────────────────────────────

export type VideoAnalysisMode = 'transcript' | 'understanding';

export interface VideoFrameSamplingOptions {
  readonly mode?: FrameSamplingMode;
  readonly intervalSec?: number;
  readonly maxFrames?: number;
}

export interface VideoAnalysisOptions {
  readonly videoBuffer: Buffer;
  readonly filename: string;
  /**
   * `transcript` serves `video_to_text` / `video_transcription`: the audio
   * track is the answer, frames are optional colour. `understanding` serves
   * `video_understanding`: both signals are required and then fused.
   */
  readonly mode: VideoAnalysisMode;
  readonly prompt?: string;
  readonly language?: string;
  readonly responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  readonly model?: string;
  readonly frameSampling?: VideoFrameSamplingOptions;
  /** Sample frames even in `transcript` mode. Off by default (cost). */
  readonly includeVisualContext?: boolean;
  readonly strategy?: string;
  readonly allowFallback?: boolean;
  readonly userContext: OrchestrationContext;
  readonly requestId: string;
}

export interface VideoFrameObservation {
  readonly index: number;
  readonly timestampSec: number;
  readonly approximateTimestamp: boolean;
  readonly description: string;
  readonly modelUsed?: string;
  readonly provider?: string;
}

export interface VideoTranscriptResult {
  readonly text: string;
  readonly language?: string;
  readonly durationSec?: number;
  readonly segments?: unknown;
  readonly words?: unknown;
  readonly srt?: string;
  readonly vtt?: string;
  readonly modelUsed: string;
  readonly provider: string;
}

export interface VideoMediaSummary {
  readonly durationSec?: number;
  readonly formatName?: string;
  readonly hasVideoStream: boolean;
  readonly hasAudioStream: boolean;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly framesSampled: number;
  readonly frameSamplingMode: FrameSamplingMode;
}

export interface VideoAnalysisResult {
  readonly mode: VideoAnalysisMode;
  readonly media: VideoMediaSummary;
  readonly transcript?: VideoTranscriptResult;
  readonly frames: readonly VideoFrameObservation[];
  readonly summary?: string;
  readonly summaryModelUsed?: string;
  readonly summaryProvider?: string;
  readonly warnings: readonly string[];
  readonly durationMs: number;
}

/**
 * Raised when the request is structurally impossible to serve (no ffmpeg, no
 * usable stream). Carries the unmet dependency so the route can answer with a
 * precise `capability_dependency_unavailable` rather than a generic 500.
 */
export class VideoAnalysisUnavailableError extends Error {
  readonly dependency: string;
  readonly detail?: string;

  constructor(dependency: string, message: string, detail?: string) {
    super(message);
    this.name = 'VideoAnalysisUnavailableError';
    this.dependency = dependency;
    this.detail = detail;
  }
}

// ─── Tunables (env-overridable, never model specific) ───────────────────

const DEFAULT_FRAME_CONCURRENCY = 3;
const DEFAULT_UNDERSTANDING_MAX_FRAMES = 6;
const DEFAULT_TRANSCRIPT_CONTEXT_MAX_FRAMES = 3;
/** Cap the transcript excerpt fed into the fusion prompt (characters). */
const FUSION_TRANSCRIPT_BUDGET = 12_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const FRAME_DESCRIPTION_PROMPT =
  'Describe what is visible in this single frame taken from a video: the setting, ' +
  'the people or objects present and what they appear to be doing, and any text ' +
  'that is legible on screen. Report only what is actually visible. If the frame ' +
  'is blank, blurred, or uninformative, say so plainly instead of guessing.';

// ─── Small concurrency helper ───────────────────────────────────────────

async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  limit: number,
  worker: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

function firstCodec(probe: MediaProbeResult, kind: 'video' | 'audio'): string | undefined {
  return probe.streams.find((stream) => stream.codecType === kind)?.codecName;
}

/**
 * The orchestration engine returns a provider-shaped chat response. Pull the
 * assistant text out without asserting a concrete provider schema.
 */
function extractResponseText(response: unknown): string {
  if (typeof response === 'string') return response.trim();
  if (!response || typeof response !== 'object') return '';

  const candidate = response as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    content?: unknown;
    text?: unknown;
  };

  const choiceContent = candidate.choices?.[0]?.message?.content ?? candidate.choices?.[0]?.text;
  if (typeof choiceContent === 'string') return choiceContent.trim();
  if (Array.isArray(choiceContent)) {
    return choiceContent
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('')
      .trim();
  }

  if (typeof candidate.content === 'string') return candidate.content.trim();
  if (typeof candidate.text === 'string') return candidate.text.trim();
  return '';
}

// ─── Service ────────────────────────────────────────────────────────────

export class VideoUnderstandingService {
  private readonly audioService: AudioOrchestrationService;
  private readonly getExecutionService: () => CapabilityExecutionService;

  constructor(
    audioService: AudioOrchestrationService = new AudioOrchestrationService(),
    getExecutionService: () => CapabilityExecutionService = getCapabilityExecutionService
  ) {
    this.audioService = audioService;
    this.getExecutionService = getExecutionService;
  }

  /** Non-throwing readiness report for the capability health surface. */
  async getReadiness(): Promise<{ available: boolean; reason?: string }> {
    const toolkit = await getMediaToolkitCapability();
    return toolkit.available
      ? { available: true }
      : { available: false, reason: toolkit.reason ?? 'ffmpeg toolchain unavailable' };
  }

  async analyzeVideo(options: VideoAnalysisOptions): Promise<VideoAnalysisResult> {
    const startedAt = Date.now();
    const { videoBuffer, filename, mode, requestId } = options;

    if (videoBuffer.length === 0) {
      throw new VideoAnalysisUnavailableError('input', 'Video payload is empty');
    }

    const probe = await this.probeOrExplain(videoBuffer, filename, requestId);
    const warnings: string[] = [];

    if (!probe.hasVideo && !probe.hasAudio) {
      throw new VideoAnalysisUnavailableError(
        'media_streams',
        'Uploaded file contains neither a video nor an audio stream'
      );
    }
    if (!probe.hasVideo) {
      warnings.push(
        'Container has no video stream; only the audio track was analysed. ' +
          'For an audio-only file use the speech_to_text capability directly.'
      );
    }

    const wantsFrames =
      probe.hasVideo && (mode === 'understanding' || options.includeVisualContext === true);
    const samplingMode: FrameSamplingMode = options.frameSampling?.mode ?? 'interval';

    const [transcript, frames] = await Promise.all([
      probe.hasAudio
        ? this.transcribeTrack(options, warnings)
        : Promise.resolve(undefined).then(() => {
            warnings.push('Container has no audio stream; no transcript was produced.');
            return undefined;
          }),
      wantsFrames ? this.describeFrames(options, samplingMode, warnings) : Promise.resolve([]),
    ]);

    if (mode === 'transcript' && !transcript) {
      // Distinguish "there was nothing to transcribe" from "transcription
      // failed" — the caller's next action differs (re-upload vs retry).
      throw new VideoAnalysisUnavailableError(
        probe.hasAudio ? 'speech_to_text' : 'media_streams',
        probe.hasAudio
          ? 'Transcription of the demuxed audio track failed'
          : 'Uploaded file has no audio stream, so there is nothing to transcribe',
        warnings.join(' | ')
      );
    }
    if (mode === 'understanding' && !transcript && frames.length === 0) {
      throw new VideoAnalysisUnavailableError(
        'speech_to_text+vision',
        'Neither the audio track nor any frame could be analysed',
        warnings.join(' | ')
      );
    }

    let summary: string | undefined;
    let summaryModelUsed: string | undefined;
    let summaryProvider: string | undefined;

    if (mode === 'understanding') {
      const fused = await this.fuseSignals(options, transcript, frames, warnings);
      summary = fused?.text;
      summaryModelUsed = fused?.modelUsed;
      summaryProvider = fused?.provider;
    }

    const result: VideoAnalysisResult = {
      mode,
      media: {
        durationSec: probe.durationSec,
        formatName: probe.formatName,
        hasVideoStream: probe.hasVideo,
        hasAudioStream: probe.hasAudio,
        videoCodec: firstCodec(probe, 'video'),
        audioCodec: firstCodec(probe, 'audio'),
        framesSampled: frames.length,
        frameSamplingMode: samplingMode,
      },
      transcript,
      frames,
      summary,
      summaryModelUsed,
      summaryProvider,
      warnings,
      durationMs: Date.now() - startedAt,
    };

    log.info(
      {
        requestId,
        mode,
        durationMs: result.durationMs,
        framesSampled: frames.length,
        hasTranscript: Boolean(transcript),
        warnings: warnings.length,
      },
      'Video analysis completed'
    );

    return result;
  }

  // ── Stage 1: probe ────────────────────────────────────────────────────

  private async probeOrExplain(
    buffer: Buffer,
    filename: string,
    requestId: string
  ): Promise<MediaProbeResult> {
    try {
      return await probeMedia(buffer, filename);
    } catch (error) {
      if (error instanceof MediaToolkitUnavailableError) {
        throw new VideoAnalysisUnavailableError('ffmpeg', error.message, error.dependency);
      }
      if (error instanceof MediaProcessingError) {
        throw new VideoAnalysisUnavailableError(
          'media_container',
          `Uploaded file could not be parsed as a media container: ${error.message}`,
          error.stderrTail
        );
      }
      log.error(
        { requestId, error: error instanceof Error ? error.message : String(error) },
        'Media probe failed'
      );
      throw error;
    }
  }

  // ── Stage 2: audio track → real STT pipeline ──────────────────────────

  private async transcribeTrack(
    options: VideoAnalysisOptions,
    warnings: string[]
  ): Promise<VideoTranscriptResult | undefined> {
    try {
      const audio = await extractAudioTrack(options.videoBuffer, options.filename);

      const stt = await this.audioService.transcribeAudio({
        audioBuffer: audio.buffer,
        filename: audio.filename,
        model: options.model,
        language: options.language,
        responseFormat: options.responseFormat ?? 'verbose_json',
        temperature: 0,
        strategy: options.strategy,
        allowFallback: options.allowFallback ?? true,
        userContext: options.userContext,
        requestId: options.requestId,
      });

      return {
        text: stt.text,
        language: stt.language,
        durationSec: stt.duration,
        segments: stt.segments,
        words: stt.words,
        srt: stt.srt,
        vtt: stt.vtt,
        modelUsed: stt.modelUsed,
        provider: stt.provider,
      };
    } catch (error) {
      if (error instanceof MediaToolkitUnavailableError) {
        throw new VideoAnalysisUnavailableError('ffmpeg', error.message, error.dependency);
      }
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Audio track could not be transcribed: ${message}`);
      log.warn({ requestId: options.requestId, error: message }, 'Video audio transcription failed');
      return undefined;
    }
  }

  // ── Stage 3: frames → real vision pipeline ────────────────────────────

  private async describeFrames(
    options: VideoAnalysisOptions,
    samplingMode: FrameSamplingMode,
    warnings: string[]
  ): Promise<VideoFrameObservation[]> {
    const maxFrames =
      options.frameSampling?.maxFrames ??
      (options.mode === 'understanding'
        ? positiveIntFromEnv('VIDEO_UNDERSTANDING_MAX_FRAMES', DEFAULT_UNDERSTANDING_MAX_FRAMES)
        : positiveIntFromEnv(
            'VIDEO_TRANSCRIPT_CONTEXT_MAX_FRAMES',
            DEFAULT_TRANSCRIPT_CONTEXT_MAX_FRAMES
          ));

    let frames;
    try {
      frames = await extractFrames(options.videoBuffer, options.filename, {
        mode: samplingMode,
        intervalSec: options.frameSampling?.intervalSec,
        maxFrames,
      });
    } catch (error) {
      if (error instanceof MediaToolkitUnavailableError) {
        throw new VideoAnalysisUnavailableError('ffmpeg', error.message, error.dependency);
      }
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Frame extraction failed: ${message}`);
      log.warn({ requestId: options.requestId, error: message }, 'Frame extraction failed');
      return [];
    }

    const concurrency = positiveIntFromEnv('VIDEO_FRAME_CONCURRENCY', DEFAULT_FRAME_CONCURRENCY);
    const executionService = this.getExecutionService();

    type FrameOutcome =
      | { readonly ok: true; readonly observation: VideoFrameObservation }
      | { readonly ok: false; readonly frameIndex: number; readonly error: string };

    const outcomes = await mapWithConcurrency<(typeof frames)[number], FrameOutcome>(
      frames,
      concurrency,
      async (frame) => {
        try {
          const vision = await executionService.executeVisionRequest(
            frame.buffer.toString('base64'),
            FRAME_DESCRIPTION_PROMPT,
            {
              imageFormat: 'base64',
              mimeType: frame.mimeType,
              organizationId: options.userContext.organizationId,
              userId: options.userContext.userId,
            }
          );

          if (!vision.success) {
            return {
              ok: false,
              frameIndex: frame.index,
              error: vision.error ?? 'vision execution failed',
            };
          }

          const description = extractResponseText(vision.response);
          if (!description) {
            return {
              ok: false,
              frameIndex: frame.index,
              error: 'vision pipeline returned an empty description',
            };
          }

          return {
            ok: true,
            observation: {
              index: frame.index,
              timestampSec: frame.timestampSec,
              // Measured offsets come from ffmpeg's own `showinfo` filter; the
              // flag is inverted from it rather than guessed from the sampling
              // mode, which was wrong in both directions (interval offsets are
              // centred by the `fps` filter, and scene offsets ARE reported).
              approximateTimestamp: !frame.timestampMeasured,
              description,
              modelUsed: vision.modelUsed,
              provider: vision.providerUsed,
            },
          };
        } catch (error) {
          return {
            ok: false,
            frameIndex: frame.index,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    );

    const described: VideoFrameObservation[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) {
        described.push(outcome.observation);
      } else {
        warnings.push(`Frame ${outcome.frameIndex} could not be described: ${outcome.error}`);
      }
    }

    if (described.length === 0 && frames.length > 0) {
      log.warn(
        { requestId: options.requestId, frames: frames.length },
        'Every sampled frame failed the vision pipeline'
      );
    }

    return described;
  }

  // ── Stage 4: fuse transcript + frames ─────────────────────────────────

  private async fuseSignals(
    options: VideoAnalysisOptions,
    transcript: VideoTranscriptResult | undefined,
    frames: readonly VideoFrameObservation[],
    warnings: string[]
  ): Promise<{ text: string; modelUsed?: string; provider?: string } | undefined> {
    const sections: string[] = [];

    if (transcript?.text) {
      const excerpt = transcript.text.slice(0, FUSION_TRANSCRIPT_BUDGET);
      sections.push(
        `SPOKEN AUDIO TRANSCRIPT${
          excerpt.length < transcript.text.length ? ' (truncated)' : ''
        }:\n${excerpt}`
      );
    } else {
      sections.push('SPOKEN AUDIO TRANSCRIPT: (none available for this video)');
    }

    if (frames.length > 0) {
      const rendered = frames
        .map(
          (frame) =>
            `- ${frame.approximateTimestamp ? '~' : ''}${frame.timestampSec}s: ${frame.description}`
        )
        .join('\n');
      sections.push(`VISUAL OBSERVATIONS FROM SAMPLED FRAMES:\n${rendered}`);
    } else {
      sections.push('VISUAL OBSERVATIONS FROM SAMPLED FRAMES: (none available for this video)');
    }

    const question =
      options.prompt?.trim() ||
      'Describe what happens in this video, combining what is said with what is shown.';

    const instruction =
      'You are given two independently produced descriptions of the same video: a ' +
      'transcript of its audio track, and descriptions of individual frames sampled ' +
      'from its timeline. Answer the question using only those two sources. Where they ' +
      'disagree, say so. Do not describe anything that appears in neither source, and ' +
      'do not claim to have watched the video yourself.';

    try {
      const result = await this.getExecutionService().executeWithCapabilities(
        [
          { role: 'system', content: instruction },
          {
            role: 'user',
            content: `${sections.join('\n\n')}\n\nQUESTION: ${question}`,
          },
        ],
        {
          requiredCapabilities: ['analysis'],
          organizationId: options.userContext.organizationId,
          userId: options.userContext.userId,
          strategy: options.strategy,
          taskType: 'analysis',
        }
      );

      if (!result.success) {
        warnings.push(`Cross-modal synthesis failed: ${result.error ?? 'unknown error'}`);
        return undefined;
      }

      const text = extractResponseText(result.response);
      if (!text) {
        warnings.push('Cross-modal synthesis returned an empty answer.');
        return undefined;
      }

      return { text, modelUsed: result.modelUsed, provider: result.providerUsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Cross-modal synthesis failed: ${message}`);
      log.warn({ requestId: options.requestId, error: message }, 'Video synthesis failed');
      return undefined;
    }
  }
}

let singleton: VideoUnderstandingService | null = null;

export function getVideoUnderstandingService(): VideoUnderstandingService {
  if (!singleton) singleton = new VideoUnderstandingService();
  return singleton;
}
