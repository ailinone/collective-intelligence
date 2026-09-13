// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dedicated BullMQ Worker Bootstrap
 *
 * Runs outside the API process to provide horizontal scalability.
 * Mirrors the core initialization path from the API entrypoint but skips
 * HTTP server startup.
 */

import http from 'node:http';
import { register } from 'prom-client';
import { config, validateConfig } from '@/config';
import { logger } from '@/utils/logger';
import { checkDatabaseHealth, connectDatabase, disconnectDatabase } from '@/database/client';
import { markSecretAuditPersistenceReady } from '@/services/secret-audit-service';
import { initializeCacheRuntime, isCacheEnabled } from '@/cache/cache-runtime-state';
import { serializeError } from '@/utils/type-guards';
import { authorizeWorkerMetricsScrape } from './worker-metrics-auth';
import { createWorkerHttpHandler } from './worker-http-handler';
import {
  getQueueRuntimeState,
  initializeQueueRuntime,
  isQueueEnabled,
} from '@/queue/queue-runtime-state';

async function bootstrapWorker(): Promise<void> {
  try {
    import('reflect-metadata');
    logger.info('🚀 Starting BullMQ worker process');

    // Initialize secrets manager
    logger.info('Initializing Secrets Manager...');
    const { initializeSecretsManager, shutdownSecretsManager } =
      await import('@/config/secrets-manager.js');
    await initializeSecretsManager(config.secrets);
    logger.info('✅ Secrets Manager initialized');

    // Load GCP secrets into process.env — documented call order in
    // load-secrets-into-env.ts is initializeSecretsManager() →
    // loadSecretsIntoEnv() → validateConfig(). index.ts (the API
    // entrypoint) already does this; this worker entrypoint never did.
    //
    // 2026-09-08 incident root cause: model-discovery-hourly and
    // pricing-integrity-check (register-scheduled-jobs.ts) execute their
    // payload in THIS process, and every native/hub fetcher in
    // central-model-discovery-service.ts reads its credential straight off
    // process.env.<PROVIDER>_API_KEY at call time (e.g. openai-native,
    // anthropic-native, aws-bedrock-hub, orqai-hub, edenai-hub, ai302-hub,
    // routeway-hub). Without this call those env vars stayed empty for the
    // entire lifetime of the worker process — even though every affected
    // GCP secret was present and ENABLED (verified via `gcloud secrets
    // versions list`) — so discovery could never authenticate, every
    // affected provider's catalog rows went unconfirmed past the 14-day
    // threshold, and pricing-integrity-job.ts's autoDisableDelistedModels()
    // mass-disabled 19,875 models believing they had been delisted. See
    // pricing-integrity-job.ts and central-model-discovery-service.ts for
    // the accompanying fixes this incident also required.
    logger.info('Loading provider/critical secrets from GCP into environment...');
    const { loadSecretsIntoEnv } = await import('@/config/load-secrets-into-env.js');
    await loadSecretsIntoEnv();
    logger.info('✅ Secrets loaded into environment');

    // Validate configuration
    validateConfig();
    logger.info('✅ Configuration validated');

    initializeCacheRuntime(config.cache.enabled);
    initializeQueueRuntime(config.queue);

    if (!isQueueEnabled()) {
      const runtime = getQueueRuntimeState();
      logger.warn(
        { reason: runtime.reason, details: runtime.details },
        'Queue runtime disabled - worker process exiting'
      );
      return;
    }

    // Initialize metrics (optional for worker-side Prometheus scraping)
    let metricsServer: http.Server | null = null;

    if (process.env.PROMETHEUS_ENABLED !== 'false') {
      logger.info('Initializing Prometheus metrics for worker...');
      const { initializeMetrics } = await import('@/utils/metrics.js');
      initializeMetrics();
      metricsServer = http.createServer(
        createWorkerHttpHandler({
          authorizeScrape: authorizeWorkerMetricsScrape,
          metricsRegister: register,
          checkDatabaseHealth,
          scrapeTokenConfigured: !!config.observability.prometheusToken,
        })
      );
      await new Promise<void>((resolve, reject) => {
        metricsServer!.listen(config.queue.workerMetricsPort, '0.0.0.0', () => {
          logger.info(
            { port: config.queue.workerMetricsPort },
            '✅ Worker metrics server listening'
          );
          resolve();
        });
        metricsServer!.on('error', reject);
      });
      logger.info('✅ Prometheus metrics initialized for worker');
    }

    if (config.observability.otelEnabled) {
      logger.info('Initializing OpenTelemetry for worker...');
      const { initializeOpenTelemetry } = await import('@/observability/opentelemetry.js');
      await initializeOpenTelemetry();
      logger.info('✅ OpenTelemetry initialized for worker');
    }

    if (process.env.SENTRY_DSN) {
      logger.info('Initializing Sentry error tracking for worker...');
      const { initializeErrorTracking } = await import('@/utils/error-tracking.js');
      initializeErrorTracking();
      logger.info('✅ Sentry error tracking initialized for worker');
    }

    if (isCacheEnabled()) {
      logger.info('Connecting to Redis...');
      const { checkRedisHealth } = await import('@/cache/redis-client.js');
      const redisHealth = await checkRedisHealth();
      if (!redisHealth.healthy) {
        throw new Error(`Redis health check failed: ${redisHealth.error}`);
      }
      logger.info({ latency: redisHealth.latency }, '✅ Redis connection established');
    }

    // Connect to Postgres
    logger.info('Connecting to PostgreSQL...');
    await connectDatabase();
    markSecretAuditPersistenceReady();
    logger.info('✅ Database connection established');

    // Initialize provider registry
    logger.info('Initializing provider registry...');
    const { initializeProviderRegistry, setProviderRegistry } =
      await import('@/providers/provider-registry.js');
    const providerRegistry = await initializeProviderRegistry(config.providers);
    setProviderRegistry(providerRegistry);
    logger.info('✅ Provider registry initialized');

    // Initialize orchestration engine
    logger.info('Initializing orchestration engine...');
    const { OrchestrationEngine, setOrchestrationEngine } =
      await import('@/core/orchestration/orchestration-engine.js');
    const orchestrationEngine = new OrchestrationEngine({
      providerRegistry,
      defaultStrategy: config.orchestration.defaultStrategy,
      enableAutoSelection: true,
      enableTriaging: config.orchestration.enableTriaging,
      triageModel: config.orchestration.triageModel,
      triageTemperature: config.orchestration.triageTemperature,
      triageMaxTokens: config.orchestration.triageMaxTokens,
    });
    // Set global instance for access from services
    setOrchestrationEngine(orchestrationEngine);
    logger.info('✅ Orchestration engine ready');

    // Register tools in the Tool Registry — the HTTP entrypoint (index.ts)
    // does this at boot, but this worker entrypoint never did: any queued
    // request with tool_calls failed with 'Tool registry not yet
    // initialized', and the triage prompt's tool catalog rendered as
    // 'None available' (so triage could never recommend tools) only in
    // worker processes — same request, different behavior per process.
    logger.info('Registering tools in Tool Registry...');
    const { registerToolsInRegistry } = await import('@/services/chat-request-processor.js');
    registerToolsInRegistry();

    // Keep-warm: same catalog/selection refresh-ahead the HTTP entrypoint
    // runs — queued requests go through the same selection path and paid
    // the same cold-cache penalty here.
    const { startCacheRefreshAhead } = await import('@/services/cache-refresh-ahead.js');
    startCacheRefreshAhead(orchestrationEngine);

    // Start workers
    logger.info('Starting BullMQ workers...');
    const { setupChatRequestWorkers } = await import('./chat-request-worker.js');
    await setupChatRequestWorkers(orchestrationEngine);

    // Start batch worker
    const { setupBatchWorker } = await import('./batch-worker.js');
    await setupBatchWorker();

    // Start thread run worker (Assistants API)
    const { setupThreadRunWorkers } = await import('./thread-run-worker.js');
    await setupThreadRunWorkers(orchestrationEngine);

    logger.info('✅ BullMQ workers running (chat, batch, thread-runs)');

    // R1 fix: Start outbox poller in worker process too (ADR-001)
    try {
      const { startOutboxPoller } = await import('@/infrastructure/events/outbox-poller.js');
      const { initializeDIContainer } = await import('@/di/container.js');
      initializeDIContainer();
      const { setupEventSubscriptions, getEventBus } =
        await import('@/infrastructure/events/event-subscriptions.js');
      setupEventSubscriptions();
      await startOutboxPoller(getEventBus());
      logger.info('✅ Outbox poller started in worker process');
    } catch (err) {
      logger.warn({ err }, 'Failed to start outbox poller in worker');
    }

    // R2 fix: Start scheduled tasks worker (ADR-002)
    try {
      const { registerScheduledJobs, startScheduledTasksWorker } =
        await import('@/jobs/register-scheduled-jobs.js');
      await registerScheduledJobs();
      await startScheduledTasksWorker();
      logger.info('✅ Scheduled tasks worker started');
    } catch (err) {
      logger.warn({ err }, 'Failed to start scheduled tasks worker');
    }

    const shutdown = async (signal: NodeJS.Signals) => {
      logger.info({ signal }, 'Received shutdown signal');
      // R5 fix: Shutdown remediation infrastructure
      try {
        const { stopOutboxPoller } = await import('@/infrastructure/events/outbox-poller.js');
        await stopOutboxPoller();
      } catch {
        /* non-fatal */
      }
      try {
        const { shutdownDLQManager } = await import('@/queue/dlq-manager.js');
        await shutdownDLQManager();
      } catch {
        /* non-fatal */
      }
      try {
        const { shutdownScheduledTasks } = await import('@/jobs/register-scheduled-jobs.js');
        await shutdownScheduledTasks();
      } catch {
        /* non-fatal */
      }

      const { requestQueueService } = await import('@/services/request-queue-service.js');
      await requestQueueService.stopWorkers();

      // Stop batch worker
      const { stopBatchWorker } = await import('./batch-worker.js');
      await stopBatchWorker();

      // Stop thread run worker
      const { stopThreadRunWorkers } = await import('./thread-run-worker.js');
      await stopThreadRunWorkers();

      if (metricsServer) {
        await new Promise<void>((resolve, reject) => {
          metricsServer!.close((err) => (err ? reject(err) : resolve()));
        });
      }

      if (isCacheEnabled()) {
        const { disconnectRedis } = await import('@/cache/redis-client.js');
        await disconnectRedis();
      }

      if (config.observability.otelEnabled) {
        const { shutdownOpenTelemetry } = await import('@/observability/opentelemetry.js');
        await shutdownOpenTelemetry();
      }

      await disconnectDatabase();
      await shutdownSecretsManager();
      logger.info('👋 Worker shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    logger.fatal({ error }, 'Worker bootstrap failed');
    process.exit(1);
  }
}

bootstrapWorker().catch((error) => {
  logger.fatal({ error: serializeError(error) }, 'Unhandled error during worker bootstrap');
  process.exit(1);
});
