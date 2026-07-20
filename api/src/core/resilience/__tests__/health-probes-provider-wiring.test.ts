// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Hermetic test for GET /health/providers (scale-to-100k Phase 2 follow-up,
 * issue #152) — verifies health-probes.ts surfaces distributed
 * circuit-breaker/bulkhead stats without touching /health/ready's existing
 * ready/not_ready verdict logic (which intentionally only considers
 * database/redis, per that route's own comment).
 *
 * Deliberately placed under core/resilience/__tests__ rather than under
 * src/routes/ next to health-probes.ts itself — this repo's
 * vitest.ci.config.ts excludes anything under a __tests__ directory inside
 * src/routes/ as "route integration tests" (real DB via testcontainers),
 * but this test is fully mocked (no DB/Redis touched) and belongs in the
 * fast hermetic unit run instead.
 *
 * Uses a real Fastify instance + .inject() (no HTTP server bound).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const { getAllCircuitStatsMock, getAllBulkheadStatsMock } = vi.hoisted(() => ({
  getAllCircuitStatsMock: vi.fn(),
  getAllBulkheadStatsMock: vi.fn(),
}));

vi.mock('@/database/client', () => ({
  checkDatabaseHealth: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/cache/redis-client', () => ({
  checkRedisHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));
vi.mock('@/utils/circuit-breaker', () => ({
  circuitBreakers: { getAllStatus: vi.fn().mockReturnValue({}) },
}));
vi.mock('@/core/resilience/distributed-circuit-breaker', () => ({
  distributedCircuitBreakerManager: { getAllStats: getAllCircuitStatsMock },
}));
vi.mock('@/core/resilience/distributed-bulkhead', () => ({
  distributedBulkheadManager: { getAllStats: getAllBulkheadStatsMock },
}));

const { registerHealthProbes } = await import('@/routes/health/health-probes');

describe('GET /health/providers', () => {
  beforeEach(() => {
    getAllCircuitStatsMock.mockReset();
    getAllBulkheadStatsMock.mockReset();
  });

  it('returns circuit-breaker and bulkhead stats from the distributed managers', async () => {
    getAllCircuitStatsMock.mockResolvedValue([
      { name: 'openai-api', state: 'CLOSED', failures: 0 },
    ]);
    getAllBulkheadStatsMock.mockResolvedValue([
      { name: 'openai', mode: 'distributed', activeLeases: 3, maxConcurrent: 20 },
    ]);

    const app = Fastify();
    registerHealthProbes(app);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/health/providers' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.circuitBreakers).toEqual([{ name: 'openai-api', state: 'CLOSED', failures: 0 }]);
    expect(body.bulkheads).toEqual([
      { name: 'openai', mode: 'distributed', activeLeases: 3, maxConcurrent: 20 },
    ]);
    expect(body.timestamp).toBeDefined();

    await app.close();
  });

  it('returns empty arrays (not an error) when no providers have been initialized yet', async () => {
    getAllCircuitStatsMock.mockResolvedValue([]);
    getAllBulkheadStatsMock.mockResolvedValue([]);

    const app = Fastify();
    registerHealthProbes(app);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/health/providers' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.circuitBreakers).toEqual([]);
    expect(body.bulkheads).toEqual([]);

    await app.close();
  });

  it('does not change /health/ready to depend on provider circuit-breaker state', async () => {
    getAllCircuitStatsMock.mockResolvedValue([{ name: 'openai-api', state: 'OPEN', failures: 99 }]);
    getAllBulkheadStatsMock.mockResolvedValue([]);

    const app = Fastify();
    registerHealthProbes(app);
    await app.ready();

    // A provider breaker being OPEN must not affect /health/ready — only
    // database/redis criticality does (see health-probes.ts's own comment).
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ready');

    await app.close();
  });
});
