// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prometheus Metrics
 * Comprehensive metrics collection for production monitoring
 */

import promClient from 'prom-client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { logger } from './logger';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

const log = logger.child({ component: 'metrics' });
const metricsServiceName = process.env.SERVICE_NAME || process.env.OTEL_SERVICE_NAME || 'ci-api';

/**
 * Helper function to get or create a metric
 * Prevents duplicate registration errors when module is reloaded (e.g., in tests)
 */
function getOrCreateMetric<T extends promClient.Metric>(
  name: string,
  createFn: () => T
): T {
  const existing = promClient.register.getSingleMetric(name);
  if (existing) {
    return existing as T;
  }
  return createFn();
}

/**
 * Initialize Prometheus client.
 *
 * `prom-client` registers the default-metrics collector on a global
 * registry. Once `collectDefaultMetrics` runs, the collector keeps
 * sampling on its own interval — we don't need to hold a handle. The
 * idempotency guard below ensures we don't double-register on hot reload.
 */
let metricsInitialized = false;

export function initializeMetrics(): void {
  if (metricsInitialized) {
    return; // Already initialized
  }

  // Check if default metrics are already being collected
  const existingDefaultMetrics = promClient.register.getMetricsAsArray().find(
    (metric) => metric.name.startsWith('ailin_dev_process_') || metric.name.startsWith('ailin_dev_nodejs_')
  );

  if (!existingDefaultMetrics) {
    // Enable default metrics (CPU, memory, event loop, etc) only if not already collected.
    // The handle is intentionally not retained — see comment above.
    promClient.collectDefaultMetrics({
      prefix: 'ailin_dev_',
      labels: { service: metricsServiceName },
    });
  } else {
    log.debug('Default metrics already collected, skipping initialization');
  }

  metricsInitialized = true;
  log.info('✅ Prometheus metrics initialized');
}

/**
 * Reset metrics (useful for tests). `register.clear()` releases any
 * existing default-metrics interval, so we just need to flip the
 * idempotency flag for the next initialize call.
 */
export function resetMetrics(): void {
  promClient.register.clear();
  metricsInitialized = false;
  log.debug('Metrics registry cleared');
}

/**
 * HTTP Request Metrics
 */
export const httpRequestDuration = getOrCreateMetric(
  'ailin_dev_http_request_duration_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
    })
);

export const httpRequestTotal = getOrCreateMetric(
  'ailin_dev_http_requests_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
    })
);

export const httpRequestErrors = getOrCreateMetric(
  'ailin_dev_http_request_errors_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_http_request_errors_total',
      help: 'Total HTTP request errors',
      labelNames: ['method', 'route', 'error_type'],
    })
);

/**
 * Multi-Model Selection Metrics
 */
export const modelSelectionDuration = getOrCreateMetric(
  'ailin_dev_model_selection_duration_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_model_selection_duration_seconds',
      help: 'Time spent selecting optimal model for request',
      labelNames: ['task_type', 'strategy_used'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    })
);

export const modelSelectionCacheHits = getOrCreateMetric(
  'ailin_dev_model_selection_cache_hits_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_model_selection_cache_hits_total',
      help: 'Total model selection cache hits',
      labelNames: ['task_type'],
    })
);

export const modelSelectionCacheMisses = getOrCreateMetric(
  'ailin_dev_model_selection_cache_misses_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_model_selection_cache_misses_total',
      help: 'Total model selection cache misses',
      labelNames: ['task_type'],
    })
);

export const modelSelected = getOrCreateMetric(
  'ailin_dev_models_selected_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_models_selected_total',
      help: 'Total models selected by task type and provider',
      labelNames: ['task_type', 'model_name', 'provider', 'reason'],
    })
);

export const orchestrationStrategyUsed = getOrCreateMetric(
  'ailin_dev_orchestration_strategies_used_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_orchestration_strategies_used_total',
      help: 'Total orchestration strategies used',
      labelNames: ['strategy_name', 'task_type', 'model_count'],
    })
);

/**
 * LLM Provider Metrics
 */
export const llmRequestDuration = getOrCreateMetric(
  'ailin_dev_llm_request_duration_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_llm_request_duration_seconds',
      help: 'LLM provider request duration in seconds',
      labelNames: ['provider', 'model', 'status'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
    })
);

export const llmRequestTotal = getOrCreateMetric(
  'ailin_dev_llm_requests_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_llm_requests_total',
      help: 'Total LLM provider requests',
      labelNames: ['provider', 'model', 'status'],
    })
);

export const llmRequestErrors = getOrCreateMetric(
  'ailin_dev_llm_request_errors_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_llm_request_errors_total',
      help: 'Total LLM provider errors',
      labelNames: ['provider', 'model', 'error_type'],
    })
);

export const llmTokensUsed = getOrCreateMetric(
  'ailin_dev_llm_tokens_used_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_llm_tokens_used_total',
      help: 'Total LLM tokens used',
      labelNames: ['provider', 'model', 'type'],
    })
);

export const llmCostUSD = getOrCreateMetric(
  'ailin_dev_llm_cost_usd_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_llm_cost_usd_total',
      help: 'Total LLM cost in USD',
      labelNames: ['provider', 'model'],
    })
);

/**
 * Orchestration Metrics
 */
export const orchestrationExecutions = getOrCreateMetric(
  'ailin_dev_orchestration_executions_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_orchestration_executions_total',
      help: 'Total orchestration executions',
      labelNames: ['strategy', 'status'],
    })
);

export const orchestrationDuration = getOrCreateMetric(
  'ailin_dev_orchestration_duration_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_orchestration_duration_seconds',
      help: 'Orchestration execution duration in seconds',
      labelNames: ['strategy', 'num_models'],
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    })
);

export const modelsPerRequest = getOrCreateMetric(
  'ailin_dev_models_per_request',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_models_per_request',
      help: 'Number of models used per request',
      buckets: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    })
);

/**
 * Cache Metrics
 */
export const cacheHits = getOrCreateMetric(
  'ailin_dev_cache_hits_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_cache_hits_total',
      help: 'Total cache hits',
      labelNames: ['cache_type', 'key_prefix'],
    })
);

export const cacheMisses = getOrCreateMetric(
  'ailin_dev_cache_misses_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_cache_misses_total',
      help: 'Total cache misses',
      labelNames: ['cache_type', 'key_prefix'],
    })
);

export const cacheLatency = getOrCreateMetric(
  'ailin_dev_cache_latency_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_cache_latency_seconds',
      help: 'Cache operation latency in seconds',
      labelNames: ['cache_type', 'operation'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    })
);

/**
 * Context Caching Metrics (Prompt/Context Cache for LLM)
 */
export const contextCacheHits = getOrCreateMetric(
  'ailin_dev_context_cache_hits_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_context_cache_hits_total',
      help: 'Total context cache hits (Redis or PostgreSQL)',
      labelNames: ['cache_layer', 'ttl'],
    })
);

export const contextCacheMisses = getOrCreateMetric(
  'ailin_dev_context_cache_misses_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_context_cache_misses_total',
      help: 'Total context cache misses (context not found or expired)',
    })
);

export const contextCacheCreated = getOrCreateMetric(
  'ailin_dev_context_cache_created_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_context_cache_created_total',
      help: 'Total cached contexts created',
      labelNames: ['ttl'],
    })
);

export const contextCacheTokens = getOrCreateMetric(
  'ailin_dev_context_cache_tokens_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_context_cache_tokens_total',
      help: 'Total tokens saved in context cache',
      labelNames: ['operation'],
    })
);

export const contextCacheOperationDuration = getOrCreateMetric(
  'ailin_dev_context_cache_operation_duration_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_context_cache_operation_duration_seconds',
      help: 'Context cache operation duration in seconds',
      labelNames: ['operation'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    })
);

export const contextCacheSize = getOrCreateMetric(
  'ailin_dev_context_cache_size_tokens',
  () =>
    new promClient.Gauge({
      name: 'ailin_dev_context_cache_size_tokens',
      help: 'Current total tokens in context cache (approximate)',
      labelNames: ['organization_id'],
    })
);

/**
 * Database Metrics
 */
export const dbQueryDuration = getOrCreateMetric(
  'ailin_dev_db_query_duration_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_db_query_duration_seconds',
      help: 'Database query duration in seconds',
      labelNames: ['operation', 'table'],
      buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5],
    })
);

export const dbConnectionPoolSize = getOrCreateMetric(
  'ailin_dev_db_connection_pool_size',
  () =>
    new promClient.Gauge({
      name: 'ailin_dev_db_connection_pool_size',
      help: 'Current database connection pool size',
      labelNames: ['state'], // active, idle
    })
);

export const dbErrors = getOrCreateMetric(
  'ailin_dev_db_errors_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_db_errors_total',
      help: 'Total database errors',
      labelNames: ['error_type'],
    })
);

export const dbSlowQueries = getOrCreateMetric(
  'ailin_dev_db_slow_queries_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_db_slow_queries_total',
      help: 'Total slow database queries (>500ms)',
      labelNames: ['operation', 'table'],
    })
);

/**
 * Circuit Breaker Metrics
 */
export const circuitBreakerState = getOrCreateMetric(
  'ailin_dev_circuit_breaker_state',
  () =>
    new promClient.Gauge({
      name: 'ailin_dev_circuit_breaker_state',
      help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
      labelNames: ['name'],
    })
);

export const circuitBreakerFailures = getOrCreateMetric(
  'ailin_dev_circuit_breaker_failures_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_circuit_breaker_failures_total',
      help: 'Total circuit breaker failures',
      labelNames: ['name'],
    })
);

export const circuitBreakerStateChanges = getOrCreateMetric(
  'ailin_dev_circuit_breaker_state_changes_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_circuit_breaker_state_changes_total',
      help: 'Total circuit breaker state changes',
      labelNames: ['name', 'from_state', 'to_state'],
    })
);

/**
 * Queue Metrics
 */
export const queueSize = getOrCreateMetric(
  'ailin_dev_queue_size',
  () =>
    new promClient.Gauge({
      name: 'ailin_dev_queue_size',
      help: 'Current queue size',
      labelNames: ['queue_name'],
    })
);

export const queueProcessed = getOrCreateMetric(
  'ailin_dev_queue_processed_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_queue_processed_total',
      help: 'Total jobs processed from queue',
      labelNames: ['queue_name', 'status'],
    })
);

export const queueWaitTime = getOrCreateMetric(
  'ailin_dev_queue_wait_time_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_queue_wait_time_seconds',
      help: 'Time jobs spent waiting in queue',
      labelNames: ['queue_name'],
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
    })
);

/**
 * Cost Optimization Metrics
 */
export const costSavings = getOrCreateMetric(
  'ailin_dev_cost_savings_usd_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_cost_savings_usd_total',
      help: 'Total cost savings in USD through optimization',
      labelNames: ['optimization_type'],
    })
);

export const costPerRequest = getOrCreateMetric(
  'ailin_dev_cost_per_request_usd',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_cost_per_request_usd',
      help: 'Distribution of cost per request in USD',
      labelNames: ['strategy'],
      buckets: [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
    })
);

/**
 * Security Metrics
 */
export const securityEventsTotal = getOrCreateMetric(
  'ailin_dev_security_events_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_security_events_total',
      help: 'Total security audit events recorded',
      labelNames: ['event_type', 'severity', 'has_organization'],
    })
);

/**
 * Billing Metrics
 */
export const billingInvoicesTotal = getOrCreateMetric(
  'ailin_dev_billing_invoices_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_billing_invoices_total',
      help: 'Total invoices processed by the billing service',
      labelNames: ['source', 'status'],
    })
);

export const billingRevenueUsd = getOrCreateMetric(
  'ailin_dev_billing_revenue_usd_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_billing_revenue_usd_total',
      help: 'Total invoiced revenue in USD',
    })
);

export const billingSubscriptionEvents = getOrCreateMetric(
  'ailin_dev_billing_subscription_events_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_billing_subscription_events_total',
      help: 'Billing subscription lifecycle events',
      labelNames: ['event'],
    })
);

/**
 * API Key Job Metrics (v5.0)
 */
export const apiKeyJobDuration = getOrCreateMetric(
  'ailin_dev_api_key_job_duration_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_api_key_job_duration_seconds',
      help: 'API key maintenance job duration in seconds',
      labelNames: ['job'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    })
);

export const apiKeyRevokedTotal = getOrCreateMetric(
  'ailin_dev_api_key_revoked_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_api_key_revoked_total',
      help: 'Total API keys revoked',
      labelNames: ['reason'],
    })
);

export const apiKeyRotatedTotal = getOrCreateMetric(
  'ailin_dev_api_key_rotated_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_api_key_rotated_total',
      help: 'Total API keys rotated',
      labelNames: ['reason'],
    })
);

export const apiKeyJobErrors = getOrCreateMetric(
  'ailin_dev_api_key_job_errors_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_api_key_job_errors_total',
      help: 'Total API key job errors',
      labelNames: ['job', 'error_type'],
    })
);

/**
 * Training Data Export Job Metrics (F3.3)
 *
 * Tracks the volume + health of the daily JSONL export that feeds
 * downstream model training (outcomes, shadow evaluations, and the
 * Ailin¹ Collective Coordination Layer signals).
 */
export const trainingDataExportDuration = getOrCreateMetric(
  'ailin_dev_training_data_export_duration_seconds',
  () =>
    new promClient.Histogram({
      name: 'ailin_dev_training_data_export_duration_seconds',
      help: 'Training data export job duration in seconds',
      labelNames: ['stream'],
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300],
    })
);

export const trainingDataExportRowsTotal = getOrCreateMetric(
  'ailin_dev_training_data_export_rows_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_training_data_export_rows_total',
      help: 'Total rows exported from each training-data stream',
      labelNames: ['stream'], // 'outcomes' | 'shadow' | 'collective_runs' | 'collective_signals'
    })
);

export const trainingDataExportErrors = getOrCreateMetric(
  'ailin_dev_training_data_export_errors_total',
  () =>
    new promClient.Counter({
      name: 'ailin_dev_training_data_export_errors_total',
      help: 'Total errors during training-data export by stream and stage',
      labelNames: ['stream', 'stage'], // stage: 'fetch' | 'write' | 'watermark'
    })
);

/**
 * Get Prometheus registry for /metrics endpoint
 */
export function getMetricsRegistry(): typeof promClient.register {
  return promClient.register;
}

/**
 * Get all metrics
 */
export function getMetrics(): Promise<string> {
  return promClient.register.metrics();
}

// Note: resetMetrics is defined at the top of this file

const _METRICS_START_KEY = Symbol('metrics_start');

function resolveRoutePath(request: FastifyRequest): string {
  const routerPath = (request as { routerPath?: string }).routerPath;
  const routeOptions = (request as { routeOptions?: { url?: string } }).routeOptions;
  const context = (request as { context?: { config?: { url?: string } } }).context;
  const url = request.url;
  
  return (
    routerPath ||
    routeOptions?.url ||
    context?.config?.url ||
    (url ? url.split('?')[0] : undefined) ||
    'unknown'
  );
}

export function registerHttpMetrics(server: FastifyInstance): void {
  server.addHook('onRequest', (request, _reply, done) => {
    const extendedRequest = request as ExtendedFastifyRequest;
    extendedRequest.metricsStartTime = process.hrtime.bigint();
    done();
  });

  server.addHook('onResponse', (request, reply, done) => {
    const extendedRequest = request as ExtendedFastifyRequest;
    const start = extendedRequest.metricsStartTime;
    if (typeof start === 'bigint') {
      const end = process.hrtime.bigint();
      const durationSeconds = Number(end - start) / 1_000_000_000;
      const route = resolveRoutePath(request);
      const method = request.method || 'UNKNOWN';
      const statusCode = reply.statusCode ?? 0;

      httpRequestDuration.observe({ method, route, status_code: statusCode }, durationSeconds);
      httpRequestTotal.inc({ method, route, status_code: statusCode });

      if (statusCode >= 400) {
        httpRequestErrors.inc({
          method,
          route,
          error_type: statusCode >= 500 ? 'server_error' : 'client_error',
        });
      }
    }

    done();
  });
}

/**
 * Performance Profiler - Enterprise-grade performance tracking
 * Provides real performance profiling with metrics integration
 */
export interface PerformanceProfiler {
  profile<T>(name: string, fn: () => Promise<T>): Promise<T>;
  profileSync<T>(name: string, fn: () => T): T;
}

class PerformanceProfilerImpl implements PerformanceProfiler {
  private readonly log = logger.child({ component: 'performance-profiler' });

  async profile<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startTime = process.hrtime.bigint();
    try {
      const result = await fn();
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1_000_000;
      const durationSeconds = durationMs / 1000;

      // Record to Prometheus metrics
      llmRequestDuration.observe({ provider: 'internal', model: name, status: 'success' }, durationSeconds);

      // Log slow operations (>1s)
      if (durationMs > 1000) {
        this.log.warn(
          { operation: name, durationMs: durationMs.toFixed(2) },
          `⚠️  Slow operation detected: ${name} took ${durationMs.toFixed(2)}ms (threshold: 1000ms)`
        );
      }

      return result;
    } catch (error) {
      const endTime = process.hrtime.bigint();
      const durationSeconds = Number(endTime - startTime) / 1_000_000_000;
      llmRequestDuration.observe({ provider: 'internal', model: name, status: 'error' }, durationSeconds);
      llmRequestErrors.inc({ provider: 'internal', model: name, error_type: 'execution_error' });
      throw error;
    }
  }

  profileSync<T>(name: string, fn: () => T): T {
    const startTime = process.hrtime.bigint();
    try {
      const result = fn();
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1_000_000;
      const durationSeconds = durationMs / 1000;

      llmRequestDuration.observe({ provider: 'internal', model: name, status: 'success' }, durationSeconds);

      if (durationMs > 1000) {
        this.log.warn(
          { operation: name, durationMs: durationMs.toFixed(2) },
          `⚠️  Slow operation detected: ${name} took ${durationMs.toFixed(2)}ms`
        );
      }

      return result;
    } catch (error) {
      const endTime = process.hrtime.bigint();
      const durationSeconds = Number(endTime - startTime) / 1_000_000_000;
      llmRequestDuration.observe({ provider: 'internal', model: name, status: 'error' }, durationSeconds);
      llmRequestErrors.inc({ provider: 'internal', model: name, error_type: 'execution_error' });
      throw error;
    }
  }
}

let profilerInstance: PerformanceProfiler | null = null;

/**
 * Get singleton instance of PerformanceProfiler
 * Enterprise pattern: Singleton for shared services
 */
export function getPerformanceProfiler(): PerformanceProfiler {
  if (!profilerInstance) {
    profilerInstance = new PerformanceProfilerImpl();
  }
  return profilerInstance;
}
