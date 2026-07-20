// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for BroadcastOutboxWriter.
 *
 * Focus:
 *   - envelope validation at the boundary (invalid → throw, no DB call)
 *   - size guard (OUTBOX_MAX_JSON_BYTES)
 *   - tenant field flattening (envelope.tenant.* → column values)
 *   - transaction client pass-through (caller's tx is used, not global)
 *
 * Uses a mock Prisma surface so tests run without a live DB.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  DefaultBroadcastOutboxWriter,
  OUTBOX_MAX_JSON_BYTES,
  OutboxEnvelopeTooLargeError,
  type OutboxPrismaRunner,
} from '../broadcast-outbox-writer';
import {
  TRACE_ENVELOPE_SCHEMA_VERSION,
  type TraceEnvelope,
} from '@/broadcast/domain/trace-envelope';
import { Prisma } from '@/generated/prisma/index.js';

// ─── Mock Prisma surface ────────────────────────────────────────────────

interface RecordedCall {
  data: Record<string, unknown>;
}

/**
 * In-memory mock that also simulates the `request_id` partial unique index.
 * A second `create` with the same non-null requestId throws the same
 * PrismaClientKnownRequestError shape Postgres would produce, so the writer's
 * idempotency branch is exercised without a live DB.
 */
function makeMockRunner(): OutboxPrismaRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const seenRequestIds = new Set<string>();
  return {
    calls,
    broadcastTraceOutbox: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const requestId = data.requestId as string | null | undefined;
        if (typeof requestId === 'string' && requestId.length > 0) {
          if (seenRequestIds.has(requestId)) {
            throw new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed on the fields: (`request_id`)',
              {
                code: 'P2002',
                clientVersion: 'test',
                meta: { target: ['request_id'] },
              },
            );
          }
          seenRequestIds.add(requestId);
        }
        calls.push({ data });
        return data;
      },
      // Only `create` is used; the rest of the model surface is unused
    } as unknown as OutboxPrismaRunner['broadcastTraceOutbox'],
  };
}

// ─── Envelope fixture ───────────────────────────────────────────────────

function makeEnvelope(overrides: Partial<TraceEnvelope> = {}): TraceEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: TRACE_ENVELOPE_SCHEMA_VERSION,
    envelopeId: randomUUID(),
    traceId: '0'.repeat(32),
    spanId: '0'.repeat(16),
    requestId: 'req-test',
    occurredAt: now,
    tenant: {
      organizationId: randomUUID(),
      userId: randomUUID(),
      apiKeyId: null,
      resolutionScope: 'organization',
    },
    resource: {
      serviceName: 'ailin-ci-api',
      deploymentEnvironment: 'production',
    },
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
      messages: [{ role: 'user', content: 'hi' }],
      choices: [],
      multimodalStripped: false,
    },
    custom: {},
    status: { code: 'ok' },
    ...overrides,
  } as TraceEnvelope;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('BroadcastOutboxWriter', () => {
  let writer: DefaultBroadcastOutboxWriter;

  beforeEach(() => {
    writer = new DefaultBroadcastOutboxWriter();
  });

  it('writes a valid envelope and returns its id + size', async () => {
    const runner = makeMockRunner();
    const envelope = makeEnvelope();

    const result = await writer.write(envelope, runner);

    expect(result.envelopeId).toBe(envelope.envelopeId);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.alreadyStaged).toBe(false);
    expect(runner.calls).toHaveLength(1);
  });

  it('flattens requestId into the dedup column', async () => {
    const runner = makeMockRunner();
    const envelope = makeEnvelope({ requestId: 'req-abc-123' });
    await writer.write(envelope, runner);

    const data = runner.calls[0]?.data;
    expect(data?.requestId).toBe('req-abc-123');
  });

  it('is idempotent: a second write with the same requestId is a no-op', async () => {
    // Proves the structural protection added by migration
    // 20260421000000_broadcast_outbox_request_id_unique — a future caller that
    // accidentally stages the same request twice (e.g. a retry wrapper that
    // moves the emit inside its loop) will NOT produce a duplicate envelope.
    const runner = makeMockRunner();
    const sharedRequestId = 'req-retry-victim';

    const first = await writer.write(
      makeEnvelope({ requestId: sharedRequestId }),
      runner,
    );
    expect(first.alreadyStaged).toBe(false);
    expect(runner.calls).toHaveLength(1);

    // Second call generates a DIFFERENT envelopeId (envelope builder uses
    // randomUUID every time) but carries the SAME requestId. The partial
    // unique index fires and we collapse to a no-op.
    const second = await writer.write(
      makeEnvelope({ requestId: sharedRequestId }),
      runner,
    );
    expect(second.alreadyStaged).toBe(true);
    // Runner only recorded the first insert — the second was collapsed.
    expect(runner.calls).toHaveLength(1);
  });

  it('does NOT mask unique violations on other columns', async () => {
    // If a future migration accidentally adds another unique constraint (e.g.
    // someone re-adds @@unique on envelopeId despite it being the PK) and
    // that constraint fires, we MUST surface the error — collapsing every
    // P2002 into alreadyStaged would hide real bugs.
    const envelopeId = randomUUID();
    const runner: OutboxPrismaRunner = {
      broadcastTraceOutbox: {
        create: async () => {
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed on the fields: (`envelope_id`)',
            {
              code: 'P2002',
              clientVersion: 'test',
              meta: { target: ['envelope_id'] },
            },
          );
        },
      } as unknown as OutboxPrismaRunner['broadcastTraceOutbox'],
    };

    await expect(
      writer.write(makeEnvelope({ envelopeId }), runner),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('flattens tenant fields into columns', async () => {
    const runner = makeMockRunner();
    const orgId = randomUUID();
    const userId = randomUUID();
    const envelope = makeEnvelope({
      tenant: {
        organizationId: orgId,
        userId,
        apiKeyId: null,
        resolutionScope: 'user',
      },
    });

    await writer.write(envelope, runner);

    const data = runner.calls[0]?.data;
    expect(data).toMatchObject({
      envelopeId: envelope.envelopeId,
      schemaVersion: TRACE_ENVELOPE_SCHEMA_VERSION,
      organizationId: orgId,
      userId,
      apiKeyId: null,
      resolutionScope: 'user',
    });
  });

  it('stores the full envelope in the JSONB column', async () => {
    const runner = makeMockRunner();
    const envelope = makeEnvelope();
    await writer.write(envelope, runner);

    const data = runner.calls[0]?.data;
    expect(data?.envelope).toBeDefined();
    // The full envelope is preserved (not flattened away)
    expect((data?.envelope as TraceEnvelope).routing.selectedProvider).toBe('openai');
  });

  it('rejects invalid envelopes BEFORE touching the DB', async () => {
    const runner = makeMockRunner();
    // Invalid: schemaVersion wrong
    const bad = makeEnvelope({ schemaVersion: '0.0' as never });

    await expect(writer.write(bad, runner)).rejects.toThrow();
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects envelopes larger than OUTBOX_MAX_JSON_BYTES', async () => {
    const runner = makeMockRunner();
    const envelope = makeEnvelope({
      content: {
        messages: [{ role: 'user', content: 'x'.repeat(OUTBOX_MAX_JSON_BYTES) }],
        choices: [],
        multimodalStripped: false,
      },
    });

    await expect(writer.write(envelope, runner)).rejects.toBeInstanceOf(
      OutboxEnvelopeTooLargeError,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it('uses the provided transaction client (not global prisma)', async () => {
    // Two distinct mock runners prove that the writer uses the one passed in.
    const runnerA = makeMockRunner();
    const runnerB = makeMockRunner();
    const envelope = makeEnvelope();

    await writer.write(envelope, runnerA);
    expect(runnerA.calls).toHaveLength(1);
    expect(runnerB.calls).toHaveLength(0);

    await writer.write(envelope, runnerB);
    expect(runnerA.calls).toHaveLength(1);
    expect(runnerB.calls).toHaveLength(1);
  });

  it('converts occurredAt ISO string to Date for column type', async () => {
    const runner = makeMockRunner();
    const iso = '2026-04-17T12:00:00.000Z';
    const envelope = makeEnvelope({ occurredAt: iso });

    await writer.write(envelope, runner);

    const data = runner.calls[0]?.data;
    expect(data?.occurredAt).toBeInstanceOf(Date);
    expect((data?.occurredAt as Date).toISOString()).toBe(iso);
  });
});
