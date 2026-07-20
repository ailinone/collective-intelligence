// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BroadcastAdminService — admin-only operations that span multiple broadcast
 * tables.
 *
 * Two responsibilities (for now):
 *
 * 1) Right-to-Erasure (GDPR Article 17 / LGPD Art. 18 V):
 *    Given a userId or organizationId, HARD-delete all rows that carry or
 *    could be correlated back to that subject. Hard delete (not soft) because
 *    erasure means "the bits are gone", not "we hid a flag".
 *
 *    Cascade order (respecting FKs — BroadcastDestination is parent of
 *    BroadcastDelivery and BroadcastDlqEntry via onDelete: Cascade):
 *      a. broadcast_trace_outbox rows where data->>'tenant'->>'userId' matches
 *         (or organizationId). These carry the raw envelope snapshot.
 *      b. broadcast_delivery rows whose envelope is being deleted (cascades
 *         via FK when the outbox row goes).
 *      c. broadcast_dlq rows referencing a destination owned by the subject
 *         (cascaded via destination delete), plus dlq rows whose
 *         envelope_snapshot references the subject (hit directly).
 *      d. broadcast_destination rows owned by the subject (cascades delivery
 *         and dlq children).
 *
 *    Returns a tally so the caller can audit what was erased.
 *
 * 2) DLQ Replay:
 *    Mark DLQ entries as replayed and re-queue them via the outbox. Replay
 *    creates a FRESH outbox row with the snapshotted envelope, preserving
 *    idempotency (original envelope id is unchanged — the poller's ON
 *    CONFLICT DO NOTHING in the delivery table still protects against
 *    double-writes if the original delivery eventually succeeded).
 *
 * Both paths require admin auth at the route layer; this service trusts its
 * callers.
 */

import { randomUUID } from 'node:crypto';

import type { Prisma, PrismaClient } from '@/generated/prisma/index.js';
import { prisma as defaultPrisma } from '@/database/client';
import type { TenantContext } from '@/broadcast/domain/trace-envelope';
import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';
import { broadcastMetrics } from '@/broadcast/infrastructure/metrics/broadcast-metrics';

const log = logger.child({ component: 'broadcast-admin-service' });

// Tenant id columns on broadcast_trace_outbox are @db.Uuid. A privacy-redacted
// DLQ snapshot may carry the REDACTED_STRING sentinel or a pseudonym in place of
// a tenant id; coerce anything that is not a canonical UUID to null so a replay
// insert cannot throw Prisma P2007 on those columns.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function asUuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

/**
 * Rebuild a valid TenantContext for a DLQ replay from (a) whatever survives in
 * the envelope snapshot and (b) the DLQ entry's destination row.
 *
 * When the snapshot was privacy-redacted, its tenant ids are the
 * REDACTED_STRING sentinel or a `pseudo:` pseudonym — not UUIDs — so they fail
 * TenantContextSchema, the @db.Uuid outbox columns, and the resolver's ::uuid
 * binds. The destination row's tenant_type/tenant_id is stored in plaintext
 * (it IS the resolution key the DLQ entry points at), so restoring the missing
 * id from it exposes nothing that isn't already on the row, and the redactor's
 * GDPR pseudonymization policy for retained snapshots stays intact.
 *
 * Precedence: a valid UUID in the snapshot wins; otherwise the destination's
 * tenant identity fills the matching field; anything else is null.
 * Exported for hermetic unit tests.
 */
export function rehydrateReplayTenant(
  snapshotTenant: Record<string, unknown>,
  destination: { tenantType: string; tenantId: string } | null | undefined,
): TenantContext {
  // Defensive: the destination relation is FK-required so it should always be
  // present, but degrade to coercion-only (nulls) rather than throw if not.
  const destType = destination?.tenantType;
  const destId = destination?.tenantId ?? null;
  const organizationId =
    asUuidOrNull(snapshotTenant.organizationId) ??
    (destType === 'organization' ? destId : null);
  const userId =
    asUuidOrNull(snapshotTenant.userId) ?? (destType === 'user' ? destId : null);
  const scope = snapshotTenant.resolutionScope;
  const resolutionScope =
    scope === 'organization' || scope === 'user' || scope === 'chatroom'
      ? scope
      : destType === 'user'
        ? ('user' as const)
        : ('organization' as const);
  return {
    organizationId,
    userId,
    apiKeyId: asUuidOrNull(snapshotTenant.apiKeyId),
    resolutionScope,
  };
}

// ─── Types ──────────────────────────────────────────────────────────────

export type Subject =
  | { kind: 'user'; userId: string }
  | { kind: 'organization'; organizationId: string };

export interface ErasureTally {
  outboxDeleted: number;
  deliveriesDeleted: number;
  dlqDeleted: number;
  destinationsDeleted: number;
}

export interface ReplayRequest {
  dlqEntryId: string;
  replayedByUserId: string;
  /**
   * When true, the re-emitted envelope carries a `broadcast.force_include`
   * marker so the delivery executor bypasses the sampling gate. This is the
   * point of an operator-initiated replay: a DLQ entry was created for a
   * delivery that DID cross the sampling filter, so sampling the replay out
   * would silently discard the operator's explicit retry. Default: false —
   * replay respects the destination's current sampling rate (useful when an
   * operator mass-replays an incident's DLQ and does NOT want to inflate
   * sampled-out destinations' volumes).
   */
  forceInclude?: boolean;
}

export interface ReplayOutcome {
  dlqEntryId: string;
  newEnvelopeId: string;
  requeued: boolean;
  reason?: string;
}

export type AdminRunner = Pick<
  PrismaClient,
  | '$executeRaw'
  | '$queryRaw'
  | '$transaction'
  | 'broadcastDlqEntry'
  | 'broadcastDestination'
  | 'broadcastTraceOutbox'
>;

export interface BroadcastAdminServiceDeps {
  db?: AdminRunner;
  now?: () => Date;
}

// ─── Service ────────────────────────────────────────────────────────────

export class BroadcastAdminService {
  private readonly db: AdminRunner;
  private readonly now: () => Date;

  constructor(deps: BroadcastAdminServiceDeps = {}) {
    this.db = deps.db ?? (narrowAs<AdminRunner>(defaultPrisma));
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Right-to-Erasure cascade for a subject (user OR organization).
   *
   * Runs inside a single transaction so partial state can't linger if any
   * delete fails. Returns a tally for audit logging.
   */
  async eraseSubject(subject: Subject): Promise<ErasureTally> {
    const id = subject.kind === 'user' ? subject.userId : subject.organizationId;

    return this.db.$transaction(async (tx) => {
      // 1) Delete outbox rows owned by the subject. The schema indexes the
      //    tenant on dedicated columns so we don't need JSON path arithmetic.
      //    Cascades to broadcast_delivery via onDelete: Cascade on the FK.
      const outboxDeleted =
        subject.kind === 'user'
          ? await tx.$executeRaw`
              DELETE FROM broadcast_trace_outbox
               WHERE user_id = ${id}::uuid
            `
          : await tx.$executeRaw`
              DELETE FROM broadcast_trace_outbox
               WHERE organization_id = ${id}::uuid
            `;

      // 2) DLQ rows may still reference the subject via their snapshot JSON.
      //    The snapshot's top-level matches the TraceEnvelope Zod shape:
      //    `tenant.userId` / `tenant.organizationId`.
      const dlqJsonField = subject.kind === 'user' ? 'userId' : 'organizationId';
      const dlqDeleted = await tx.$executeRaw`
        DELETE FROM broadcast_dlq
         WHERE envelope_snapshot #>> ARRAY['tenant', ${dlqJsonField}] = ${id}
      `;

      // 3) Delivery rows tied to a destination the subject owns. The cascade
      //    from step 4 covers these via FK, but we issue an explicit DELETE
      //    so the count reflects all rows removed for the subject.
      const deliveriesDeleted = await tx.$executeRaw`
        DELETE FROM broadcast_delivery d
         USING broadcast_destination bd
         WHERE d.destination_id = bd.id
           AND bd.tenant_type  = ${subject.kind}
           AND bd.tenant_id    = ${id}::uuid
      `;

      // 4) Destinations owned by the subject. Cascade covers any remaining
      //    delivery and dlq children via onDelete: Cascade on the FK.
      const destinationsDeleted = await tx.broadcastDestination.deleteMany({
        where: {
          tenantType: subject.kind,
          tenantId: id,
        },
      });

      log.warn(
        {
          subjectKind: subject.kind,
          subjectId: id,
          outboxDeleted,
          deliveriesDeleted,
          dlqDeleted,
          destinationsDeleted: destinationsDeleted.count,
        },
        'broadcast right-to-erasure executed',
      );
      broadcastMetrics.erasures.inc({ subject_kind: subject.kind });

      return {
        outboxDeleted,
        deliveriesDeleted,
        dlqDeleted,
        destinationsDeleted: destinationsDeleted.count,
      };
    });
  }

  /**
   * Re-queue a DLQ entry by writing a fresh envelope row to the outbox.
   *
   * Why a new envelope id? The original envelope's deliveries are already
   * marked dlq; reusing the id would collide with the unique (envelope_id,
   * destination_id) index on broadcast_delivery. A new id for the re-play is
   * the simple safe choice — the original envelope_id is preserved in
   * `envelope_snapshot.metadata.replayedFromEnvelopeId` for audit.
   */
  async replayDlqEntry(request: ReplayRequest): Promise<ReplayOutcome> {
    return this.db.$transaction(async (tx) => {
      const dlq = await tx.broadcastDlqEntry.findUnique({
        where: { id: request.dlqEntryId },
        // The destination's tenant identity (tenant_type/tenant_id, stored in
        // plaintext as the resolution key) rehydrates tenant ids that the
        // privacy redactor stripped from the envelope snapshot — see
        // rehydrateReplayTenant below.
        include: {
          destination: { select: { tenantType: true, tenantId: true } },
        },
      });
      if (!dlq) {
        return {
          dlqEntryId: request.dlqEntryId,
          newEnvelopeId: '',
          requeued: false,
          reason: 'dlq entry not found',
        };
      }
      if (dlq.replayedAt) {
        return {
          dlqEntryId: request.dlqEntryId,
          newEnvelopeId: '',
          requeued: false,
          reason: 'dlq entry already replayed',
        };
      }

      // Clone snapshot, bump the envelopeId so it doesn't collide on insert.
      const snapshotUnknown = dlq.envelopeSnapshot as unknown;
      const snapshot =
        snapshotUnknown && typeof snapshotUnknown === 'object'
          ? (snapshotUnknown as Record<string, unknown>)
          : {};
      const newEnvelopeId = randomUUID();
      // forceInclude is threaded on `custom` (not `metadata`) because `custom`
      // is what `decideSampling` and `redactEnvelope` traverse — sibling keys
      // to user-supplied trace metadata. Marker key is namespaced to avoid
      // colliding with user-supplied tags.
      const existingCustom =
        snapshot.custom && typeof snapshot.custom === 'object'
          ? (snapshot.custom as Record<string, unknown>)
          : {};
      const customWithMarker = request.forceInclude
        ? { ...existingCustom, 'broadcast.force_include': true }
        : existingCustom;
      // Rehydrate tenant identity. A privacy-redacted snapshot carries the
      // REDACTED_STRING sentinel (or a pseudonym) where TenantContext requires
      // uuid-or-null, which (a) throws Prisma P2007 on the @db.Uuid outbox
      // columns, (b) fails the ::uuid binds in DefaultDestinationResolver, and
      // (c) fails TenantContextSchema on any re-parse — making redacted DLQ
      // entries un-replayable. The DLQ entry's destination row already stores
      // its tenant identity in PLAINTEXT (tenant_type/tenant_id is the
      // resolution key), so restoring the id from there leaks nothing new and
      // keeps the redactor's GDPR pseudonymization policy untouched.
      const snapshotTenant =
        snapshot.tenant && typeof snapshot.tenant === 'object'
          ? (snapshot.tenant as Record<string, unknown>)
          : {};
      const tenant = rehydrateReplayTenant(snapshotTenant, dlq.destination);
      const clone: Record<string, unknown> = {
        ...snapshot,
        envelopeId: newEnvelopeId,
        tenant,
        custom: customWithMarker,
        metadata: {
          ...((snapshot.metadata as Record<string, unknown> | undefined) ?? {}),
          replayedFromEnvelopeId: snapshot.envelopeId,
          replayedFromDlqId: dlq.id,
          replayedAt: this.now().toISOString(),
          forceInclude: request.forceInclude === true,
        },
      };

      const now = this.now();

      await tx.broadcastTraceOutbox.create({
        data: {
          envelopeId: newEnvelopeId,
          envelope: clone as Prisma.InputJsonValue,
          schemaVersion:
            typeof snapshot.schemaVersion === 'string'
              ? snapshot.schemaVersion
              : '1.0.0',
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          apiKeyId: tenant.apiKeyId,
          resolutionScope: tenant.resolutionScope,
          occurredAt:
            typeof snapshot.occurredAt === 'string'
              ? new Date(snapshot.occurredAt)
              : now,
          createdAt: now,
        },
      });

      await tx.broadcastDlqEntry.update({
        where: { id: dlq.id },
        data: {
          replayedAt: this.now(),
          replayedByUserId: request.replayedByUserId,
        },
      });

      log.info(
        {
          dlqEntryId: dlq.id,
          newEnvelopeId,
          originalEnvelopeId: snapshot.envelopeId,
          replayedByUserId: request.replayedByUserId,
        },
        'broadcast DLQ entry replayed',
      );
      broadcastMetrics.dlqReplays.inc({
        destination_type: (snapshot.destinationType as string | undefined) ?? 'unknown',
      });

      return {
        dlqEntryId: dlq.id,
        newEnvelopeId,
        requeued: true,
      };
    });
  }
}

