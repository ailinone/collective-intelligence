// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for BroadcastDeliveryExecutor.
 *
 * Focus (5-stage pipeline):
 *   1. Sampling — sampled-out destinations are recorded as `sampled_out`
 *      and the adapter is never called
 *   2. Config decryption — cipher failure → dlq + `config_decrypt_failed`
 *   3. Privacy redaction — adapter receives a REDACTED envelope, not the raw one
 *   4. Adapter dispatch — missing adapter → dlq + `no_adapter`; successful
 *      send records `sent` + `sentAt`; retryable → `failed` (unless maxAttempts);
 *      thrown adapter error is caught and classified retryable
 *   5. Outcome recording — attemptCount increments across calls; `dlq` after
 *      `maxAttempts` retryable failures
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  BroadcastDeliveryExecutor,
  type DeliveryPrismaRunner,
} from '../delivery-executor';
import type { ResolvedDestination } from '../destination-resolver';
import type { TraceEnvelope } from '@/broadcast/domain/trace-envelope';
import { TRACE_ENVELOPE_SCHEMA_VERSION } from '@/broadcast/domain/trace-envelope';
import type {
  DeliveryOutcome,
  DestinationAdapter,
  DestinationAdapterRegistry,
  DestinationType,
} from '@/broadcast/infrastructure/destinations/destination-adapter';
import type { DestinationConfigCipher } from '@/broadcast/infrastructure/encryption';

// ─── Mock Prisma surface ────────────────────────────────────────────────

interface DeliveryRow {
  envelopeId: string;
  destinationId: string;
  status: string;
  attempts: number;
  lastErrorClass: string | null;
  lastError: string | null;
  firstAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  sentAt: Date | null;
}

interface DlqRow {
  id: string;
  envelopeId: string;
  destinationId: string;
  envelopeSnapshot: unknown;
  errorClass: string;
  errorMessage: string;
  errorContext: unknown;
  totalAttempts: number;
  firstAttemptedAt: Date;
  deadLetteredAt: Date;
}

function makeMockDb(): DeliveryPrismaRunner & {
  rows: Map<string, DeliveryRow>;
  dlq: DlqRow[];
} {
  const rows = new Map<string, DeliveryRow>();
  const dlq: DlqRow[] = [];
  const key = (envelopeId: string, destinationId: string) =>
    `${envelopeId}|${destinationId}`;

  const surface: DeliveryPrismaRunner['broadcastDelivery'] = {
    upsert: async (args: {
      where: { envelopeId_destinationId: { envelopeId: string; destinationId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const { envelopeId, destinationId } = args.where.envelopeId_destinationId;
      const k = key(envelopeId, destinationId);
      const existing = rows.get(k);
      if (!existing) {
        const row: DeliveryRow = {
          envelopeId,
          destinationId,
          status: String(args.create.status ?? 'pending'),
          attempts: Number(args.create.attempts ?? 0),
          lastErrorClass: (args.create.lastErrorClass as string | null) ?? null,
          lastError: (args.create.lastError as string | null) ?? null,
          firstAttemptAt: (args.create.firstAttemptAt as Date | null) ?? null,
          lastAttemptAt: (args.create.lastAttemptAt as Date | null) ?? null,
          sentAt: (args.create.sentAt as Date | null) ?? null,
        };
        rows.set(k, row);
        return row as unknown;
      }
      // Apply update — handle `{increment}` operator on attempts
      const upd = args.update;
      const attemptsOp = upd.attempts as { increment?: number } | number | undefined;
      const nextAttempts =
        typeof attemptsOp === 'object' && attemptsOp && 'increment' in attemptsOp
          ? existing.attempts + (attemptsOp.increment ?? 0)
          : typeof attemptsOp === 'number'
            ? attemptsOp
            : existing.attempts;
      const merged: DeliveryRow = {
        ...existing,
        status: String(upd.status ?? existing.status),
        attempts: nextAttempts,
        lastErrorClass:
          'lastErrorClass' in upd
            ? (upd.lastErrorClass as string | null)
            : existing.lastErrorClass,
        lastError:
          'lastError' in upd ? (upd.lastError as string | null) : existing.lastError,
        lastAttemptAt:
          'lastAttemptAt' in upd
            ? (upd.lastAttemptAt as Date | null)
            : existing.lastAttemptAt,
        sentAt: 'sentAt' in upd ? (upd.sentAt as Date | null) : existing.sentAt,
      };
      rows.set(k, merged);
      return merged as unknown;
    },
    findUnique: async (args: {
      where: { envelopeId_destinationId: { envelopeId: string; destinationId: string } };
      select?: Record<string, true>;
    }) => {
      const { envelopeId, destinationId } = args.where.envelopeId_destinationId;
      const row = rows.get(key(envelopeId, destinationId));
      if (!row) return null;
      // Honor Prisma-style select shape so the executor can ask for any
      // subset of columns. Missing select === whole row.
      const sel = args.select;
      if (!sel) return row as unknown;
      const out: Record<string, unknown> = {};
      for (const k2 of Object.keys(sel)) out[k2] = (row as unknown as Record<string, unknown>)[k2];
      return out as unknown;
    },
  } as unknown as DeliveryPrismaRunner['broadcastDelivery'];

  const dlqSurface: DeliveryPrismaRunner['broadcastDlqEntry'] = {
    create: async (args: { data: Record<string, unknown> }) => {
      const d = args.data;
      const row: DlqRow = {
        id: randomUUID(),
        envelopeId: String(d.envelopeId),
        destinationId: String(d.destinationId),
        envelopeSnapshot: d.envelopeSnapshot,
        errorClass: String(d.errorClass),
        errorMessage: String(d.errorMessage),
        errorContext: d.errorContext,
        totalAttempts: Number(d.totalAttempts),
        firstAttemptedAt: d.firstAttemptedAt as Date,
        deadLetteredAt: new Date(),
      };
      dlq.push(row);
      return row as unknown;
    },
  } as unknown as DeliveryPrismaRunner['broadcastDlqEntry'];

  return { rows, dlq, broadcastDelivery: surface, broadcastDlqEntry: dlqSurface };
}

// ─── Mock cipher ────────────────────────────────────────────────────────

function makeMockCipher(
  config: Record<string, unknown> = { url: 'https://example.com/hook' },
  opts: { fail?: boolean } = {},
): DestinationConfigCipher {
  return {
    encrypt: vi.fn(),
    decrypt: vi.fn(async () => {
      if (opts.fail) throw new Error('KEK unwrap failed');
      return config;
    }),
    invalidate: vi.fn(),
    rotateDek: vi.fn(),
  } as unknown as DestinationConfigCipher;
}

// ─── Mock adapter ───────────────────────────────────────────────────────

function makeMockAdapter(
  type: DestinationType,
  outcome: DeliveryOutcome | (() => Promise<DeliveryOutcome>),
  opts: { throws?: Error } = {},
): DestinationAdapter & { calls: Array<{ envelope: TraceEnvelope; config: Record<string, unknown> }> } {
  const calls: Array<{ envelope: TraceEnvelope; config: Record<string, unknown> }> = [];
  const adapter = {
    type,
    calls,
    send: async (ctx: { envelope: TraceEnvelope; config: Record<string, unknown> }) => {
      calls.push({ envelope: ctx.envelope, config: ctx.config });
      if (opts.throws) throw opts.throws;
      return typeof outcome === 'function' ? outcome() : outcome;
    },
  };
  return adapter as unknown as DestinationAdapter & typeof adapter;
}

// ─── Fixtures ───────────────────────────────────────────────────────────

function makeEnvelope(sessionId?: string, traceMessage = 'hello'): TraceEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: TRACE_ENVELOPE_SCHEMA_VERSION,
    envelopeId: randomUUID(),
    traceId: '0'.repeat(32),
    spanId: '0'.repeat(16),
    requestId: 'req-' + randomUUID(),
    occurredAt: now,
    tenant: {
      organizationId: randomUUID(),
      userId: randomUUID(),
      apiKeyId: null,
      resolutionScope: 'organization',
    },
    resource: { serviceName: 'ailin-ci-api', deploymentEnvironment: 'test' },
    generation: {
      model: { slug: 'gpt-5', provider: 'openai' },
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.01 },
      timing: { startedAt: now, endedAt: now, latencyMs: 100 },
      streaming: false,
    },
    routing: {
      selectedProvider: 'openai',
      reason: 'primary',
      candidatesConsidered: [],
      retryAttempts: 0,
    },
    content: {
      messages: [{ role: 'user', content: traceMessage }],
      choices: [],
      multimodalStripped: false,
    },
    custom: sessionId ? { sessionId } : {},
    status: { code: 'ok' },
  } as TraceEnvelope;
}

function makeDestination(overrides: Partial<ResolvedDestination> = {}): ResolvedDestination {
  return {
    id: randomUUID(),
    tenantType: 'organization',
    tenantId: randomUUID(),
    type: 'webhook',
    name: 'test-webhook',
    samplingRate: 1.0,
    privacyMode: false,
    releaseStatus: 'stable',
    configCiphertext: Buffer.alloc(0),
    configIv: Buffer.alloc(12),
    configAuthTag: Buffer.alloc(16),
    configAad: 'x',
    configDekWrapped: Buffer.alloc(0),
    configKekResource: 'local',
    ...overrides,
  };
}

function registry(
  webhook?: DestinationAdapter,
  langfuse?: DestinationAdapter,
  datadog?: DestinationAdapter,
  otlp?: DestinationAdapter,
): DestinationAdapterRegistry {
  return {
    webhook: webhook ?? makeMockAdapter('webhook', { kind: 'success', latencyMs: 10 }),
    langfuse: langfuse ?? makeMockAdapter('langfuse', { kind: 'success', latencyMs: 10 }),
    datadog: datadog ?? makeMockAdapter('datadog', { kind: 'success', latencyMs: 10 }),
    otlp_collector: otlp ?? makeMockAdapter('otlp_collector', { kind: 'success', latencyMs: 10 }),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('BroadcastDeliveryExecutor — sampling', () => {
  let db: ReturnType<typeof makeMockDb>;
  beforeEach(() => {
    db = makeMockDb();
  });

  it('records sampled_out and skips adapter when rate=0', async () => {
    const cipher = makeMockCipher();
    const adapters = registry();
    const executor = new BroadcastDeliveryExecutor({ cipher, adapters, db });

    const envelope = makeEnvelope('session-1');
    const dest = makeDestination({ samplingRate: 0 });

    const report = await executor.deliverOne(envelope, dest);

    expect(report.status).toBe('skipped');
    expect(report.samplingBucket).toBeDefined();
    expect(report.attemptNumber).toBe(0);
    const row = db.rows.get(`${envelope.envelopeId}|${dest.id}`);
    expect(row?.status).toBe('sampled_out');
    expect(row?.attempts).toBe(0);
    // Adapter must NOT be called
    const webhookCalls = (adapters.webhook as unknown as { calls: unknown[] }).calls;
    expect(webhookCalls).toHaveLength(0);
  });

  it('passes through to dispatch when sampled in (rate=1)', async () => {
    const cipher = makeMockCipher();
    const adapters = registry();
    const executor = new BroadcastDeliveryExecutor({ cipher, adapters, db });

    const envelope = makeEnvelope('session-1');
    const dest = makeDestination({ samplingRate: 1 });

    const report = await executor.deliverOne(envelope, dest);

    expect(report.status).toBe('success');
    expect(report.attemptNumber).toBe(1);
    expect(db.rows.get(`${envelope.envelopeId}|${dest.id}`)?.status).toBe('sent');
  });

  it('forceInclude marker bypasses sampling even when rate=0 (operator replay)', async () => {
    // Invariant: a DLQ replay with forceInclude=true MUST reach the adapter,
    // otherwise the operator's explicit retry silently vanishes. This test
    // pins the behaviour: rate=0 would normally sample-out, but the marker
    // short-circuits that decision.
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter('webhook', { kind: 'success', latencyMs: 5 });
    const adapters = registry(adapter);
    const executor = new BroadcastDeliveryExecutor({ cipher, adapters, db });

    const envelope = makeEnvelope('session-1');
    // Mutate custom to set the force-include marker (as the admin service does)
    (envelope.custom as Record<string, unknown>)['broadcast.force_include'] = true;
    const dest = makeDestination({ samplingRate: 0 });

    const report = await executor.deliverOne(envelope, dest);

    expect(report.status).toBe('success');
    expect(report.attemptNumber).toBe(1);
    expect(adapter.calls).toHaveLength(1);
    const row = db.rows.get(`${envelope.envelopeId}|${dest.id}`);
    expect(row?.status).toBe('sent');
  });
});

describe('BroadcastDeliveryExecutor — config decryption', () => {
  it('records dlq with config_decrypt_failed on cipher throw', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher({}, { fail: true });
    const adapters = registry();
    const executor = new BroadcastDeliveryExecutor({ cipher, adapters, db });

    const envelope = makeEnvelope('session-1');
    const dest = makeDestination();

    const report = await executor.deliverOne(envelope, dest);

    expect(report.status).toBe('permanent_failure');
    expect(report.errorClass).toBe('config_decrypt_failed');
    const row = db.rows.get(`${envelope.envelopeId}|${dest.id}`);
    expect(row?.status).toBe('dlq');
    expect(row?.lastErrorClass).toBe('config_decrypt_failed');
    // Adapter NOT called
    const calls = (adapters.webhook as unknown as { calls: unknown[] }).calls;
    expect(calls).toHaveLength(0);
  });
});

describe('BroadcastDeliveryExecutor — privacy redaction', () => {
  it('passes a redacted envelope to the adapter when privacyMode is true', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter('webhook', { kind: 'success', latencyMs: 5 });
    const adapters = registry(adapter);
    const executor = new BroadcastDeliveryExecutor({ cipher, adapters, db });

    const envelope = makeEnvelope('session-1', 'sensitive message body');
    const dest = makeDestination({ privacyMode: true });

    await executor.deliverOne(envelope, dest);

    expect(adapter.calls).toHaveLength(1);
    // With privacy mode on, message content must be redacted to the
    // REDACTED marker string — NOT the original.
    const passedMessage = adapter.calls[0]!.envelope.content.messages[0]!.content;
    expect(passedMessage).not.toBe('sensitive message body');
  });

  it('passes an unredacted-but-transformed envelope when privacyMode is false', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter('webhook', { kind: 'success', latencyMs: 5 });
    const adapters = registry(adapter);
    const executor = new BroadcastDeliveryExecutor({ cipher, adapters, db });

    const envelope = makeEnvelope('session-1', 'business message');
    const dest = makeDestination({ privacyMode: false });

    await executor.deliverOne(envelope, dest);

    expect(adapter.calls).toHaveLength(1);
    // With privacy off, the business-class content passes through.
    expect(adapter.calls[0]!.envelope.content.messages[0]!.content).toBe('business message');
  });
});

describe('BroadcastDeliveryExecutor — adapter dispatch', () => {
  it('records dlq + no_adapter when destination.type has no registered adapter', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    // Registry intentionally missing 'datadog' by using a broken map
    const brokenRegistry = {
      webhook: makeMockAdapter('webhook', { kind: 'success', latencyMs: 1 }),
    } as unknown as DestinationAdapterRegistry;
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: brokenRegistry,
      db,
    });
    const envelope = makeEnvelope('s');
    const dest = makeDestination({ type: 'datadog' });

    const report = await executor.deliverOne(envelope, dest);

    expect(report.status).toBe('permanent_failure');
    expect(report.errorClass).toBe('no_adapter');
    expect(db.rows.get(`${envelope.envelopeId}|${dest.id}`)?.status).toBe('dlq');
  });

  it('classifies a thrown adapter error as retryable (adapter_threw)', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter(
      'webhook',
      { kind: 'success', latencyMs: 0 },
      { throws: new Error('boom') },
    );
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: registry(adapter),
      db,
      maxAttempts: 5,
    });
    const envelope = makeEnvelope('s');
    const dest = makeDestination();

    const report = await executor.deliverOne(envelope, dest);

    expect(report.status).toBe('pending_retry');
    expect(report.errorClass).toBe('adapter_threw');
    expect(db.rows.get(`${envelope.envelopeId}|${dest.id}`)?.status).toBe('failed');
  });

  it('records sent + sentAt on success', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter('webhook', {
      kind: 'success',
      statusCode: 200,
      latencyMs: 42,
    });
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: registry(adapter),
      db,
    });
    const envelope = makeEnvelope('s');
    const dest = makeDestination();

    const report = await executor.deliverOne(envelope, dest);

    expect(report.status).toBe('success');
    const row = db.rows.get(`${envelope.envelopeId}|${dest.id}`);
    expect(row?.status).toBe('sent');
    expect(row?.sentAt).toBeInstanceOf(Date);
    expect(row?.attempts).toBe(1);
  });
});

describe('BroadcastDeliveryExecutor — retry lifecycle', () => {
  it('increments attempts across repeated failures and escalates to dlq at maxAttempts', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter('webhook', {
      kind: 'retryable',
      errorClass: 'network_error',
      errorMessage: 'ECONNRESET',
      latencyMs: 5,
    });
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: registry(adapter),
      db,
      maxAttempts: 3,
    });
    const envelope = makeEnvelope('s');
    const dest = makeDestination();

    const r1 = await executor.deliverOne(envelope, dest);
    expect(r1.status).toBe('pending_retry');
    expect(r1.attemptNumber).toBe(1);
    expect(db.rows.get(`${envelope.envelopeId}|${dest.id}`)?.status).toBe('failed');

    const r2 = await executor.deliverOne(envelope, dest);
    expect(r2.status).toBe('pending_retry');
    expect(r2.attemptNumber).toBe(2);
    expect(db.rows.get(`${envelope.envelopeId}|${dest.id}`)?.status).toBe('failed');

    const r3 = await executor.deliverOne(envelope, dest);
    expect(r3.status).toBe('permanent_failure');
    expect(r3.attemptNumber).toBe(3);
    // At maxAttempts the DB row escalates to dlq.
    expect(db.rows.get(`${envelope.envelopeId}|${dest.id}`)?.status).toBe('dlq');
  });

  it('adapter returning permanent immediately maps to dlq', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter('webhook', {
      kind: 'permanent',
      errorClass: 'auth_failed',
      errorMessage: '401 Unauthorized',
      latencyMs: 3,
    });
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: registry(adapter),
      db,
      maxAttempts: 5,
    });
    const envelope = makeEnvelope('s');
    const dest = makeDestination();

    const report = await executor.deliverOne(envelope, dest);

    expect(report.status).toBe('permanent_failure');
    expect(report.errorClass).toBe('auth_failed');
    expect(db.rows.get(`${envelope.envelopeId}|${dest.id}`)?.status).toBe('dlq');
  });
});

describe('BroadcastDeliveryExecutor — timeout propagation', () => {
  it('aborts when the configured timeout elapses', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    // Adapter that resolves only when aborted
    const slowAdapter: DestinationAdapter = {
      type: 'webhook',
      send: (ctx) =>
        new Promise<DeliveryOutcome>((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            resolve({
              kind: 'retryable',
              errorClass: 'timeout',
              errorMessage: 'aborted',
              latencyMs: 50,
            });
          });
        }),
    };
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: registry(slowAdapter),
      db,
      timeoutMs: 20,
      maxAttempts: 5,
    });
    const envelope = makeEnvelope('s');
    const dest = makeDestination();

    const report = await executor.deliverOne(envelope, dest);

    expect(report.status).toBe('pending_retry');
    expect(report.errorClass).toBe('timeout');
  });
});

describe('BroadcastDeliveryExecutor — DLQ admission (ADR-019)', () => {
  it('inserts a broadcast_dlq row with envelope snapshot on permanent outcome', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter('webhook', {
      kind: 'permanent',
      errorClass: 'auth_failed',
      errorMessage: '401 Unauthorized',
      statusCode: 401,
      latencyMs: 3,
    });
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: registry(adapter),
      db,
      maxAttempts: 5,
    });
    const envelope = makeEnvelope('s');
    const dest = makeDestination();

    await executor.deliverOne(envelope, dest);

    expect(db.dlq).toHaveLength(1);
    const entry = db.dlq[0]!;
    expect(entry.envelopeId).toBe(envelope.envelopeId);
    expect(entry.destinationId).toBe(dest.id);
    expect(entry.errorClass).toBe('auth_failed');
    expect(entry.totalAttempts).toBe(1);
    // envelopeSnapshot is the REDACTED envelope (same bytes that went to the
    // adapter). It must carry the envelope identity but NOT the raw PII.
    expect((entry.envelopeSnapshot as TraceEnvelope).envelopeId).toBe(envelope.envelopeId);
  });

  it('DLQ snapshot is redacted (privacy-by-default on failure path) — GDPR Art. 25', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter('webhook', {
      kind: 'permanent',
      errorClass: 'auth_failed',
      errorMessage: '401',
      latencyMs: 1,
    });
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: registry(adapter),
      db,
      maxAttempts: 5,
    });
    // Sensitive content flows through an envelope destined for a
    // privacyMode=true destination. Post-dispatch DLQ must contain the
    // redacted version, NOT the raw "super secret prompt".
    const envelope = makeEnvelope('sid', 'super secret prompt');
    const dest = makeDestination({ privacyMode: true });

    await executor.deliverOne(envelope, dest);

    expect(db.dlq).toHaveLength(1);
    const snapshot = db.dlq[0]!.envelopeSnapshot as TraceEnvelope;
    const snapshotMsg = snapshot.content.messages[0]!.content as string;
    expect(snapshotMsg).not.toBe('super secret prompt');
    // Marker attribute proves redaction ran.
    expect(
      (snapshot.custom as Record<string, unknown>)['broadcast.privacy_mode_applied'],
    ).toBe(true);
  });

  it('pre-dispatch DLQ (config_decrypt_failed) snapshot is SOTA-redacted', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher({}, { fail: true });
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: registry(),
      db,
    });
    const envelope = makeEnvelope('sid', 'leaky secret payload');
    const dest = makeDestination({ privacyMode: false });

    await executor.deliverOne(envelope, dest);

    expect(db.dlq).toHaveLength(1);
    const snapshot = db.dlq[0]!.envelopeSnapshot as TraceEnvelope;
    // Even when the destination's privacyMode is OFF, a pre-dispatch failure
    // must fall back to SOTA-strict redaction (we couldn't build the
    // destination-specific policy), so the raw payload must NOT appear.
    const snapshotMsg = snapshot.content.messages[0]!.content as string;
    expect(snapshotMsg).not.toBe('leaky secret payload');
    expect(
      (snapshot.custom as Record<string, unknown>)['broadcast.privacy_mode_applied'],
    ).toBe(true);
  });

  it('inserts a broadcast_dlq row only at maxAttempts, not on each retryable failure', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter('webhook', {
      kind: 'retryable',
      errorClass: 'network_error',
      errorMessage: 'ECONNRESET',
      latencyMs: 5,
    });
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: registry(adapter),
      db,
      maxAttempts: 3,
    });
    const envelope = makeEnvelope('s');
    const dest = makeDestination();

    await executor.deliverOne(envelope, dest);
    expect(db.dlq).toHaveLength(0); // retry #1, not yet dlq
    await executor.deliverOne(envelope, dest);
    expect(db.dlq).toHaveLength(0); // retry #2, not yet dlq
    await executor.deliverOne(envelope, dest);
    expect(db.dlq).toHaveLength(1); // retry #3 == maxAttempts → dlq
    expect(db.dlq[0]!.totalAttempts).toBe(3);
  });

  it('does not duplicate the DLQ row if deliverOne is somehow invoked again after dlq', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const adapter = makeMockAdapter('webhook', {
      kind: 'permanent',
      errorClass: 'auth_failed',
      errorMessage: '401',
      latencyMs: 1,
    });
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: registry(adapter),
      db,
      maxAttempts: 5,
    });
    const envelope = makeEnvelope('s');
    const dest = makeDestination();

    await executor.deliverOne(envelope, dest);
    await executor.deliverOne(envelope, dest);
    await executor.deliverOne(envelope, dest);
    expect(db.dlq).toHaveLength(1);
  });

  it('admits to DLQ on config_decrypt_failed (pre-dispatch permanent)', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher({}, { fail: true });
    const adapters = registry();
    const executor = new BroadcastDeliveryExecutor({ cipher, adapters, db });

    const envelope = makeEnvelope('s');
    const dest = makeDestination();

    await executor.deliverOne(envelope, dest);

    expect(db.dlq).toHaveLength(1);
    expect(db.dlq[0]!.errorClass).toBe('config_decrypt_failed');
    expect((db.dlq[0]!.errorContext as { stage?: string }).stage).toBe('pre_dispatch');
  });

  it('admits to DLQ on no_adapter (pre-dispatch permanent)', async () => {
    const db = makeMockDb();
    const cipher = makeMockCipher();
    const brokenRegistry = {
      webhook: makeMockAdapter('webhook', { kind: 'success', latencyMs: 1 }),
    } as unknown as DestinationAdapterRegistry;
    const executor = new BroadcastDeliveryExecutor({
      cipher,
      adapters: brokenRegistry,
      db,
    });
    const envelope = makeEnvelope('s');
    const dest = makeDestination({ type: 'datadog' });

    await executor.deliverOne(envelope, dest);

    expect(db.dlq).toHaveLength(1);
    expect(db.dlq[0]!.errorClass).toBe('no_adapter');
  });
});
