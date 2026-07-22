// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '@/config';
import { getMetrics } from '@/utils/metrics';
import { getErrorMessage, extractErrorCodeFromObject, getHeaderString } from '@/utils/type-guards';

function extractBearerToken(authorization?: string): string | undefined {
  if (!authorization) return undefined;
  const parts = authorization.split(' ');
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
    return parts[1];
  }
  return authorization;
}

/**
 * Gate the Prometheus scrape endpoints. Secure-by-default:
 *
 *  - If `PROMETHEUS_SCRAPE_TOKEN` is configured → the caller must present the
 *    matching Bearer token (any environment).
 *  - If NO token is configured:
 *      • production (`NODE_ENV === 'production'`) → DENY (403). An unauthenticated
 *        /metrics endpoint leaks operational/cardinality data, so production
 *        refuses to serve it until a token is set. This is fail-closed.
 *      • non-production (dev/test/local) → ALLOW, so local scraping and tests
 *        work without ceremony.
 *
 * Returns `true` when the request is authorized to proceed; otherwise it has
 * already sent the 403 response and the caller must return immediately.
 */
function authorizeScrape(request: FastifyRequest, reply: FastifyReply): boolean {
  const expectedToken = config.observability.prometheusToken;
  const isProduction = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

  if (!expectedToken) {
    if (isProduction) {
      request.log.warn(
        { requestId: request.id },
        'Metrics scrape denied: PROMETHEUS_SCRAPE_TOKEN is not configured in production'
      );
      reply.status(403).send({
        error: {
          code: 'forbidden',
          message:
            'Metrics endpoint is disabled in production until PROMETHEUS_SCRAPE_TOKEN is configured',
        },
      });
      return false;
    }
    // Non-production with no token configured: open for local/dev scraping.
    return true;
  }

  const provided = extractBearerToken(getHeaderString(request.headers, 'authorization'));
  if (provided !== expectedToken) {
    reply.status(403).send({
      error: {
        code: 'forbidden',
        message: 'Invalid or missing scrape token',
      },
    });
    return false;
  }
  return true;
}

/**
 * Rate-limit the scrape endpoints themselves.
 *
 * `/metrics` and `/metrics/prompts` are intentionally listed in both
 * `OPERATIONAL_ROUTE_PATHS` (token-bucket-rate-limit.ts) and `PUBLIC_ROUTES`
 * (api-key-auth-middleware.ts), so the product-level rate limiters that run
 * as global preHandler hooks deliberately skip them — that's correct, it
 * stops Kubernetes probes / Prometheus scrapes from draining a customer's
 * per-key/per-user/per-org quota. But it also means these two routes carry
 * NO rate limiting of any kind: a caller who knows the scrape token (or, in
 * non-production, doesn't even need one) could hammer the metrics-generation
 * path freely.
 *
 * This is a small self-contained in-process sliding window — the same
 * "local fallback" idiom already used for the Redis-outage path in
 * api-key-rate-limit-middleware.ts — rather than the shared Redis-backed
 * tokenBucketManager: that manager is wired for the *product* rate limiters,
 * and this endpoint is deliberately exempt from product state, so it needs
 * its own independent, lightweight counter, not a dependency on Redis or the
 * full app config. Keyed by source IP + route, sized well above normal
 * Prometheus scrape cadences (typically 15-60s) so legitimate scraping is
 * unaffected.
 */
const SCRAPE_RATE_LIMIT_WINDOW_MS = 60_000; // 60s
const SCRAPE_RATE_LIMIT_MAX = 30; // generous vs. typical 15-60s scrape interval
const SCRAPE_RATE_LIMIT_MAX_KEYS = 1_000; // safety cap against unbounded growth

const scrapeRequestWindows = new Map<string, number[]>();

function enforceMetricsScrapeRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  routeTag: string
): boolean {
  const identifier = `${routeTag}:${request.ip || 'unknown'}`;
  const now = Date.now();
  const windowStart = now - SCRAPE_RATE_LIMIT_WINDOW_MS;

  let timestamps = scrapeRequestWindows.get(identifier);
  if (!timestamps) {
    if (scrapeRequestWindows.size >= SCRAPE_RATE_LIMIT_MAX_KEYS) {
      const oldestKey = scrapeRequestWindows.keys().next().value;
      if (oldestKey !== undefined) scrapeRequestWindows.delete(oldestKey);
    }
    timestamps = [];
  }
  const pruned = timestamps.filter((t) => t > windowStart);

  if (pruned.length >= SCRAPE_RATE_LIMIT_MAX) {
    scrapeRequestWindows.set(identifier, pruned);
    const retryAfterSeconds = Math.max(1, Math.ceil((pruned[0] + SCRAPE_RATE_LIMIT_WINDOW_MS - now) / 1000));
    reply.header('Retry-After', retryAfterSeconds.toString());
    reply.status(429).send({
      error: {
        code: 'rate_limit_exceeded',
        message: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
      },
    });
    return false;
  }

  pruned.push(now);
  scrapeRequestWindows.set(identifier, pruned);
  return true;
}

export async function registerMetricsRoute(server: FastifyInstance): Promise<void> {
  server.get(
    '/metrics',
    {
      logLevel: 'warn', // Only log warnings and errors, not info/debug
      schema: {
        hide: true,
        response: {
          200: { type: 'string' },
          403: { type: 'object' },
        },
      },
      // Configure error handling for this route
      errorHandler: (error: unknown, request, reply) => {
        // Safely extract error message and code without type assertions
        const errorMessage = getErrorMessage(error);
        const errorCode = extractErrorCodeFromObject(error);
        
        // Handle premature close errors silently for metrics endpoint
        // This is expected behavior for Prometheus scraping
        if (
          errorMessage.toLowerCase() === 'premature close' ||
          errorCode === 'ERR_STREAM_PREMATURE_CLOSE'
        ) {
          request.log.debug(
            { requestId: request.id },
            'Metrics endpoint: client connection closed (normal for Prometheus scraping)'
          );
          
          // Don't send response if connection is already closed
          if (!reply.sent && !reply.raw.destroyed) {
            try {
              reply.raw.destroy();
            } catch {
              // Ignore errors when destroying already closed connections
            }
          }
          return;
        }
        
        // For other errors, use default handler
        throw error;
      },
    },
    async (request, reply) => {
      if (!enforceMetricsScrapeRateLimit(request, reply, 'metrics')) return reply;
      if (!authorizeScrape(request, reply)) return reply;

      try {
        const payload = await getMetrics();
        reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        
        // Check if connection is still open before sending
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.send(payload);
        } else {
          // Connection was closed by client (normal for scraping)
          request.log.debug({ requestId: request.id }, 'Metrics endpoint: connection closed before send');
        }
      } catch (error: unknown) {
        // Safely extract error message and code without type assertions
        const errorMessage = getErrorMessage(error);
        const errorCode = extractErrorCodeFromObject(error);
        
        // Handle premature close errors gracefully
        if (
          errorMessage.toLowerCase() === 'premature close' ||
          errorCode === 'ERR_STREAM_PREMATURE_CLOSE'
        ) {
          request.log.debug(
            { requestId: request.id },
            'Metrics endpoint: client connection closed during metrics generation'
          );
          return;
        }
        
        // Re-throw other errors
        throw error;
      }
    }
  );

  // F5-OBS: Prompt-layer metrics (slots, variants, augmentation, judges, selector, triage)
  // Served as a separate endpoint so Prometheus can scrape it independently of the
  // OpenTelemetry /metrics endpoint above. Uses the same auth gate.
  server.get(
    '/metrics/prompts',
    {
      logLevel: 'warn',
      schema: { hide: true, response: { 200: { type: 'string' }, 403: { type: 'object' } } },
    },
    async (request, reply) => {
      if (!enforceMetricsScrapeRateLimit(request, reply, 'metrics-prompts')) return reply;
      if (!authorizeScrape(request, reply)) return reply;

      const { exportPromptMetricsAsPrometheus, PROMETHEUS_CONTENT_TYPE } = await import(
        '@/core/orchestration/prompts/prompt-metrics-exporter.js'
      );
      reply.header('Content-Type', PROMETHEUS_CONTENT_TYPE);
      reply.send(exportPromptMetricsAsPrometheus());
    },
  );
}
