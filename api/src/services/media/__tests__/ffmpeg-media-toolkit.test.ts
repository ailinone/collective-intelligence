// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Contract tests for the ffmpeg media toolkit.
 *
 * The point of this suite is the FAIL-CLOSED behaviour: when the toolchain is
 * absent, every entry point must raise `MediaToolkitUnavailableError` naming
 * the missing binary. It must never return an empty result that a caller
 * could mistake for "the video had no audio" or "no frames were found".
 *
 * The happy path needs a real ffmpeg, so it lives in
 * `ffmpeg-media-toolkit.live.test.ts`, which skips itself when the binary is
 * not installed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  __resetMediaToolkitResolution,
  extendVideoToDuration,
  extractAudioTrack,
  extractFrames,
  getMediaToolkitCapability,
  MediaProcessingError,
  MediaToolkitUnavailableError,
  muxAudioIntoVideo,
  parseShowinfoTimestamps,
  probeMedia,
  resizeVideo,
  sanitiseFilename,
} from '../ffmpeg-media-toolkit';

const ORIGINAL_FFMPEG_PATH = process.env.FFMPEG_PATH;
const ORIGINAL_FFPROBE_PATH = process.env.FFPROBE_PATH;

/**
 * Point both binaries at a path that cannot exist. This is deterministic on
 * every host, including CI images that DO ship ffmpeg — the explicit env
 * override always wins over the PATH lookup.
 */
function forceToolchainMissing(): void {
  process.env.FFMPEG_PATH = '/nonexistent/ailin-test/ffmpeg-does-not-exist';
  process.env.FFPROBE_PATH = '/nonexistent/ailin-test/ffprobe-does-not-exist';
  __resetMediaToolkitResolution();
}

describe('ffmpeg-media-toolkit — fail-closed contract', () => {
  beforeEach(() => {
    forceToolchainMissing();
  });

  afterEach(() => {
    if (ORIGINAL_FFMPEG_PATH === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = ORIGINAL_FFMPEG_PATH;
    if (ORIGINAL_FFPROBE_PATH === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = ORIGINAL_FFPROBE_PATH;
    __resetMediaToolkitResolution();
  });

  it('reports unavailability without throwing, and names the reason', async () => {
    const capability = await getMediaToolkitCapability();

    expect(capability.available).toBe(false);
    expect(capability.reason).toContain('FFMPEG_PATH');
    expect(capability.reason).toContain('FFPROBE_PATH');
  });

  it('probeMedia throws MediaToolkitUnavailableError naming ffprobe', async () => {
    await expect(probeMedia(Buffer.from('not-a-video'), 'clip.mp4')).rejects.toBeInstanceOf(
      MediaToolkitUnavailableError
    );

    await expect(probeMedia(Buffer.from('not-a-video'), 'clip.mp4')).rejects.toMatchObject({
      dependency: 'ffprobe',
    });
  });

  it('extractAudioTrack throws rather than returning an empty buffer', async () => {
    await expect(extractAudioTrack(Buffer.from('x'), 'clip.mp4')).rejects.toMatchObject({
      name: 'MediaToolkitUnavailableError',
      dependency: 'ffmpeg',
    });
  });

  it('extractFrames throws rather than returning an empty frame list', async () => {
    await expect(extractFrames(Buffer.from('x'), 'clip.mp4')).rejects.toMatchObject({
      name: 'MediaToolkitUnavailableError',
      dependency: 'ffmpeg',
    });
  });

  it('extendVideoToDuration throws rather than silently returning the unmodified clip', async () => {
    // Probes the source duration first (ffprobe), so a fully-missing
    // toolchain surfaces citing ffprobe, same as probeMedia's own contract.
    await expect(
      extendVideoToDuration(Buffer.from('x'), 'clip.mp4', { targetDurationSec: 30 })
    ).rejects.toMatchObject({
      name: 'MediaToolkitUnavailableError',
      dependency: 'ffprobe',
    });
  });

  it('muxAudioIntoVideo throws rather than returning the video unchanged', async () => {
    await expect(
      muxAudioIntoVideo(Buffer.from('v'), 'clip.mp4', Buffer.from('a'), 'track.wav')
    ).rejects.toMatchObject({
      name: 'MediaToolkitUnavailableError',
      dependency: 'ffmpeg',
    });
  });

  it('resizeVideo throws rather than returning the video unchanged', async () => {
    await expect(
      resizeVideo(Buffer.from('v'), 'clip.mp4', { width: 1280, height: 720 })
    ).rejects.toMatchObject({
      name: 'MediaToolkitUnavailableError',
      dependency: 'ffmpeg',
    });
  });
});

describe('extendVideoToDuration — input validation', () => {
  it('rejects a non-positive targetDurationSec before touching the toolchain', async () => {
    // No forceToolchainMissing() here: this must fail on the argument alone,
    // proving the validation runs before any binary resolution is attempted.
    await expect(
      extendVideoToDuration(Buffer.from('x'), 'clip.mp4', { targetDurationSec: 0 })
    ).rejects.toBeInstanceOf(MediaProcessingError);
    await expect(
      extendVideoToDuration(Buffer.from('x'), 'clip.mp4', { targetDurationSec: -5 })
    ).rejects.toBeInstanceOf(MediaProcessingError);
  });
});

describe('resizeVideo — argument validation', () => {
  it('rejects a call with neither width nor height, even without ffmpeg', () => {
    // This check happens before the ffmpeg binary is resolved, so it must
    // reject synchronously with a MediaProcessingError, not the toolchain
    // error — a caller mis-using the function gets an immediately actionable
    // message instead of a red herring about a missing binary.
    return expect(resizeVideo(Buffer.from('v'), 'clip.mp4', {})).rejects.toMatchObject({
      name: 'MediaProcessingError',
    });
  });
});

/**
 * Frame timestamps are MEASURED from ffmpeg's `showinfo` filter rather than
 * computed, so this parser is the one link in that chain the container proof
 * did not exercise through the TypeScript. The fixture below is verbatim
 * ffmpeg 8.1.2 stderr, captured 2026-09-05 from the exact argv this module
 * builds (`fps=1/5,scale=…,format=yuvj420p,showinfo` on a 12 s clip).
 */
const REAL_SHOWINFO_STDERR = [
  '[Parsed_showinfo_3 @ 0x7fb16d3b7640] config in time_base: 5/1, frame_rate: 1/5',
  '[Parsed_showinfo_3 @ 0x7fb16d3b7640] config out time_base: 0/0, frame_rate: 0/0',
  '[Parsed_showinfo_3 @ 0x7fb16d3b7640] n:   0 pts:      0 pts_time:0       duration:      1 duration_time:5       fmt:yuvj420p cl:unspecified sar:1/1 s:160x90 i:P iskey:0 type:P checksum:D26BA05A',
  '[Parsed_showinfo_3 @ 0x7fb16d3b7640] color_range:pc color_space:unknown color_primaries:unknown color_trc:unknown',
  '[Parsed_showinfo_3 @ 0x7fb16d3b7640] n:   1 pts:      1 pts_time:5       duration:      1 duration_time:5       fmt:yuvj420p cl:unspecified sar:1/1 s:160x90 i:P iskey:0 type:B checksum:8AC56323',
  '[Parsed_showinfo_3 @ 0x7fb16d3b7640] color_range:pc color_space:unknown color_primaries:unknown color_trc:unknown',
].join('\n');

describe('parseShowinfoTimestamps', () => {
  it('reads the real offsets out of verbatim ffmpeg stderr, in emission order', () => {
    expect(parseShowinfoTimestamps(REAL_SHOWINFO_STDERR)).toEqual([0, 5]);
  });

  it('does not mistake duration_time or the frame_rate header for a timestamp', () => {
    // Each showinfo line also carries `duration_time:5`, and the header lines
    // carry `time_base: 5/1` and `frame_rate: 1/5`. Matching any of those
    // would silently shift every reported offset.
    const timestamps = parseShowinfoTimestamps(REAL_SHOWINFO_STDERR);
    expect(timestamps).toHaveLength(2);
  });

  it('reads fractional offsets, which scene sampling produces', () => {
    expect(
      parseShowinfoTimestamps('n:0 pts_time:2.502 x\nn:1 pts_time:7.375 y')
    ).toEqual([2.502, 7.375]);
  });

  it('returns an empty list when ffmpeg logged nothing', () => {
    // The caller treats this as "timestamps unknown" and flags the frames
    // `timestampMeasured: false` rather than presenting a guess as a fact.
    expect(parseShowinfoTimestamps('')).toEqual([]);
    expect(parseShowinfoTimestamps('some unrelated ffmpeg chatter')).toEqual([]);
  });
});

describe('sanitiseFilename', () => {
  it('reduces a path to its leaf', () => {
    expect(sanitiseFilename('/var/tmp/movie.mp4')).toBe('movie.mp4');
    expect(sanitiseFilename('C:\\Users\\x\\movie.mp4')).toBe('movie.mp4');
  });

  it('strips traversal segments and shell-significant characters', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd');
    // Leading dots are removed so the result can never be a dotfile or `..`.
    expect(sanitiseFilename('..')).toBe('source.bin');
    // Separators, spaces and shell metacharacters cannot survive: the leaf is
    // taken first, then everything outside [A-Za-z0-9._-] becomes '_'.
    expect(sanitiseFilename('a b;rm -rf x.mp4')).toBe('a_b_rm_-rf_x.mp4');
    expect(sanitiseFilename('$(whoami).mp4')).toBe('__whoami_.mp4');
    // A trailing path separator leaves the last real segment as the leaf.
    expect(sanitiseFilename('a b;rm -rf /.mp4')).toBe('mp4');
  });

  it('never returns an empty name', () => {
    expect(sanitiseFilename('')).toBe('source.bin');
    expect(sanitiseFilename('///')).toBe('source.bin');
  });

  it('bounds the length', () => {
    expect(sanitiseFilename('a'.repeat(500)).length).toBe(128);
  });
});
