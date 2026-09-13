// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * media-deterministic-gate — objective, pre-judge constraint checking.
 *
 * Per the published architecture: "A deterministic gate (ffprobe/metadata
 * probe on the actual generated file) runs BEFORE any LLM judge call for
 * objective checks (duration, resolution, page count, audio-track
 * presence) — cheaper, exact, immune to VLM-judge foolability."
 *
 * This module is a thin wrapper around the REAL probe already implemented
 * in `services/media/ffmpeg-media-toolkit.ts` (`probeMedia`) — it does not
 * reimplement any media inspection. Its only job is: given an
 * `AilinArtifact` and a `MediaConstraintSet`, decide pass/fail/skip and
 * report WHY, never fabricating a verdict when the toolchain or the bytes
 * are unavailable (fail-open on unknown data, per the architecture's own
 * stated principle — an absent/partial probe is a `skipped_*` status, not
 * a manufactured `pass`).
 */
import {
  probeMedia,
  MediaProcessingError,
  MediaToolkitUnavailableError,
  type MediaProbeResult,
} from '@/services/media/ffmpeg-media-toolkit';
import type { AilinArtifact } from '@/types';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'media-deterministic-gate' });

export interface DurationConstraint {
  readonly minSec?: number;
  readonly maxSec?: number;
}

export interface ResolutionConstraint {
  readonly width?: number;
  readonly height?: number;
  /** Fractional tolerance below the target, e.g. 0.1 = 10% under is still OK.
   *  Default 0 (exact-or-above). Generation is rarely pixel-exact, so callers
   *  typically pass a small tolerance. */
  readonly tolerancePct?: number;
}

/**
 * Constraints the deterministic gate can check OBJECTIVELY from a probed
 * container. Anything not stated here (subjective quality, spec adherence
 * beyond these numeric facts) is the judge's job, not this gate's.
 */
export interface MediaConstraintSet {
  readonly durationSec?: DurationConstraint;
  readonly resolution?: ResolutionConstraint;
  readonly requireAudioTrack?: boolean;
}

export type DeterministicGateStatus =
  | 'pass'
  | 'fail'
  /** ffmpeg/ffprobe is not installed on this host. */
  | 'skipped_unavailable'
  /** The artifact has no usable bytes to probe (generation failed, or only
   *  a remote `url` was returned with no inline `b64_json` — this gate
   *  deliberately never fetches a remote URL itself). */
  | 'skipped_no_bytes'
  /** No constraints were supplied, or the artifact's modality has no
   *  objective checks defined for it (e.g. `'file'`). */
  | 'skipped_no_constraints';

export interface DeterministicGateViolation {
  readonly constraint: 'duration' | 'resolution' | 'audio_track';
  readonly expected: string;
  readonly actual: string;
}

export interface DeterministicGateResult {
  readonly status: DeterministicGateStatus;
  readonly probe?: MediaProbeResult;
  readonly violations: readonly DeterministicGateViolation[];
  readonly notes?: string;
}

const PROBEABLE_MODALITIES: ReadonlySet<AilinArtifact['modality']> = new Set([
  'video',
  'audio',
  'image',
]);

/**
 * Run the deterministic gate against one generated artifact. NEVER throws —
 * every failure mode (missing toolchain, missing bytes, malformed base64,
 * a probe error) resolves to a `skipped_*` status so a candidate is never
 * silently disqualified by an infrastructure hiccup instead of an actual
 * constraint violation.
 */
export async function runDeterministicMediaGate(
  artifact: AilinArtifact | undefined,
  constraints: MediaConstraintSet | undefined
): Promise<DeterministicGateResult> {
  if (!artifact || artifact.error) {
    return {
      status: 'skipped_no_bytes',
      violations: [],
      notes: artifact?.error ? `artifact generation failed: ${artifact.error}` : 'no artifact',
    };
  }
  if (!constraints || Object.keys(constraints).length === 0) {
    return { status: 'skipped_no_constraints', violations: [] };
  }
  if (!PROBEABLE_MODALITIES.has(artifact.modality)) {
    return {
      status: 'skipped_no_constraints',
      violations: [],
      notes: `no objective probe defined for modality "${artifact.modality}"`,
    };
  }
  if (!artifact.b64_json) {
    return {
      status: 'skipped_no_bytes',
      violations: [],
      notes: artifact.url
        ? 'artifact has a url but no inline b64_json; the deterministic gate does not fetch remote bytes'
        : 'artifact has no inline bytes to probe',
    };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(artifact.b64_json, 'base64');
  } catch {
    return { status: 'skipped_no_bytes', violations: [], notes: 'b64_json was not valid base64' };
  }
  if (buffer.length === 0) {
    return { status: 'skipped_no_bytes', violations: [], notes: 'decoded artifact buffer is empty' };
  }

  const filename = artifact.filename ?? `artifact.${extensionForArtifact(artifact)}`;

  let probe: MediaProbeResult;
  try {
    probe = await probeMedia(buffer, filename);
  } catch (err) {
    if (err instanceof MediaToolkitUnavailableError) {
      return { status: 'skipped_unavailable', violations: [], notes: err.message };
    }
    const message =
      err instanceof MediaProcessingError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    log.warn({ error: message, modality: artifact.modality }, 'deterministic gate: probe failed');
    return { status: 'skipped_unavailable', violations: [], notes: `probe failed: ${message}` };
  }

  const violations = evaluateConstraints(probe, constraints);
  return { status: violations.length > 0 ? 'fail' : 'pass', probe, violations };
}

// ─── pure helpers (exported for tests) ──────────────────────────────────

export function evaluateConstraints(
  probe: MediaProbeResult,
  constraints: MediaConstraintSet
): DeterministicGateViolation[] {
  const violations: DeterministicGateViolation[] = [];

  if (constraints.durationSec && probe.durationSec !== undefined) {
    const { minSec, maxSec } = constraints.durationSec;
    if (minSec !== undefined && probe.durationSec < minSec) {
      violations.push({
        constraint: 'duration',
        expected: `>= ${minSec}s`,
        actual: `${probe.durationSec}s`,
      });
    }
    if (maxSec !== undefined && probe.durationSec > maxSec) {
      violations.push({
        constraint: 'duration',
        expected: `<= ${maxSec}s`,
        actual: `${probe.durationSec}s`,
      });
    }
  }

  if (constraints.resolution) {
    const videoStream = probe.streams.find(
      (s) => s.codecType === 'video' && s.width && s.height
    );
    if (videoStream?.width && videoStream?.height) {
      const tolerance = constraints.resolution.tolerancePct ?? 0;
      if (constraints.resolution.width !== undefined) {
        const floor = constraints.resolution.width * (1 - tolerance);
        if (videoStream.width < floor) {
          violations.push({
            constraint: 'resolution',
            expected: `width >= ${Math.round(floor)}px`,
            actual: `${videoStream.width}px`,
          });
        }
      }
      if (constraints.resolution.height !== undefined) {
        const floor = constraints.resolution.height * (1 - tolerance);
        if (videoStream.height < floor) {
          violations.push({
            constraint: 'resolution',
            expected: `height >= ${Math.round(floor)}px`,
            actual: `${videoStream.height}px`,
          });
        }
      }
    }
  }

  if (constraints.requireAudioTrack && !probe.hasAudio) {
    violations.push({ constraint: 'audio_track', expected: 'present', actual: 'absent' });
  }

  return violations;
}

function extensionForArtifact(artifact: AilinArtifact): string {
  const mime = artifact.mime_type ?? '';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime') || mime.includes('mov')) return 'mov';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (artifact.modality === 'video') return 'mp4';
  if (artifact.modality === 'audio') return 'wav';
  if (artifact.modality === 'image') return 'jpg';
  return 'bin';
}
