// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for LangfuseDestinationAdapter.
 *
 * Strategy: local http.Server standing in for Langfuse. We assert:
 *   - request hits `/api/public/ingestion`
 *   - Basic auth header is constructed from public:secret
 *   - batch payload contains a trace-create + generation-create
 *   - 207 Multi-Status with empty errors[] is classified as success
 *   - 207 Multi-Status with errors[] is success + partial_failure tag
 *   - 5xx is retryable, 401 is permanent
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { LangfuseDestinationAdapter, buildLangfusePayload } from '../langfuse-adapter';
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
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.005 },
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
      messages: [{ role: 'user', content: 'hello' }],
      choices: [{ role: 'assistant', content: 'hi there', finishReason: 'stop', index: 0 }],
      multimodalStripped: false,
    },
    custom: { sessionId: 'sess-123' },
    status: { code: 'ok' },
  } as TraceEnvelope;
}

function makeCtx(baseUrl: string): DeliveryContext {
  return {
    deliveryAttemptId: randomUUID(),
    envelope: makeEnvelope(),
    config: { baseUrl, publicKey: 'pk_x', secretKey: 'sk_y' },
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

describe('buildLangfusePayload', () => {
  it('produces a batch with trace-create + generation-create', () => {
    const ctx = makeCtx('http://127.0.0.1:1');
    const payload = buildLangfusePayload(ctx);
    expect(payload.batch).toHaveLength(2);
    const types = payload.batch.map((e) => e.type);
    expect(types).toContain('trace-create');
    expect(types).toContain('generation-create');
  });

  it('propagates sessionId from envelope.custom', () => {
    const ctx = makeCtx('http://127.0.0.1:1');
    const payload = buildLangfusePayload(ctx);
    const trace = payload.batch.find((e) => e.type === 'trace-create') as { body: { sessionId?: string } };
    expect(trace.body.sessionId).toBe('sess-123');
  });
});

describe('LangfuseDestinationAdapter — integration', () => {
  it('POSTs to /api/public/ingestion with Basic auth', async () => {
    const { server, port, calls } = await startTestServer((_req, res) => {
      res.writeHead(207, { 'content-type': 'application/json' });
      res.end('{"successes":[],"errors":[]}');
    });
    try {
      const adapter = new LangfuseDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}`));
      expect(outcome.kind).toBe('success');
      const req = calls[0]!;
      expect(req.url).toBe('/api/public/ingestion');
      expect(req.headers.authorization).toMatch(/^Basic /);
      // Decode and check
      const decoded = Buffer.from(req.headers.authorization!.slice(6), 'base64').toString();
      expect(decoded).toBe('pk_x:sk_y');
      // Payload has 2 events
      const parsed = JSON.parse(req.body);
      expect(parsed.batch).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it('marks 207 with errors[] as success + partial_failure', async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(207, { 'content-type': 'application/json' });
      res.end('{"errors":[{"status":422,"message":"bad event"}]}');
    });
    try {
      const adapter = new LangfuseDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}`));
      expect(outcome.kind).toBe('success');
      expect(outcome.errorClass).toBe('partial_failure');
    } finally {
      server.close();
    }
  });

  it('treats 401 as permanent', async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(401);
      res.end('bad key');
    });
    try {
      const adapter = new LangfuseDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}`));
      expect(outcome.kind).toBe('permanent');
      expect(outcome.errorClass).toBe('auth_failed');
    } finally {
      server.close();
    }
  });

  it('treats 503 as retryable', async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(503);
      res.end('down');
    });
    try {
      const adapter = new LangfuseDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}`));
      expect(outcome.kind).toBe('retryable');
      expect(outcome.errorClass).toBe('server_error');
    } finally {
      server.close();
    }
  });

  it('rejects missing publicKey with config_invalid', async () => {
    const adapter = new LangfuseDestinationAdapter();
    const outcome = await adapter.send({
      ...makeCtx('http://127.0.0.1:1'),
      config: { baseUrl: 'http://example.com', secretKey: 'y' },
    });
    expect(outcome.kind).toBe('permanent');
    expect(outcome.errorClass).toBe('config_invalid');
  });
});
