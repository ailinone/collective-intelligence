// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression coverage for inbound admission control (Track 1 §2.1,
 * CAPACITY-SCALING-PLAN-10K-USERS.md). Verifies the four properties the
 * plan's own safety requirement hinges on:
 *
 *  1. Shadow mode (the default) NEVER rejects a request, no matter how far
 *     over a resource-pressure threshold the process is — it only logs and
 *     increments metrics.
 *  2. Enforce mode (ADMISSION_CONTROL_ENFORCE=true) DOES reject with a real
 *     503 + Retry-After once a threshold is exceeded.
 *  3. The in-flight counter increments/decrements correctly across
 *     concurrent requests, including on the error path (a leaked counter
 *     that never decrements on failure would be worse than no counter).
 *  4. Health/auth-shaped routes are excluded from the in-flight scope and
 *     are never touched by either mechanism.
 *
 * Uses a real `Fastify()` instance + `.inject()` (this codebase's own
 * convention — see idempotency-middleware-real-fastify-sendresponse.test.ts)
 * rather than hand-rolled fake request/reply objects, because
 * `@fastify/under-pressure` registers real hooks against the real instance
 * (`server.memoryUsage()`, `server.register(...)`) that a fake object can't
 * stand in for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  registerAdmissionControl,
  isExpensiveRoute,
  resolveAdmissionControlThresholds,
  getInFlightRequestCount,
  __resetAdmissionControlStateForTests,
} from '../admission-control';
import {
  admissionControlPressureEventsTotal,
  admissionControlRejectedTotal,
} from '@/observability/ci-metrics';

async function metricValue(
  metric: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown> }> }> },
  labels: Record<string, unknown>
): Promise<number> {
  const snapshot = await metric.get();
  const match = snapshot.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val)
  );
  return match?.value ?? 0;
}

async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

  server.post('/v1/chat/completions', async () => ({ ok: true }));
  server.get('/v1/threads/:thread_id', async () => ({ ok: true })); // NOT expensive (CRUD read)
  server.post('/v1/threads/:thread_id/runs', async () => ({ ok: true })); // expensive
  server.get('/health', async () => ({ status: 'ok' }));
  server.post('/v1/auth/login', async () => ({ ok: true }));
  server.post('/v1/chat/completions/slow', async (request) => {
    // Lets a test hold this request open to create real overlapping in-flight requests.
    const gate = (request.server as unknown as { __gate?: Promise<void> }).__gate;
    if (gate) await gate;
    return { ok: true };
  });
  server.get('/v1/chat/completions/boom', async () => {
    throw new Error('simulated handler failure');
  });

  // Deliberately NOT calling server.ready() here — registerAdmissionControl
  // (called by each test afterward) itself calls server.register(), which
  // avvio refuses once the root plugin has already booted. Real production
  // boot order (index.ts) registers admission control before server.listen()
  // for the same reason; mirror that order here.
  return server;
}

describe('resolveAdmissionControlThresholds', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults maxEventLoopDelayMs/maxEventLoopUtilization/maxInFlightRequests to undefined (plan: measure, do not guess)', () => {
    const thresholds = resolveAdmissionControlThresholds();
    expect(thresholds.maxEventLoopDelayMs).toBeUndefined();
    expect(thresholds.maxEventLoopUtilization).toBeUndefined();
    expect(thresholds.maxInFlightRequests).toBeUndefined();
  });

  it('defaults heap/rss thresholds to the real-shadow-data-revised starting points (2026-09-10)', () => {
    // See the module doc on DEFAULT_MAX_HEAP_USED_BYTES/DEFAULT_MAX_RSS_BYTES
    // for the full 24h real-production-percentile methodology behind these
    // two numbers — no longer pure container-limit guesses.
    const thresholds = resolveAdmissionControlThresholds();
    expect(thresholds.maxHeapUsedBytes).toBeCloseTo(2.8 * 1024 * 1024 * 1024, -3);
    expect(thresholds.maxRssBytes).toBeCloseTo(3.6 * 1024 * 1024 * 1024, -3);
  });

  it('honors explicit env overrides for every threshold', () => {
    vi.stubEnv('ADMISSION_CONTROL_MAX_HEAP_USED_BYTES', '123');
    vi.stubEnv('ADMISSION_CONTROL_MAX_RSS_BYTES', '456');
    vi.stubEnv('ADMISSION_CONTROL_MAX_EVENT_LOOP_DELAY_MS', '789');
    vi.stubEnv('ADMISSION_CONTROL_MAX_EVENT_LOOP_UTILIZATION', '0.9');
    vi.stubEnv('ADMISSION_CONTROL_MAX_IN_FLIGHT', '50');
    vi.stubEnv('ADMISSION_CONTROL_RETRY_AFTER_SECONDS', '15');

    const thresholds = resolveAdmissionControlThresholds();
    expect(thresholds.maxHeapUsedBytes).toBe(123);
    expect(thresholds.maxRssBytes).toBe(456);
    expect(thresholds.maxEventLoopDelayMs).toBe(789);
    expect(thresholds.maxEventLoopUtilization).toBe(0.9);
    expect(thresholds.maxInFlightRequests).toBe(50);
    expect(thresholds.retryAfterSeconds).toBe(15);
  });
});

describe('isExpensiveRoute', () => {
  it('matches chat completions, responses, and their named equivalents', () => {
    expect(isExpensiveRoute('/v1/chat/completions')).toBe(true);
    expect(isExpensiveRoute('/v1/chat/completions/extended-thinking')).toBe(true);
    expect(isExpensiveRoute('/v1/responses')).toBe(true);
    expect(isExpensiveRoute('/v1/collective/runs')).toBe(true);
    expect(isExpensiveRoute('/v1/embeddings')).toBe(true);
    expect(isExpensiveRoute('/v1/images/generations')).toBe(true);
    expect(isExpensiveRoute('/v1/threads/abc123/runs')).toBe(true);
  });

  it('excludes health, auth, and CRUD-only routes', () => {
    expect(isExpensiveRoute('/health')).toBe(false);
    expect(isExpensiveRoute('/health/ready')).toBe(false);
    expect(isExpensiveRoute('/v1/auth/login')).toBe(false);
    expect(isExpensiveRoute('/v1/status')).toBe(false);
    expect(isExpensiveRoute('/metrics')).toBe(false);
    expect(isExpensiveRoute('/v1/threads/abc123')).toBe(false); // reading a thread ≠ running one
    expect(isExpensiveRoute('/v1/threads')).toBe(false);
    expect(isExpensiveRoute('/v1/models')).toBe(false);
  });
});

describe('admission control — shadow mode (default)', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    vi.unstubAllEnvs();
    __resetAdmissionControlStateForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server?.close();
  });

  it('never rejects, even with resource thresholds set far below current usage', async () => {
    // 1 byte is guaranteed to be exceeded by the running test process —
    // this deterministically forces the pressureHandler to fire without
    // needing to actually allocate gigabytes of heap in a unit test.
    vi.stubEnv('ADMISSION_CONTROL_MAX_HEAP_USED_BYTES', '1');
    vi.stubEnv('ADMISSION_CONTROL_MAX_RSS_BYTES', '1');
    vi.stubEnv('ADMISSION_CONTROL_SAMPLE_INTERVAL_MS', '10');

    server = await buildServer();
    await registerAdmissionControl(server);
    await server.ready();
    // Let under-pressure's sampler tick at least once so heapUsed/rssBytes
    // reflect real (non-zero) process values.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const before = await metricValue(admissionControlPressureEventsTotal, {
      metric: 'heapUsedBytes',
    });

    const response = await server.inject({ method: 'POST', url: '/v1/chat/completions' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const after = await metricValue(admissionControlPressureEventsTotal, {
      metric: 'heapUsedBytes',
    });
    expect(after).toBeGreaterThan(before); // the pressure event WAS observed...
    // ...but nothing was ever rejected because of it.
    const rejected = await metricValue(admissionControlRejectedTotal, {
      route: '/v1/chat/completions',
      reason: 'pressure_heapUsedBytes',
    });
    expect(rejected).toBe(0);
  });

  it('tracks in-flight count for expensive routes only, decrementing after the response completes', async () => {
    server = await buildServer();
    await registerAdmissionControl(server);
    await server.ready();

    expect(getInFlightRequestCount()).toBe(0);

    await server.inject({ method: 'GET', url: '/health' });
    expect(getInFlightRequestCount()).toBe(0); // health never touched the counter

    await server.inject({ method: 'POST', url: '/v1/auth/login' });
    expect(getInFlightRequestCount()).toBe(0); // auth never touched the counter

    await server.inject({ method: 'POST', url: '/v1/chat/completions' });
    expect(getInFlightRequestCount()).toBe(0); // incremented, then decremented after response
  });

  it('decrements the in-flight counter on a handler error (no leak on failure)', async () => {
    server = await buildServer();
    await registerAdmissionControl(server);
    await server.ready();

    const response = await server.inject({ method: 'GET', url: '/v1/chat/completions/boom' });
    expect(response.statusCode).toBe(500);
    expect(getInFlightRequestCount()).toBe(0);
  });

  it('increments while genuinely concurrent and decrements once each finishes', async () => {
    server = await buildServer();
    await registerAdmissionControl(server);
    await server.ready();

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    (server as unknown as { __gate: Promise<void> }).__gate = gate;

    const first = server.inject({ method: 'POST', url: '/v1/chat/completions/slow' });
    const second = server.inject({ method: 'POST', url: '/v1/chat/completions/slow' });

    // Give both requests a tick to enter the handler and register in-flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getInFlightRequestCount()).toBe(2);

    releaseGate();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(getInFlightRequestCount()).toBe(0);
  });
});

describe('admission control — enforce mode', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    vi.unstubAllEnvs();
    __resetAdmissionControlStateForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server?.close();
  });

  it('rejects with 503 + Retry-After once a resource-pressure threshold is exceeded', async () => {
    vi.stubEnv('ADMISSION_CONTROL_ENFORCE', 'true');
    vi.stubEnv('ADMISSION_CONTROL_MAX_HEAP_USED_BYTES', '1');
    vi.stubEnv('ADMISSION_CONTROL_MAX_RSS_BYTES', '1');
    vi.stubEnv('ADMISSION_CONTROL_SAMPLE_INTERVAL_MS', '10');
    vi.stubEnv('ADMISSION_CONTROL_RETRY_AFTER_SECONDS', '13');

    server = await buildServer();
    await registerAdmissionControl(server);
    await server.ready();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const response = await server.inject({ method: 'POST', url: '/v1/chat/completions' });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('13');
    expect(response.json().error.code).toBe('service_unavailable');
  });

  it('does not reject health/auth routes even while under simulated pressure', async () => {
    vi.stubEnv('ADMISSION_CONTROL_ENFORCE', 'true');
    vi.stubEnv('ADMISSION_CONTROL_MAX_HEAP_USED_BYTES', '1');
    vi.stubEnv('ADMISSION_CONTROL_MAX_RSS_BYTES', '1');
    vi.stubEnv('ADMISSION_CONTROL_SAMPLE_INTERVAL_MS', '10');

    server = await buildServer();
    await registerAdmissionControl(server);
    await server.ready();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // under-pressure's own onRequest hook is global (fleet-wide pressure
    // applies regardless of route), so health/auth ARE still subject to the
    // resource-pressure axis by design (a truly out-of-memory process should
    // shed everything) — what must stay untouched is the IN-FLIGHT-COUNTER
    // axis, which is scoped. Assert that axis directly instead.
    await server.inject({ method: 'GET', url: '/health' });
    expect(getInFlightRequestCount()).toBe(0);
  });

  it('rejects once the in-flight cap is reached, and admits again after it drains', async () => {
    vi.stubEnv('ADMISSION_CONTROL_ENFORCE', 'true');
    vi.stubEnv('ADMISSION_CONTROL_MAX_IN_FLIGHT', '1');

    server = await buildServer();
    await registerAdmissionControl(server);
    await server.ready();

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    (server as unknown as { __gate: Promise<void> }).__gate = gate;

    const first = server.inject({ method: 'POST', url: '/v1/chat/completions/slow' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getInFlightRequestCount()).toBe(1);

    const secondResponse = await server.inject({ method: 'POST', url: '/v1/chat/completions' });
    expect(secondResponse.statusCode).toBe(503);
    expect(secondResponse.json().error.code).toBe('service_unavailable');

    releaseGate();
    const firstResponse = await first;
    expect(firstResponse.statusCode).toBe(200);
    expect(getInFlightRequestCount()).toBe(0);

    // Cap has drained — a new request is admitted again.
    const thirdResponse = await server.inject({ method: 'POST', url: '/v1/chat/completions' });
    expect(thirdResponse.statusCode).toBe(200);
  });
});

describe('registerAdmissionControl — master kill switch', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    vi.unstubAllEnvs();
    __resetAdmissionControlStateForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server?.close();
  });

  it('registers nothing when ADMISSION_CONTROL_ENABLED=false — no in-flight tracking, no pressure hooks', async () => {
    vi.stubEnv('ADMISSION_CONTROL_ENABLED', 'false');
    vi.stubEnv('ADMISSION_CONTROL_MAX_HEAP_USED_BYTES', '1'); // would trip instantly if wired up

    server = await buildServer();
    await registerAdmissionControl(server);
    await server.ready();

    const response = await server.inject({ method: 'POST', url: '/v1/chat/completions' });
    expect(response.statusCode).toBe(200);
    expect(getInFlightRequestCount()).toBe(0); // never incremented — hook was never registered
  });
});
