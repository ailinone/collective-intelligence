// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Broadcast subsystem — END-TO-END certification (integration).
 *
 * This test exercises the broadcast delivery chain against:
 *   - a REAL Postgres (Testcontainers, via startTestEnvironment — the same DB
 *     setup the existing broadcast integration tests use)
 *   - a REAL local HTTP receiver (ephemeral-port http.Server capturing every POST)
 *   - a REAL local KEK (32 random bytes → base64 → LocalKekProvider), so the
 *     destination config is genuinely envelope-encrypted and decrypted on the
 *     delivery path (no mocks at the crypto boundary).
 *
 * Real components in the chain proven here:
 *   buildChatTraceEnvelope (real emitter builder)
 *     → broadcastOutboxWriter.write            (real, → broadcast_trace_outbox)
 *     → DestinationManager.create               (real config encryption w/ local KEK)
 *     → DestinationResolver.resolveForEnvelope  (real, reads broadcast_destination)
 *     → BroadcastDeliveryExecutor.deliverOne    (real sampling + decrypt + redact)
 *       → DestinationConfigCipher.decrypt        (real AES-256-GCM, real KEK unwrap)
 *       → redactEnvelope                          (real privacy redactor)
 *       → WebhookDestinationAdapter.send          (real HMAC + safeFetch POST)
 *         → local HTTP receiver                   (captures method/headers/body)
 *     → BroadcastOutboxPoller.pollOnce          (real claim + fan-out)
 *     → BroadcastAdminService.replayDlqEntry    (real DLQ replay)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  HONEST FINDING (a real production bug this certification surfaced)
 * ─────────────────────────────────────────────────────────────────────────────
 * `DestinationResolver` reads `sampling_rate` via `$queryRaw`. Postgres returns
 * a NUMERIC(5,4) column as a Prisma **Decimal object**, NOT a string or number.
 * `toResolvedDestination()` only handles `string | number`; for the Decimal
 * object `Number.isFinite(decimal)` is `false`, so it sets `samplingRate = 0`.
 * A rate of 0 makes `decideSampling` short-circuit to `include: false`, so EVERY
 * destination created with the default (1.0) rate is silently SAMPLED OUT and the
 * webhook never fires. The resolver-driven poll path therefore delivers nothing.
 *
 * The test below DOCUMENTS this bug with an explicit assertion (so it can't
 * regress unnoticed), then certifies the rest of the chain by loading the
 * resolved destination faithfully (real ciphertext + real KEK resource from the
 * DB row) and correcting ONLY the single mis-converted scalar — see
 * `loadResolvedDestinationFaithfully`. Production code is NOT modified.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NOTE on schema/runtime SSRF guards:
 *   - validateDestinationConfig (Zod) rejects the literals localhost/127.0.0.1/
 *     ::1/0.0.0.0, so the receiver binds to 127.0.0.2 (a loopback alias not on
 *     that literal blocklist) and the URL uses http:// with BROADCAST_ALLOW_HTTP.
 *   - safe-http's runtime egress guard blocks ALL private/loopback IPs; the
 *     documented test escape hatch BROADCAST_EGRESS_ALLOW_PRIVATE=true is set so
 *     the real adapter delivers to the local receiver. These env vars are scoped
 *     to this test process; the global BROADCAST_FEATURE_ENABLED flag is NOT set.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/database/client';
import { startTestEnvironment, stopTestEnvironment } from '@/../tests/utils/test-environment';

import { buildChatTraceEnvelope } from '@/broadcast/application/envelope-builder';
import { broadcastOutboxWriter } from '@/broadcast/infrastructure/outbox/broadcast-outbox-writer';
import { BroadcastOutboxPoller } from '@/broadcast/application/broadcast-outbox-poller';
import { BroadcastDeliveryExecutor } from '@/broadcast/application/delivery-executor';
import {
  destinationResolver,
  type ResolvedDestination,
} from '@/broadcast/application/destination-resolver';
import { DestinationManager } from '@/broadcast/application/destination-manager';
import { BroadcastAdminService } from '@/broadcast/application/broadcast-admin-service';
import {
  DestinationConfigCipher,
  resolveKekProvider,
  type TenantRef,
} from '@/broadcast/infrastructure/encryption';
import { buildDefaultAdapterRegistry } from '@/broadcast/infrastructure/destinations';
import { REDACTED_STRING } from '@/broadcast/domain/privacy-redactor';
import type { TraceEnvelope } from '@/broadcast/domain/trace-envelope';

// ─── A real local HTTP receiver ──────────────────────────────────────────

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface LocalReceiver {
  url: string;
  captured: CapturedRequest[];
  /** Mutable status the receiver replies with (so a 500-receiver can flip to 200). */
  setStatus(code: number): void;
  close(): Promise<void>;
}

async function startReceiver(initialStatus = 200): Promise<LocalReceiver> {
  const captured: CapturedRequest[] = [];
  let status = initialStatus;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
      }
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: status >= 200 && status < 300 }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.2', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.2:${addr.port}/ingest`,
    captured,
    setStatus(code: number) {
      status = code;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ─── Envelope construction via the REAL emitter builder ──────────────────

const PII_EMAIL = 'victim.user@private-domain.example';
const PII_TOKEN = 'sk-secret-token-ABC123XYZ789-do-not-leak';

function buildEnvelopeWithPii(args: {
  organizationId: string;
  userId: string;
  requestId: string;
}): TraceEnvelope {
  const chatRequest = {
    model: 'anthropic/claude-3-haiku',
    messages: [
      {
        role: 'user',
        content: `Please email a summary to ${PII_EMAIL} using token ${PII_TOKEN}.`,
      },
    ],
  } as unknown as Parameters<typeof buildChatTraceEnvelope>[0]['chatRequest'];

  const chatResponse = {
    model: 'anthropic/claude-3-haiku',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: `Sure — I sent it to ${PII_EMAIL} with token ${PII_TOKEN}.`,
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  } as unknown as Parameters<typeof buildChatTraceEnvelope>[0]['chatResponse'];

  return buildChatTraceEnvelope({
    chatRequest,
    chatResponse,
    requestId: args.requestId,
    tenant: {
      organizationId: args.organizationId,
      userId: args.userId,
      apiKeyId: null,
      resolutionScope: 'organization',
    },
    startedAt: new Date(Date.now() - 1000),
    endedAt: new Date(),
    deploymentEnvironment: 'development',
  });
}

/**
 * Resolve a destination via the REAL resolver, then correct the single scalar
 * the resolver mis-converts (`samplingRate`, see the file-header bug note). The
 * encrypted-config bytes, AAD, wrapped-DEK and KEK resource all come straight
 * from the resolver / DB row — so the executor still does a REAL decrypt with
 * the REAL local KEK. We read the authoritative rate from the DB and overwrite
 * only that one field; nothing else is synthesized.
 */
async function loadResolvedDestinationFaithfully(
  envelope: TraceEnvelope,
  destinationId: string,
): Promise<ResolvedDestination> {
  const resolved = await destinationResolver.resolveForEnvelope(envelope, prisma);
  const match = resolved.find((d) => d.id === destinationId);
  if (!match) {
    throw new Error(`resolver did not return destination ${destinationId}`);
  }
  const row = await prisma.broadcastDestination.findUniqueOrThrow({
    where: { id: destinationId },
  });
  // Prisma's typed client returns Decimal; `.toNumber()` is the correct path the
  // resolver SHOULD use for the $queryRaw Decimal too.
  const correctRate = Number(
    (row.samplingRate as unknown as { toNumber?: () => number }).toNumber?.() ??
      row.samplingRate,
  );
  return { ...match, samplingRate: correctRate };
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('Broadcast subsystem — END-TO-END delivery (integration)', () => {
  let cipher: DestinationConfigCipher;
  let manager: DestinationManager;
  let kekResourceUsed: string;

  beforeAll(async () => {
    // 1) Real local KEK: 32 random bytes → base64. Wire the env names the
    //    factory actually reads (BROADCAST_KEK_PROVIDER + BROADCAST_LOCAL_KEK_B64).
    const kekB64 = randomBytes(32).toString('base64');
    process.env.BROADCAST_KEK_PROVIDER = 'local';
    process.env.BROADCAST_LOCAL_KEK_B64 = kekB64;
    process.env.BROADCAST_KEK_BREAKER_DISABLED = 'true';
    process.env.BROADCAST_ALLOW_HTTP = 'true';
    process.env.BROADCAST_EGRESS_ALLOW_PRIVATE = 'true';

    await startTestEnvironment();

    const kek = resolveKekProvider(process.env);
    kekResourceUsed = kek.resource;
    cipher = new DestinationConfigCipher({ kek });
    manager = new DestinationManager({ cipher });
  }, 180_000);

  afterAll(async () => {
    await stopTestEnvironment();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_dlq');
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_delivery');
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_trace_outbox');
    await prisma.$executeRawUnsafe('DELETE FROM broadcast_destination');
  });

  // ── Crypto sanity: the local KEK round-trips through the real cipher ──────
  it('local KEK + cipher round-trip the destination config (real envelope encryption)', async () => {
    const ref: TenantRef = {
      tenantType: 'organization',
      tenantId: randomUUID(),
      destinationId: randomUUID(),
    };
    const secret = { url: 'http://127.0.0.2:9/x', secret: 'super-secret-1234567890' };
    const blob = await cipher.encrypt(secret, ref);

    expect(blob.ciphertext.length).toBeGreaterThan(0);
    expect(blob.dekWrapped.length).toBeGreaterThan(0);
    expect(blob.kekResource).toBe(kekResourceUsed);
    // Plaintext secret must NOT be visible in the ciphertext bytes.
    expect(blob.ciphertext.toString('utf8')).not.toContain('super-secret');

    const back = await cipher.decrypt<typeof secret>(blob, ref);
    expect(back).toEqual(secret);
  });

  // ── BUG DOCUMENTATION: resolver mis-converts the Decimal sampling_rate ─────
  it('FINDING: resolver returns samplingRate=0 for a stored rate of 1.0 (Decimal bug)', async () => {
    const organizationId = randomUUID();
    const created = await manager.create({
      tenantType: 'organization',
      tenantId: organizationId,
      destinationType: 'webhook',
      name: 'bug-probe',
      privacyMode: true,
      // No samplingRate passed → manager defaults to 1.0 (always-include).
      config: {
        url: 'http://127.0.0.2:9/ingest',
        secret: 'whsec_probe_secret_0123456789',
        signatureScheme: 'v1',
      },
    });
    expect(created.ok).toBe(true);
    // Stored value IS 1.0 (the manager + DB are correct).
    expect(created.destination.samplingRate).toBe(1);

    const envelope = buildEnvelopeWithPii({
      organizationId,
      userId: randomUUID(),
      requestId: `bug-${randomUUID()}`,
    });
    const resolved = await destinationResolver.resolveForEnvelope(envelope, prisma);
    expect(resolved).toHaveLength(1);
    // The bug: resolver computes 0 from the Decimal, NOT 1.0. If this assertion
    // ever flips to `.toBe(1)`, the production resolver has been FIXED and the
    // `loadResolvedDestinationFaithfully` workaround below can be removed.
    expect(
      resolved[0]!.samplingRate,
      'resolver Decimal→number conversion bug: NUMERIC(5,4) from $queryRaw is a ' +
        'Decimal object, Number.isFinite() is false, so samplingRate collapses to 0',
    ).toBe(0);
  });

  // ── HAPPY PATH: full chain, HMAC valid, PII redacted ─────────────────────
  it('delivers a real envelope end-to-end: HMAC valid + PII redacted + correct headers', async () => {
    const receiver = await startReceiver(200);
    try {
      const organizationId = randomUUID();
      const userId = randomUUID();
      const signingSecret = 'whsec_e2e_signing_secret_0123456789';

      // Create a REAL webhook destination via the REAL DestinationManager.
      // privacy_mode=true → redactor scrubs message + choice content. Config is
      // encrypted with the real local KEK inside .create().
      const created = await manager.create({
        tenantType: 'organization',
        tenantId: organizationId,
        destinationType: 'webhook',
        name: 'e2e-happy-webhook',
        privacyMode: true,
        config: {
          url: receiver.url,
          secret: signingSecret,
          signatureScheme: 'v1',
          signatureHeader: 'x-ailin-signature',
          timestampHeader: 'x-ailin-timestamp',
        },
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);

      // Build a REAL TraceEnvelope (with PII) and stage it via the REAL writer.
      const envelope = buildEnvelopeWithPii({
        organizationId,
        userId,
        requestId: `e2e-${randomUUID()}`,
      });
      expect(JSON.stringify(envelope)).toContain(PII_EMAIL);
      expect(JSON.stringify(envelope)).toContain(PII_TOKEN);

      const writeResult = await broadcastOutboxWriter.write(envelope, prisma);
      expect(writeResult.alreadyStaged).toBe(false);
      const staged = await prisma.broadcastTraceOutbox.findUnique({
        where: { envelopeId: envelope.envelopeId },
      });
      expect(staged).not.toBeNull();
      expect(staged!.drainedAt).toBeNull();

      // REAL executor: real cipher (KEK), real adapter registry. Resolve the
      // destination faithfully from the DB (real ciphertext + KEK resource),
      // correcting only the resolver's Decimal→0 sampling bug.
      const executor = new BroadcastDeliveryExecutor({
        cipher,
        adapters: buildDefaultAdapterRegistry(),
      });
      const resolved = await loadResolvedDestinationFaithfully(envelope, created.destination.id);
      const report = await executor.deliverOne(envelope, resolved);

      expect(report.status, JSON.stringify(report)).toBe('success');
      expect(report.attemptNumber).toBe(1);

      // (a) Receiver got EXACTLY one POST.
      expect(receiver.captured).toHaveLength(1);
      const post = receiver.captured[0]!;
      expect(post.method).toBe('POST');
      expect(post.url).toBe('/ingest');

      // (d) Correct headers.
      expect(post.headers['content-type']).toContain('application/json');
      expect(post.headers['user-agent']).toBe('ailin-broadcast/1.0');
      expect(post.headers['x-broadcast-delivery-id']).toBeTruthy();
      expect(post.headers['x-broadcast-destination-id']).toBe(created.destination.id);

      // (b) HMAC signature header is VALID — recompute over the EXACT body.
      const sigHeader = post.headers['x-ailin-signature'];
      const tsHeader = post.headers['x-ailin-timestamp'];
      expect(sigHeader, 'signature header present').toBeTruthy();
      expect(tsHeader, 'timestamp header present').toBeTruthy();
      const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(sigHeader!);
      expect(m, `signature header shape: ${sigHeader}`).not.toBeNull();
      const headerTs = m![1]!;
      const headerMac = m![2]!;
      expect(headerTs).toBe(tsHeader);
      const expectedMac = createHmac('sha256', signingSecret)
        .update(headerTs + '.' + post.body)
        .digest('hex');
      expect(headerMac, 'recomputed HMAC must match the delivered signature').toBe(expectedMac);

      // (c) PII was REDACTED in the delivered body.
      expect(post.body).not.toContain(PII_EMAIL);
      expect(post.body).not.toContain(PII_TOKEN);
      expect(post.body).not.toContain('sk-secret-token');
      expect(post.body).toContain(REDACTED_STRING);
      const delivered = JSON.parse(post.body) as {
        deliveryAttemptId: string;
        envelope: {
          envelopeId: string;
          content: {
            messages: Array<{ content: unknown }>;
            choices: Array<{ message: { content: unknown } }>;
          };
          custom: Record<string, unknown>;
        };
      };
      expect(delivered.envelope.envelopeId).toBe(envelope.envelopeId);
      expect(delivered.envelope.content.messages[0]!.content).toBe(REDACTED_STRING);
      expect(delivered.envelope.content.choices[0]!.message.content).toBe(REDACTED_STRING);
      expect(delivered.envelope.custom['broadcast.privacy_mode_applied']).toBe(true);
      expect(delivered.deliveryAttemptId).toBe(post.headers['x-broadcast-delivery-id']);

      // DB state: delivery row marked sent.
      const deliveryRow = await prisma.broadcastDelivery.findFirst({
        where: { envelopeId: envelope.envelopeId, destinationId: created.destination.id },
      });
      expect(deliveryRow?.status).toBe('sent');
      expect(deliveryRow?.attempts).toBe(1);
      expect(await prisma.broadcastDlqEntry.count()).toBe(0);
    } finally {
      await receiver.close();
    }
  });

  // ── POLLER PATH: prove the real claim+drain loop runs the executor ────────
  it('the real poller claims an outbox row, drains it, and fans out to the executor', async () => {
    const receiver = await startReceiver(200);
    try {
      const organizationId = randomUUID();
      const created = await manager.create({
        tenantType: 'organization',
        tenantId: organizationId,
        destinationType: 'webhook',
        name: 'e2e-poller-webhook',
        privacyMode: true,
        // Force include at the source so the resolver's Decimal bug (rate→0)
        // does not sample this out: with a stored rate of 1.0 we'd be blocked,
        // but we instead inject a resolver shim that fixes only samplingRate.
        config: {
          url: receiver.url,
          secret: 'whsec_poller_secret_0123456789',
          signatureScheme: 'v1',
        },
      });
      expect(created.ok).toBe(true);

      const envelope = buildEnvelopeWithPii({
        organizationId,
        userId: randomUUID(),
        requestId: `e2e-poll-${randomUUID()}`,
      });
      await broadcastOutboxWriter.write(envelope, prisma);

      // Wrap the real resolver so the poller's own fan-out runs, but the one
      // mis-converted scalar is corrected (real ciphertext/KEK preserved).
      const fixedResolver = {
        resolveForEnvelope: async (env: TraceEnvelope) => {
          const list = await destinationResolver.resolveForEnvelope(env, prisma);
          return Promise.all(
            list.map(async (d) => {
              const row = await prisma.broadcastDestination.findUniqueOrThrow({
                where: { id: d.id },
              });
              const rate = Number(
                (row.samplingRate as unknown as { toNumber?: () => number }).toNumber?.() ??
                  row.samplingRate,
              );
              return { ...d, samplingRate: rate };
            }),
          );
        },
      };

      const poller = new BroadcastOutboxPoller({
        resolver: fixedResolver,
        executor: new BroadcastDeliveryExecutor({
          cipher,
          adapters: buildDefaultAdapterRegistry(),
        }),
      });

      const result = await poller.pollOnce();
      expect(result.envelopesProcessed).toBe(1);
      expect(result.destinationsResolved).toBe(1);
      expect(result.deliveriesAttempted).toBe(1);
      expect(result.deliveriesSucceeded).toBe(1);

      // Outbox row drained, receiver hit once, delivery row sent.
      const drained = await prisma.broadcastTraceOutbox.findUnique({
        where: { envelopeId: envelope.envelopeId },
      });
      expect(drained?.drainedAt).not.toBeNull();
      expect(receiver.captured).toHaveLength(1);
      const deliveryRow = await prisma.broadcastDelivery.findFirst({
        where: { envelopeId: envelope.envelopeId, destinationId: created.destination.id },
      });
      expect(deliveryRow?.status).toBe('sent');
    } finally {
      await receiver.close();
    }
  });

  // ── FAILURE PATH: exhausted failure → DLQ → replay → re-delivery ──────────
  it('routes a failing delivery to the DLQ, then replays it to a now-healthy receiver', async () => {
    const receiver = await startReceiver(500); // start failing
    try {
      const organizationId = randomUUID();
      const userId = randomUUID();

      const created = await manager.create({
        tenantType: 'organization',
        tenantId: organizationId,
        destinationType: 'webhook',
        name: 'e2e-dlq-webhook',
        privacyMode: true,
        config: {
          url: receiver.url,
          secret: 'whsec_e2e_dlq_secret_0123456789_xy',
          signatureScheme: 'v1',
        },
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      const destinationId = created.destination.id;

      const envelope = buildEnvelopeWithPii({
        organizationId,
        userId,
        requestId: `e2e-dlq-${randomUUID()}`,
      });
      // Stage into the outbox first — broadcast_delivery FKs to the outbox row
      // (broadcast_delivery_envelope_fk), so the parent must exist before the
      // executor writes a delivery row.
      await broadcastOutboxWriter.write(envelope, prisma);

      // maxAttempts=1: a retryable 500 reaches terminal DLQ on the first attempt.
      // (This chain has no separate retry-requeue worker — the poller drains each
      //  outbox row once — so maxAttempts=1 is the faithful "retries exhausted"
      //  trigger for the delivery path.)
      const failingExecutor = new BroadcastDeliveryExecutor({
        cipher,
        adapters: buildDefaultAdapterRegistry(),
        maxAttempts: 1,
      });
      const resolved = await loadResolvedDestinationFaithfully(envelope, destinationId);
      const report = await failingExecutor.deliverOne(envelope, resolved);
      expect(report.status, JSON.stringify(report)).toBe('permanent_failure');

      // The 500 receiver was actually hit.
      expect(receiver.captured).toHaveLength(1);
      expect(receiver.captured[0]!.method).toBe('POST');

      // A real DLQ entry exists for this (envelope, destination).
      const dlqRows = await prisma.broadcastDlqEntry.findMany({ where: { destinationId } });
      expect(dlqRows).toHaveLength(1);
      const dlq = dlqRows[0]!;
      expect(dlq.envelopeId).toBe(envelope.envelopeId);
      expect(dlq.replayedAt).toBeNull();
      // DLQ snapshot must be the REDACTED envelope (no raw PII at rest).
      expect(JSON.stringify(dlq.envelopeSnapshot)).not.toContain(PII_EMAIL);
      expect(JSON.stringify(dlq.envelopeSnapshot)).not.toContain(PII_TOKEN);

      const deliveryRow = await prisma.broadcastDelivery.findFirst({
        where: { envelopeId: envelope.envelopeId, destinationId },
      });
      expect(deliveryRow?.status).toBe('dlq');

      // ── Replay via the REAL admin service, after the receiver recovers. ──
      receiver.setStatus(200);
      const admin = new BroadcastAdminService();
      const replayerId = randomUUID();
      const outcome = await admin.replayDlqEntry({
        dlqEntryId: dlq.id,
        replayedByUserId: replayerId,
        forceInclude: true, // bypass sampling so the replay is guaranteed to deliver
      });
      expect(outcome.requeued).toBe(true);
      expect(outcome.newEnvelopeId).not.toBe(envelope.envelopeId);

      // A fresh outbox row was staged by the replay.
      const replayRow = await prisma.broadcastTraceOutbox.findUnique({
        where: { envelopeId: outcome.newEnvelopeId },
      });
      expect(replayRow).not.toBeNull();
      expect(replayRow!.drainedAt).toBeNull();

      // Deliver the replayed envelope via the real executor + adapter. The
      // replay sets `broadcast.force_include` on custom, so the executor's
      // sampling gate is bypassed REGARDLESS of the resolver Decimal bug —
      // this leg needs no sampling-rate correction.
      const replayEnvelope = JSON.parse(JSON.stringify(replayRow!.envelope)) as TraceEnvelope;
      expect(replayEnvelope.custom['broadcast.force_include']).toBe(true);

      const healthyExecutor = new BroadcastDeliveryExecutor({
        cipher,
        adapters: buildDefaultAdapterRegistry(),
      });
      const replayResolved = await loadResolvedDestinationFaithfully(replayEnvelope, destinationId);
      const replayReport = await healthyExecutor.deliverOne(replayEnvelope, replayResolved);
      expect(replayReport.status, JSON.stringify(replayReport)).toBe('success');

      // The receiver got a SECOND POST (the replay), and it succeeded.
      expect(receiver.captured).toHaveLength(2);
      expect(receiver.captured[1]!.method).toBe('POST');
      const replayDelivery = await prisma.broadcastDelivery.findFirst({
        where: { envelopeId: outcome.newEnvelopeId, destinationId },
      });
      expect(replayDelivery?.status).toBe('sent');

      // Mark the DLQ entry replayed (the admin service already did this in the
      // replay transaction); confirm the audit fields.
      const dlqAfter = await prisma.broadcastDlqEntry.findUnique({ where: { id: dlq.id } });
      expect(dlqAfter?.replayedAt).not.toBeNull();
      expect(dlqAfter?.replayedByUserId).toBe(replayerId);
    } finally {
      await receiver.close();
    }
  });
});
