// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * broadcast-metrics.test — verifies each counter / histogram / gauge fires
 * at the right cardinality along the real pipeline.
 *
 * Why here (not next to each call site)?
 *   Metrics are an observability contract. The contract is easier to reason
 *   about when all emit points converge in one test file that drives the full
 *   path: sampling → decryption → adapter dispatch → terminal state → DLQ
 *   admit → egress block → outbox write.
 *
 * Style:
 *   Each test reads promClient.register.getSingleMetric(name).get() before
 *   and after the action, then asserts the delta. Absolute values leak state
 *   between tests (the module-level registry persists for the test process).
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import promClient from 'prom-client';

import { broadcastMetrics } from '../broadcast-metrics';
import { BroadcastDeliveryExecutor } from '@/broadcast/application/delivery-executor';
import type { DeliveryPrismaRunner } from '@/broadcast/application/delivery-executor';
import type { ResolvedDestination } from '@/broadcast/application/destination-resolver';
import type { DestinationConfigCipher } from '@/broadcast/infrastructure/encryption';
import type {
  DeliveryOutcome,
  DestinationAdapter,
  DestinationAdapterRegistry,
} from '@/broadcast/infrastructure/destinations/destination-adapter';
import { EgressBlockedError } from '@/broadcast/infrastructure/destinations/safe-http';
import type { TraceEnvelope } from '@/broadcast/domain/trace-envelope';
import { TRACE_ENVELOPE_SCHEMA_VERSION } from '@/broadcast/domain/trace-envelope';

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Read the sum of matching samples from a Counter / Gauge. For Histograms,
 * sum the `_count` sample (distinct from `_sum`).
 */
async function readCounterTotal(
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = promClient.register.getSingleMetric(name);
  if (!metric) return 0;
  const snap = await metric.get();
  let sum = 0;
  for (const v of snap.values) {
    // Histogram _count samples end in `_count`; counters have plain names.
    if ((v as { metricName?: string }).metricName &&
        !(v as { metricName: string }).metricName.endsWith('_count') &&
        !(v as { metricName: string }).metricName.endsWith('_sum')) {
      continue;
    }
    const matches = Object.entries(labels).every(
      ([k, want]) => (v.labels as Record<string, string>)[k] === want,
    );
    if (matches) sum += v.value;
  }
  return sum;
}

async function readSimpleTotal(
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = promClient.register.getSingleMetric(name);
  if (!metric) return 0;
  const snap = await metric.get();
  let sum = 0;
  for (const v of snap.values) {
    const matches = Object.entries(labels).every(
      ([k, want]) => (v.labels as Record<string, string>)[k] === want,
    );
    if (matches) sum += v.value;
  }
  return sum;
}

async function readHistogramCount(
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = promClient.register.getSingleMetric(name);
  if (!metric) return 0;
  const snap = await metric.get();
  let total = 0;
  for (const v of snap.values) {
    const m = v as { metricName?: string; labels: Record<string, string>; value: number };
    if (m.metricName && m.metricName.endsWith('_count')) {
      const matches = Object.entries(labels).every(([k, want]) => m.labels[k] === want);
      if (matches) total += m.value;
    }
  }
  return total;
}

// ─── Fixtures (trimmed from delivery-executor.test) ─────────────────────

function makeMockDb(): DeliveryPrismaRunner {
  const rows = new Map<string, { envelopeId: string; destinationId: string; status: string; attempts: number }>();
  const key = (e: string, d: string) => `${e}|${d}`;
  return {
    broadcastDelivery: {
      upsert: async (args: {
        where: { envelopeId_destinationId: { envelopeId: string; destinationId: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { envelopeId, destinationId } = args.where.envelopeId_destinationId;
        const k = key(envelopeId, destinationId);
        const existing = rows.get(k);
        if (!existing) {
          rows.set(k, {
            envelopeId,
            destinationId,
            status: String(args.create.status ?? 'pending'),
            attempts: Number(args.create.attempts ?? 0),
          });
          return {} as unknown;
        }
        const upd = args.update;
        const attemptsOp = upd.attempts as { increment?: number } | number | undefined;
        const next =
          typeof attemptsOp === 'object' && attemptsOp && 'increment' in attemptsOp
            ? existing.attempts + (attemptsOp.increment ?? 0)
            : typeof attemptsOp === 'number'
              ? attemptsOp
              : existing.attempts;
        rows.set(k, { ...existing, status: String(upd.status ?? existing.status), attempts: next });
        return {} as unknown;
      },
      findUnique: async (args: {
        where: { envelopeId_destinationId: { envelopeId: string; destinationId: string } };
      }) => {
        const { envelopeId, destinationId } = args.where.envelopeId_destinationId;
        const row = rows.get(key(envelopeId, destinationId));
        return row ? { attempts: row.attempts, status: row.status, firstAttemptAt: null } : null;
      },
    },
    broadcastDlqEntry: {
      create: async () => ({}) as unknown,
    },
  } as unknown as DeliveryPrismaRunner;
}

function makeCipher(config: Record<string, unknown> = { url: 'https://example.com/hook' }): DestinationConfigCipher {
  return {
    encrypt: vi.fn(),
    decrypt: vi.fn(async () => config),
    invalidate: vi.fn(),
    rotateDek: vi.fn(),
  } as unknown as DestinationConfigCipher;
}

function makeAdapter(outcome: DeliveryOutcome): DestinationAdapter {
  return {
    type: 'webhook',
    send: async () => outcome,
  } as DestinationAdapter;
}

function registry(outcome: DeliveryOutcome): DestinationAdapterRegistry {
  const a = makeAdapter(outcome);
  return {
    webhook: a,
    langfuse: a,
    datadog: a,
    otlp_collector: a,
  };
}

function makeEnvelope(): TraceEnvelope {
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
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.0001 },
      timing: { startedAt: now, endedAt: now, latencyMs: 10 },
      streaming: false,
    },
    routing: { selectedProvider: 'openai', reason: 'primary', candidatesConsidered: [], retryAttempts: 0 },
    content: { messages: [{ role: 'user', content: 'hi' }], choices: [], multimodalStripped: false },
    custom: {},
    status: { code: 'ok' },
  } as TraceEnvelope;
}

function makeDestination(overrides: Partial<ResolvedDestination> = {}): ResolvedDestination {
  return {
    id: randomUUID(),
    tenantType: 'organization',
    tenantId: randomUUID(),
    type: 'webhook',
    name: 'test',
    samplingRate: 1,
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

// ─── Tests ──────────────────────────────────────────────────────────────

describe('broadcast-metrics — sampling decisions', () => {
  it('increments sampled_out when samplingRate=0', async () => {
    const before = await readSimpleTotal('ailin_broadcast_sampling_decisions_total', {
      destination_type: 'webhook',
      decision: 'sampled_out',
    });
    const executor = new BroadcastDeliveryExecutor({
      cipher: makeCipher(),
      adapters: registry({ kind: 'success', latencyMs: 10 }),
      db: makeMockDb(),
    });
    await executor.deliverOne(makeEnvelope(), makeDestination({ samplingRate: 0 }));
    const after = await readSimpleTotal('ailin_broadcast_sampling_decisions_total', {
      destination_type: 'webhook',
      decision: 'sampled_out',
    });
    expect(after - before).toBe(1);
  });

  it('increments included when samplingRate=1', async () => {
    const before = await readSimpleTotal('ailin_broadcast_sampling_decisions_total', {
      destination_type: 'webhook',
      decision: 'included',
    });
    const executor = new BroadcastDeliveryExecutor({
      cipher: makeCipher(),
      adapters: registry({ kind: 'success', latencyMs: 10 }),
      db: makeMockDb(),
    });
    await executor.deliverOne(makeEnvelope(), makeDestination({ samplingRate: 1 }));
    const after = await readSimpleTotal('ailin_broadcast_sampling_decisions_total', {
      destination_type: 'webhook',
      decision: 'included',
    });
    expect(after - before).toBe(1);
  });
});

describe('broadcast-metrics — delivery counters', () => {
  it('increments deliveries{outcome=success} and observes latency on success', async () => {
    const deliveriesBefore = await readSimpleTotal('ailin_broadcast_deliveries_total', {
      destination_type: 'webhook',
      outcome: 'success',
    });
    const latencyBefore = await readHistogramCount('ailin_broadcast_delivery_latency_seconds', {
      destination_type: 'webhook',
      outcome: 'success',
    });
    const attemptsBefore = await readHistogramCount('ailin_broadcast_delivery_attempts_total', {
      destination_type: 'webhook',
      terminal_state: 'sent',
    });

    const executor = new BroadcastDeliveryExecutor({
      cipher: makeCipher(),
      adapters: registry({ kind: 'success', latencyMs: 123 }),
      db: makeMockDb(),
    });
    await executor.deliverOne(makeEnvelope(), makeDestination({ samplingRate: 1 }));

    const deliveriesAfter = await readSimpleTotal('ailin_broadcast_deliveries_total', {
      destination_type: 'webhook',
      outcome: 'success',
    });
    const latencyAfter = await readHistogramCount('ailin_broadcast_delivery_latency_seconds', {
      destination_type: 'webhook',
      outcome: 'success',
    });
    const attemptsAfter = await readHistogramCount('ailin_broadcast_delivery_attempts_total', {
      destination_type: 'webhook',
      terminal_state: 'sent',
    });

    expect(deliveriesAfter - deliveriesBefore).toBe(1);
    expect(latencyAfter - latencyBefore).toBe(1);
    expect(attemptsAfter - attemptsBefore).toBe(1);
  });

  it('increments dlqAdmits on permanent failure', async () => {
    const admitsBefore = await readSimpleTotal('ailin_broadcast_dlq_admits_total', {
      destination_type: 'webhook',
      error_class: 'config_invalid',
    });
    const executor = new BroadcastDeliveryExecutor({
      cipher: makeCipher(),
      adapters: registry({
        kind: 'permanent',
        errorClass: 'config_invalid',
        errorMessage: 'no',
        latencyMs: 5,
      }),
      db: makeMockDb(),
    });
    await executor.deliverOne(makeEnvelope(), makeDestination({ samplingRate: 1 }));
    const admitsAfter = await readSimpleTotal('ailin_broadcast_dlq_admits_total', {
      destination_type: 'webhook',
      error_class: 'config_invalid',
    });
    expect(admitsAfter - admitsBefore).toBe(1);
  });
});

describe('broadcast-metrics — egress blocker', () => {
  it('increments egressBlocked{reason} each time an EgressBlockedError is constructed', async () => {
    const before = await readSimpleTotal('ailin_broadcast_egress_blocked_total', {
      reason: 'ip_blocked',
    });
    // Construct the error — the constructor bumps the counter.
    const err = new EgressBlockedError('ip_blocked', 'blocked 10.0.0.1');
    expect(err.reason).toBe('ip_blocked');
    const after = await readSimpleTotal('ailin_broadcast_egress_blocked_total', {
      reason: 'ip_blocked',
    });
    expect(after - before).toBe(1);
  });
});

describe('broadcast-metrics — direct counter API', () => {
  it('erasures counter accepts subject_kind labels', async () => {
    const before = await readSimpleTotal('ailin_broadcast_erasures_total', {
      subject_kind: 'user',
    });
    broadcastMetrics.erasures.inc({ subject_kind: 'user' });
    const after = await readSimpleTotal('ailin_broadcast_erasures_total', {
      subject_kind: 'user',
    });
    expect(after - before).toBe(1);
  });

  it('dlqReplays counter accepts destination_type labels', async () => {
    const before = await readSimpleTotal('ailin_broadcast_dlq_replays_total', {
      destination_type: 'webhook',
    });
    broadcastMetrics.dlqReplays.inc({ destination_type: 'webhook' });
    const after = await readSimpleTotal('ailin_broadcast_dlq_replays_total', {
      destination_type: 'webhook',
    });
    expect(after - before).toBe(1);
  });

  it('outboxWrites counter tracks ok / error separately', async () => {
    const okBefore = await readSimpleTotal('ailin_broadcast_outbox_writes_total', {
      status: 'ok',
    });
    const errBefore = await readSimpleTotal('ailin_broadcast_outbox_writes_total', {
      status: 'error',
    });
    broadcastMetrics.outboxWrites.inc({ status: 'ok' });
    broadcastMetrics.outboxWrites.inc({ status: 'ok' });
    broadcastMetrics.outboxWrites.inc({ status: 'error' });
    const okAfter = await readSimpleTotal('ailin_broadcast_outbox_writes_total', {
      status: 'ok',
    });
    const errAfter = await readSimpleTotal('ailin_broadcast_outbox_writes_total', {
      status: 'error',
    });
    expect(okAfter - okBefore).toBe(2);
    expect(errAfter - errBefore).toBe(1);
  });
});

describe('broadcast-metrics — label cardinality guardrails', () => {
  it('deliveries counter has exactly the bounded label set', async () => {
    const metric = promClient.register.getSingleMetric('ailin_broadcast_deliveries_total');
    expect(metric).toBeDefined();
    const snap = await metric!.get();
    expect(snap.aggregator ?? 'sum').toBeTruthy();
    // Inspect one observed sample: labels must only include the whitelisted keys.
    broadcastMetrics.deliveries.inc({
      destination_type: 'webhook',
      outcome: 'success',
      error_class: 'none',
    });
    const s = await metric!.get();
    const sample = s.values.find(
      (v) =>
        v.labels.destination_type === 'webhook' &&
        v.labels.outcome === 'success' &&
        v.labels.error_class === 'none',
    );
    expect(sample).toBeDefined();
    const keys = Object.keys(sample!.labels).sort();
    expect(keys).toEqual(['destination_type', 'error_class', 'outcome']);
  });
});
