// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Broadcast Outbox Poller — claims unprocessed envelopes from
 * `broadcast_trace_outbox`, resolves their destinations, and fans out to the
 * delivery executor.
 *
 * Claim loop (ADR-014, revised Fase 3.1):
 *
 *   -- PHASE 1: CLAIM (short, never contains HTTP latency)
 *   BEGIN
 *     SELECT envelope_id, envelope
 *       FROM broadcast_trace_outbox
 *      WHERE drained_at IS NULL
 *      ORDER BY created_at
 *      LIMIT $batchSize
 *      FOR UPDATE SKIP LOCKED;
 *     UPDATE broadcast_trace_outbox
 *        SET drained_at = NOW()
 *      WHERE envelope_id IN (...);
 *   COMMIT
 *   -- PHASE 2: DISPATCH (NO transaction held across HTTP)
 *   For each envelope: resolve destinations + executor.deliverOne (via global
 *   Prisma — delivery rows are written non-transactionally).
 *   -- PHASE 3: FINALIZE (short UPDATE per envelope)
 *   UPDATE broadcast_trace_outbox
 *      SET destinations_resolved_count = $n
 *    WHERE envelope_id = $id;
 *   -- PHASE 3b: RECLAIM STRANDED (transient failures during dispatch)
 *   If processEnvelope threw (parse or resolver error), reset drained_at=NULL
 *   inline so the row becomes re-claimable on the next tick.
 *
 * Why the refactor (Fase 3.1):
 *   The previous design wrapped claim + resolve + deliver + mark all in ONE
 *   transaction. That gave perfect atomicity (no duplicate deliveries) but
 *   held a Postgres transaction across HTTP calls — every slow destination
 *   burned a DB connection and risked the 30s tx-timeout cap. Under N
 *   concurrent pollers this made the DB pool the bottleneck. The new flow
 *   commits the drain marker immediately and dispatches with no tx, trading
 *   exactly-once for at-least-once. Destinations must be idempotent at the
 *   receive-side (we include `deliveryAttemptId` on every request so they
 *   can dedupe); the DLQ still admits each permanent failure exactly once
 *   because the delivery writer uses ON CONFLICT upserts keyed by
 *   (envelope_id, destination_id, attempt_number).
 *
 * Properties:
 *   1. HORIZONTAL SCALING — SKIP LOCKED makes N pollers work on disjoint subsets
 *      with zero coordination. Adding pollers is pure win until DB contention.
 *   2. CRASH-SAFE (with reconciliation) — if the poller crashes after claim
 *      but before dispatch, the row is stranded with `drained_at` set and
 *      `destinations_resolved_count IS NULL`. A periodic sweep (see
 *      broadcast-metrics-job) resets such rows older than the visibility
 *      window so another poller can re-claim.
 *   3. BOUNDED TX DURATION — phase 1 (claim) is a pure SELECT + UPDATE; phase
 *      3 is a single-row UPDATE. Neither holds locks across HTTP.
 *   4. BOUNDED LATENCY — registered at 1s BullMQ JobScheduler cadence
 *      (per ARCHITECTURE-GOVERNANCE §3). P50 end-to-end ≈ 1s + fan-out time.
 */

import { prisma } from '@/database/client';
import type { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';

import type { BroadcastDeliveryExecutor } from '@/broadcast/application/delivery-executor';
import type { DestinationResolver } from '@/broadcast/application/destination-resolver';
import { parseTraceEnvelope, type TraceEnvelope } from '@/broadcast/domain/trace-envelope';
import { KekUnwrapBreakerOpenError } from '@/broadcast/infrastructure/encryption/kek-circuit-breaker';
import { broadcastMetrics } from '@/broadcast/infrastructure/metrics/broadcast-metrics';

const log = logger.child({ component: 'broadcast-outbox-poller' });

// ─── Config ─────────────────────────────────────────────────────────────

export const DEFAULT_POLLER_BATCH_SIZE = 50;

// ─── Types ──────────────────────────────────────────────────────────────

export interface PollerDeps {
  resolver: DestinationResolver;
  executor: BroadcastDeliveryExecutor;
  batchSize?: number;
  /** Prisma client; defaults to global. Injectable for tests. */
  db?: typeof prisma;
}

export interface PollResult {
  /** Envelopes claimed and marked as drained in this tick. */
  envelopesProcessed: number;
  /** Sum of deliveries attempted (skipped + sent + failed + dlq) across the batch. */
  deliveriesAttempted: number;
  /** How many of those deliveries hit `success` status. */
  deliveriesSucceeded: number;
  /** How many destinations total resolved across all envelopes in the batch. */
  destinationsResolved: number;
  /** Envelopes whose dispatch threw — drained_at was reset for retry. */
  envelopesReclaimed: number;
}

// Raw row shape returned by the claim SELECT.
interface ClaimedOutboxRow {
  envelope_id: string;
  envelope: unknown; // JSONB
}

interface EnvelopeOutcome {
  envelopeId: string;
  destinationsResolved: number;
  deliveriesAttempted: number;
  deliveriesSucceeded: number;
  occurredAt?: Date;
}

// ─── Public API ─────────────────────────────────────────────────────────

export class BroadcastOutboxPoller {
  private readonly resolver: DestinationResolver;
  private readonly executor: BroadcastDeliveryExecutor;
  private readonly batchSize: number;
  private readonly db: typeof prisma;

  constructor(deps: PollerDeps) {
    this.resolver = deps.resolver;
    this.executor = deps.executor;
    this.batchSize = deps.batchSize ?? DEFAULT_POLLER_BATCH_SIZE;
    this.db = deps.db ?? prisma;
  }

  /**
   * One poll tick. Claim → dispatch → finalize, with stranded reclaim on
   * per-envelope dispatch failure. Safe to run concurrently (SKIP LOCKED
   * handles contention).
   */
  async pollOnce(): Promise<PollResult> {
    const summary: PollResult = {
      envelopesProcessed: 0,
      deliveriesAttempted: 0,
      deliveriesSucceeded: 0,
      destinationsResolved: 0,
      envelopesReclaimed: 0,
    };

    // ── Phase 1: CLAIM (short tx, no HTTP) ──────────────────────────────
    const claimed = await this.claimAndMarkDrained();
    if (claimed.length === 0) return summary;

    const drainedAt = new Date();

    // ── Phase 2: DISPATCH (no transaction held across HTTP) ─────────────
    const envelopeResults = await Promise.allSettled(
      claimed.map((row) => this.processEnvelope(row)),
    );

    const successfulOutcomes: EnvelopeOutcome[] = [];
    const strandedIds: string[] = [];

    for (let i = 0; i < envelopeResults.length; i++) {
      const result = envelopeResults[i];
      const row = claimed[i]!;
      if (result?.status === 'fulfilled') {
        const outcome = result.value;
        successfulOutcomes.push(outcome);
        summary.envelopesProcessed += 1;
        summary.deliveriesAttempted += outcome.deliveriesAttempted;
        summary.deliveriesSucceeded += outcome.deliveriesSucceeded;
        summary.destinationsResolved += outcome.destinationsResolved;
        // Observe end-to-end lag (envelope origin → drain). Excludes adapter
        // latency, which is already covered by deliveryLatency.
        if (outcome.occurredAt) {
          const lagS = Math.max(
            0,
            (drainedAt.getTime() - outcome.occurredAt.getTime()) / 1000,
          );
          broadcastMetrics.outboxLag.observe(lagS);
        }
      } else {
        // processEnvelope threw — parse or resolver failure. Reset drained_at
        // so the next tick can re-claim. (Executor contract says it never
        // throws; resolver/parse DO.) This inline reclaim covers the common
        // case of transient errors; for crashed-poller scenarios, a separate
        // visibility-window sweep resets stranded rows.
        strandedIds.push(row.envelope_id);
        // Promise.allSettled rejection reason is `unknown` by contract.
        const reason: unknown = result?.reason;
        log.error(
          {
            envelopeId: row.envelope_id,
            err: reason instanceof Error ? reason.message : String(reason),
            stack: reason instanceof Error ? reason.stack : undefined,
          },
          'envelope fan-out failed — resetting drained_at for retry',
        );
      }
    }

    // ── Phase 3: FINALIZE (short UPDATE) ────────────────────────────────
    if (successfulOutcomes.length > 0) {
      await this.finalizeResolvedCounts(successfulOutcomes);
    }
    if (strandedIds.length > 0) {
      await this.reclaimStranded(strandedIds);
      summary.envelopesReclaimed = strandedIds.length;
    }

    if (summary.envelopesProcessed > 0 || summary.envelopesReclaimed > 0) {
      log.debug(summary, 'poll tick finished');
    }
    return summary;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Claim tx (phase 1). Atomically SELECT FOR UPDATE SKIP LOCKED + mark
   * drained_at so other pollers can't see these rows. Returns the claimed
   * envelopes for dispatch outside the tx.
   */
  private async claimAndMarkDrained(): Promise<ClaimedOutboxRow[]> {
    return await this.db.$transaction(
      async (tx) => {
        const claimed = await tx.$queryRaw<ClaimedOutboxRow[]>`
          SELECT envelope_id, envelope
            FROM broadcast_trace_outbox
           WHERE drained_at IS NULL
           ORDER BY created_at
           LIMIT ${this.batchSize}
           FOR UPDATE SKIP LOCKED
        `;
        if (claimed.length === 0) return [];

        const ids = claimed.map((r) => r.envelope_id);
        await tx.$executeRaw`
          UPDATE broadcast_trace_outbox
             SET drained_at = NOW()
           WHERE envelope_id = ANY(${ids}::uuid[])
        `;

        return claimed;
      },
      { timeout: 5_000 },
    );
  }

  /**
   * Finalize tx (phase 3). Writes `destinations_resolved_count` for each
   * envelope that dispatched cleanly. A single batched UPDATE via UNNEST
   * keeps this to one round-trip.
   */
  private async finalizeResolvedCounts(outcomes: EnvelopeOutcome[]): Promise<void> {
    const ids = outcomes.map((o) => o.envelopeId);
    const counts = outcomes.map((o) => o.destinationsResolved);
    await this.db.$executeRaw`
      UPDATE broadcast_trace_outbox
         SET destinations_resolved_count = data.resolved_count
        FROM (
          SELECT
            UNNEST(${ids}::uuid[])    AS envelope_id,
            UNNEST(${counts}::int[])  AS resolved_count
        ) AS data
       WHERE broadcast_trace_outbox.envelope_id = data.envelope_id
    `;
  }

  /**
   * Inline reclaim for envelopes whose dispatch threw. Resets drained_at to
   * NULL so the next poll can re-claim. Called after phase 2 for the subset
   * of envelopes that failed synchronously.
   */
  private async reclaimStranded(ids: string[]): Promise<void> {
    await this.db.$executeRaw`
      UPDATE broadcast_trace_outbox
         SET drained_at = NULL
       WHERE envelope_id = ANY(${ids}::uuid[])
         AND destinations_resolved_count IS NULL
    `;
  }

  /**
   * Phase 2 per-envelope work: parse, resolve, dispatch. Runs OUTSIDE any
   * transaction — destination I/O must never hold a DB lock.
   *
   * Per-destination errors are absorbed by the executor (it never throws),
   * so this function only throws on catastrophic issues (bad JSON, resolver
   * DB error). Those bubble up and trigger stranded-reclaim.
   */
  private async processEnvelope(
    row: ClaimedOutboxRow,
  ): Promise<EnvelopeOutcome> {
    const envelope = this.parseRow(row);
    const occurredAt = new Date(envelope.occurredAt);
    const destinations = await this.resolver.resolveForEnvelope(envelope, this.db);

    if (destinations.length === 0) {
      return {
        envelopeId: envelope.envelopeId,
        destinationsResolved: 0,
        deliveriesAttempted: 0,
        deliveriesSucceeded: 0,
        occurredAt,
      };
    }

    // Dispatch concurrently via the global Prisma client (no tx). Delivery
    // writes are now non-transactional by design — duplicate delivery
    // rows on retry are prevented by the executor's ON CONFLICT upsert on
    // (envelope_id, destination_id, attempt_number). See the header
    // "Why the refactor" block for the at-least-once trade-off.
    const results = await Promise.allSettled(
      destinations.map((d) => this.executor.deliverOne(envelope, d)),
    );

    let attempted = 0;
    let succeeded = 0;
    let breakerOpen: KekUnwrapBreakerOpenError | null = null;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        attempted += 1;
        if (r.value.status === 'success') succeeded += 1;
      } else if (r.reason instanceof KekUnwrapBreakerOpenError) {
        // KEK breaker open (Fase 3.2): the executor rethrew instead of
        // persisting, because a KMS outage is not a delivery failure. We
        // propagate so the envelope gets reclaimed (drained_at → NULL) and
        // retried once the breaker closes. Remember one instance for the
        // rethrow; other destinations' breaker errors are redundant (they
        // all share the same provider).
        breakerOpen = r.reason;
      } else {
        // Per contract the executor shouldn't throw — surface this loudly.
        log.error(
          { envelopeId: envelope.envelopeId, err: String(r.reason) },
          'executor threw — contract violation',
        );
      }
    }
    if (breakerOpen) {
      log.warn(
        { envelopeId: envelope.envelopeId, retryAfterMs: breakerOpen.retryAfterMs },
        'KEK breaker open during fan-out — envelope will be reclaimed',
      );
      throw breakerOpen;
    }

    return {
      envelopeId: envelope.envelopeId,
      destinationsResolved: destinations.length,
      deliveriesAttempted: attempted,
      deliveriesSucceeded: succeeded,
      occurredAt,
    };
  }

  private parseRow(row: ClaimedOutboxRow): TraceEnvelope {
    // The JSONB column was written by a validated writer — a parse failure
    // here means either schema drift or a manual DB edit. Either way, log
    // and rethrow so the envelope is reclaimed for retry. Persistent parse
    // failures would loop until human intervention (no poison counter yet).
    try {
      return parseTraceEnvelope(row.envelope);
    } catch (e) {
      const err = e as Error;
      log.error(
        { envelopeId: row.envelope_id, err: err.message },
        'stored envelope failed schema parse — will be reclaimed',
      );
      throw err;
    }
  }
}

// Satisfy tsc for the unused `Prisma` import in type positions.
export type { Prisma };
