// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability-attribute persistence overlay — LOTE AZ (2026-09-23).
 *
 * `ProviderCatalogEntry.capabilityAttributes` (provider-catalog.types.ts) is
 * a static, compiled TS literal — nothing at runtime can write to it. This
 * module is the actual write target for the Tier 1 (schema), Tier 2
 * (probed), and Tier 3 (llm_draft / human-promoted) discovery jobs, and the
 * single merge-read function every consumer (matchers, the projection job,
 * the admin endpoints) should call instead of reading the catalog directly
 * for anything other than the 6 hand-authored rows.
 *
 * Trust order on read (highest first): the static catalog's own `source:
 * 'human'` literal (if the provider has one) wins outright — those rows were
 * hand-verified against vendor docs and are never overridden by a
 * lower-trust runtime discovery result. Otherwise, among DB rows for the
 * same (providerId, capability), pick the highest-trust non-draft row:
 * human > probed > schema. `llm_draft` rows are NEVER returned by this
 * function — they only surface via the admin draft-review endpoints.
 */
import { prisma, Prisma } from '@/database/client';
import { PROVIDER_CATALOG } from '@/providers/catalog/providers.catalog';
import type { CapabilityAttributes } from '@/providers/catalog/provider-catalog.types';
import type { ModelCapability } from '@/types';

const TRUST_RANK: Record<string, number> = { human: 3, probed: 2, schema: 1 };

function toIsoDate(value: Date | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.toISOString().slice(0, 10);
}

export async function resolveCapabilityAttributes(
  providerId: string,
  capability: ModelCapability
): Promise<CapabilityAttributes | undefined> {
  const staticEntry = PROVIDER_CATALOG.find((e) => e.providerId === providerId);
  const staticAttrs = staticEntry?.capabilityAttributes?.[capability];
  if (staticAttrs) return staticAttrs;

  const rows = await prisma.providerCapabilityAttributeRecord.findMany({
    where: { providerId, capability },
  });

  const nonDraft = rows.filter((r) => r.source !== 'llm_draft');
  if (nonDraft.length === 0) return undefined;

  const best = nonDraft.reduce((a, b) =>
    (TRUST_RANK[b.source] ?? 0) > (TRUST_RANK[a.source] ?? 0) ? b : a
  );

  return {
    ...(best.attributes as Record<string, unknown>),
    source: best.source as CapabilityAttributes['source'],
    attributesVerifiedAt: toIsoDate(best.attributesVerifiedAt),
  } as CapabilityAttributes;
}

export interface WriteCapabilityAttributeRecordInput {
  readonly providerId: string;
  readonly capability: ModelCapability;
  readonly source: 'schema' | 'probed' | 'llm_draft' | 'human';
  readonly attributes: Record<string, unknown>;
  readonly attributesVerifiedAt?: string;
}

export async function writeCapabilityAttributeRecord(
  input: WriteCapabilityAttributeRecordInput
): Promise<{ id: string }> {
  const created = await prisma.providerCapabilityAttributeRecord.create({
    data: {
      providerId: input.providerId,
      capability: input.capability,
      source: input.source,
      attributes: input.attributes as Prisma.InputJsonValue,
      attributesVerifiedAt: input.attributesVerifiedAt
        ? new Date(input.attributesVerifiedAt)
        : undefined,
    },
  });
  return { id: created.id };
}
