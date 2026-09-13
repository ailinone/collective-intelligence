// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Request handler for the worker's raw node:http server (queue-runner.ts).
 *
 * Extracted so the routes are testable without booting the worker (which
 * connects to Postgres/Redis/BullMQ at module load). Routes:
 * - `/metrics`: Prometheus scrape, gated by the scrape token.
 * - `/health`: liveness only (process is up), unauthenticated.
 * - `/health/ready`: readiness; runs the same `checkDatabaseHealth()` the
 *   api's `/health/ready` uses (circuit-breaker protected) so the Swarm
 *   healthcheck has a real database gate during a pooler canary. Bounded by
 *   a short timeout so a hung pool acquisition cannot outlive the compose
 *   healthcheck's own `timeout`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface WorkerHttpHandlerDeps {
  authorizeScrape: (req: IncomingMessage) => boolean;
  metricsRegister: { metrics(): Promise<string>; readonly contentType: string };
  checkDatabaseHealth: () => Promise<boolean>;
  scrapeTokenConfigured: boolean;
  /** Must stay below the compose healthcheck `timeout` (10 s). */
  readinessTimeoutMs?: number;
}

export const DEFAULT_WORKER_READINESS_TIMEOUT_MS = 5000;

export type WorkerHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

async function checkReadiness(
  checkDatabaseHealth: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([checkDatabaseHealth().catch(() => false), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createWorkerHttpHandler(deps: WorkerHttpHandlerDeps): WorkerHttpHandler {
  const readinessTimeoutMs = deps.readinessTimeoutMs ?? DEFAULT_WORKER_READINESS_TIMEOUT_MS;

  return async (req, res) => {
    if (req.url === '/metrics') {
      if (!deps.authorizeScrape(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'forbidden',
              message: deps.scrapeTokenConfigured
                ? 'Invalid or missing scrape token'
                : 'Metrics endpoint is disabled in production until PROMETHEUS_SCRAPE_TOKEN is configured',
            },
          })
        );
        return;
      }
      const data = await deps.metricsRegister.metrics();
      res.writeHead(200, {
        'Content-Type': deps.metricsRegister.contentType,
        'Content-Length': Buffer.byteLength(data),
      });
      res.end(data);
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.url === '/health/ready') {
      const ready = await checkReadiness(deps.checkDatabaseHealth, readinessTimeoutMs);
      if (ready) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ready');
      } else {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('database unavailable');
      }
      return;
    }

    res.writeHead(404);
    res.end();
  };
}
