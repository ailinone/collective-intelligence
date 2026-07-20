// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * BroadcastEmitter — the one edge-side entry point for staging a chat trace
 * into the outbox.
 *
 * Contract:
 *   1. Builds an envelope via `buildChatTraceEnvelope` (pure, validated).
 *   2. Writes it via `broadcastOutboxWriter.write(envelope, tx)`.
 *   3. NEVER throws to the caller — a broadcast emission failure must not
 *      impact the user-facing request. Failures are logged + counted.
 *
 * Transactionality: the chat completion path has no single atomic "business
 * write" to piggyback on — `requestLogger.logRequest` is batched-async and
 * `trackChatUsage` fans out to multiple stores. The outbox commit therefore
 * uses a bare `prisma` write by default, which means the initial staging is
 * at-most-once under failure. Downstream from the outbox the guarantee is
 * at-least-once (poller retries until success or DLQ). Callers that DO have
 * an atomic business write can pass a `TransactionClient` as the second arg
 * to `emitChatCompletion(args, tx)` — that is the supported pattern; callers
 * must NOT rely on the emitter opening a transaction on their behalf because
 * the emitter swallows errors and would silently roll back sibling writes.
 *
 * Idempotency: each invocation generates a fresh `envelopeId` UUID, so the
 * PK alone would not protect us if a caller staged the same request twice.
 * Structural protection lives one layer down: `broadcast_trace_outbox` has a
 * partial unique index on `request_id` (migration
 * 20260421000000_broadcast_outbox_request_id_unique), and the writer catches
 * the resulting P2002 to return `alreadyStaged: true` instead of throwing. A
 * future caller that moves the emit inside a retry loop, or a double-invoke
 * from any other code path, will therefore produce at most one outbox row
 * per `requestId` — by the DB, not by convention. The current call-site is
 * still post-retry for latency reasons, but it no longer has to be for
 * correctness reasons.
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

import {
  buildChatTraceEnvelope,
  type BuildEnvelopeArgs,
} from '@/broadcast/application/envelope-builder';
import {
  broadcastOutboxWriter,
  type BroadcastOutboxWriter,
  type OutboxPrismaRunner,
} from '@/broadcast/infrastructure/outbox/broadcast-outbox-writer';

const log = logger.child({ component: 'broadcast-emitter' });

export interface BroadcastEmitter {
  /**
   * Build an envelope from a successful (or failed) chat completion and stage
   * it into the outbox. Never throws.
   *
   * @returns `true` if the envelope was staged; `false` on any failure (the
   *   failure is already logged + counted; caller doesn't need to handle it).
   */
  emitChatCompletion(args: BuildEnvelopeArgs, tx?: OutboxPrismaRunner): Promise<boolean>;
}

export class DefaultBroadcastEmitter implements BroadcastEmitter {
  constructor(private readonly writer: BroadcastOutboxWriter = broadcastOutboxWriter) {}

  async emitChatCompletion(
    args: BuildEnvelopeArgs,
    tx?: OutboxPrismaRunner,
  ): Promise<boolean> {
    // Build phase: pure + validated. A build failure indicates schema drift
    // (bug in this builder, not a runtime condition). Log and drop.
    let envelope;
    try {
      envelope = buildChatTraceEnvelope(args);
    } catch (e) {
      const err = e as Error;
      log.error(
        {
          requestId: args.requestId,
          organizationId: args.tenant.organizationId,
          err: err.message,
        },
        'broadcast envelope build failed — skipping emission',
      );
      // Build errors aren't counted in outboxWrites (whose label set is
      // {ok,error} for DB-side outcomes). A build failure is a pre-DB defect;
      // rely on logs + a future separate counter if frequency matters.
      return false;
    }

    // Persist phase: fire-and-forget with respect to the caller, but awaited
    // inside so we can record the metric truthfully and so failures are
    // captured synchronously (not swallowed by an unhandled-rejection).
    try {
      await this.writer.write(envelope, tx ?? prisma);
      return true;
    } catch (e) {
      const err = e as Error;
      log.error(
        {
          requestId: args.requestId,
          organizationId: args.tenant.organizationId,
          envelopeId: envelope.envelopeId,
          err: err.message,
        },
        'broadcast outbox write failed — user request is unaffected',
      );
      return false;
    }
  }
}

/** Shared singleton. Emitter is stateless. */
export const broadcastEmitter: BroadcastEmitter = new DefaultBroadcastEmitter();
