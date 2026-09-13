// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Video capability attribute matcher — LOTE AS (2026-09-06).
 *
 * Pure, dependency-free predicate: does a provider's DECLARED
 * `VideoCapabilityAttributes` plausibly satisfy a video-generation request's
 * duration/resolution/aspect-ratio/audio constraints? Used as an additive
 * pre-filter in `video-orchestration-service.ts#selectVideoCandidateModels`,
 * ahead of cost/quality/latency ranking.
 *
 * Fail-open / fail-closed contract (load-bearing — see the task's own research
 * artifact): an attribute the catalog doesn't declare is UNKNOWN, never
 * "unsupported". Only a PRESENT, documented limit that the request clearly
 * exceeds excludes a candidate. This mirrors the project's existing
 * "never turn missing data into a false rejection" convention (HCRA fusion
 * confidence tiers in provider-catalog.types.ts).
 */

import type { VideoCapabilityAttributes } from './provider-catalog.types';

/**
 * The subset of a video-generation request relevant to capability matching.
 * Field names mirror `VideoGenerationOptions` so a caller can derive this
 * directly from the public request (`durationSeconds` <- `duration`,
 * `audioRequested` <- `generateAudio === true`, NOT the `audio` input-
 * conditioning field, which is a different concept).
 */
export interface VideoAttributeRequest {
  readonly durationSeconds?: number;
  readonly resolution?: string; // e.g. '1080p', '4K', '3840x2160'
  readonly aspectRatio?: string; // e.g. '16:9', '1280:720'
  readonly audioRequested?: boolean; // true only for "generate a soundtrack"
}

/**
 * Normalizes a resolution string (labeled tier OR raw pixel dimensions) into
 * a comparable ordinal. Returns `null` when the string cannot be parsed —
 * callers must treat `null` as "unknown", not as tier 0, so an unparseable
 * value never causes a false rejection in either direction.
 */
export function resolutionTier(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  const pixelMatch = normalized.match(/^(\d+)\s*x\s*(\d+)$/);
  if (pixelMatch) {
    const shortSide = Math.min(Number(pixelMatch[1]), Number(pixelMatch[2]));
    if (shortSide >= 2160) return 4;
    if (shortSide >= 1440) return 3.5;
    if (shortSide >= 1080) return 3;
    if (shortSide >= 720) return 2;
    if (shortSide >= 480) return 1;
    return 0.5;
  }

  const table: Record<string, number> = {
    '4k': 4,
    '2160p': 4,
    '2k': 3.5,
    '1440p': 3.5,
    true_1080p: 3,
    '1080p': 3,
    fhd: 3,
    '720p': 2,
    hd: 2,
    '540p': 1.5,
    '480p': 1,
    sd: 1,
    '360p': 0.5,
    '256p': 0.25,
  };
  return normalized in table ? table[normalized] : null;
}

/**
 * Normalizes an aspect-ratio string into a rational `width/height` number.
 * Accepts both a labeled ratio (`'16:9'`) and a pixel-dimension string
 * (RunwayML's `'1280:720'`) — both use the same `w:h` shape, so a single
 * parse covers them; the caller decides whether two ratios are "close
 * enough" via `RATIO_TOLERANCE`. `'adaptive'`/`'auto'` are wildcards that
 * match any requested ratio. Returns `null` when unparseable.
 */
export function normalizeRatio(value: string): number | 'wildcard' | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'adaptive' || normalized === 'auto') return 'wildcard';
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return null;
  return width / height;
}

const RATIO_TOLERANCE = 0.02;

/**
 * Returns whether a candidate's declared `VideoCapabilityAttributes` can
 * PLAUSIBLY satisfy a request's media constraints. See module doc for the
 * fail-open/fail-closed contract.
 */
export function canSatisfyVideoAttributes(
  attrs: VideoCapabilityAttributes | undefined,
  request: VideoAttributeRequest
): boolean {
  if (!attrs) return true;

  if (request.durationSeconds !== undefined) {
    if (attrs.allowedDurationsSeconds && attrs.allowedDurationsSeconds.length > 0) {
      const maxAllowed = Math.max(...attrs.allowedDurationsSeconds);
      if (request.durationSeconds > maxAllowed) return false;
    }
    if (
      attrs.maxDurationSeconds !== undefined &&
      request.durationSeconds > attrs.maxDurationSeconds
    ) {
      return false;
    }
    if (
      attrs.minDurationSeconds !== undefined &&
      request.durationSeconds < attrs.minDurationSeconds
    ) {
      return false;
    }
  }

  if (request.resolution !== undefined && attrs.maxResolution !== undefined) {
    const requestedTier = resolutionTier(request.resolution);
    const maxTier = resolutionTier(attrs.maxResolution);
    // Only reject when BOTH sides parse to a known tier — an unparseable
    // value on either side is "unknown", not a conflict.
    if (requestedTier !== null && maxTier !== null && requestedTier > maxTier) {
      return false;
    }
  }

  if (
    request.aspectRatio !== undefined &&
    attrs.supportedAspectRatios &&
    attrs.supportedAspectRatios.length > 0
  ) {
    const requestedRatio = normalizeRatio(request.aspectRatio);
    // An unparseable request ratio is "unknown" — don't reject on it.
    if (requestedRatio !== null) {
      const satisfied = attrs.supportedAspectRatios.some((candidate) => {
        const candidateRatio = normalizeRatio(candidate);
        if (candidateRatio === 'wildcard' || requestedRatio === 'wildcard') return true;
        // An unparseable catalog entry never causes a rejection by itself.
        if (candidateRatio === null) return true;
        return Math.abs(candidateRatio - requestedRatio) < RATIO_TOLERANCE;
      });
      if (!satisfied) return false;
    }
  }

  if (request.audioRequested === true && attrs.nativeAudioSupport === false) {
    return false;
  }
  // attrs.nativeAudioSupport === undefined + audioRequested === true: NOT
  // excluded — unknown, not "no".

  return true;
}
