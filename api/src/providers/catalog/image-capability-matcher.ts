// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Image capability attribute matcher — LOTE AZ (2026-09-23).
 *
 * Same fail-open/fail-closed contract as `video-capability-matcher.ts`: a
 * field the catalog doesn't declare is UNKNOWN, never "unsupported". Only a
 * PRESENT, documented limit the request clearly exceeds excludes a candidate.
 */
import type { ImageCapabilityAttributes } from './provider-catalog.types';

export interface ImageAttributeRequest {
  readonly width?: number;
  readonly height?: number;
  readonly format?: string;
}

/** Parses a `'WIDTHxHEIGHT'` string. Returns `null` when unparseable. */
export function parseDimensions(value: string): { width: number; height: number } | null {
  const match = value.trim().toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

export function canSatisfyImageAttributes(
  attrs: ImageCapabilityAttributes | undefined,
  request: ImageAttributeRequest
): boolean {
  if (!attrs) return true;

  if (
    (request.width !== undefined || request.height !== undefined) &&
    attrs.maxDimensions !== undefined
  ) {
    const max = parseDimensions(attrs.maxDimensions);
    // An unparseable catalog value never causes a rejection by itself.
    if (max) {
      if (request.width !== undefined && request.width > max.width) return false;
      if (request.height !== undefined && request.height > max.height) return false;
    }
  }

  if (
    (request.width !== undefined || request.height !== undefined) &&
    attrs.minDimensions !== undefined
  ) {
    const min = parseDimensions(attrs.minDimensions);
    if (min) {
      if (request.width !== undefined && request.width < min.width) return false;
      if (request.height !== undefined && request.height < min.height) return false;
    }
  }

  if (
    request.format !== undefined &&
    attrs.supportedFormats &&
    attrs.supportedFormats.length > 0
  ) {
    const requested = request.format.trim().toLowerCase();
    const satisfied = attrs.supportedFormats.some((f) => f.trim().toLowerCase() === requested);
    if (!satisfied) return false;
  }

  return true;
}
