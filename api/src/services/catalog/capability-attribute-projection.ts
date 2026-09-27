// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `Model.metadata.capabilityAttributes` projection — LOTE AZ (2026-09-23).
 *
 * `media-planner-gate.ts#findNativeCollapseModel` reads
 * `model.metadata['capabilityAttributes']` (a runtime, per-model field) —
 * see that file's own doc comment flagging this exact seam as unpopulated.
 * This function is the "missing projection" it names: after a Tier 2 probe
 * or a Tier 3 promotion writes a `ProviderCapabilityAttributeRecord`, call
 * this to denormalize the same value onto every `Model` row for that
 * provider+capability, so the gate starts reading real data.
 *
 * Deliberately matches models the same way `findNativeCollapseModel` and
 * `hasVideoCapability` already do — `model.capabilities.includes(capability)`
 * — the simple, legacy JSON array field, NOT the HCRA `capabilityUris`
 * ontology layer, so this write path stays consistent with what the READ
 * path (media-planner-gate.ts) actually checks.
 *
 * Tier 1 (RunwayML) does NOT need this function — its schema-derived
 * metadata already flows onto `Model.metadata` for free via the existing
 * discovery-cycle bulk upsert (`metadata = EXCLUDED.metadata` on every
 * cycle). This function exists for Tier 2/3, which write outside that cycle.
 *
 * KNOWN SHAPE MISMATCH (found while implementing this task, not fixed here
 * — see this task's report): `media-planner-gate.ts#readCapabilityAttributes`
 * reads `model.metadata.capabilityAttributes` and casts it DIRECTLY to
 * `MediaCapabilityAttributesLike` (a flat object with `maxDurationSec`,
 * `nativeAudioSupport`, etc. — no further keying by capability), whereas
 * this function writes `metadata.capabilityAttributes` as a MAP keyed by
 * capability (`{ video_generation: { maxDurationSeconds, ... } }`), per this
 * task's own explicit spec/test. The two field names also differ
 * (`maxDurationSeconds` here vs. `maxDurationSec` in the gate's read type).
 * Reconciling that is out of scope for this task (which only wires the
 * write path per its literal spec) — flagged for the owner of
 * media-planner-gate.ts.
 */
import { prisma, Prisma } from '@/database/client';
import type { ModelCapability } from '@/types';
import type { CapabilityAttributes } from '@/providers/catalog/provider-catalog.types';

export async function projectCapabilityAttributesToModels(
  providerId: string,
  capability: ModelCapability,
  attributes: CapabilityAttributes
): Promise<void> {
  const rows = await prisma.model.findMany({ where: { providerId } });

  const matching = rows.filter((row) => {
    const capabilities = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];
    return capabilities.includes(capability);
  });

  await Promise.all(
    matching.map((row) => {
      const existingMetadata = (row.metadata as Record<string, unknown>) ?? {};
      const existingAttrs =
        (existingMetadata.capabilityAttributes as Record<string, unknown>) ?? {};
      return prisma.model.update({
        where: { uid: row.uid },
        data: {
          metadata: {
            ...existingMetadata,
            capabilityAttributes: { ...existingAttrs, [capability]: attributes },
          } as Prisma.InputJsonValue,
        },
      });
    })
  );
}
