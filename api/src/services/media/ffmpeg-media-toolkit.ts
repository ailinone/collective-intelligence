// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ffmpeg-media-toolkit.ts — REAL container demux for the video capability family.
 *
 * Why this exists
 * ───────────────
 * `video_to_text`, `video_transcription` and `video_understanding` used to be
 * routed at the capability dispatcher into `AudioOrchestrationService`
 * .transcribeAudio() with the caller's raw bytes. That is a Level-2 lie: a
 * container (mp4/webm/mkv) is not an audio stream, so either the STT provider
 * rejected it or it silently transcribed nothing, and NO frame ever reached a
 * vision model. This module performs the real work those capabilities imply —
 * demux the audio track, sample representative frames — and hands each signal
 * to the pipeline that already executes it for real (`speech_to_text` for the
 * audio track, `vision` for the frames).
 *
 * Contract invariants
 * ───────────────────
 *  - NO fabrication. If the ffmpeg toolchain is not installed, every entry
 *    point throws `MediaToolkitUnavailableError`. It never degrades into
 *    "returned the input unchanged" or a synthesised description.
 *  - NO model / provider name appears here. This module is pure media
 *    plumbing; model selection stays dynamic in the services above it.
 *  - Every temporary artefact is written under an `mkdtemp` directory that is
 *    removed in a `finally`, including on throw.
 *  - Binary resolution is explicit: `FFMPEG_PATH` / `FFPROBE_PATH` win, then a
 *    PATH lookup, probed once per process and memoised (including the negative
 *    result, so a missing toolchain does not spawn a process per request).
 *
 * Deployment: the runtime image installs `ffmpeg` (see `api/Dockerfile`), which
 * provides both `ffmpeg` and `ffprobe`.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/utils/logger';

const log = logger.child({ module: 'ffmpeg-media-toolkit' });

// ─── Errors ─────────────────────────────────────────────────────────────

/**
 * The ffmpeg toolchain is absent (or not executable). Callers MUST surface
 * this as an unmet dependency, never as an empty or degraded result.
 */
export class MediaToolkitUnavailableError extends Error {
  readonly dependency: string;

  constructor(dependency: string, detail?: string) {
    super(
      `Media toolkit dependency "${dependency}" is not available on this host${
        detail ? `: ${detail}` : ''
      }. Install ffmpeg (which ships ffprobe) or set ${dependency.toUpperCase()}_PATH.`
    );
    this.name = 'MediaToolkitUnavailableError';
    this.dependency = dependency;
  }
}

/** ffmpeg/ffprobe ran but rejected the input (corrupt file, unknown codec…). */
export class MediaProcessingError extends Error {
  readonly stderrTail?: string;

  constructor(message: string, stderrTail?: string) {
    super(message);
    this.name = 'MediaProcessingError';
    this.stderrTail = stderrTail;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

export interface MediaStreamSummary {
  readonly codecType: 'video' | 'audio' | 'subtitle' | 'data' | 'other';
  readonly codecName?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSec?: number;
}

export interface MediaProbeResult {
  readonly durationSec?: number;
  readonly formatName?: string;
  readonly sizeBytes?: number;
  readonly streams: readonly MediaStreamSummary[];
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

export interface AudioExtractionOptions {
  /** Target sample rate. 16 kHz mono is the ASR-standard ingest shape. */
  readonly sampleRateHz?: number;
  readonly channels?: number;
  /** Hard cap on the decoded span; protects against multi-hour uploads. */
  readonly maxDurationSec?: number;
}

export interface ExtractedAudio {
  readonly buffer: Buffer;
  readonly filename: string;
  readonly mimeType: string;
  readonly sampleRateHz: number;
  readonly channels: number;
}

export type FrameSamplingMode = 'interval' | 'scene';

export interface FrameExtractionOptions {
  /**
   * `interval` samples one frame every `intervalSec` (deterministic, cheap,
   * covers the whole timeline). `scene` samples on detected scene changes and
   * is preferred when the video is mostly static — it is a single ffmpeg
   * filter, so it costs the same decode pass.
   */
  readonly mode?: FrameSamplingMode;
  readonly intervalSec?: number;
  /** Scene-change sensitivity in [0,1]; only read when `mode === 'scene'`. */
  readonly sceneThreshold?: number;
  readonly maxFrames?: number;
  /** Longest edge in pixels; frames are downscaled before base64 encoding. */
  readonly maxWidth?: number;
  readonly jpegQuality?: number;
}

export interface ExtractedFrame {
  readonly index: number;
  /** Offset of the frame inside the source, in seconds. */
  readonly timestampSec: number;
  /**
   * True when `timestampSec` was MEASURED (read back from ffmpeg's `showinfo`
   * filter), false when it is the nominal sampling grid used as a fallback.
   * Consumers must not present an unmeasured offset as a fact.
   */
  readonly timestampMeasured: boolean;
  readonly buffer: Buffer;
  readonly mimeType: 'image/jpeg';
}

export interface MediaToolkitCapability {
  readonly available: boolean;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly reason?: string;
}

// ─── Defaults (env-overridable, never model/provider specific) ──────────

const DEFAULT_AUDIO_SAMPLE_RATE_HZ = 16_000;
const DEFAULT_AUDIO_CHANNELS = 1;
const DEFAULT_FRAME_INTERVAL_SEC = 5;
const DEFAULT_MAX_FRAMES = 8;
const DEFAULT_MAX_FRAME_WIDTH = 768;
const DEFAULT_JPEG_QUALITY = 4; // ffmpeg -q:v scale, 2 (best) … 31 (worst)
const DEFAULT_SCENE_THRESHOLD = 0.35;
const PROCESS_TIMEOUT_MS = 120_000;
const STDERR_TAIL_CHARS = 2_000;
/**
 * Frame extraction runs ffmpeg at `-v info` so the `showinfo` filter's
 * per-frame `pts_time:` lines are visible. That output is bounded by
 * `-frames:v`, but the window is generous so an early frame's timestamp is
 * never trimmed away by ffmpeg's own start-up chatter.
 */
const SHOWINFO_STDERR_LIMIT_CHARS = 256_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ─── Binary resolution ──────────────────────────────────────────────────

type ResolutionCache = { readonly path: string | null; readonly reason?: string };

const resolutionCache = new Map<string, ResolutionCache>();

async function canExecute(binary: string): Promise<boolean> {
  try {
    await runProcess(binary, ['-version'], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function resolveBinary(name: 'ffmpeg' | 'ffprobe'): Promise<ResolutionCache> {
  const cached = resolutionCache.get(name);
  if (cached) return cached;

  const explicit = process.env[`${name.toUpperCase()}_PATH`];
  const candidates = explicit ? [explicit] : [name];

  for (const candidate of candidates) {
    if (await canExecute(candidate)) {
      const resolved: ResolutionCache = { path: candidate };
      resolutionCache.set(name, resolved);
      log.info({ binary: name, path: candidate }, 'Media toolkit binary resolved');
      return resolved;
    }
  }

  const resolved: ResolutionCache = {
    path: null,
    reason: explicit
      ? `${name.toUpperCase()}_PATH="${explicit}" is not executable`
      : `"${name}" was not found on PATH`,
  };
  resolutionCache.set(name, resolved);
  log.warn({ binary: name, reason: resolved.reason }, 'Media toolkit binary unavailable');
  return resolved;
}

/** Test seam — forget memoised probes so a test can flip the environment. */
export function __resetMediaToolkitResolution(): void {
  resolutionCache.clear();
}

async function requireBinary(name: 'ffmpeg' | 'ffprobe'): Promise<string> {
  const resolved = await resolveBinary(name);
  if (!resolved.path) throw new MediaToolkitUnavailableError(name, resolved.reason);
  return resolved.path;
}

/**
 * Non-throwing availability report. Used by the capability health surface so
 * `/v1/capabilities/video_understanding/health` can state the real reason a
 * capability is not operational instead of guessing.
 */
export async function getMediaToolkitCapability(): Promise<MediaToolkitCapability> {
  const [ffmpeg, ffprobe] = await Promise.all([resolveBinary('ffmpeg'), resolveBinary('ffprobe')]);
  if (ffmpeg.path && ffprobe.path) {
    return { available: true, ffmpegPath: ffmpeg.path, ffprobePath: ffprobe.path };
  }
  return {
    available: false,
    ffmpegPath: ffmpeg.path ?? undefined,
    ffprobePath: ffprobe.path ?? undefined,
    reason: [ffmpeg.reason, ffprobe.reason].filter(Boolean).join('; '),
  };
}

// ─── Process runner ─────────────────────────────────────────────────────

interface RunProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  /**
   * True when stderr outgrew its retention window and the EARLIEST output was
   * dropped. Load-bearing for frame extraction: `showinfo` emits one timestamp
   * line per frame in order, and the frames are matched to them BY INDEX, so a
   * truncated head would silently attach frame 0's picture to frame 3's
   * timestamp. The caller falls back to unmeasured offsets instead.
   */
  readonly stderrTruncated: boolean;
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; cwd?: string; stderrLimitChars?: number }
): Promise<RunProcessResult> {
  // Frame extraction needs the FULL stderr (the `showinfo` filter reports one
  // timestamp line per emitted frame there), so the retention window is a
  // parameter. It stays bounded — the caller caps the frame count.
  const stderrLimit = options.stderrLimitChars ?? STDERR_TAIL_CHARS * 2;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // `shell: false` (the default) is load-bearing: every argument below
        // is passed as an argv element, so a hostile filename can never be
        // reinterpreted by a shell.
        shell: false,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stderrTruncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new MediaProcessingError(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > stderrLimit * 2) {
        stderr = stderr.slice(-stderrLimit);
        stderrTruncated = true;
      }
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, stderrTruncated });
        return;
      }
      reject(
        new MediaProcessingError(
          `${command} exited with code ${code ?? 'null'}`,
          stderr.slice(-STDERR_TAIL_CHARS)
        )
      );
    });
  });
}

// ─── Temp workspace ─────────────────────────────────────────────────────

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      log.warn(
        { dir, error: error instanceof Error ? error.message : String(error) },
        'Failed to remove media temp dir'
      );
    });
  }
}

/**
 * ffmpeg is given a real file rather than stdin: container formats such as
 * mp4 carry their index in a trailing atom, and a non-seekable pipe makes
 * ffmpeg fail or buffer the whole stream anyway.
 */
async function writeSource(dir: string, buffer: Buffer, filename: string): Promise<string> {
  const safeName = sanitiseFilename(filename);
  const path = join(dir, safeName);
  await fs.writeFile(path, buffer);
  return path;
}

/**
 * Reduce a caller-supplied filename to a leaf name with a conservative
 * charset. The file lands in a private mkdtemp dir, so this is defence in
 * depth against traversal (`../../etc/x`) rather than the only barrier.
 */
export function sanitiseFilename(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 128) : 'source.bin';
}

// ─── Probe ──────────────────────────────────────────────────────────────

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string; size?: string };
}

function toCodecType(value: string | undefined): MediaStreamSummary['codecType'] {
  if (value === 'video' || value === 'audio' || value === 'subtitle' || value === 'data') {
    return value;
  }
  return 'other';
}

function parseNumeric(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Inspect a media container. Throws when the toolchain is missing. */
export async function probeMedia(buffer: Buffer, filename: string): Promise<MediaProbeResult> {
  const ffprobe = await requireBinary('ffprobe');

  return withTempDir('ailin-probe-', async (dir) => {
    const source = await writeSource(dir, buffer, filename);
    const { stdout } = await runProcess(
      ffprobe,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-i',
        source,
      ],
      { timeoutMs: PROCESS_TIMEOUT_MS, cwd: dir }
    );

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch {
      throw new MediaProcessingError('ffprobe returned unparseable JSON');
    }

    const streams: MediaStreamSummary[] = (parsed.streams ?? []).map((stream) => ({
      codecType: toCodecType(stream.codec_type),
      codecName: stream.codec_name,
      width: stream.width,
      height: stream.height,
      durationSec: parseNumeric(stream.duration),
    }));

    return {
      durationSec: parseNumeric(parsed.format?.duration),
      formatName: parsed.format?.format_name,
      sizeBytes: parseNumeric(parsed.format?.size),
      streams,
      hasVideo: streams.some((stream) => stream.codecType === 'video'),
      hasAudio: streams.some((stream) => stream.codecType === 'audio'),
    };
  });
}

// ─── Audio demux ────────────────────────────────────────────────────────

/**
 * Extract the audio track as 16-bit PCM WAV. WAV (rather than a compressed
 * codec) keeps the output universally acceptable to every STT provider in the
 * catalog and removes a re-encode from the critical path.
 */
export async function extractAudioTrack(
  buffer: Buffer,
  filename: string,
  options: AudioExtractionOptions = {}
): Promise<ExtractedAudio> {
  const ffmpeg = await requireBinary('ffmpeg');
  const sampleRateHz =
    options.sampleRateHz ??
    positiveIntFromEnv('MEDIA_AUDIO_SAMPLE_RATE_HZ', DEFAULT_AUDIO_SAMPLE_RATE_HZ);
  const channels =
    options.channels ?? positiveIntFromEnv('MEDIA_AUDIO_CHANNELS', DEFAULT_AUDIO_CHANNELS);

  return withTempDir('ailin-demux-', async (dir) => {
    const source = await writeSource(dir, buffer, filename);
    const outputPath = join(dir, 'audio.wav');

    const args = [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-i',
      source,
      // Fail loudly when the container has no audio track instead of writing
      // a valid-but-silent wav that STT would "transcribe" to "".
      '-vn',
      '-map',
      '0:a:0',
      '-acodec',
      'pcm_s16le',
      '-ar',
      String(sampleRateHz),
      '-ac',
      String(channels),
      ...(options.maxDurationSec ? ['-t', String(options.maxDurationSec)] : []),
      '-y',
      outputPath,
    ];

    await runProcess(ffmpeg, args, { timeoutMs: PROCESS_TIMEOUT_MS, cwd: dir });
    const audio = await fs.readFile(outputPath);

    if (audio.length === 0) {
      throw new MediaProcessingError('Audio demux produced an empty track');
    }

    return {
      buffer: audio,
      filename: 'audio.wav',
      mimeType: 'audio/wav',
      sampleRateHz,
      channels,
    };
  });
}

// ─── Frame sampling ─────────────────────────────────────────────────────

function frameFilter(
  mode: FrameSamplingMode,
  intervalSec: number,
  sceneThreshold: number,
  maxWidth: number
): string {
  // `scale` keeps the width bounded while preserving aspect ratio (-2 rounds
  // the height to an even value, which the JPEG encoder requires). `min(w,iw)`
  // means a frame narrower than the cap is never upscaled.
  const scale = `scale='min(${maxWidth},iw)':-2`;
  // `format=yuvj420p` is NOT cosmetic. Verified against ffmpeg 8.1.2 on
  // alpine (2026-09-05): with a limited-range yuv420p source the mjpeg
  // encoder refuses to initialise — "Non full-range YUV is non-standard" →
  // "ff_frame_thread_encoder_init failed" → "Nothing was written into output
  // file". `scene` mode hit this on a plain h264 test clip while `interval`
  // mode happened not to, so the conversion is applied to both rather than
  // left to chance.
  const jpegPixelFormat = 'format=yuvj420p';
  // `showinfo` prints one `pts_time:` line per emitted frame to stderr, which
  // is how the caller learns each frame's REAL offset. Computing it as
  // `index * intervalSec` was wrong: the `fps` filter centres its samples, so
  // a 12 s clip at `fps=1/5` emits frames at 2.5 s and 7.5 s, not 0 s and 5 s
  // (measured in the same container run).
  const selector =
    mode === 'scene' ? `select='gt(scene,${sceneThreshold})'` : `fps=1/${intervalSec}`;
  return `${selector},${scale},${jpegPixelFormat},showinfo`;
}

/**
 * Pull the per-frame presentation timestamps out of `showinfo`'s stderr
 * output, in emission order. Returns an empty array when the filter logged
 * nothing (which the caller treats as "timestamps unknown" rather than
 * inventing them).
 */
export function parseShowinfoTimestamps(stderr: string): number[] {
  const timestamps: number[] = [];
  const pattern = /pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stderr)) !== null) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) timestamps.push(value);
  }
  return timestamps;
}

/**
 * Sample representative frames. Returns them in timeline order with the real
 * presentation timestamp attached, so a downstream description can be tied to
 * a moment in the video rather than to an opaque index.
 */
export async function extractFrames(
  buffer: Buffer,
  filename: string,
  options: FrameExtractionOptions = {}
): Promise<ExtractedFrame[]> {
  const ffmpeg = await requireBinary('ffmpeg');

  const mode: FrameSamplingMode = options.mode ?? 'interval';
  const intervalSec =
    options.intervalSec ??
    positiveIntFromEnv('MEDIA_FRAME_INTERVAL_SEC', DEFAULT_FRAME_INTERVAL_SEC);
  const maxFrames =
    options.maxFrames ?? positiveIntFromEnv('MEDIA_MAX_FRAMES', DEFAULT_MAX_FRAMES);
  const sceneThreshold = options.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD;
  const jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const maxWidth =
    options.maxWidth ?? positiveIntFromEnv('MEDIA_MAX_FRAME_WIDTH', DEFAULT_MAX_FRAME_WIDTH);

  return withTempDir('ailin-frames-', async (dir) => {
    const source = await writeSource(dir, buffer, filename);

    const args = [
      '-hide_banner',
      '-nostdin',
      // `info`, not `error`: the `showinfo` filter reports each emitted
      // frame's pts_time at info level, and those timestamps are the whole
      // point. stderr stays bounded because `-frames:v` bounds the output.
      '-v',
      'info',
      '-i',
      source,
      '-map',
      '0:v:0',
      '-vf',
      frameFilter(mode, intervalSec, sceneThreshold, maxWidth),
      // `vsync vfr` keeps the selected frames' own timestamps rather than
      // resampling to a constant rate — required for `select` filters.
      '-vsync',
      'vfr',
      '-frames:v',
      String(maxFrames),
      '-q:v',
      String(jpegQuality),
      '-f',
      'image2',
      '-y',
      join(dir, 'frame-%04d.jpg'),
    ];

    const { stderr, stderrTruncated } = await runProcess(ffmpeg, args, {
      timeoutMs: PROCESS_TIMEOUT_MS,
      cwd: dir,
      stderrLimitChars: SHOWINFO_STDERR_LIMIT_CHARS,
    });
    // Frames are matched to `showinfo` lines BY INDEX. If the earliest stderr
    // was dropped, that mapping is off by an unknown amount, so every offset
    // is reported as unmeasured rather than as a plausible wrong number.
    // `-frames:v` bounds the output, so this should not be reachable — the
    // guard exists because the failure mode is silent, not because it is likely.
    const timestamps = stderrTruncated ? [] : parseShowinfoTimestamps(stderr);
    if (stderrTruncated) {
      log.warn(
        { retainedChars: stderr.length },
        'ffmpeg stderr outgrew its window; frame timestamps reported as unmeasured'
      );
    }

    const entries = (await fs.readdir(dir))
      .filter((name) => /^frame-\d{4}\.jpg$/.test(name))
      .sort();

    const frames: ExtractedFrame[] = [];
    for (const [index, name] of entries.entries()) {
      const frameBuffer = await fs.readFile(join(dir, name));
      if (frameBuffer.length === 0) continue;
      const measured = timestamps[index];
      frames.push({
        index,
        // The MEASURED offset when showinfo reported one. The fallback grid is
        // only reached if the filter logged nothing, and is flagged by
        // `timestampMeasured: false` so a consumer never presents a guessed
        // offset as a fact.
        timestampSec: measured ?? index * intervalSec,
        timestampMeasured: measured !== undefined,
        buffer: frameBuffer,
        mimeType: 'image/jpeg',
      });
    }

    if (frames.length === 0) {
      throw new MediaProcessingError(
        'Frame extraction produced no frames',
        stderr.slice(-STDERR_TAIL_CHARS)
      );
    }

    return frames;
  });
}

// ─── Compose (duration extension, mux audio + video, resize) ───────────
//
// 2026-09-09: the demux/frame functions above only ever go ONE direction —
// container IN, audio/frames OUT. There was no COMPOSITION capability
// anywhere in this module (or the codebase) to close the gap an audit found
// in the video-generation routing path: a duration-bearing request (e.g.
// "a 30 second video") is filtered by `video-capability-matcher.ts` against
// each candidate's DECLARED `maxDurationSeconds`/`allowedDurationsSeconds`,
// but only 5 providers have that attribute populated (see
// `providers.catalog.ts`) — every other candidate is admitted "fail-open"
// with NO guarantee its actual output reaches the requested length. Before
// this function existed, a model that silently produced an 8s clip for a
// 30s request shipped that clip as a "success" with no correction and no
// signal that the requirement went unmet.
//
// `extendVideoToDuration` is the duration analogue of the image
// `image_upscale`/`image_denoise` pattern (a base model generates, a
// separate specialized step completes what the base model couldn't): it
// loops the ALREADY-GENERATED, real clip via ffmpeg's `-stream_loop` and
// trims to the exact target length. This extends real generated content —
// it never fabricates new frames or synthesizes footage the model never
// produced.
//
// `muxAudioIntoVideo` (Package A, 2026-09-09) is the audio analogue of the
// same pattern: when a video-generation model has no native audio
// capability (`VideoCapabilityAttributes.nativeAudioSupport === false`, or
// simply undeclared) but the caller supplies a real soundtrack asset, this
// function attaches it for real instead of silently returning a silent clip.
// `resizeVideo` is the video analogue of an upscale/downscale step, for a
// candidate whose native output resolution doesn't match what was requested.

export interface ExtendVideoOptions {
  /** Desired minimum total duration of the output, in seconds. */
  readonly targetDurationSec: number;
}

export interface ExtendedVideo {
  readonly buffer: Buffer;
  readonly mimeType: 'video/mp4';
  /**
   * How many EXTRA passes of the source were concatenated to reach the
   * target (0 means the source already met/exceeded the target and was only
   * trimmed to it).
   */
  readonly loopsApplied: number;
}

/**
 * Defensive ceiling on how many extra passes a single extend call will
 * attempt. A source clip far shorter than the target would otherwise spawn
 * an unbounded ffmpeg job — `loopsApplied` scales with `target / source`,
 * so a degenerate (near-zero-length) source against a large target must be
 * rejected rather than attempted. Callers see a clear `MediaProcessingError`
 * instead of a job that runs for an unbounded amount of time.
 */
const MAX_EXTEND_LOOPS = 20;

/**
 * Extend (or trim) a real generated video clip to a target duration by
 * looping it with ffmpeg's `-stream_loop` and cutting to the exact length.
 * Re-encodes (`libx264`/`aac`) rather than stream-copying: `-stream_loop`
 * concatenation across a re-used input can produce non-monotonic timestamps
 * under `-c copy`, which some players / downstream ffmpeg passes reject.
 *
 * Throws `MediaToolkitUnavailableError` when ffmpeg/ffprobe are missing, and
 * `MediaProcessingError` when the source duration cannot be determined, or
 * when the required loop count exceeds `MAX_EXTEND_LOOPS`. Never silently
 * returns the original video unchanged — a soft-fail composition step (ship
 * the original if extension isn't possible) is the CALLER's decision, same
 * contract as the rest of this module.
 */
export async function extendVideoToDuration(
  videoBuffer: Buffer,
  videoFilename: string,
  options: ExtendVideoOptions
): Promise<ExtendedVideo> {
  const { targetDurationSec } = options;
  if (!(targetDurationSec > 0)) {
    throw new MediaProcessingError('extendVideoToDuration requires a positive targetDurationSec');
  }

  // Reuses the existing, tested probe rather than re-implementing ffprobe
  // invocation here. Requires ffprobe; a missing toolchain surfaces as
  // MediaToolkitUnavailableError naming it, before ffmpeg is even resolved.
  const probe = await probeMedia(videoBuffer, videoFilename);
  const sourceDurationSec = probe.durationSec;
  if (!sourceDurationSec || sourceDurationSec <= 0) {
    throw new MediaProcessingError(
      'extendVideoToDuration could not determine the source clip duration'
    );
  }

  const ffmpeg = await requireBinary('ffmpeg');
  const loopsApplied =
    sourceDurationSec >= targetDurationSec
      ? 0
      : Math.ceil(targetDurationSec / sourceDurationSec) - 1;

  if (loopsApplied > MAX_EXTEND_LOOPS) {
    throw new MediaProcessingError(
      `extendVideoToDuration would need ${loopsApplied} loop passes (source ` +
        `${sourceDurationSec}s -> target ${targetDurationSec}s), which exceeds the safety ` +
        `cap of ${MAX_EXTEND_LOOPS}`
    );
  }

  return withTempDir('ailin-extend-', async (dir) => {
    const videoPath = await writeSource(dir, videoBuffer, videoFilename);
    const outputPath = join(dir, 'extended.mp4');

    const args = [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-stream_loop',
      String(loopsApplied),
      '-i',
      videoPath,
      '-map',
      '0:v:0',
      // Optional map ('?' suffix): a source with no audio stream must not
      // fail the whole job just because there is nothing to map onto -c:a.
      '-map',
      '0:a:0?',
      '-t',
      String(targetDurationSec),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    ];

    await runProcess(ffmpeg, args, { timeoutMs: PROCESS_TIMEOUT_MS, cwd: dir });
    const extended = await fs.readFile(outputPath);

    if (extended.length === 0) {
      throw new MediaProcessingError('Video duration extension produced an empty file');
    }

    return { buffer: extended, mimeType: 'video/mp4', loopsApplied };
  });
}

export interface MuxAudioOptions {
  /**
   * `'replace'` (default) drops any existing audio stream and uses ONLY the
   * supplied track. `'mix'` keeps the video's own audio (if it has one) and
   * mixes the supplied track in on top — use this when the base video
   * already has ambient/dialogue audio and the soundtrack should layer over
   * it, not replace it.
   */
  readonly mode?: 'replace' | 'mix';
  /** Trim/pad the composed output to the VIDEO's duration (default `true`).
   *  When `false`, the output runs as long as the LONGER of the two inputs
   *  (ffmpeg's default `amerge`/concat behavior), which can leave trailing
   *  silence or an abruptly-cut soundtrack — most callers want `true`. */
  readonly matchVideoDuration?: boolean;
}

export interface ComposedVideo {
  readonly buffer: Buffer;
  readonly mimeType: 'video/mp4';
}

/**
 * Mux an audio track into a video, producing a new MP4. Re-encodes the audio
 * to AAC (universally accepted by MP4 containers) while copying the video
 * stream unchanged (`-c:v copy`) — fast, and never re-introduces generation
 * artifacts into a video the caller already accepted.
 *
 * Throws `MediaToolkitUnavailableError` when ffmpeg is missing (never
 * silently returns the original video unchanged — that would misreport a
 * skipped step as a completed one). Callers that want a soft-fail composition
 * step (e.g. "attach a soundtrack if possible, otherwise ship the silent
 * video") must catch this at the call site and decide the fallback there; this
 * function's own contract is the same fail-closed one as the rest of the
 * module.
 */
export async function muxAudioIntoVideo(
  videoBuffer: Buffer,
  videoFilename: string,
  audioBuffer: Buffer,
  audioFilename: string,
  options: MuxAudioOptions = {}
): Promise<ComposedVideo> {
  const ffmpeg = await requireBinary('ffmpeg');
  const mode = options.mode ?? 'replace';
  const matchVideoDuration = options.matchVideoDuration ?? true;

  return withTempDir('ailin-mux-', async (dir) => {
    const videoPath = await writeSource(dir, videoBuffer, videoFilename);
    const audioPath = await writeSource(dir, audioBuffer, audioFilename);
    const outputPath = join(dir, 'composed.mp4');

    const args = [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-i',
      videoPath,
      '-i',
      audioPath,
      '-map',
      '0:v:0',
    ];

    if (mode === 'mix') {
      // Mix the video's own audio (if any) with the supplied track. `amix`
      // requires both inputs to exist; `-filter_complex` with an explicit
      // duration policy avoids ffmpeg's default of ending when the SHORTER
      // input ends, which would clip whichever track is longer.
      args.push(
        '-filter_complex',
        `[0:a:0][1:a:0]amix=inputs=2:duration=${matchVideoDuration ? 'first' : 'longest'}:dropout_transition=0[aout]`,
        '-map',
        '[aout]'
      );
    } else {
      args.push('-map', '1:a:0');
    }

    args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k');
    if (matchVideoDuration && mode === 'replace') {
      // `-shortest` only matters in replace mode — mix mode's `amix duration=`
      // above already governs the output length.
      args.push('-shortest');
    }
    args.push('-movflags', '+faststart', '-y', outputPath);

    await runProcess(ffmpeg, args, { timeoutMs: PROCESS_TIMEOUT_MS, cwd: dir });
    const composed = await fs.readFile(outputPath);

    if (composed.length === 0) {
      throw new MediaProcessingError('Audio/video mux produced an empty file');
    }

    return { buffer: composed, mimeType: 'video/mp4' };
  });
}

export interface ResizeVideoOptions {
  /** Target width in pixels. Height is derived to preserve aspect ratio
   *  unless `height` is also given. At least one of `width`/`height` is
   *  required. */
  readonly width?: number;
  readonly height?: number;
  /**
   * When both `width` and `height` are given, `'fit'` (default) letterboxes
   * to preserve the source aspect ratio inside the target box; `'stretch'`
   * distorts the source to fill the exact target dimensions; `'crop'` fills
   * the target box by cropping any overflow.
   */
  readonly fitMode?: 'fit' | 'stretch' | 'crop';
}

/**
 * Re-encode a video to a target resolution. Used as a follow-up composition
 * step when a generation model's native output doesn't match a requested
 * resolution/aspect ratio (mirrors `muxAudioIntoVideo`'s role for the audio
 * axis). Video is re-encoded (`libx264`); the audio stream, if present, is
 * copied unchanged.
 */
export async function resizeVideo(
  videoBuffer: Buffer,
  videoFilename: string,
  options: ResizeVideoOptions
): Promise<ComposedVideo> {
  if (!options.width && !options.height) {
    throw new MediaProcessingError('resizeVideo requires at least one of width/height');
  }
  const ffmpeg = await requireBinary('ffmpeg');
  const fitMode = options.fitMode ?? 'fit';

  return withTempDir('ailin-resize-', async (dir) => {
    const videoPath = await writeSource(dir, videoBuffer, videoFilename);
    const outputPath = join(dir, 'resized.mp4');

    const width = options.width ?? -2;
    const height = options.height ?? -2;
    let scaleFilter: string;
    if (fitMode === 'stretch' || !options.width || !options.height) {
      // Only one dimension given (or an explicit stretch request): scale
      // directly, letting ffmpeg derive the other side with `-2` (rounds to
      // an even value, required by most encoders) when it was omitted.
      scaleFilter = `scale=${width}:${height}${fitMode === 'stretch' && options.width && options.height ? '' : ':force_original_aspect_ratio=decrease'}`;
    } else if (fitMode === 'crop') {
      scaleFilter =
        `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height}`;
    } else {
      // 'fit': scale to fit inside the box, then pad the shortfall (letterbox).
      scaleFilter =
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
    }

    const args = [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-i',
      videoPath,
      '-vf',
      scaleFilter,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    ];

    await runProcess(ffmpeg, args, { timeoutMs: PROCESS_TIMEOUT_MS, cwd: dir });
    const resized = await fs.readFile(outputPath);

    if (resized.length === 0) {
      throw new MediaProcessingError('Video resize produced an empty file');
    }

    return { buffer: resized, mimeType: 'video/mp4' };
  });
}

export const __mediaToolkitDefaults = Object.freeze({
  DEFAULT_AUDIO_SAMPLE_RATE_HZ,
  DEFAULT_AUDIO_CHANNELS,
  DEFAULT_FRAME_INTERVAL_SEC,
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_FRAME_WIDTH,
  DEFAULT_SCENE_THRESHOLD,
  MAX_EXTEND_LOOPS,
});
