// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for OtlpCollectorDestinationAdapter.
 *
 * Assertions:
 *   - OTLP/HTTP-JSON payload shape: resourceSpans[0].scopeSpans[0].spans[0]
 *   - nanosecond-precision unix times as strings (not BigInts on the wire)
 *   - traceId/spanId preserved verbatim from the envelope
 *   - attributes encode gen_ai.* keys with correct value types
 *   - custom tracesPath is honored
 *   - custom headers passed through (except reserved)
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { OtlpCollectorDestinationAdapter, buildOtlpPayload } from '../otlp-adapter';
import type { DeliveryContext } from '../destination-adapter';
import {
  TRACE_ENVELOPE_SCHEMA_VERSION,
  type TraceEnvelope,
} from '@/broadcast/domain/trace-envelope';

function makeEnvelope(): TraceEnvelope {
  const now = new Date('2026-04-17T12:00:00Z').toISOString();
  return {
    schemaVersion: TRACE_ENVELOPE_SCHEMA_VERSION,
    envelopeId: randomUUID(),
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    requestId: 'req-' + randomUUID(),
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
      usage: { inputTokens: 7, outputTokens: 13, totalTokens: 20, costUsd: 0.003 },
      timing: { startedAt: now, endedAt: now, latencyMs: 100 },
      streaming: true,
    },
    routing: {
      selectedProvider: 'openai',
      reason: 'primary',
      candidatesConsidered: [],
      retryAttempts: 2,
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

function makeCtx(endpoint: string, extra: Partial<DeliveryContext['config']> = {}): DeliveryContext {
  return {
    deliveryAttemptId: randomUUID(),
    envelope: makeEnvelope(),
    config: { endpoint, ...extra },
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

describe('buildOtlpPayload', () => {
  it('produces OTLP-compliant JSON', () => {
    const ctx = makeCtx('http://127.0.0.1:1');
    const payload = buildOtlpPayload(ctx) as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{
            traceId: string;
            spanId: string;
            startTimeUnixNano: string;
            endTimeUnixNano: string;
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
          }>;
        }>;
      }>;
    };
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.traceId).toBe('a'.repeat(32));
    expect(span.spanId).toBe('b'.repeat(16));
    // Nanos are strings
    expect(typeof span.startTimeUnixNano).toBe('string');
    expect(typeof span.endTimeUnixNano).toBe('string');
    // Has gen_ai.* attrs
    const keys = span.attributes.map((a) => a.key);
    expect(keys).toContain('gen_ai.system');
    expect(keys).toContain('gen_ai.request.model');
    expect(keys).toContain('gen_ai.usage.input_tokens');
    expect(keys).toContain('gen_ai.usage.total_tokens');
  });
});

describe('OtlpCollectorDestinationAdapter — integration', () => {
  it('POSTs to /v1/traces by default', async () => {
    const { server, port, calls } = await startTestServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    try {
      const adapter = new OtlpCollectorDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}`));
      expect(outcome.kind).toBe('success');
      expect(calls[0]?.url).toBe('/v1/traces');
      expect(calls[0]?.headers['content-type']).toContain('application/json');
    } finally {
      server.close();
    }
  });

  it('honors a custom tracesPath', async () => {
    const { server, port, calls } = await startTestServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    try {
      const adapter = new OtlpCollectorDestinationAdapter();
      await adapter.send(
        makeCtx(`http://127.0.0.1:${port}`, { tracesPath: '/otel/traces' }),
      );
      expect(calls[0]?.url).toBe('/otel/traces');
    } finally {
      server.close();
    }
  });

  it('passes custom headers but drops reserved ones', async () => {
    const { server, port, calls } = await startTestServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    try {
      const adapter = new OtlpCollectorDestinationAdapter();
      await adapter.send(
        makeCtx(`http://127.0.0.1:${port}`, {
          headers: {
            authorization: 'Bearer abc',
            'x-tenant': 'acme',
            host: 'bad.example.com', // reserved
          },
        }),
      );
      expect(calls[0]?.headers.authorization).toBe('Bearer abc');
      expect(calls[0]?.headers['x-tenant']).toBe('acme');
      expect(calls[0]?.headers.host).not.toBe('bad.example.com');
    } finally {
      server.close();
    }
  });

  it('classifies 500 as retryable', async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    try {
      const adapter = new OtlpCollectorDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}`));
      expect(outcome.kind).toBe('retryable');
      expect(outcome.errorClass).toBe('server_error');
    } finally {
      server.close();
    }
  });

  it('rejects missing endpoint with config_invalid', async () => {
    const adapter = new OtlpCollectorDestinationAdapter();
    const outcome = await adapter.send({
      ...makeCtx('http://127.0.0.1:1'),
      config: {},
    });
    expect(outcome.kind).toBe('permanent');
    expect(outcome.errorClass).toBe('config_invalid');
  });
});
