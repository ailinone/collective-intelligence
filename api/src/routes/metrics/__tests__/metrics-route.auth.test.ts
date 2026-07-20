// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * B6: /metrics + /metrics/prompts scrape-token gate is secure-by-default.
 *
 * Contract:
 *   - token configured                → must present the matching Bearer token.
 *   - no token, NODE_ENV=production   → DENY (403) — fail-closed, never serve
 *                                       metrics unauthenticated in production.
 *   - no token, non-production        → ALLOW (open for local/dev scraping).
 *
 * `config.observability.prometheusToken` is captured at module load, so we mock
 * `@/config` per test and import the route module fresh (resetModules) so the
 * mocked token value is the one the handler reads.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getMetrics() touches the OTel pipeline; stub it to a deterministic payload so
// these tests only exercise the auth gate.
vi.mock('@/utils/metrics', () => ({
  getMetrics: vi.fn(async () => '# HELP stub_metric\nstub_metric 1\n'),
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

async function buildServer(token: string | undefined, nodeEnv: string): Promise<FastifyInstance> {
  process.env.NODE_ENV = nodeEnv;
  vi.resetModules();
  vi.doMock('@/config', () => ({
    config: { observability: { prometheusToken: token } },
  }));
  const { registerMetricsRoute } = await import('../metrics-route');
  const server = Fastify();
  await registerMetricsRoute(server);
  await server.ready();
  return server;
}

describe('/metrics scrape-token gate (secure-by-default)', () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    vi.doUnmock('@/config');
  });

  it('DENIES /metrics in production when no token is configured (403)', async () => {
    server = await buildServer(undefined, 'production');
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    // The route's 403 response schema (`{ type: 'object' }`) serializes the body
    // to `{}`, so we assert on the status code (the security-relevant signal)
    // rather than the message payload.
    expect(res.statusCode).toBe(403);
    // It must NOT have leaked the metrics payload.
    expect(res.body).not.toContain('stub_metric');
  });

  it('DENIES /metrics/prompts in production when no token is configured (403)', async () => {
    server = await buildServer(undefined, 'production');
    const res = await server.inject({ method: 'GET', url: '/metrics/prompts' });
    expect(res.statusCode).toBe(403);
  });

  it('ALLOWS /metrics in non-production when no token is configured', async () => {
    server = await buildServer(undefined, 'test');
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('stub_metric');
  });

  it('requires the matching Bearer token when a token IS configured (even in dev)', async () => {
    server = await buildServer('s3cr3t', 'test');

    const missing = await server.inject({ method: 'GET', url: '/metrics' });
    expect(missing.statusCode).toBe(403);

    const wrong = await server.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(403);

    const ok = await server.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer s3cr3t' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('stub_metric');
  });

  it('accepts the configured token in production (the normal scrape path)', async () => {
    server = await buildServer('prod-token', 'production');
    const ok = await server.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer prod-token' },
    });
    expect(ok.statusCode).toBe(200);
  });
});
