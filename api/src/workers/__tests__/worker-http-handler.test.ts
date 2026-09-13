// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Worker http routes, exercised without booting queue-runner.ts:
 * /health stays liveness-only; /health/ready is the real database gate the
 * compose healthcheck can point at during a pooler canary (bounded by a
 * short timeout so a hung pool cannot outlive the healthcheck).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkerHttpHandler, type WorkerHttpHandlerDeps } from '../worker-http-handler';

function fakeReq(url: string): IncomingMessage {
  return { url, headers: {} } as unknown as IncomingMessage;
}

function fakeRes() {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  return res as unknown as ServerResponse & typeof res;
}

function status(res: ReturnType<typeof fakeRes>): number {
  return res.writeHead.mock.calls[0][0] as number;
}

function body(res: ReturnType<typeof fakeRes>): string {
  return String(res.end.mock.calls[0]?.[0] ?? '');
}

function makeHandler(overrides: Partial<WorkerHttpHandlerDeps> = {}) {
  return createWorkerHttpHandler({
    authorizeScrape: () => true,
    metricsRegister: { metrics: async () => '# metrics', contentType: 'text/plain' },
    checkDatabaseHealth: async () => true,
    scrapeTokenConfigured: true,
    ...overrides,
  });
}

describe('createWorkerHttpHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('/health -> 200 ok even when the database check rejects (liveness only)', async () => {
    const handler = makeHandler({ checkDatabaseHealth: async () => Promise.reject(new Error('down')) });
    const res = fakeRes();
    await handler(fakeReq('/health'), res);
    expect(status(res)).toBe(200);
    expect(body(res)).toBe('ok');
  });

  it('/health/ready -> 200 ready when checkDatabaseHealth resolves true', async () => {
    const res = fakeRes();
    await makeHandler()(fakeReq('/health/ready'), res);
    expect(status(res)).toBe(200);
    expect(body(res)).toBe('ready');
  });

  it('/health/ready -> 503 when checkDatabaseHealth resolves false', async () => {
    const res = fakeRes();
    await makeHandler({ checkDatabaseHealth: async () => false })(fakeReq('/health/ready'), res);
    expect(status(res)).toBe(503);
    expect(body(res)).toBe('database unavailable');
  });

  it('/health/ready -> 503 when checkDatabaseHealth throws', async () => {
    const res = fakeRes();
    await makeHandler({ checkDatabaseHealth: async () => Promise.reject(new Error('boom')) })(
      fakeReq('/health/ready'),
      res
    );
    expect(status(res)).toBe(503);
  });

  it('/health/ready -> 503 when checkDatabaseHealth hangs past the readiness timeout', async () => {
    vi.useFakeTimers();
    const handler = makeHandler({
      checkDatabaseHealth: () => new Promise<boolean>(() => {}),
      readinessTimeoutMs: 100,
    });
    const res = fakeRes();
    const pending = handler(fakeReq('/health/ready'), res);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(status(res)).toBe(503);
  });

  it('/metrics -> 403 without authorization, 200 with', async () => {
    const denied = fakeRes();
    await makeHandler({ authorizeScrape: () => false })(fakeReq('/metrics'), denied);
    expect(status(denied)).toBe(403);
    expect(body(denied)).toContain('forbidden');

    const allowed = fakeRes();
    await makeHandler()(fakeReq('/metrics'), allowed);
    expect(status(allowed)).toBe(200);
    expect(body(allowed)).toBe('# metrics');
  });

  it('unknown routes -> 404', async () => {
    const res = fakeRes();
    await makeHandler()(fakeReq('/nope'), res);
    expect(status(res)).toBe(404);
  });
});

describe('queue-runner.ts wiring (source-level, same technique as queue-runner-secrets-wiring.test.ts)', () => {
  const source = readFileSync(join(__dirname, '..', 'queue-runner.ts'), 'utf8');

  it('builds its http server from createWorkerHttpHandler', () => {
    expect(source).toMatch(/import\s*\{\s*createWorkerHttpHandler\s*\}\s*from\s*['"]\.\/worker-http-handler['"]/);
    expect(source).toMatch(/http\.createServer\(\s*createWorkerHttpHandler\(/);
  });

  it('passes checkDatabaseHealth from @/database/client (the same probe the api uses)', () => {
    expect(source).toMatch(/import\s*\{[^}]*\bcheckDatabaseHealth\b[^}]*\}\s*from\s*['"]@\/database\/client['"]/);
    expect(source).toMatch(/checkDatabaseHealth,/);
  });
});
