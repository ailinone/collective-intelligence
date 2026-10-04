// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SAB plan Phase 1b contract: the Swarm healthchecks of api and worker are
 * liveness-only and never touch the database, and the database gate lives
 * in the boot sequence instead (startup-db-check.ts), ordered so a task
 * that cannot reach Postgres exits before its healthcheck can pass.
 *
 * Why it matters: /health/ready ran SELECT 1 through the shared Prisma pool,
 * whose acquisition wait (20 s) outlasts the healthcheck timeout (10 s); a
 * saturated pool or a slow database got healthy tasks killed and
 * rescheduled. The boot ordering is pinned at the source level (same
 * technique as queue-runner-secrets-wiring.test.ts) because the entrypoints
 * cannot be booted in a unit test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const { checkDatabaseHealthMock, checkRedisHealthMock } = vi.hoisted(() => ({
  // Hangs forever: if /health/live ever awaited it, the inject below would time out.
  checkDatabaseHealthMock: vi.fn(() => new Promise<boolean>(() => {})),
  checkRedisHealthMock: vi.fn(() => new Promise<{ healthy: boolean }>(() => {})),
}));

vi.mock('@/database/client', () => ({
  checkDatabaseHealth: checkDatabaseHealthMock,
}));
vi.mock('@/cache/redis-client', () => ({
  checkRedisHealth: checkRedisHealthMock,
}));
vi.mock('@/utils/circuit-breaker', () => ({
  circuitBreakers: { getAllStatus: vi.fn().mockReturnValue({}) },
}));
vi.mock('@/core/resilience/distributed-circuit-breaker', () => ({
  distributedCircuitBreakerManager: { getAllStats: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/core/resilience/distributed-bulkhead', () => ({
  distributedBulkheadManager: { getAllStats: vi.fn().mockResolvedValue([]) },
}));

const { registerHealthProbes } = await import('@/routes/health/health-probes');

const API_SRC = join(__dirname, '..', '..');
const REPO_ROOT = join(API_SRC, '..', '..');
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

// The public mirror does not export the production compose; modules under test that
// parse it are gated below, so an absent file degrades to an empty string here.
const COMPOSE_PATH = join(REPO_ROOT, 'docker', 'docker-compose.production.yml');
const compose = existsSync(COMPOSE_PATH) ? readFileSync(COMPOSE_PATH, 'utf8') : '';

/** Text of one top-level service block (`  <name>:` up to the next one). */
function serviceBlock(name: string): string {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `service ${name} not found in docker-compose.production.yml`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^[A-Za-z]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function healthcheckUrl(service: string): string {
  const block = serviceBlock(service);
  const match = block.match(/\n {4}healthcheck:\n {6}test:[\s\S]*?fetch\('([^']+)'\)/);
  expect(match, `no fetch() healthcheck in service ${service}`).not.toBeNull();
  return match![1];
}

/** The production compose is not exported to the public mirror; parse-contract only applies where the file exists. */
const describeCompose = existsSync(join(REPO_ROOT, 'docker', 'docker-compose.production.yml')) ? describe : describe.skip;
describeCompose('docker-compose.production.yml healthchecks are liveness-only', () => {
  it('api probes /health/live', () => {
    expect(healthcheckUrl('api')).toBe('http://127.0.0.1:3000/health/live');
  });

  it('worker probes the liveness-only /health of its metrics server', () => {
    expect(healthcheckUrl('worker')).toBe('http://127.0.0.1:9465/health');
  });

  it('neither service points its healthcheck at a database-backed route', () => {
    for (const service of ['api', 'worker']) {
      expect(healthcheckUrl(service)).not.toMatch(/\/health\/(ready|startup)$/);
    }
  });
});

describe('the probed routes never touch the database', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    registerHealthProbes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('api /health/live answers 200 while the database and redis checks hang', async () => {
    checkDatabaseHealthMock.mockClear();
    checkRedisHealthMock.mockClear();

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('alive');
    expect(checkDatabaseHealthMock).not.toHaveBeenCalled();
    expect(checkRedisHealthMock).not.toHaveBeenCalled();
  });

  it('worker /health stays liveness-only in worker-http-handler.ts', () => {
    const handler = read(API_SRC, 'workers', 'worker-http-handler.ts');
    const branch = handler.slice(
      handler.indexOf("if (req.url === '/health') {"),
      handler.indexOf("if (req.url === '/health/ready') {")
    );
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).not.toMatch(/checkDatabaseHealth|checkReadiness|prisma/);
  });
});

describe('the database gate runs at boot, before the healthcheck can pass', () => {
  it('client.ts probes the same runtime target as the raw pg pools', () => {
    const client = read(API_SRC, 'database', 'client.ts');
    const fn = client.slice(client.indexOf('export async function verifyDatabaseReachableAtStartup'));
    expect(fn).toMatch(/getRuntimeDatabaseUrl\(\)/);
    expect(fn).toMatch(/createPgSelectOneProbe\(/);
    expect(fn).toMatch(/runStartupDatabaseCheck\(/);
  });

  it('index.ts runs it before migrations, outside the SKIP_DB_MIGRATIONS branch, and before listen', () => {
    const index = read(API_SRC, 'index.ts');
    const gate = index.indexOf('await verifyDatabaseReachableAtStartup()');
    const skipBranch = index.indexOf("if (process.env.SKIP_DB_MIGRATIONS !== 'true')");
    const connect = index.indexOf('await connectDatabase()');
    const listen = index.indexOf('await startServer(server)');

    expect(gate).toBeGreaterThan(-1);
    expect(skipBranch).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(skipBranch);
    expect(gate).toBeLessThan(connect);
    expect(gate).toBeLessThan(listen);
  });

  it('queue-runner.ts runs it before the metrics/health server listens and before connectDatabase()', () => {
    const runner = read(API_SRC, 'workers', 'queue-runner.ts');
    const gate = runner.indexOf('await verifyDatabaseReachableAtStartup()');
    const server = runner.indexOf('http.createServer(');
    const listen = runner.indexOf('.listen(config.queue.workerMetricsPort');
    const connect = runner.indexOf('await connectDatabase()');

    expect(gate).toBeGreaterThan(-1);
    expect(server).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(server);
    expect(gate).toBeLessThan(listen);
    expect(gate).toBeLessThan(connect);
  });
});
