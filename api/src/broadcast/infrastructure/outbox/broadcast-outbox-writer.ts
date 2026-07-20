// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BroadcastOutboxWriter — persists a TraceEnvelope to broadcast_trace_outbox
 * as part of the caller's transaction.
 *
 * See ADR-014 (Broadcast uses Transactional Outbox).
 *
 * Contract:
 *   writer.write(envelope, tx)
 *     - `tx` is REQUIRED. The INSERT runs in the caller's transaction,
 *       guaranteeing the envelope is committed IFF the business write commits.
 *     - Callers that legitimately need a non-transactional write (e.g. a
 *       replay admin tool) must pass the global `prisma` client explicitly.
 *       This forces every call-site to make a deliberate decision about
 *       atomicity — the previous default (`tx = prisma`) silently turned
 *       every forgotten tx into a dual-write race and made the outbox
 *       pattern decorative.
 *
 * Validation:
 *   The envelope is parsed by TraceEnvelopeSchema before insert. This is the
 *   trust boundary: downstream consumers (poller, serializer, destinations)
 *   can assume envelope shape is canonical. Invalid envelopes throw BEFORE
 *   the DB round-trip.
 *
 * Size guard:
 *   Envelope JSON is capped at OUTBOX_MAX_JSON_BYTES (default 256 KiB). Above
 *   this, we throw instead of writing — a single trace shouldn't bloat the
 *   outbox. For larger payloads, future iterations can store the envelope in
 *   object storage and reference by URL.
 *
 * Idempotency by requestId (structural — not by convention):
 *   The outbox has a PARTIAL unique index on `request_id` (see migration
 *   20260421000000_broadcast_outbox_request_id_unique). The writer catches
 *   the P2002 unique violation and returns `alreadyStaged: true` rather than
 *   rethrowing. This makes double-emission of the same caller requestId a
 *   no-op at the DB level, independent of upstream retry logic.
 *
 *   Why this belongs in the schema (not in a TODO in the emitter):
 *     - The emitter today is invoked only AFTER executeRouteWithRetry
 *       succeeds, so double-emission is structurally impossible in the
 *       current code shape.
 *     - That structural impossibility rests on a convention that could be
 *       violated by any future refactor that moves the emit inside a retry
 *       loop. A DB-level guarantee closes that evolution footgun without
 *       forcing every future maintainer to re-derive the invariant.
 *     - The partial index (`WHERE request_id IS NOT NULL`) keeps legacy rows
 *       and non-chat emission paths (async jobs, webhooks) free to leave
 *       request_id NULL — they stay non-deduplicated, which is what we want
 *       because those paths have no shared key to dedupe on.
 */

import type { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';

import {
  parseTraceEnvelope,
  type TraceEnvelope,
} from '@/broadcast/domain/trace-envelope';
import { narrowAs } from '@/utils/type-guards';
import { broadcastMetrics } from '@/broadcast/infrastructure/metrics/broadcast-metrics';

const log = logger.child({ component: 'broadcast-outbox-writer' });

/** Soft cap on envelope JSON size. Traces above this are pathological. */
export const OUTBOX_MAX_JSON_BYTES = 256 * 1024; // 256 KiB

/**
 * Minimal Prisma surface used by the writer. Satisfied by both
 * `PrismaClient` and `Prisma.TransactionClient`.
 */
export type OutboxPrismaRunner = Pick<
  Prisma.TransactionClient | typeof prisma,
  'broadcastTraceOutbox'
>;

export class OutboxEnvelopeTooLargeError extends Error {
  constructor(bytes: number, envelopeId: string) {
    super(
      `TraceEnvelope ${envelopeId} is ${bytes} bytes, exceeds OUTBOX_MAX_JSON_BYTES=${OUTBOX_MAX_JSON_BYTES}`,
    );
    this.name = 'OutboxEnvelopeTooLargeError';
  }
}

export interface BroadcastOutboxWriteResult {
  envelopeId: string;
  bytes: number;
  stagedAt: Date;
  /**
   * `true` when a row with the same `requestId` was already in the outbox and
   * this call was a no-op (the partial unique index rejected the insert).
   * Callers log at debug level; user-facing behavior is unchanged because the
   * envelope is — by definition — already queued for delivery.
   */
  alreadyStaged: boolean;
}

export interface BroadcastOutboxWriter {
  /**
   * Stage a trace envelope for downstream broadcast.
   *
   * @param envelope  the trace envelope (validated by Zod schema)
   * @param tx        REQUIRED Prisma transaction client (or the global
   *                  `prisma` if the caller is deliberately outside a tx —
   *                  see ADR-014). There is no default: forgetting to pass
   *                  a tx used to silently produce dual-write bugs.
   */
  write(
    envelope: TraceEnvelope,
    tx: OutboxPrismaRunner,
  ): Promise<BroadcastOutboxWriteResult>;
}

// ─── Implementation ──────────────────────────────────────────────────────

export class DefaultBroadcastOutboxWriter implements BroadcastOutboxWriter {
  async write(
    envelope: TraceEnvelope,
    tx: OutboxPrismaRunner,
  ): Promise<BroadcastOutboxWriteResult> {
    // Trust boundary: parse before insert so invalid envelopes never reach the DB.
    const validated = parseTraceEnvelope(envelope);

    const serialized = JSON.stringify(validated);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > OUTBOX_MAX_JSON_BYTES) {
      throw new OutboxEnvelopeTooLargeError(bytes, validated.envelopeId);
    }

    const stagedAt = new Date();

    try {
      await tx.broadcastTraceOutbox.create({
        data: {
          envelopeId: validated.envelopeId,
          schemaVersion: validated.schemaVersion,
          organizationId: validated.tenant.organizationId,
          userId: validated.tenant.userId,
          apiKeyId: validated.tenant.apiKeyId,
          resolutionScope: validated.tenant.resolutionScope,
          envelope: narrowAs<Prisma.InputJsonValue>(validated),
          occurredAt: new Date(validated.occurredAt),
          createdAt: stagedAt,
          requestId: validated.requestId,
        },
      });
    } catch (e) {
      // P2002 on the partial unique index = a row with the same requestId is
      // already in the outbox. Treat as a successful no-op: the caller wanted
      // the envelope staged, and it IS staged (from a prior call). Record the
      // outcome as `ok` because there is no error from the caller's point of
      // view; a separate label would blow up the metric's cardinality budget
      // without buying observability a log line doesn't already give us.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        isRequestIdConflict(e)
      ) {
        broadcastMetrics.outboxWrites.inc({ status: 'ok' });
        log.debug(
          {
            envelopeId: validated.envelopeId,
            requestId: validated.requestId,
            organizationId: validated.tenant.organizationId,
          },
          'Trace envelope already staged for this requestId — no-op',
        );
        return {
          envelopeId: validated.envelopeId,
          bytes,
          stagedAt,
          alreadyStaged: true,
        };
      }
      broadcastMetrics.outboxWrites.inc({ status: 'error' });
      throw e;
    }
    broadcastMetrics.outboxWrites.inc({ status: 'ok' });

    log.debug(
      {
        envelopeId: validated.envelopeId,
        organizationId: validated.tenant.organizationId,
        userId: validated.tenant.userId,
        resolutionScope: validated.tenant.resolutionScope,
        bytes,
      },
      'Trace envelope staged in outbox',
    );

    return {
      envelopeId: validated.envelopeId,
      bytes,
      stagedAt,
      alreadyStaged: false,
    };
  }
}

/**
 * Did this P2002 come from the partial unique index on `request_id`?
 *
 * Prisma surfaces the conflicting target in `meta.target`. We only treat
 * request_id conflicts as idempotent no-ops; any other unique violation
 * (e.g. a future accidentally-duplicated envelopeId) must still surface to
 * the caller as a hard error.
 */
function isRequestIdConflict(e: Prisma.PrismaClientKnownRequestError): boolean {
  const target = e.meta?.target;
  if (Array.isArray(target)) {
    return target.some((t) => typeof t === 'string' && t.includes('request_id'));
  }
  if (typeof target === 'string') return target.includes('request_id');
  return false;
}

/**
 * Shared singleton. The writer is stateless so a module-scoped instance is safe.
 */
export const broadcastOutboxWriter: BroadcastOutboxWriter = new DefaultBroadcastOutboxWriter();
