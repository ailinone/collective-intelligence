// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * /metrics and /metrics/prompts behind @fastify/compress (as registered in
 * server.ts: global, threshold 1 KB) must return the full body when the
 * scraper asks for gzip.
 *
 * Regression (2026-09-23): both handlers are async and called reply.send()
 * without returning the reply. With compress's async onSend hook, Fastify saw
 * the handler resolve with undefined, treated the reply as unsent and sent
 * again: the ~500 KB /metrics payload went out as `content-encoding: gzip`
 * with content-length 0 (Prometheus reported "EOF" and the target stayed
 * down), and every scrape logged ERR_HTTP_HEADERS_SENT / "Reply was already
 * sent".
 */
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';

import compress from '@fastify/compress';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { BIG_METRICS, PROMPT_METRICS } = vi.hoisted(() => {
  const lines: string[] = ['# HELP big_metric synthetic payload', '# TYPE big_metric gauge'];
  for (let i = 0; i < 12_000; i++) lines.push(`big_metric{series="s${i}",job="ci"} ${i}`);
  const prompt: string[] = ['# HELP prompt_metric synthetic payload', '# TYPE prompt_metric gauge'];
  for (let i = 0; i < 80; i++) prompt.push(`prompt_metric{slot="slot_${i}"} ${i}`);
  return { BIG_METRICS: `${lines.join('\n')}\n`, PROMPT_METRICS: `${prompt.join('\n')}\n` };
});

vi.mock('@/utils/metrics', () => ({
  getMetrics: vi.fn(async () => BIG_METRICS),
}));

vi.mock('@/core/orchestration/prompts/prompt-metrics-exporter.js', () => ({
  exportPromptMetricsAsPrometheus: () => PROMPT_METRICS,
  PROMETHEUS_CONTENT_TYPE: 'text/plain; version=0.0.4',
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const TOKEN = 'scrape-token';

async function buildServer(logLines: string[]): Promise<FastifyInstance> {
  process.env.NODE_ENV = 'test';
  vi.resetModules();
  vi.doMock('@/config', () => ({
    config: { observability: { prometheusToken: TOKEN } },
  }));
  const { registerMetricsRoute } = await import('../metrics-route');
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(chunk.toString());
      callback();
    },
  });
  const server = Fastify({ logger: { level: 'warn', stream } });
  await server.register(compress, { global: true, threshold: 1024 });
  await registerMetricsRoute(server);
  await server.ready();
  return server;
}

describe('/metrics behind @fastify/compress', () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    vi.doUnmock('@/config');
  });

  it('sanity: the synthetic /metrics payload is well above the compression threshold', () => {
    expect(BIG_METRICS.length).toBeGreaterThan(300_000);
    expect(PROMPT_METRICS.length).toBeGreaterThan(1024);
  });

  it.each([
    ['/metrics', () => BIG_METRICS],
    ['/metrics/prompts', () => PROMPT_METRICS],
  ])('returns the full gzip body for %s and sends the reply only once', async (url, expected) => {
    const logLines: string[] = [];
    server = await buildServer(logLines);

    const res = await server.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${TOKEN}`, 'accept-encoding': 'gzip' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.rawPayload.length).toBeGreaterThan(0);
    expect(gunzipSync(res.rawPayload).toString('utf8')).toBe(expected());

    const logs = logLines.join('');
    expect(logs).not.toContain('Reply was already sent');
    expect(logs).not.toContain('ERR_HTTP_HEADERS_SENT');
  });

  it('still returns the uncompressed body when the scraper does not ask for gzip', async () => {
    server = await buildServer([]);
    const res = await server.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}`, 'accept-encoding': 'identity' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toBe(BIG_METRICS);
  });
});
