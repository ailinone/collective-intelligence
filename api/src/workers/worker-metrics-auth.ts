// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Scrape-token gate for the worker's raw node:http metrics server
 * (queue-runner.ts) — the same fail-closed contract as
 * api/src/routes/metrics/metrics-route.ts's authorizeScrape(), reimplemented
 * against a plain http.IncomingMessage since this server predates Fastify
 * entirely and has no request/reply types to share.
 *
 * Split into its own side-effect-free module (rather than living inline in
 * queue-runner.ts) so it's unit-testable in isolation: queue-runner.ts calls
 * bootstrapWorker() at module load, so importing it directly in a test would
 * trigger real DB/secrets-manager initialization.
 */
import type { IncomingMessage } from 'node:http';
import { config } from '@/config';
import { getHeaderString } from '@/utils/type-guards';

function extractBearerToken(authorization?: string): string | undefined {
  if (!authorization) return undefined;
  const parts = authorization.split(' ');
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
    return parts[1];
  }
  return authorization;
}

/**
 * `/health` is deliberately NOT gated by this function — matches the api
 * service's own unauthenticated health/ready endpoints, needed for container
 * healthchecks that don't carry the scrape token. Only call this for `/metrics`.
 */
export function authorizeWorkerMetricsScrape(req: IncomingMessage): boolean {
  const expectedToken = config.observability.prometheusToken;
  const isProduction = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

  if (!expectedToken) {
    return !isProduction;
  }

  const provided = extractBearerToken(getHeaderString(req.headers, 'authorization'));
  return provided === expectedToken;
}
