// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * image-deterministic-gate — objective, pre-judge constraint checking for
 * IMAGE EDITS (Section D — "Image editing with verify").
 *
 * Mirrors `media-deterministic-gate.ts`'s shape exactly (same
 * pass/fail/skipped_* status union, same never-throws contract, same
 * fail-open-on-unknown-data philosophy) but probes real image bytes with
 * `image-size` — a lightweight, zero-dependency header-only reader — instead
 * of shelling out to ffmpeg/ffprobe, since a still image needs only
 * dimensions + format, not duration/codec/audio-track inspection.
 *
 * NEVER throws — every failure mode (missing bytes, unrecognized format,
 * the `image-size` call itself throwing) resolves to a `skipped_*` status so
 * an edit is never silently disqualified by an infrastructure hiccup
 * instead of an actual constraint violation.
 */
import { imageSize } from 'image-size';
import type { AilinArtifact } from '@/types';
import { logger } from '@/utils/logger';
import type { ImageCapabilityAttributes } from './image-capability-attributes';

const log = logger.child({ component: 'image-deterministic-gate' });

export interface ImageDimensionConstraint {
  readonly width?: number;
  readonly height?: number;
  /** Fractional tolerance below the target, e.g. 0.1 = 10% under is still
   *  OK. Default 0 (exact-or-above) — mirrors
   *  `media-deterministic-gate.ts`'s `ResolutionConstraint.tolerancePct`. */
  readonly tolerancePct?: number;
}

/**
 * Constraints the image gate can check OBJECTIVELY from a probed file
 * header. Kept structurally close to `ImageCapabilityAttributes` (dimensions
 * + format) so a future caller can derive one from the other without a
 * translation layer.
 */
export interface ImageEditConstraintSet {
  readonly dimensions?: ImageDimensionConstraint;
  /** Lowercase format identifier compared against `image-size`'s `type`
   *  field (e.g. 'png', 'jpg', 'webp') — NOT a MIME type. */
  readonly format?: string;
}

export type ImageGateStatus =
  | 'pass'
  | 'fail'
  /** No usable bytes to probe (edit call failed, or only a remote `url` was
   *  returned with no inline `b64_json` — this gate deliberately never
   *  fetches a remote URL itself, matching the media gate's contract). */
  | 'skipped_no_bytes'
  /** No constraints were supplied, or the artifact's modality isn't 'image'. */
  | 'skipped_no_constraints'
  /** `image-size` could not read the header (corrupt bytes, unsupported
   *  format) — an infrastructure/data problem, not a constraint failure. */
  | 'skipped_unavailable';

export interface ImageGateViolation {
  readonly constraint: 'dimensions' | 'format';
  readonly expected: string;
  readonly actual: string;
}

export interface ImageGateResult {
  readonly status: ImageGateStatus;
  readonly probe?: { readonly width?: number; readonly height?: number; readonly type?: string };
  readonly violations: readonly ImageGateViolation[];
  readonly notes?: string;
}

/** Referenced for documentation/type-parity with Section B — not consumed
 *  directly by this gate (this gate compares the REQUEST's constraints
 *  against the ACTUAL probed output, the same relationship
 *  `runDeterministicMediaGate` has to `MediaConstraintSet`; a provider's
 *  catalog-level `ImageCapabilityAttributes` is a routing-time concern,
 *  handled by Section B's pre-filter in `images-orchestration-service.ts`,
 *  not by this post-generation gate). */
export type { ImageCapabilityAttributes };

export async function runImageDeterministicGate(
  artifact: AilinArtifact | undefined,
  constraints: ImageEditConstraintSet | undefined
): Promise<ImageGateResult> {
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
  if (artifact.modality !== 'image') {
    return {
      status: 'skipped_no_constraints',
      violations: [],
      notes: `image gate only applies to modality "image", got "${artifact.modality}"`,
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

  let probe: { width?: number; height?: number; type?: string };
  try {
    probe = imageSize(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ error: message }, 'image gate: imageSize probe failed');
    return { status: 'skipped_unavailable', violations: [], notes: `probe failed: ${message}` };
  }

  const violations = evaluateImageConstraints(probe, constraints);
  return { status: violations.length > 0 ? 'fail' : 'pass', probe, violations };
}

// ─── pure helpers (exported for tests) ──────────────────────────────────

export function evaluateImageConstraints(
  probe: { width?: number; height?: number; type?: string },
  constraints: ImageEditConstraintSet
): ImageGateViolation[] {
  const violations: ImageGateViolation[] = [];

  if (constraints.format && probe.type && constraints.format.toLowerCase() !== probe.type.toLowerCase()) {
    violations.push({ constraint: 'format', expected: constraints.format, actual: probe.type });
  }

  if (constraints.dimensions && probe.width !== undefined && probe.height !== undefined) {
    const tolerance = constraints.dimensions.tolerancePct ?? 0;
    if (constraints.dimensions.width !== undefined) {
      const floor = constraints.dimensions.width * (1 - tolerance);
      if (probe.width < floor) {
        violations.push({
          constraint: 'dimensions',
          expected: `width >= ${Math.round(floor)}px`,
          actual: `${probe.width}px`,
        });
      }
    }
    if (constraints.dimensions.height !== undefined) {
      const floor = constraints.dimensions.height * (1 - tolerance);
      if (probe.height < floor) {
        violations.push({
          constraint: 'dimensions',
          expected: `height >= ${Math.round(floor)}px`,
          actual: `${probe.height}px`,
        });
      }
    }
  }

  return violations;
}
