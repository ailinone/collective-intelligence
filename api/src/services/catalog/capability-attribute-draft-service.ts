// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tier 3 — LLM-drafted attributes + auto-promotion (LOTE AZ, 2026-09-23).
 *
 * `llm_draft`-sourced rows are written by a (separate, not-yet-wired-here)
 * doc-reading LLM pass and are NEVER used by `canSatisfyCapabilityAttributes`
 * (enforced in `capability-attribute-matcher.ts`). They exist purely to be
 * reviewed: either auto-promoted here (called from the Tier 2 probe job's
 * write path, right after a probe succeeds) when a probed result agrees, or
 * manually promoted via the admin endpoints below.
 *
 * Auto-promotion rule (from the design):
 *   - enum/boolean fields (e.g. nativeAudioSupport): EXACT match required.
 *   - numeric fields (e.g. maxDurationSeconds): probed value within +/-10%
 *     of the drafted value.
 * Disagreement leaves BOTH rows in place — the probed row is already the
 * one `resolveCapabilityAttributes` trusts (probed outranks llm_draft
 * unconditionally, and llm_draft is excluded from matching entirely), the
 * draft just stays visible in the admin list, not silently discarded.
 */
import { prisma } from '@/database/client';
import type { ModelCapability } from '@/types';
import { projectCapabilityAttributesToModels } from './capability-attribute-projection';

export interface UnpromotedDraft {
  readonly id: string;
  readonly attributes: Record<string, unknown>;
}

export async function findUnpromotedDraft(
  providerId: string,
  capability: ModelCapability
): Promise<UnpromotedDraft | undefined> {
  const rows = await prisma.providerCapabilityAttributeRecord.findMany({
    where: { providerId, capability, source: 'llm_draft' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  const row = rows[0];
  if (!row) return undefined;
  return { id: row.id, attributes: row.attributes as Record<string, unknown> };
}

const NUMERIC_AGREEMENT_TOLERANCE = 0.1;

function valuesAgree(draftValue: unknown, probedValue: unknown): boolean {
  if (typeof draftValue === 'number' && typeof probedValue === 'number') {
    if (draftValue === 0) return probedValue === 0;
    return Math.abs(probedValue - draftValue) / Math.abs(draftValue) <= NUMERIC_AGREEMENT_TOLERANCE;
  }
  // Enum/boolean/string fields: exact match only.
  return draftValue === probedValue;
}

export interface AutoPromoteIfAgreesInput {
  readonly draftId: string;
  readonly providerId: string;
  readonly capability: ModelCapability;
  readonly draftAttributes: Record<string, unknown>;
  readonly probedValue: unknown;
  readonly probedField: string;
}

export async function autoPromoteIfAgrees(input: AutoPromoteIfAgreesInput): Promise<boolean> {
  const draftValue = input.draftAttributes[input.probedField];
  if (draftValue === undefined) return false;
  if (!valuesAgree(draftValue, input.probedValue)) return false;

  await prisma.providerCapabilityAttributeRecord.update({
    where: { id: input.draftId },
    data: {
      source: 'human',
      promotionNote: `agreement-promoted: probed ${input.probedField}=${String(input.probedValue)} agreed with draft ${String(draftValue)}`,
    },
  });
  await projectCapabilityAttributesToModels(input.providerId, input.capability, {
    ...input.draftAttributes,
    source: 'human',
  } as never);
  return true;
}

/**
 * SAFETY-GUARD FIX-FORWARD (2026-09-24): Task 8's code review flagged that
 * this `update` call had no `where: { source: 'llm_draft' }` guard, meaning
 * it could accidentally promote a non-draft row (e.g. re-promoting an
 * already-`human` row, or a `probed`/`schema` row, if a caller ever passed
 * the wrong id). Added here, while this function is already being touched
 * for the Task 9 projection wiring, rather than carrying the gap forward.
 * `prisma.update` throws `P2025` when the compound `where` doesn't match —
 * the only caller, `catalog-attribute-drafts-admin-routes.ts`'s POST
 * `/v1/admin/catalog/attribute-drafts/:id/promote` handler, already wraps
 * this call in a try/catch that logs and returns a generic 500, so no
 * additional error handling is needed here.
 */
export async function promoteDraft(draftId: string): Promise<void> {
  const updated = await prisma.providerCapabilityAttributeRecord.update({
    where: { id: draftId, source: 'llm_draft' },
    data: { source: 'human', promotionNote: 'manually promoted via admin endpoint' },
  });
  await projectCapabilityAttributesToModels(
    updated.providerId,
    updated.capability as ModelCapability,
    { ...(updated.attributes as Record<string, unknown>), source: 'human' } as never
  );
}

export interface AttributeDraftListItem {
  readonly id: string;
  readonly providerId: string;
  readonly capability: string;
  readonly attributes: Record<string, unknown>;
  readonly createdAt: Date;
  /** True when a later Tier 2 probe already agreement-promoted a DIFFERENT
   *  row for the same provider+capability — surfaces so the admin UI can
   *  show this draft as "auto-resolved" rather than pending, per the design. */
  readonly autoResolved: boolean;
}

export async function listAttributeDrafts(): Promise<AttributeDraftListItem[]> {
  const drafts = await prisma.providerCapabilityAttributeRecord.findMany({
    where: { source: 'llm_draft' },
    orderBy: { createdAt: 'desc' },
  });
  if (drafts.length === 0) return [];

  const humanRows = await prisma.providerCapabilityAttributeRecord.findMany({
    where: {
      source: 'human',
      OR: drafts.map((d) => ({ providerId: d.providerId, capability: d.capability })),
    },
  });
  const hasHumanRow = new Set(humanRows.map((r) => `${r.providerId}:${r.capability}`));

  return drafts.map((d) => ({
    id: d.id,
    providerId: d.providerId,
    capability: d.capability,
    attributes: d.attributes as Record<string, unknown>,
    createdAt: d.createdAt,
    autoResolved: hasHumanRow.has(`${d.providerId}:${d.capability}`),
  }));
}
