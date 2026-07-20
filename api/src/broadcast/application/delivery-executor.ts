// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Delivery Executor — the per-destination pipeline for one envelope.
 *
 * Pipeline stages (in order):
 *   1. Sampling decision   (ADR-018) — skip destination if not sampled
 *   2. Config decryption   (ADR-017) — unwrap DEK via KEK, decrypt JSON
 *   3. Privacy redaction   (ADR-016) — apply destination's privacy policy
 *   4. Adapter dispatch    — hand redacted envelope to the adapter
 *   5. Outcome recording   — upsert into broadcast_delivery; enqueue DLQ on
 *                            permanent failure
 *
 * The executor is the trust boundary between the outbox + resolver layer and
 * the adapter layer. An adapter never sees raw envelopes or encrypted configs.
 *
 * ─── Delivery semantics: AT-LEAST-ONCE (ADR-014 §5) ────────────────────────
 *
 * This executor is **at-least-once**. An envelope may be delivered to an
 * external destination more than once. Two mechanisms make this OK:
 *
 *   1. **DB consistency via injected runner.** When the caller (poller)
 *      wraps dispatch in a transaction, it passes its `tx` client as the
 *      `runner` argument to `deliverOne`. All broadcast_delivery + DLQ
 *      writes then land in the same tx as the outbox `drained_at` update,
 *      so the claim-and-fan-out transaction is atomic at the DB level. If
 *      the tx rolls back, neither the delivery row NOR the drained marker
 *      commit — the envelope is re-claimed next tick.
 *
 *   2. **Downstream idempotency.** The external dispatch already happened
 *      before the tx commit, so a rollback → re-dispatch is physically
 *      observable by the destination. Adapters MUST include the delivery
 *      idempotency key (`x-broadcast-delivery-id` header + `envelope_id`
 *      in the payload) so the destination can dedupe. This is contract,
 *      not best-effort — see ADR-015 §3 "Idempotency on the wire".
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '@/database/client';
import type { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';

import {
  PRIVACY_POLICY_SOTA,
  buildDefaultPrivacyPolicy,
  redactEnvelope,
  type FieldMode,
} from '@/broadcast/domain/privacy-redactor';
import type { TraceEnvelope } from '@/broadcast/domain/trace-envelope';
import { decideSampling } from '@/broadcast/application/sampling-decision';
import type { ResolvedDestination } from '@/broadcast/application/destination-resolver';
import {
  DestinationConfigCipher,
  type TenantRef,
} from '@/broadcast/infrastructure/encryption';
import { KekUnwrapBreakerOpenError } from '@/broadcast/infrastructure/encryption/kek-circuit-breaker';
import type {
  DeliveryOutcome,
  DestinationAdapter,
  DestinationAdapterRegistry,
  DestinationType,
} from '@/broadcast/infrastructure/destinations/destination-adapter';
import { broadcastMetrics } from '@/broadcast/infrastructure/metrics/broadcast-metrics';
import { narrowAs } from '@/utils/type-guards';
import { normalizeErrorClass } from '@/broadcast/infrastructure/metrics/error-class-enum';

const log = logger.child({ component: 'broadcast-delivery-executor' });

// ─── Config ─────────────────────────────────────────────────────────────

export const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
export const DEFAULT_DELIVERY_MAX_ATTEMPTS = 5;

// ─── Types ──────────────────────────────────────────────────────────────

export type DeliveryStatus = 'success' | 'skipped' | 'pending_retry' | 'permanent_failure';

/**
 * DB-level status values from the broadcast_delivery CHECK constraint.
 * Keep in lock-step with the migration — the CHECK constraint will reject
 * anything else.
 */
type DbDeliveryStatus = 'pending' | 'sent' | 'failed' | 'dlq' | 'sampled_out';

export interface DeliveryReport {
  destinationId: string;
  status: DeliveryStatus;
  samplingBucket?: number;
  attemptNumber: number;
  outcome?: DeliveryOutcome;
  errorClass?: string;
}

/**
 * Prisma surface the executor touches. Narrowed so tests can supply a mock
 * surface without constructing a full PrismaClient.
 *
 * Why both `broadcastDelivery` AND `broadcastDlqEntry`: on permanent failure
 * we atomically update the delivery row AND admit to the DLQ so operators
 * can replay. Without the DLQ row, `status='dlq'` in `broadcast_delivery` is
 * a dead end — see ADR-019 (§ DLQ Contract).
 */
export type DeliveryPrismaRunner = Pick<
  Prisma.TransactionClient | typeof prisma,
  'broadcastDelivery' | 'broadcastDlqEntry'
>;

export interface DeliveryExecutorDeps {
  cipher: DestinationConfigCipher;
  adapters: DestinationAdapterRegistry;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Prisma client or transaction client. Defaults to the global `prisma`. */
  db?: DeliveryPrismaRunner;
}

// ─── Executor ───────────────────────────────────────────────────────────

export class BroadcastDeliveryExecutor {
  private readonly cipher: DestinationConfigCipher;
  private readonly adapters: DestinationAdapterRegistry;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly db: DeliveryPrismaRunner;

  constructor(deps: DeliveryExecutorDeps) {
    this.cipher = deps.cipher;
    this.adapters = deps.adapters;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_DELIVERY_MAX_ATTEMPTS;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    this.db = deps.db ?? prisma;
  }

  /**
   * Deliver one envelope to one destination. Always returns a DeliveryReport —
   * never throws. Failures are persisted to broadcast_delivery.
   *
   * @param runner Optional Prisma tx client. When provided, every DB write
   *   (broadcast_delivery + broadcast_dlq) lands in that transaction. The
   *   outbox poller passes its own `tx` here so the delivery rows commit
   *   atomically with the envelope's `drained_at` marker. Defaults to the
   *   executor's global `db`.
   */
  async deliverOne(
    envelope: TraceEnvelope,
    destination: ResolvedDestination,
    runner: DeliveryPrismaRunner = this.db,
  ): Promise<DeliveryReport> {
    // ── Stage 1: sampling ─────────────────────────────────────────────
    // Operator replay escape hatch: a DLQ replay sets `broadcast.force_include`
    // on the envelope so this delivery bypasses the sampling gate. Without
    // this, a replayed envelope could be silently sampled out and never reach
    // the destination — defeating the operator's explicit re-deliver action.
    const forceInclude =
      envelope.custom?.['broadcast.force_include'] === true;
    const sampling = forceInclude
      ? { include: true as const, bucket: 0 }
      : decideSampling({
          destinationId: destination.id,
          sessionId: envelope.custom?.sessionId as string | undefined,
          requestId: envelope.requestId,
          samplingRate: destination.samplingRate,
        });
    if (!sampling.include) {
      await this.recordSkipped(envelope, destination, sampling.bucket, runner);
      broadcastMetrics.sampling.inc({
        destination_type: destination.type,
        decision: 'sampled_out',
      });
      return {
        destinationId: destination.id,
        status: 'skipped',
        samplingBucket: sampling.bucket,
        attemptNumber: 0,
      };
    }
    broadcastMetrics.sampling.inc({
      destination_type: destination.type,
      decision: forceInclude ? 'force_included' : 'included',
    });

    // ── Stage 2: config decryption ─────────────────────────────────────
    const tenantRef: TenantRef = {
      tenantType: destination.tenantType,
      tenantId: destination.tenantId,
      destinationId: destination.id,
    };
    let config: Record<string, unknown>;
    try {
      config = await this.cipher.decrypt(
        {
          ciphertext: destination.configCiphertext,
          iv: destination.configIv,
          authTag: destination.configAuthTag,
          aad: destination.configAad,
          dekWrapped: destination.configDekWrapped,
          kekResource: destination.configKekResource,
        },
        tenantRef,
      );
    } catch (e) {
      const err = e as Error;
      // KEK breaker open = transient (Fase 3.2). We RETHROW so the poller
      // reclaims the envelope (drained_at → NULL) and retries once the
      // breaker closes. We do NOT persist a broadcast_delivery row or admit
      // to DLQ: a KMS outage is not an adapter failure, and absorbing it
      // silently would set destinations_resolved_count and prevent future
      // retries. See processEnvelope() in broadcast-outbox-poller.ts for
      // the complementary catch that turns this into a stranded reclaim.
      if (e instanceof KekUnwrapBreakerOpenError) {
        broadcastMetrics.deliveries.inc({
          destination_type: destination.type as DestinationType,
          outcome: 'retryable',
          error_class: 'kek_unavailable',
        });
        throw e;
      }
      log.error(
        { destinationId: destination.id, err: err.message },
        'Destination config decryption failed — skipping delivery',
      );
      await this.recordConfigFailure(
        envelope,
        destination,
        err.message,
        'config_decrypt_failed',
        runner,
      );
      return {
        destinationId: destination.id,
        status: 'permanent_failure',
        attemptNumber: 1,
        errorClass: 'config_decrypt_failed',
      };
    }

    // ── Stage 3: privacy redaction ─────────────────────────────────────
    const pseudonymizationKey = extractPseudonymizationKey(config);
    const policy = buildDefaultPrivacyPolicy({
      privacyMode: destination.privacyMode,
      pseudonymizationKey,
      customFieldOverrides: extractCustomFieldOverrides(config),
    });
    const redacted = redactEnvelope(envelope, policy);

    // ── Stage 4: adapter dispatch ──────────────────────────────────────
    const adapter = this.adapters[destination.type];
    if (!adapter) {
      const err = `no adapter registered for type "${destination.type}"`;
      log.error({ destinationId: destination.id }, err);
      await this.recordConfigFailure(envelope, destination, err, 'no_adapter', runner);
      return {
        destinationId: destination.id,
        status: 'permanent_failure',
        attemptNumber: 1,
        errorClass: 'no_adapter',
      };
    }

    const deliveryAttemptId = randomUUID();
    const outcome = await this.dispatch(adapter, {
      deliveryAttemptId,
      envelope: redacted,
      config,
      destinationId: destination.id,
      timeoutMs: this.timeoutMs,
    });

    // ── Stage 5: outcome recording ─────────────────────────────────────
    const attempt = await this.recordOutcome(envelope, redacted, destination, outcome, runner);
    const status: DeliveryStatus =
      outcome.kind === 'success'
        ? 'success'
        : outcome.kind === 'permanent' || attempt >= this.maxAttempts
          ? 'permanent_failure'
          : 'pending_retry';

    // Metrics — one counter per attempt + a histogram for latency.
    const destType = destination.type as DestinationType;
    broadcastMetrics.deliveries.inc({
      destination_type: destType,
      outcome: outcome.kind,
      error_class: normalizeErrorClass(outcome.errorClass),
    });
    broadcastMetrics.deliveryLatency.observe(
      { destination_type: destType, outcome: outcome.kind },
      outcome.latencyMs / 1000,
    );
    if (status !== 'pending_retry') {
      broadcastMetrics.deliveryAttempts.observe(
        { destination_type: destType, terminal_state: status === 'success' ? 'sent' : 'dlq' },
        attempt,
      );
    }
    if (status === 'permanent_failure') {
      broadcastMetrics.dlqAdmits.inc({
        destination_type: destType,
        error_class: normalizeErrorClass(outcome.errorClass ?? 'unknown'),
      });
    }

    return {
      destinationId: destination.id,
      status,
      attemptNumber: attempt,
      outcome,
      errorClass: outcome.errorClass,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async dispatch(
    adapter: DestinationAdapter,
    ctx: {
      deliveryAttemptId: string;
      envelope: TraceEnvelope;
      config: Record<string, unknown>;
      destinationId: string;
      timeoutMs: number;
    },
  ): Promise<DeliveryOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      return await adapter.send({ ...ctx, signal: controller.signal });
    } catch (e) {
      // An adapter throwing (should not happen per contract) is recorded as retryable.
      const err = e as Error;
      log.warn(
        { destinationId: ctx.destinationId, err: err.message },
        'Adapter threw — classifying as retryable',
      );
      return {
        kind: 'retryable',
        errorClass: 'adapter_threw',
        errorMessage: truncate(err.message, 512),
        latencyMs: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async recordSkipped(
    envelope: TraceEnvelope,
    destination: ResolvedDestination,
    _bucket: number,
    runner: DeliveryPrismaRunner = this.db,
  ): Promise<void> {
    const now = new Date();
    await runner.broadcastDelivery.upsert({
      where: {
        envelopeId_destinationId: {
          envelopeId: envelope.envelopeId,
          destinationId: destination.id,
        },
      },
      create: {
        envelopeId: envelope.envelopeId,
        destinationId: destination.id,
        status: 'sampled_out' satisfies DbDeliveryStatus,
        attempts: 0,
        firstAttemptAt: now,
        lastAttemptAt: now,
      },
      update: {
        status: 'sampled_out' satisfies DbDeliveryStatus,
        lastAttemptAt: now,
      },
    });
  }

  private async recordConfigFailure(
    envelope: TraceEnvelope,
    destination: ResolvedDestination,
    reason: string,
    errorClass: string,
    runner: DeliveryPrismaRunner = this.db,
  ): Promise<void> {
    const now = new Date();
    // Read prior state first so we can detect a first-time dlq transition and
    // avoid admitting the same (envelope,destination) to the DLQ twice.
    const existing = await runner.broadcastDelivery.findUnique({
      where: {
        envelopeId_destinationId: {
          envelopeId: envelope.envelopeId,
          destinationId: destination.id,
        },
      },
      select: { status: true, attempts: true, firstAttemptAt: true },
    });
    await runner.broadcastDelivery.upsert({
      where: {
        envelopeId_destinationId: {
          envelopeId: envelope.envelopeId,
          destinationId: destination.id,
        },
      },
      create: {
        envelopeId: envelope.envelopeId,
        destinationId: destination.id,
        status: 'dlq' satisfies DbDeliveryStatus,
        attempts: 1,
        lastErrorClass: truncate(errorClass, 32),
        lastError: truncate(reason, 1024),
        firstAttemptAt: now,
        lastAttemptAt: now,
      },
      update: {
        status: 'dlq' satisfies DbDeliveryStatus,
        attempts: { increment: 1 },
        lastErrorClass: truncate(errorClass, 32),
        lastError: truncate(reason, 1024),
        lastAttemptAt: now,
      },
    });
    if (existing?.status !== 'dlq') {
      const totalAttempts = (existing?.attempts ?? 0) + 1;
      // Pre-dispatch failure: destination policy isn't available (decrypt failed
      // or adapter missing), so fall back to SOTA-strict redaction. Fail-closed:
      // the DLQ snapshot must NEVER contain raw PII, even when we can't build
      // the destination's own policy. See ADR-016 §Failure semantics.
      const snapshot = redactEnvelope(envelope, PRIVACY_POLICY_SOTA);
      await this.admitToDlq(runner, {
        envelopeId: envelope.envelopeId,
        envelopeSnapshot: snapshot,
        destinationId: destination.id,
        errorClass,
        errorMessage: reason,
        totalAttempts,
        firstAttemptedAt: existing?.firstAttemptAt ?? now,
        errorContext: { stage: 'pre_dispatch' },
      });
    }
  }

  private async recordOutcome(
    envelope: TraceEnvelope,
    redactedEnvelope: TraceEnvelope,
    destination: ResolvedDestination,
    outcome: DeliveryOutcome,
    runner: DeliveryPrismaRunner = this.db,
  ): Promise<number> {
    const now = new Date();
    // Read current state: attempts drives the retry-budget decision, status
    // + firstAttemptAt drive the DLQ admission below.
    const existing = await runner.broadcastDelivery.findUnique({
      where: {
        envelopeId_destinationId: {
          envelopeId: envelope.envelopeId,
          destinationId: destination.id,
        },
      },
      select: { attempts: true, status: true, firstAttemptAt: true },
    });
    const nextAttempts = (existing?.attempts ?? 0) + 1;

    const dbStatus: DbDeliveryStatus =
      outcome.kind === 'success'
        ? 'sent'
        : outcome.kind === 'permanent' || nextAttempts >= this.maxAttempts
          ? 'dlq'
          : 'failed';

    await runner.broadcastDelivery.upsert({
      where: {
        envelopeId_destinationId: {
          envelopeId: envelope.envelopeId,
          destinationId: destination.id,
        },
      },
      create: {
        envelopeId: envelope.envelopeId,
        destinationId: destination.id,
        status: dbStatus,
        attempts: 1,
        lastErrorClass: outcome.errorClass ? truncate(outcome.errorClass, 32) : null,
        lastError: outcome.errorMessage ? truncate(outcome.errorMessage, 1024) : null,
        firstAttemptAt: now,
        lastAttemptAt: now,
        sentAt: outcome.kind === 'success' ? now : null,
      },
      update: {
        status: dbStatus,
        attempts: { increment: 1 },
        lastErrorClass: outcome.errorClass ? truncate(outcome.errorClass, 32) : null,
        lastError: outcome.errorMessage ? truncate(outcome.errorMessage, 1024) : null,
        lastAttemptAt: now,
        ...(outcome.kind === 'success' ? { sentAt: now } : {}),
      },
    });

    // DLQ admission: first time this (envelope,destination) crosses into
    // terminal `dlq` status, snapshot the envelope + error context so
    // operators can replay.
    //
    // Idempotency is enforced at TWO layers, on purpose:
    //   1. Application-level (this `if`): reads prior `status` and only admits
    //      on the first transition closed→dlq within the same tick.
    //   2. DB-level: partial unique index `broadcast_dlq_active_envelope_destination_unique`
    //      ON (envelope_id, destination_id) WHERE replayed_at IS NULL (see
    //      migration 20260420120000_broadcast_dlq_unique_active). This closes
    //      the race window between concurrent poll ticks / replay paths that
    //      the app-level check alone cannot cover.
    //   The index is PARTIAL so that a replayed entry (replayed_at IS NOT NULL)
    //   is excluded from the active set — a fresh permanent failure on the
    //   same (envelope,destination) after a replay CAN insert a new row,
    //   preserving replay history as an append-only audit trail.
    if (dbStatus === 'dlq' && existing?.status !== 'dlq') {
      // Privacy invariant: the snapshot we persist is the SAME redacted
      // envelope we already passed to the adapter. Persisting raw PII in
      // DLQ would violate GDPR Art. 25 data minimization (the whole point
      // of per-destination redaction is that the data-at-rest for this
      // destination must match the data-on-the-wire for it).
      await this.admitToDlq(runner, {
        envelopeId: envelope.envelopeId,
        envelopeSnapshot: redactedEnvelope,
        destinationId: destination.id,
        errorClass: outcome.errorClass ?? 'unknown',
        errorMessage: outcome.errorMessage ?? '',
        totalAttempts: nextAttempts,
        firstAttemptedAt: existing?.firstAttemptAt ?? now,
        errorContext: {
          outcomeKind: outcome.kind,
          statusCode: outcome.kind === 'success' ? undefined : outcome.statusCode,
          latencyMs: outcome.latencyMs,
        },
      });
    }
    return nextAttempts;
  }

  /**
   * Insert a row into broadcast_dlq snapshotting the envelope and error
   * context. Failures here are logged but never bubble up: the delivery
   * outcome has already been persisted, and a missing DLQ row is strictly
   * worse than not losing the envelope's retry trail — but it must not
   * cause us to redeliver.
   */
  private async admitToDlq(
    runner: DeliveryPrismaRunner,
    args: {
      envelopeId: string;
      /** Redacted envelope snapshot — MUST NOT contain raw PII. */
      envelopeSnapshot: TraceEnvelope;
      destinationId: string;
      errorClass: string;
      errorMessage: string;
      totalAttempts: number;
      firstAttemptedAt: Date;
      errorContext: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await runner.broadcastDlqEntry.create({
        data: {
          envelopeId: args.envelopeId,
          destinationId: args.destinationId,
          envelopeSnapshot: narrowAs<Prisma.InputJsonValue>(args.envelopeSnapshot),
          errorClass: truncate(args.errorClass, 32),
          errorMessage: truncate(args.errorMessage, 4096),
          errorContext: args.errorContext as Prisma.InputJsonValue,
          totalAttempts: args.totalAttempts,
          firstAttemptedAt: args.firstAttemptedAt,
        },
      });
    } catch (e) {
      const err = e as Error;
      log.error(
        {
          envelopeId: args.envelopeId,
          destinationId: args.destinationId,
          err: err.message,
        },
        'DLQ admission failed — delivery row is dlq but broadcast_dlq insert did not succeed',
      );
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Extract the per-destination pseudonymization key from decrypted config.
 * The key is stored as base64 string in `pseudonymizationKeyB64`.
 */
function extractPseudonymizationKey(config: Record<string, unknown>): Buffer | undefined {
  const raw = config.pseudonymizationKeyB64;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const buf = Buffer.from(raw, 'base64');
  return buf.length >= 16 ? buf : undefined;
}

function extractCustomFieldOverrides(
  config: Record<string, unknown>,
): Record<string, FieldMode> | undefined {
  const raw = config.customFieldOverrides;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, FieldMode> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === 'pass' || v === 'redact' || v === 'pseudonymize') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
