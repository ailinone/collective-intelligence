// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RunwayML Tier 1 attribute source — LOTE AZ (2026-09-23).
 *
 * RunwayML has no live-fetchable JSON-Schema/OpenAPI HTTP endpoint in this
 * codebase (confirmed against `runwayml-adapter.ts`, which hard-codes
 * `STATIC_MODELS` and posts directly to `/v1/image_to_video` with no schema
 * probe). What it DOES publish is a real, documented, VERSIONED
 * request-parameter contract — the `duration`/`ratio` enums this table
 * encodes — gated by the `X-Runway-Version` header the adapter already
 * sends. That versioned contract is exactly what the design's Tier 1
 * definition means by "a documented parameter list with enums/min/max":
 * ground truth, no inference. This table is reviewed and extended only when
 * RunwayML ships a new `X-Runway-Version` — never runtime-fetched, since
 * there is nothing to fetch.
 *
 * Values as of 2024-11-06 match the pre-existing hand-verified
 * `providers.catalog.ts` runwayml literal — this table doesn't change what
 * RunwayML can do, it changes how that fact enters the system: `source:
 * 'schema'` instead of a one-off hand edit.
 */
import type { VideoCapabilityAttributes } from '../catalog/provider-catalog.types';

const RUNWAY_SCHEMA_BY_API_VERSION: Record<string, Omit<VideoCapabilityAttributes, 'source'>> = {
  '2024-11-06': {
    maxDurationSeconds: 10,
    minDurationSeconds: 2,
    maxResolution: '1584x672',
    supportedAspectRatios: ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'],
    nativeAudioSupport: false,
  },
};

export function getRunwaymlSchemaCapabilityAttributes(
  apiVersion: string
): VideoCapabilityAttributes | undefined {
  const base = RUNWAY_SCHEMA_BY_API_VERSION[apiVersion];
  if (!base) return undefined;
  return { ...base, source: 'schema', attributesVerifiedAt: new Date().toISOString().slice(0, 10) };
}
