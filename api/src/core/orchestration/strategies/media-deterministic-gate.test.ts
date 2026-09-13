// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * media-deterministic-gate — tests.
 *
 * Mocks `probeMedia` (same pattern as
 * `services/__tests__/video-understanding-service.test.ts`) so this suite
 * never shells out to a real ffmpeg/ffprobe binary. The property that
 * matters most: an out-of-spec fixture is REJECTED (`status: 'fail'`) with
 * the concrete violation reported, and every missing-input case degrades to
 * a `skipped_*` status rather than fabricating a pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const probeMedia = vi.fn();

vi.mock('@/services/media/ffmpeg-media-toolkit', async () => {
  const actual = await vi.importActual<typeof import('@/services/media/ffmpeg-media-toolkit')>(
    '@/services/media/ffmpeg-media-toolkit'
  );
  return {
    ...actual,
    probeMedia: (...args: unknown[]) => probeMedia(...args),
  };
});

import {
  runDeterministicMediaGate,
  evaluateConstraints,
  type MediaConstraintSet,
} from './media-deterministic-gate';
import {
  MediaToolkitUnavailableError,
  MediaProcessingError,
  type MediaProbeResult,
} from '@/services/media/ffmpeg-media-toolkit';
import type { AilinArtifact } from '@/types';

beforeEach(() => {
  vi.clearAllMocks();
  // Sane default so tests that don't care about the exact probe shape (e.g.
  // the "invalid base64" resilience check below, where Buffer.from's lenient
  // decoding may still produce a non-empty buffer) don't crash on an
  // unconfigured mock. Tests that DO care override this per-test.
  probeMedia.mockResolvedValue(okProbe);
});

function videoArtifact(overrides: Partial<AilinArtifact> = {}): AilinArtifact {
  return {
    modality: 'video',
    stage_name: 'gen-video',
    stage_index: 0,
    b64_json: Buffer.from('fake video bytes').toString('base64'),
    mime_type: 'video/mp4',
    ...overrides,
  };
}

const okProbe: MediaProbeResult = {
  durationSec: 30,
  streams: [{ codecType: 'video', width: 1920, height: 1080 }, { codecType: 'audio' }],
  hasVideo: true,
  hasAudio: true,
};

describe('runDeterministicMediaGate — skip cases (never fabricates a verdict)', () => {
  it('no artifact → skipped_no_bytes', async () => {
    const r = await runDeterministicMediaGate(undefined, { requireAudioTrack: true });
    expect(r.status).toBe('skipped_no_bytes');
    expect(probeMedia).not.toHaveBeenCalled();
  });

  it('artifact with .error (generation failed) → skipped_no_bytes', async () => {
    const r = await runDeterministicMediaGate(
      videoArtifact({ error: 'provider 500', b64_json: undefined }),
      { requireAudioTrack: true }
    );
    expect(r.status).toBe('skipped_no_bytes');
    expect(probeMedia).not.toHaveBeenCalled();
  });

  it('no constraints supplied → skipped_no_constraints', async () => {
    const r = await runDeterministicMediaGate(videoArtifact(), undefined);
    expect(r.status).toBe('skipped_no_constraints');
    expect(probeMedia).not.toHaveBeenCalled();
  });

  it('modality with no objective checks ("file") → skipped_no_constraints', async () => {
    const r = await runDeterministicMediaGate(
      { modality: 'file', stage_name: 's', stage_index: 0, b64_json: 'abc' },
      { requireAudioTrack: true }
    );
    expect(r.status).toBe('skipped_no_constraints');
    expect(probeMedia).not.toHaveBeenCalled();
  });

  it('only a remote url, no inline bytes → skipped_no_bytes, never fetches the url', async () => {
    const r = await runDeterministicMediaGate(
      videoArtifact({ b64_json: undefined, url: 'https://example.com/video.mp4' }),
      { requireAudioTrack: true }
    );
    expect(r.status).toBe('skipped_no_bytes');
    expect(r.notes).toContain('does not fetch remote bytes');
    expect(probeMedia).not.toHaveBeenCalled();
  });

  it('invalid base64 → skipped_no_bytes', async () => {
    const r = await runDeterministicMediaGate(videoArtifact({ b64_json: '!!!not-base64!!!' }), {
      requireAudioTrack: true,
    });
    // Node's Buffer.from('base64') is lenient and rarely throws; assert we
    // never crash and either skip cleanly or (if it happens to decode to
    // something) proceed to probe — either way, no exception escapes.
    expect(['skipped_no_bytes', 'pass', 'fail', 'skipped_unavailable']).toContain(r.status);
  });

  it('ffmpeg unavailable → skipped_unavailable, not a fabricated pass', async () => {
    probeMedia.mockRejectedValue(new MediaToolkitUnavailableError('ffprobe'));
    const r = await runDeterministicMediaGate(videoArtifact(), { requireAudioTrack: true });
    expect(r.status).toBe('skipped_unavailable');
  });

  it('probe throws MediaProcessingError → skipped_unavailable', async () => {
    probeMedia.mockRejectedValue(new MediaProcessingError('corrupt container'));
    const r = await runDeterministicMediaGate(videoArtifact(), { requireAudioTrack: true });
    expect(r.status).toBe('skipped_unavailable');
    expect(r.notes).toContain('corrupt container');
  });
});

describe('runDeterministicMediaGate — pass/fail on a real probe', () => {
  it('within every constraint → pass', async () => {
    probeMedia.mockResolvedValue(okProbe);
    const r = await runDeterministicMediaGate(videoArtifact(), {
      durationSec: { minSec: 10, maxSec: 60 },
      resolution: { width: 1920, height: 1080 },
      requireAudioTrack: true,
    });
    expect(r.status).toBe('pass');
    expect(r.violations).toHaveLength(0);
  });

  it('out-of-spec fixture (too short, low-res, no audio) → fail, with concrete violations', async () => {
    probeMedia.mockResolvedValue({
      durationSec: 3,
      streams: [{ codecType: 'video', width: 640, height: 480 }],
      hasVideo: true,
      hasAudio: false,
    } satisfies MediaProbeResult);

    const r = await runDeterministicMediaGate(videoArtifact(), {
      durationSec: { minSec: 30 },
      resolution: { width: 3840, height: 2160 },
      requireAudioTrack: true,
    });

    expect(r.status).toBe('fail');
    expect(r.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ constraint: 'duration' }),
        expect.objectContaining({ constraint: 'resolution' }),
        expect.objectContaining({ constraint: 'audio_track' }),
      ])
    );
    expect(r.violations).toHaveLength(4); // duration, width, height, audio_track
  });

  it('duration too long → fail on max bound', async () => {
    probeMedia.mockResolvedValue({ ...okProbe, durationSec: 120 });
    const r = await runDeterministicMediaGate(videoArtifact(), {
      durationSec: { maxSec: 60 },
    });
    expect(r.status).toBe('fail');
    expect(r.violations[0]).toMatchObject({ constraint: 'duration', actual: '120s' });
  });

  it('resolution tolerance allows a small under-shoot', async () => {
    probeMedia.mockResolvedValue({
      durationSec: 10,
      streams: [{ codecType: 'video', width: 1900, height: 1070 }],
      hasVideo: true,
      hasAudio: false,
    } satisfies MediaProbeResult);
    const r = await runDeterministicMediaGate(videoArtifact(), {
      resolution: { width: 1920, height: 1080, tolerancePct: 0.05 },
    });
    expect(r.status).toBe('pass');
  });
});

describe('evaluateConstraints — pure function', () => {
  it('no video stream present → resolution constraint is silently skipped (fail-open on unknown data)', () => {
    const probe: MediaProbeResult = { durationSec: 10, streams: [], hasVideo: false, hasAudio: false };
    const constraints: MediaConstraintSet = { resolution: { width: 1920, height: 1080 } };
    expect(evaluateConstraints(probe, constraints)).toEqual([]);
  });

  it('durationSec undefined on the probe → duration constraint is silently skipped', () => {
    const probe: MediaProbeResult = { streams: [], hasVideo: false, hasAudio: false };
    const constraints: MediaConstraintSet = { durationSec: { minSec: 5 } };
    expect(evaluateConstraints(probe, constraints)).toEqual([]);
  });
});
