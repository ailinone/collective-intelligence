// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Destination Resolver — given a TraceEnvelope, return the set of destinations
 * that should receive it.
 *
 * Matching logic (ADR-020 — Multi-Tenant Destination Resolution):
 *   - destination.enabled = true AND deleted_at IS NULL
 *   - tenant match:
 *       (tenant_type = 'organization' AND tenant_id = envelope.tenant.organizationId)
 *       OR
 *       (tenant_type = 'user'         AND tenant_id = envelope.tenant.userId)
 *     Matching is ADDITIVE: an envelope with both org and user matches will
 *     broadcast to ALL applicable destinations (org-level + user-level).
 *   - api_key_filter: empty array → match any; non-empty → must contain
 *     envelope.tenant.apiKeyId
 *
 * The resolver DOES NOT apply sampling or privacy policy — those run in the
 * delivery executor. This module only answers "which destinations match?".
 */

import { prisma } from '@/database/client';
import type { Prisma } from '@/generated/prisma/index.js';

import type { TraceEnvelope } from '@/broadcast/domain/trace-envelope';
import type { DestinationType } from '@/broadcast/infrastructure/destinations/destination-adapter';

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Row shape returned by the resolver. Keeps the envelope-of-concerns: only
 * the fields the executor needs. Config stays encrypted at this layer;
 * decryption happens inside the executor just before delivery.
 */
export interface ResolvedDestination {
  id: string;
  tenantType: 'organization' | 'user';
  tenantId: string;
  type: DestinationType;
  name: string;
  samplingRate: number;
  privacyMode: boolean;
  releaseStatus: 'alpha' | 'beta' | 'stable' | 'deprecated';

  /** Encrypted config blob — decrypt inside the executor per delivery. */
  configCiphertext: Buffer;
  configIv: Buffer;
  configAuthTag: Buffer;
  configAad: string;
  configDekWrapped: Buffer;
  configKekResource: string;
}

export type ResolverRunner = Pick<Prisma.TransactionClient, '$queryRaw'>;

// ─── Public API ─────────────────────────────────────────────────────────

export interface DestinationResolver {
  resolveForEnvelope(envelope: TraceEnvelope, runner?: ResolverRunner): Promise<ResolvedDestination[]>;
}

export class DefaultDestinationResolver implements DestinationResolver {
  async resolveForEnvelope(
    envelope: TraceEnvelope,
    runner: ResolverRunner = prisma,
  ): Promise<ResolvedDestination[]> {
    const orgId = envelope.tenant.organizationId;
    const userId = envelope.tenant.userId;
    const apiKeyId = envelope.tenant.apiKeyId;

    // No tenant → nowhere to broadcast. Empty list.
    if (!orgId && !userId) return [];

    const rows = await runner.$queryRaw<DestinationRow[]>`
      SELECT id,
             tenant_type,
             tenant_id,
             destination_type,
             name,
             sampling_rate,
             privacy_mode,
             release_status,
             api_key_filter,
             config_ciphertext,
             config_iv,
             config_auth_tag,
             config_aad,
             config_dek_wrapped,
             config_kek_resource
        FROM broadcast_destination
       WHERE enabled = TRUE
         AND deleted_at IS NULL
         AND release_status <> 'deprecated'
         AND (
               (tenant_type = 'organization' AND tenant_id = ${orgId ?? null}::uuid)
            OR (tenant_type = 'user'         AND tenant_id = ${userId ?? null}::uuid)
         )
    `;

    // Filter api_key_filter in application code: small array, JSONB `?` op
    // would work but is less portable across Prisma versions.
    return rows
      .filter((r) => matchesApiKeyFilter(r.api_key_filter, apiKeyId))
      .map(toResolvedDestination);
  }
}

export const destinationResolver: DestinationResolver = new DefaultDestinationResolver();

// ─── Internals ──────────────────────────────────────────────────────────

interface DestinationRow {
  id: string;
  tenant_type: 'organization' | 'user';
  tenant_id: string;
  destination_type: string;
  name: string;
  sampling_rate: string | number; // NUMERIC comes back as string in some drivers
  privacy_mode: boolean;
  release_status: 'alpha' | 'beta' | 'stable' | 'deprecated';
  api_key_filter: unknown;
  config_ciphertext: Buffer;
  config_iv: Buffer;
  config_auth_tag: Buffer;
  config_aad: string;
  config_dek_wrapped: Buffer;
  config_kek_resource: string;
}

function matchesApiKeyFilter(filter: unknown, apiKeyId: string | null | undefined): boolean {
  if (!Array.isArray(filter)) return true; // malformed → treat as unrestricted
  if (filter.length === 0) return true; // empty array → match any
  if (!apiKeyId) return false; // destination has filter but envelope has no api key
  return filter.includes(apiKeyId);
}

function toResolvedDestination(row: DestinationRow): ResolvedDestination {
  const rate =
    typeof row.sampling_rate === 'string' ? Number(row.sampling_rate) : row.sampling_rate;
  return {
    id: row.id,
    tenantType: row.tenant_type,
    tenantId: row.tenant_id,
    type: row.destination_type as DestinationType,
    name: row.name,
    samplingRate: Number.isFinite(rate) ? rate : 0,
    privacyMode: row.privacy_mode,
    releaseStatus: row.release_status,
    configCiphertext: row.config_ciphertext,
    configIv: row.config_iv,
    configAuthTag: row.config_auth_tag,
    configAad: row.config_aad,
    configDekWrapped: row.config_dek_wrapped,
    configKekResource: row.config_kek_resource,
  };
}
