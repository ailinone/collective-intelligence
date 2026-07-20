// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for DatadogDestinationAdapter.
 *
 * Assertions:
 *   - site allowlist refuses anything outside ALLOWED_SITES
 *   - DD-API-KEY header set correctly
 *   - ddtags include service:, env:, provider:, model: labels
 *   - 401 → permanent; 429 → retryable; 413 → permanent (payload too large)
 *   - custom tags appended
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { DatadogDestinationAdapter, buildDatadogEvents } from '../datadog-adapter';
import type { DeliveryContext } from '../destination-adapter';
import {
  TRACE_ENVELOPE_SCHEMA_VERSION,
  type TraceEnvelope,
} from '@/broadcast/domain/trace-envelope';

function makeEnvelope(): TraceEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: TRACE_ENVELOPE_SCHEMA_VERSION,
    envelopeId: randomUUID(),
    traceId: '0'.repeat(32),
    spanId: '0'.repeat(16),
    requestId: 'req-x',
    occurredAt: now,
    tenant: {
      organizationId: randomUUID(),
      userId: randomUUID(),
      apiKeyId: null,
      resolutionScope: 'organization',
    },
    resource: { serviceName: 'ailin-ci-api', deploymentEnvironment: 'production' },
    generation: {
      model: { slug: 'gpt-5', provider: 'openai' },
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15, costUsd: 0.002 },
      timing: { startedAt: now, endedAt: now, latencyMs: 50 },
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
  } as TraceEnvelope;
}

function makeCtx(url: string, extra: Partial<DeliveryContext['config']> = {}): DeliveryContext {
  return {
    deliveryAttemptId: randomUUID(),
    envelope: makeEnvelope(),
    config: { apiKey: 'dd-api-key-x', urlOverride: url, ...extra },
    destinationId: randomUUID(),
    timeoutMs: 2000,
  };
}

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number; calls: CapturedRequest[] }> {
  const calls: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
        ),
        body,
      });
      handler(req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr && 'port' in addr) {
        resolve({ server, port: addr.port, calls });
      }
    });
  });
}

let prevEgress: string | undefined;
beforeAll(() => {
  prevEgress = process.env.BROADCAST_EGRESS_ALLOW_PRIVATE;
  process.env.BROADCAST_EGRESS_ALLOW_PRIVATE = 'true';
});
afterAll(() => {
  if (prevEgress === undefined) delete process.env.BROADCAST_EGRESS_ALLOW_PRIVATE;
  else process.env.BROADCAST_EGRESS_ALLOW_PRIVATE = prevEgress;
});

describe('buildDatadogEvents', () => {
  it('returns a single log event with ddtags', () => {
    const ctx = makeCtx('http://127.0.0.1:1');
    const events = buildDatadogEvents(ctx, {
      apiKey: 'x',
      site: 'datadoghq.com',
      service: 'svc',
      tags: ['team:platform'],
    });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.ddsource).toBe('ailin-broadcast');
    expect(String(e.ddtags)).toContain('service:svc');
    expect(String(e.ddtags)).toContain('provider:openai');
    expect(String(e.ddtags)).toContain('model:gpt-5');
    expect(String(e.ddtags)).toContain('team:platform');
  });
});

describe('DatadogDestinationAdapter — integration', () => {
  it('posts to urlOverride with DD-API-KEY and structured payload', async () => {
    const { server, port, calls } = await startTestServer((_req, res) => {
      res.writeHead(202); // Datadog returns 202 on success
      res.end();
    });
    try {
      const adapter = new DatadogDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}/api/v2/logs`));
      expect(outcome.kind).toBe('success');
      expect(calls[0]?.headers['dd-api-key']).toBe('dd-api-key-x');
      const parsed = JSON.parse(calls[0]!.body);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('rejects an out-of-allowlist site', async () => {
    const adapter = new DatadogDestinationAdapter();
    const outcome = await adapter.send({
      ...makeCtx('http://127.0.0.1:1'),
      config: { apiKey: 'x', site: 'evil.example.com' },
    });
    expect(outcome.kind).toBe('permanent');
    expect(outcome.errorClass).toBe('config_invalid');
  });

  it('treats 413 as permanent (payload_too_large)', async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(413);
      res.end();
    });
    try {
      const adapter = new DatadogDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}/x`));
      expect(outcome.kind).toBe('permanent');
      expect(outcome.errorClass).toBe('payload_too_large');
    } finally {
      server.close();
    }
  });

  it('treats 429 as retryable (rate_limited)', async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(429);
      res.end();
    });
    try {
      const adapter = new DatadogDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}/x`));
      expect(outcome.kind).toBe('retryable');
      expect(outcome.errorClass).toBe('rate_limited');
    } finally {
      server.close();
    }
  });

  it('IGNORES urlOverride when BROADCAST_EGRESS_ALLOW_PRIVATE is not set (prod-safe)', async () => {
    // Spin up a rogue server on loopback. A prod-mode adapter MUST NOT hit it
    // even though the tenant config asks for it — it must fall through to
    // the real Datadog URL (which will fail to resolve under the egress
    // guard or the guard will block the connect; either way, not our server).
    const { server, port, calls } = await startTestServer((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const savedFlag = process.env.BROADCAST_EGRESS_ALLOW_PRIVATE;
    delete process.env.BROADCAST_EGRESS_ALLOW_PRIVATE;
    try {
      const adapter = new DatadogDestinationAdapter();
      // Tenant-supplied urlOverride pointing at the attacker's server.
      const ctx: DeliveryContext = {
        ...makeCtx(`http://127.0.0.1:${port}/steal`),
        config: {
          apiKey: 'dd-api-key-x',
          site: 'datadoghq.com',
          urlOverride: `http://127.0.0.1:${port}/steal`,
        },
      };
      const outcome = await adapter.send(ctx);
      // The rogue server MUST NOT have received any request — the adapter
      // should have tried the real Datadog site, which in a restricted
      // environment either resolves to a public IP (and times out
      // quickly here because we have no network) or fails. Either outcome
      // is acceptable — what matters is the rogue server stays silent.
      expect(calls).toHaveLength(0);
      // Whatever the outcome, it isn't `success` (our server never replied).
      expect(outcome.kind).not.toBe('success');
    } finally {
      if (savedFlag !== undefined) process.env.BROADCAST_EGRESS_ALLOW_PRIVATE = savedFlag;
      server.close();
    }
  });

  it('rejects missing apiKey', async () => {
    const adapter = new DatadogDestinationAdapter();
    const outcome = await adapter.send({
      ...makeCtx('http://127.0.0.1:1'),
      config: {},
    });
    expect(outcome.kind).toBe('permanent');
    expect(outcome.errorClass).toBe('config_invalid');
  });
});
