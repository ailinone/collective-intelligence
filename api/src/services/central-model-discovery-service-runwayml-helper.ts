// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pure helper extracted so Tier 1's RunwayML hook (LOTE AZ, 2026-09-23) is
 * unit-testable without exercising the whole `discoverAllModels()` pipeline.
 * Called from `central-model-discovery-service.ts#addCatalogProviderSources()`'s
 * execution-only pinned-fallback closure, once per emitted RunwayML model,
 * every discovery cycle (hourly/startup/manual). RunwayML is the ONLY
 * provider wired here deliberately — fal.ai/Replicate are future candidates
 * once this is proven, not part of this change.
 */
import { getRunwaymlSchemaCapabilityAttributes } from '@/providers/runwayml/runwayml-schema-attributes';
import { DEFAULT_RUNWAYML_API_VERSION } from '@/providers/runwayml/runwayml-adapter';

export function attachRunwaymlTier1Metadata<
  T extends { metadata?: Record<string, unknown> },
>(providerId: string, model: T): T {
  if (providerId !== 'runwayml') return model;
  const attrs = getRunwaymlSchemaCapabilityAttributes(DEFAULT_RUNWAYML_API_VERSION);
  if (!attrs) return model;
  return {
    ...model,
    metadata: {
      ...(model.metadata ?? {}),
      capabilityAttributes: { video_generation: attrs },
    },
  };
}
