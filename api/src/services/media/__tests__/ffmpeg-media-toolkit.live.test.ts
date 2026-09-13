// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * LIVE ffmpeg tests — real demux and real frame extraction on a real
 * container. Skipped automatically when the toolchain is absent (developer
 * laptops), and exercised for real wherever ffmpeg is installed: the API
 * runtime image installs it, so this suite runs in every environment that can
 * actually serve the video-input capabilities.
 *
 * Provenance: the argv asserted here was first validated by hand inside
 * `node:24-alpine` + `apk add ffmpeg` (ffmpeg 8.1.2, 2026-09-05). That run
 * caught two real defects which this suite now locks down:
 *   1. the mjpeg encoder refusing limited-range yuv420p input, which made
 *      `scene` sampling silently produce ZERO frames ("Nothing was written
 *      into output file") — fixed by `format=yuvj420p` in the filter chain;
 *   2. frame offsets being computed as `index * intervalSec` instead of read
 *      back from ffmpeg, which is now measured via `showinfo`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  extendVideoToDuration,
  extractAudioTrack,
  extractFrames,
  getMediaToolkitCapability,
  MediaProcessingError,
  muxAudioIntoVideo,
  probeMedia,
  resizeVideo,
} from '../ffmpeg-media-toolkit';

async function toolchainAvailable(): Promise<boolean> {
  const capability = await getMediaToolkitCapability();
  return capability.available;
}

const HAS_FFMPEG = await toolchainAvailable();

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg fixture failed: ${stderr.slice(-500)}`))
    );
  });
}

/** 12 s clip: a moving test pattern plus a 440 Hz tone (video + audio). */
async function buildFixture(dir: string, name: string, withAudio: boolean): Promise<Buffer> {
  const path = join(dir, name);
  const args = withAudio
    ? [
        '-hide_banner', '-v', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=12',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', path,
      ]
    : [
        '-hide_banner', '-v', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=6',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path,
      ];
  await runFfmpeg(args);
  return fs.readFile(path);
}

describe.skipIf(!HAS_FFMPEG)('ffmpeg-media-toolkit — live', () => {
  let workDir: string;
  let clipWithAudio: Buffer;
  let clipWithoutAudio: Buffer;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), 'ailin-media-live-'));
    clipWithAudio = await buildFixture(workDir, 'with-audio.mp4', true);
    clipWithoutAudio = await buildFixture(workDir, 'no-audio.mp4', false);
  }, 120_000);

  it('probes the container and reports both streams', async () => {
    const probe = await probeMedia(clipWithAudio, 'with-audio.mp4');

    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
    expect(probe.durationSec).toBeGreaterThan(11);
    expect(probe.streams.find((s) => s.codecType === 'video')?.width).toBe(320);
  }, 60_000);

  it('demuxes the audio track to 16 kHz mono PCM WAV', async () => {
    const audio = await extractAudioTrack(clipWithAudio, 'with-audio.mp4');

    expect(audio.buffer.length).toBeGreaterThan(1000);
    expect(audio.mimeType).toBe('audio/wav');
    expect(audio.sampleRateHz).toBe(16_000);
    expect(audio.channels).toBe(1);
    // RIFF/WAVE magic — the bytes really are a wav container, not the mp4.
    expect(audio.buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(audio.buffer.subarray(8, 12).toString('ascii')).toBe('WAVE');

    const audioProbe = await probeMedia(audio.buffer, 'audio.wav');
    expect(audioProbe.hasAudio).toBe(true);
    expect(audioProbe.hasVideo).toBe(false);
  }, 60_000);

  it('fails closed when the container carries no audio track', async () => {
    // The whole point: never return a valid-but-silent wav that STT would
    // "transcribe" to an empty string.
    await expect(extractAudioTrack(clipWithoutAudio, 'no-audio.mp4')).rejects.toMatchObject({
      name: 'MediaProcessingError',
    });
  }, 60_000);

  it('extracts real JPEG frames with MEASURED timestamps', async () => {
    const frames = await extractFrames(clipWithAudio, 'with-audio.mp4', {
      mode: 'interval',
      intervalSec: 5,
      maxFrames: 4,
    });

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      // JPEG SOI marker — real image bytes, not a placeholder.
      expect(frame.buffer.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(frame.mimeType).toBe('image/jpeg');
      expect(frame.timestampMeasured).toBe(true);
    }
    // Offsets must be strictly increasing along the timeline.
    const offsets = frames.map((f) => f.timestampSec);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  }, 90_000);

  it('honours maxFrames', async () => {
    const frames = await extractFrames(clipWithAudio, 'with-audio.mp4', {
      mode: 'interval',
      intervalSec: 1,
      maxFrames: 3,
    });
    expect(frames.length).toBeLessThanOrEqual(3);
  }, 90_000);

  it('mux: attaches a real soundtrack to a video with no audio track', async () => {
    // clipWithoutAudio genuinely has no audio stream (proven above by the
    // "fails closed" demux test) — muxAudioIntoVideo must give it one.
    const soundtrackPath = join(workDir, 'soundtrack.wav');
    await runFfmpeg([
      '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6',
      '-c:a', 'pcm_s16le', '-y', soundtrackPath,
    ]);
    const soundtrack = await fs.readFile(soundtrackPath);

    const composed = await muxAudioIntoVideo(
      clipWithoutAudio,
      'no-audio.mp4',
      soundtrack,
      'soundtrack.wav'
    );

    expect(composed.mimeType).toBe('video/mp4');
    expect(composed.buffer.length).toBeGreaterThan(0);

    const probe = await probeMedia(composed.buffer, 'composed.mp4');
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
    // The source video is 6s (no-audio.mp4's own build duration); the
    // composed output should still carry a real video stream at the same
    // dimensions (video was `-c:v copy`, never re-encoded).
    expect(probe.streams.find((s) => s.codecType === 'video')?.width).toBe(320);
  }, 60_000);

  it('mux: mode="mix" preserves the video\'s own audio alongside the new track', async () => {
    const extraTrackPath = join(workDir, 'extra.wav');
    await runFfmpeg([
      '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12',
      '-c:a', 'pcm_s16le', '-y', extraTrackPath,
    ]);
    const extraTrack = await fs.readFile(extraTrackPath);

    const composed = await muxAudioIntoVideo(
      clipWithAudio,
      'with-audio.mp4',
      extraTrack,
      'extra.wav',
      { mode: 'mix' }
    );

    const probe = await probeMedia(composed.buffer, 'composed-mix.mp4');
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
  }, 60_000);

  it('resize: re-encodes to the requested dimensions, preserving audio', async () => {
    const resized = await resizeVideo(clipWithAudio, 'with-audio.mp4', {
      width: 160,
      height: 90,
      fitMode: 'stretch',
    });

    expect(resized.mimeType).toBe('video/mp4');
    const probe = await probeMedia(resized.buffer, 'resized.mp4');
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
    const videoStream = probe.streams.find((s) => s.codecType === 'video');
    expect(videoStream?.width).toBe(160);
    expect(videoStream?.height).toBe(90);
  }, 60_000);

  it('resize: "fit" letterboxes instead of distorting the source aspect ratio', async () => {
    // Source is 320x180 (16:9). Target box is 200x200 (1:1) — 'fit' must
    // produce EXACTLY the target box (padding added), not the naive
    // scaled-only 200x112.
    const resized = await resizeVideo(clipWithoutAudio, 'no-audio.mp4', {
      width: 200,
      height: 200,
      fitMode: 'fit',
    });

    const probe = await probeMedia(resized.buffer, 'resized-fit.mp4');
    const videoStream = probe.streams.find((s) => s.codecType === 'video');
    expect(videoStream?.width).toBe(200);
    expect(videoStream?.height).toBe(200);
  }, 60_000);

  it('scene sampling emits frames at the real cuts', async () => {
    // Three visually distinct segments concatenated => exactly two hard cuts.
    const segments = ['red', 'blue', 'white'];
    for (const [index, colour] of segments.entries()) {
      await runFfmpeg([
        '-hide_banner', '-v', 'error',
        '-f', 'lavfi', '-i', `color=c=${colour}:s=160x90:d=3`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(workDir, `seg-${index}.mp4`),
      ]);
    }
    const listPath = join(workDir, 'list.txt');
    await fs.writeFile(
      listPath,
      segments.map((_, index) => `file 'seg-${index}.mp4'`).join('\n'),
      'utf8'
    );
    await runFfmpeg([
      '-hide_banner', '-v', 'error',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-y', join(workDir, 'cuts.mp4'),
    ]);
    const cuts = await fs.readFile(join(workDir, 'cuts.mp4'));

    const frames = await extractFrames(cuts, 'cuts.mp4', { mode: 'scene', maxFrames: 8 });

    // Two cuts, at the 3 s and 6 s boundaries. This assertion is what would
    // have caught the yuvj420p defect: before the fix, scene mode produced
    // zero frames on a clip with obvious cuts.
    expect(frames.length).toBe(2);
    expect(frames[0].timestampMeasured).toBe(true);
    expect(frames[0].timestampSec).toBeCloseTo(3, 0);
    expect(frames[1].timestampSec).toBeCloseTo(6, 0);
  }, 120_000);

  describe('extendVideoToDuration — real composition', () => {
    it('loops a short real clip and trims it to the exact requested duration', async () => {
      // clipWithoutAudio is a real 6s generated clip (see buildFixture).
      const target = 20;
      const extended = await extendVideoToDuration(clipWithoutAudio, 'no-audio.mp4', {
        targetDurationSec: target,
      });

      expect(extended.mimeType).toBe('video/mp4');
      expect(extended.buffer.length).toBeGreaterThan(0);
      // ceil(20/6) - 1 = 3 extra passes of the real 6s source.
      expect(extended.loopsApplied).toBe(3);

      const probe = await probeMedia(extended.buffer, 'extended.mp4');
      expect(probe.hasVideo).toBe(true);
      // -t trims to the exact target; ffmpeg's own trim can land a hair
      // under/over depending on keyframe alignment, so allow a 1s window.
      expect(probe.durationSec).toBeGreaterThan(target - 1);
      expect(probe.durationSec).toBeLessThanOrEqual(target + 0.5);
    }, 90_000);

    it('trims (does not loop) a clip already at/above the target', async () => {
      // clipWithAudio is a real 12s clip; asking for 8s should only trim.
      const extended = await extendVideoToDuration(clipWithAudio, 'with-audio.mp4', {
        targetDurationSec: 8,
      });

      expect(extended.loopsApplied).toBe(0);
      const probe = await probeMedia(extended.buffer, 'extended.mp4');
      expect(probe.durationSec).toBeGreaterThan(7);
      expect(probe.durationSec).toBeLessThanOrEqual(8.5);
    }, 60_000);

    it('preserves the real audio track through a loop pass', async () => {
      // clipWithAudio has a real 440Hz tone; extending it must not drop audio.
      const extended = await extendVideoToDuration(clipWithAudio, 'with-audio.mp4', {
        targetDurationSec: 30,
      });

      const probe = await probeMedia(extended.buffer, 'extended.mp4');
      expect(probe.hasAudio).toBe(true);
    }, 90_000);

    it('rejects a request that would exceed the safety-capped loop count', async () => {
      // A 6s source against a 3600s target needs ceil(3600/6)-1 = 599 loops,
      // far past MAX_EXTEND_LOOPS — must fail fast, never attempt the job.
      await expect(
        extendVideoToDuration(clipWithoutAudio, 'no-audio.mp4', { targetDurationSec: 3600 })
      ).rejects.toBeInstanceOf(MediaProcessingError);
    }, 30_000);
  });
});
