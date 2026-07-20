// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for WebhookDestinationAdapter.
 *
 * Strategy: stand up a real http.Server on 127.0.0.1 and point the adapter
 * at it. This catches the whole stack — safe-http, signing, classification.
 *
 * Because the test server runs on 127.0.0.1 (which the egress guard blocks),
 * we set `BROADCAST_EGRESS_ALLOW_PRIVATE=true` in beforeAll. This is the
 * documented escape hatch for test rigs.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { WebhookDestinationAdapter, signRequest, verifyV1Signature } from '../webhook-adapter';
import type { DeliveryContext } from '../destination-adapter';
import {
  TRACE_ENVELOPE_SCHEMA_VERSION,
  type TraceEnvelope,
} from '@/broadcast/domain/trace-envelope';

// ─── Envelope fixture ───────────────────────────────────────────────────

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
    resource: { serviceName: 'ailin-ci-api', deploymentEnvironment: 'staging' },
    generation: {
      model: { slug: 'gpt-5', provider: 'openai' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
      timing: { startedAt: now, endedAt: now, latencyMs: 1 },
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

function makeCtx(url: string, overrides: Partial<DeliveryContext> = {}): DeliveryContext {
  return {
    deliveryAttemptId: randomUUID(),
    envelope: makeEnvelope(),
    config: { url, secret: 'shhh' },
    destinationId: randomUUID(),
    timeoutMs: 2000,
    ...overrides,
  };
}

// ─── Test HTTP server ──────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse, captured: CapturedRequest) => void,
): Promise<{ server: Server; port: number; calls: CapturedRequest[] }> {
  const calls: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
        ),
        body,
      };
      calls.push(captured);
      handler(req, res, captured);
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

// ─── Suite ─────────────────────────────────────────────────────────────

let prevEgress: string | undefined;

beforeAll(() => {
  prevEgress = process.env.BROADCAST_EGRESS_ALLOW_PRIVATE;
  process.env.BROADCAST_EGRESS_ALLOW_PRIVATE = 'true';
});

afterAll(() => {
  if (prevEgress === undefined) delete process.env.BROADCAST_EGRESS_ALLOW_PRIVATE;
  else process.env.BROADCAST_EGRESS_ALLOW_PRIVATE = prevEgress;
});

describe('WebhookDestinationAdapter — success path', () => {
  it('POSTs a signed request and returns success on 200', async () => {
    const { server, port, calls } = await startTestServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });

    try {
      const adapter = new WebhookDestinationAdapter();
      const ctx = makeCtx(`http://127.0.0.1:${port}/hook`);
      const outcome = await adapter.send(ctx);

      expect(outcome.kind).toBe('success');
      expect(outcome.statusCode).toBe(200);
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
      expect(calls).toHaveLength(1);

      const req = calls[0]!;
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toContain('application/json');
      expect(req.headers['x-broadcast-delivery-id']).toBe(ctx.deliveryAttemptId);
      expect(req.headers['x-broadcast-destination-id']).toBe(ctx.destinationId);
      // v1 default: t=..,v1=..
      expect(req.headers['x-webhook-signature']).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
      // Body contains the envelope
      const parsed = JSON.parse(req.body);
      expect(parsed.envelope.envelopeId).toBe(ctx.envelope.envelopeId);
      expect(parsed.deliveryAttemptId).toBe(ctx.deliveryAttemptId);
    } finally {
      server.close();
    }
  });

  it('honors customHeaders but refuses to override reserved ones', async () => {
    const { server, port, calls } = await startTestServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    try {
      const adapter = new WebhookDestinationAdapter();
      const ctx = makeCtx(`http://127.0.0.1:${port}/hook`, {
        config: {
          url: `http://127.0.0.1:${port}/hook`,
          secret: 'shhh',
          customHeaders: {
            'X-My-Tenant': 'acme',
            'Content-Type': 'text/evil', // reserved — should be dropped
            'Host': 'attacker.com',        // reserved — should be dropped
          },
        },
      });

      const outcome = await adapter.send(ctx);
      expect(outcome.kind).toBe('success');
      const req = calls[0]!;
      expect(req.headers['x-my-tenant']).toBe('acme');
      expect(req.headers['content-type']).toContain('application/json');
      // The Host header is automatically set by node's http client — never 'attacker.com'.
      expect(req.headers['host']).not.toBe('attacker.com');
    } finally {
      server.close();
    }
  });
});

describe('WebhookDestinationAdapter — error classification', () => {
  it('classifies 5xx as retryable', async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(502);
      res.end('bad gateway');
    });
    try {
      const adapter = new WebhookDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}/x`));
      expect(outcome.kind).toBe('retryable');
      expect(outcome.statusCode).toBe(502);
      expect(outcome.errorClass).toBe('server_error');
    } finally {
      server.close();
    }
  });

  it('classifies 401 as permanent (auth_failed)', async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(401);
      res.end('nope');
    });
    try {
      const adapter = new WebhookDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}/x`));
      expect(outcome.kind).toBe('permanent');
      expect(outcome.errorClass).toBe('auth_failed');
    } finally {
      server.close();
    }
  });

  it('classifies 429 as retryable (rate_limited)', async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(429);
      res.end('slow down');
    });
    try {
      const adapter = new WebhookDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}/x`));
      expect(outcome.kind).toBe('retryable');
      expect(outcome.errorClass).toBe('rate_limited');
    } finally {
      server.close();
    }
  });

  it('classifies 422 as permanent (bad_request)', async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(422);
      res.end('bad shape');
    });
    try {
      const adapter = new WebhookDestinationAdapter();
      const outcome = await adapter.send(makeCtx(`http://127.0.0.1:${port}/x`));
      expect(outcome.kind).toBe('permanent');
      expect(outcome.errorClass).toBe('bad_request');
    } finally {
      server.close();
    }
  });
});

describe('WebhookDestinationAdapter — config validation', () => {
  it('returns permanent/config_invalid when url is missing', async () => {
    const adapter = new WebhookDestinationAdapter();
    const outcome = await adapter.send({
      ...makeCtx('http://127.0.0.1:1/ignored'),
      config: { secret: 'x' }, // no url
    });
    expect(outcome.kind).toBe('permanent');
    expect(outcome.errorClass).toBe('config_invalid');
  });

  it('returns permanent/config_invalid when secret is missing', async () => {
    const adapter = new WebhookDestinationAdapter();
    const outcome = await adapter.send({
      ...makeCtx('http://127.0.0.1:1/ignored'),
      config: { url: 'http://example.com' }, // no secret
    });
    expect(outcome.kind).toBe('permanent');
    expect(outcome.errorClass).toBe('config_invalid');
  });
});

describe('WebhookDestinationAdapter — SSRF block', () => {
  it('blocks a forbidden IP when the allowlist escape is OFF', async () => {
    // Temporarily flip off the allowlist.
    const prev = process.env.BROADCAST_EGRESS_ALLOW_PRIVATE;
    process.env.BROADCAST_EGRESS_ALLOW_PRIVATE = 'false';
    try {
      const adapter = new WebhookDestinationAdapter();
      const outcome = await adapter.send(makeCtx('http://127.0.0.1:1/ignored'));
      expect(outcome.kind).toBe('permanent');
      expect(outcome.errorClass).toBe('ip_blocked');
    } finally {
      if (prev === undefined) delete process.env.BROADCAST_EGRESS_ALLOW_PRIVATE;
      else process.env.BROADCAST_EGRESS_ALLOW_PRIVATE = prev;
    }
  });

  it('refuses non-http schemes', async () => {
    const adapter = new WebhookDestinationAdapter();
    const outcome = await adapter.send(makeCtx('file:///etc/passwd'));
    expect(outcome.kind).toBe('permanent');
    expect(outcome.errorClass).toBe('scheme_blocked');
  });
});

describe('WebhookDestinationAdapter — timeout', () => {
  it('returns retryable/timeout when server never responds', async () => {
    // Server that accepts but hangs forever.
    const { server, port } = await startTestServer(() => {
      // never write a response
    });
    try {
      const adapter = new WebhookDestinationAdapter();
      const outcome = await adapter.send(
        makeCtx(`http://127.0.0.1:${port}/slow`, { timeoutMs: 200 }),
      );
      expect(outcome.kind).toBe('retryable');
      expect(outcome.errorClass).toBe('timeout');
    } finally {
      server.close();
    }
  }, 5000);
});

describe('signRequest + verifyV1Signature — round-trip', () => {
  it('v1 signature verifies with the same secret', () => {
    const body = '{"hello":"world"}';
    const headers = signRequest(body, { secret: 'k', signatureScheme: 'v1' }, 1_700_000_000_000);
    const sig = headers['X-Webhook-Signature']!;
    expect(verifyV1Signature(body, sig, 'k', 300, 1_700_000_000_000)).toBe(true);
  });

  it('v1 signature fails with wrong secret', () => {
    const body = '{"a":1}';
    const headers = signRequest(body, { secret: 'k', signatureScheme: 'v1' }, 1_700_000_000_000);
    const sig = headers['X-Webhook-Signature']!;
    expect(verifyV1Signature(body, sig, 'wrong-secret', 300, 1_700_000_000_000)).toBe(false);
  });

  it('v1 signature fails outside the tolerance window', () => {
    const body = '{"a":1}';
    const headers = signRequest(body, { secret: 'k', signatureScheme: 'v1' }, 1_700_000_000_000);
    const sig = headers['X-Webhook-Signature']!;
    // 10 minutes later, with 5-minute tolerance
    expect(
      verifyV1Signature(body, sig, 'k', 300, 1_700_000_000_000 + 10 * 60_000),
    ).toBe(false);
  });
});
