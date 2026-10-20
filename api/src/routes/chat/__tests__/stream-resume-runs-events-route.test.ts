// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * CI-CHAT-0003 (R3) — functional contract of GET /v1/runs/:runId/events.
 *
 * 503 when ENABLE_STREAM_RESUME is off; 400 on a runId that isn't a nanoid
 * requestId or a bad cursor; 200 with the buffered wire frames verbatim +
 * the [DONE] terminator on success. Redis is mocked — this tests the route
 * contract, not the cache (covered by stream-event-buffer.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { OrchestrationEngine } from '@/types';

const mocks = vi.hoisted(() => ({
  readStreamEvents: vi.fn(async () => [] as string[]),
}));

vi.mock('@/cache/stream-event-buffer', () => ({
  annotateStreamChunk: vi.fn((c: unknown) => c),
  bufferStreamEvent: vi.fn(async () => {}),
  readStreamEvents: mocks.readStreamEvents,
}));

const PREV_FLAG = process.env.ENABLE_STREAM_RESUME;

import { registerChatRoutes } from '../chat-routes';

async function buildApp() {
  const app = Fastify({ logger: false });
  await registerChatRoutes(app, {} as unknown as OrchestrationEngine);
  await app.ready();
  return app;
}

afterAll(() => {
  if (PREV_FLAG === undefined) delete process.env.ENABLE_STREAM_RESUME;
  else process.env.ENABLE_STREAM_RESUME = PREV_FLAG;
});

describe('GET /v1/runs/:runId/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 503 when ENABLE_STREAM_RESUME is off', async () => {
    process.env.ENABLE_STREAM_RESUME = 'false';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/runs/abc123/events' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('stream_resume_disabled');
    await app.close();
  });

  it('rejects a runId that is not a requestId-shaped token', async () => {
    process.env.ENABLE_STREAM_RESUME = 'true';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/runs/..%2Fetc%2Fpasswd/events' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_run_id');
    await app.close();
  });

  it('rejects a non-numeric since cursor', async () => {
    process.env.ENABLE_STREAM_RESUME = 'true';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/runs/abc123/events?since=abc' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_since');
    await app.close();
  });

  it('streams buffered frames verbatim + [DONE], passing the cursor through', async () => {
    process.env.ENABLE_STREAM_RESUME = 'true';
    const wire1 = 'data: {"ailin_metadata":{"run_id":"abc123","seq":2}}\n\n';
    const wire2 = 'data: {"ailin_metadata":{"run_id":"abc123","seq":3}}\n\n';
    mocks.readStreamEvents.mockResolvedValueOnce([wire1, wire2]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/runs/abc123/events?since=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toBe(wire1 + wire2 + 'data: [DONE]\n\n');
    expect(mocks.readStreamEvents).toHaveBeenCalledWith('abc123', 1);
    await app.close();
  });

  it('returns just the terminator for an unknown/expired run', async () => {
    process.env.ENABLE_STREAM_RESUME = 'true';
    mocks.readStreamEvents.mockResolvedValueOnce([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/runs/ghost_run-1/events' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('data: [DONE]\n\n');
    await app.close();
  });
});
