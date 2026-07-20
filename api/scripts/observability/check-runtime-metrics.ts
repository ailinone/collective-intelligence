// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Runtime Metrics Validation Script
 *
 * Validates that the production metrics endpoint is reachable and exposes the
 * required Prometheus metrics for enterprise observability.
 *
 * Usage:
 *   METRICS_URL=https://api.ailin.one METRICS_PATH=/metrics pnpm tsx scripts/observability/check-runtime-metrics.ts
 *
 * Optional environment variables:
 *   - METRICS_BEARER_TOKEN: Bearer token for protected metrics endpoints
 *   - METRICS_EXPECTED_METRICS: Comma-separated list to override required metrics
 */

import { setTimeout as delay } from 'timers/promises';

// Metrics that MUST be present on a healthy production /metrics endpoint.
// These are the names actually emitted by the app (see src/utils/metrics.ts and
// prom-client `collectDefaultMetrics({ prefix: 'ailin_dev_' })`). The previous
// list asserted `ailin_request_*` / `ailin_queue_depth` / `ailin_quality_score_gauge`
// names that no instrumentation ever produces, so the gate could only ever
// fail (or was silently never run). Each entry below is verified to be emitted:
//   - http RED metrics come from the Fastify onResponse hook (registerHttpMetrics)
//   - process_/nodejs_ metrics come from collectDefaultMetrics with the ailin_dev_ prefix
const DEFAULT_METRICS = [
  'ailin_dev_http_request_duration_seconds_bucket',
  'ailin_dev_http_requests_total',
  'ailin_dev_process_resident_memory_bytes',
  'ailin_dev_process_cpu_seconds_total',
  'ailin_dev_nodejs_eventloop_lag_seconds',
];

function parseRequiredMetrics(): string[] {
  const custom = process.env.METRICS_EXPECTED_METRICS;
  if (!custom) {
    return DEFAULT_METRICS;
  }
  return custom
    .split(',')
    .map((metric) => metric.trim())
    .filter(Boolean);
}

async function fetchMetrics(url: string, bearerToken?: string, retries = 3): Promise<string> {
  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt < retries) {
    attempt += 1;
    try {
      const response = await fetch(url, {
        headers: bearerToken
          ? {
              Authorization: `Bearer ${bearerToken}`,
            }
          : undefined,
      });

      if (!response.ok) {
        throw new Error(`Metrics endpoint responded with status ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error as Error;
      console.warn(
        `[metrics] Attempt ${attempt} failed: ${lastError.message}. Retrying in 2 seconds...`
      );
      await delay(2000);
    }
  }

  throw lastError ?? new Error('Failed to fetch metrics');
}

function validateMetricsPayload(payload: string, expectedMetrics: string[]): void {
  const lines = payload
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const missing: string[] = [];

  for (const metric of expectedMetrics) {
    const exists = lines.some((line) => line.startsWith(metric));
    if (!exists) {
      missing.push(metric);
    }
  }

  if (missing.length > 0) {
    const error = missing
      .map((metric) => `  - ${metric}`)
      .join('\n');
    throw new Error(
      `Metrics endpoint is missing required metrics:\n${error}\n` +
        'Ensure the Prometheus exporter is correctly configured and all instrumentation is enabled.'
    );
  }
}

function validateLatencyBuckets(payload: string, metricName: string): void {
  const bucketLines = payload
    .split('\n')
    .filter((line) => line.startsWith(`${metricName}_bucket`));

  if (bucketLines.length === 0) {
    console.warn(
      `[metrics] Warning: no histogram buckets found for ${metricName}. ` +
        'Ensure Histogram metrics are not converted/dropped by the exporter.'
    );
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.METRICS_URL ?? 'http://localhost:3000';
  const metricsPath = process.env.METRICS_PATH ?? '/metrics';
  const bearerToken = process.env.METRICS_BEARER_TOKEN;
  const timeoutMs = Number(process.env.METRICS_TIMEOUT_MS ?? '10000');

  const url = new URL(metricsPath, baseUrl).toString();
  console.log(`[metrics] Validating Prometheus endpoint: ${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = await fetchMetrics(url, bearerToken);
    const requiredMetrics = parseRequiredMetrics();

    validateMetricsPayload(payload, requiredMetrics);
    validateLatencyBuckets(payload, 'ailin_dev_http_request_duration_seconds');
    validateLatencyBuckets(payload, 'ailin_dev_model_selection_duration_seconds');

    console.log('âœ… Metrics endpoint validation passed');
  } catch (error) {
    console.error('âŒ Metrics endpoint validation failed:', (error as Error).message);
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((error) => {
  console.error('âŒ Metrics validation encountered an unexpected error:', error);
  process.exit(1);
});



