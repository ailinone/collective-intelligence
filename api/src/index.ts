// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin Dev API - Entry Point
 * Enterprise Multi-Model LLM Orchestration Gateway
 */

// === DNS resolver override ===
// Optional override for environments where the system resolver is broken.
// In Docker Desktop the embedded resolver at 127.0.0.11 forwards to upstream
// servers, but under concurrent load returns EAI_AGAIN burst-failures that
// the orchestrator's retry budget can't always cover. Setting
// DNS_OVERRIDE_SERVERS="8.8.8.8,1.1.1.1" bypasses the system resolver
// entirely for this Node process. Production should leave this unset and
// rely on the host's resolver.
//
// NOTE: `dns.setServers` only affects `dns.resolve*` (c-ares). Node's
// `fetch` (undici) uses `dns.lookup` → OS getaddrinfo, which IGNORES
// this setting. For environments where UDP/53 outbound is blocked
// (Docker Desktop on Windows, observed 2026-05-11), use
// DNS_TCP_FALLBACK_SERVERS instead — that path installs a TCP-only
// resolver into undici's global dispatcher so fetch works.
import dns from 'node:dns';
const __dnsOverride = process.env.DNS_OVERRIDE_SERVERS;
if (__dnsOverride) {
  const servers = __dnsOverride.split(',').map((s) => s.trim()).filter(Boolean);
  if (servers.length > 0) {
    try {
      dns.setServers(servers);
      // eslint-disable-next-line no-console
      console.log('[dns] override applied:', dns.getServers());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[dns] override failed:', err);
    }
  }
}

// Prefer IPv4 in containers where IPv6 outbound is broken (Docker
// Desktop defaults). Harmless when IPv6 is available — just orders A
// records before AAAA from getaddrinfo.
dns.setDefaultResultOrder?.('ipv4first');

import { config, validateConfig } from '@/config';
import { logger } from '@/utils/logger';
import { connectDatabase, disconnectDatabase } from '@/database/client';
import { markSecretAuditPersistenceReady } from '@/services/secret-audit-service';
import { createServer, startServer, shutdownServer } from './server';
import {
  disableCacheRuntime,
  initializeCacheRuntime,
  isCacheEnabled,
} from '@/cache/cache-runtime-state';
import { getQueueRuntimeState, initializeQueueRuntime } from '@/queue/queue-runtime-state';
import { providerAvailabilityService } from '@/services/provider-availability-service';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { serializeError } from '@/utils/type-guards';
import type { ProviderRegistry } from '@/providers/provider-registry';

/**
 * Global safety net for Google Auth unhandled rejections.
 *
 * Context: When ADC is missing/expired, `@google-cloud/*` SDKs spawn
 * background gRPC stub promises (via google-gax) that reject asynchronously
 * outside any caller's try/catch. With --unhandled-rejections=strict (Node 20+
 * default), these kill the process even though our secrets-loader handled
 * the visible error.
 *
 * This handler intercepts ONLY Google-Auth-related rejections, logs them,
 * and prevents process death. Everything else still crashes (which is good
 * behavior — we don't want a blanket catch-all swallowing real bugs).
 *
 * This is defense in depth: the primary fix is the ADC preflight in
 * gcp-provider.ts. This handler covers rejections that still escape from
 * OTHER Google SDK clients instantiated lazily by the framework.
 */
function installGoogleAuthSafetyNet(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : String(reason);
    const isGoogleAuthFailure =
      message.includes('Could not load the default credentials') ||
      message.includes('Could not refresh access token') ||
      message.includes('Could not automatically determine credentials') ||
      message.includes('Application Default Credentials') ||
      message.includes('NO_ADC_FOUND') ||
      message.includes('invalid_rapt') ||
      message.includes('invalid_grant');

    if (isGoogleAuthFailure) {
      logger.warn(
        {
          component: 'google-auth-safety-net',
          error: message,
          advice:
            'Background Google Auth rejection suppressed. Server continues in degraded mode. ' +
            'Fix: gcloud auth application-default login (local) or Workload Identity Federation (prod).',
        },
        '⚠️ Google Auth background rejection intercepted — preventing process death'
      );
      return;
    }

    // Re-throw everything else so real bugs still surface
    logger.error({ reason: String(reason) }, 'Unhandled promise rejection');
    throw reason;
  });
}

/**
 * Main application bootstrap
 */
async function bootstrap(): Promise<void> {
  installGoogleAuthSafetyNet();
  try {
    initializeCacheRuntime(config.cache.enabled);
    initializeQueueRuntime(config.queue);

    // ==========================================
    // Phase 0a: Network bootstrap (TCP-DNS fallback)
    // MUST be first so subsequent fetches resolve hostnames correctly
    // in containers where UDP/53 is blocked (Docker Desktop). Idempotent
    // and no-op when DNS_TCP_FALLBACK_SERVERS is unset.
    // ==========================================
    try {
      const { installTcpDnsFallback } = await import('./network/dns-bootstrap.js');
      const dnsResult = await installTcpDnsFallback();
      logger.info(dnsResult, dnsResult.installed
        ? '✅ TCP-DNS fallback active'
        : 'TCP-DNS fallback skipped (UDP/53 assumed working)');
    } catch (err) {
      logger.warn({ err: serializeError(err) }, 'TCP-DNS fallback bootstrap failed (non-fatal)');
    }

    // ==========================================
    // Phase 0: Initialize Reflect Metadata (v5.1)
    // MUST be first - DI container needs it
    // ==========================================
    await import('reflect-metadata');
    logger.info('✅ Reflect metadata loaded');

    // ==========================================
    // Phase 1: Initialize Secrets Manager (v5.0)
    // MUST be second - other services need secrets
    // ==========================================
    logger.info('Initializing Secrets Manager...');
    const { initializeSecretsManager } = await import('./config/secrets-manager.js');
    await initializeSecretsManager(config.secrets);
    logger.info('✅ Secrets Manager initialized');

    // ==========================================
    // Phase 1.5: Load Secrets into Environment (v5.1)
    // Load critical secrets from GCP into process.env
    // This allows existing config system to work
    // ==========================================
    logger.info('Loading secrets from GCP into environment...');
    const { loadSecretsIntoEnv } = await import('./config/load-secrets-into-env.js');
    await loadSecretsIntoEnv();
    logger.info('✅ Secrets loaded from GCP into environment');

    // Validate configuration
    logger.info('Validating configuration...');
    validateConfig();
    logger.info('✅ Configuration valid');

    // Validate security configuration
    logger.info('Validating security configuration...');
    const { validateSecurityConfig } = await import('./config/security-config.js');
    validateSecurityConfig();
    logger.info('✅ Security configuration valid');

    // ==========================================
    // Phase 5 — production boot guard
    // ==========================================
    // The pre-Phase-0 default was for every plugin to run a per-startup
    // discovery probe (Anthropic /v1/models, Google /models, etc.). At
    // 80+ catalog providers this serialized into 8-minute container
    // boots and SwarmKit health-check timeouts. The fix is the
    // SKIP_PER_PLUGIN_DISCOVERY=true gate, which defers per-plugin
    // probes to the central-discovery-service's batched aggregator. In
    // production the gate MUST be set explicitly so a regression that
    // forgets the env var fails loud at boot rather than producing a
    // slow-but-running container that the orchestrator eventually kills.
    if (process.env.NODE_ENV === 'production' && process.env.SKIP_PER_PLUGIN_DISCOVERY !== 'true') {
      const message =
        'SKIP_PER_PLUGIN_DISCOVERY must be explicitly set to "true" in production — ' +
        'unset would re-enable per-plugin discovery and serialize boot to 8+ minutes ' +
        '(see plan: Phase 5 boot guard).';
      logger.error({ env: process.env.NODE_ENV }, message);
      throw new Error(message);
    }
    logger.info(
      { skipPerPluginDiscovery: process.env.SKIP_PER_PLUGIN_DISCOVERY === 'true' },
      '✅ Phase 5 boot guard passed',
    );

    // Initialize provider availability (credentials) before touching adapters
    providerAvailabilityService.initializeFromEnv();
    providerAvailabilityService.logSummary();

    // Phase 2: Initialize Universal Model Client
    // Multi-provider model testing framework
    // ==========================================
    logger.info('Initializing Universal Model Client...');
    const { initializeUniversalClient } = await import('./client/bootstrap.js');
    initializeUniversalClient();
    logger.info('✅ Universal Model Client initialized');

    let httpMetricsRegistered = false;
    if (process.env.PROMETHEUS_ENABLED !== 'false') {
      logger.info('Initializing Prometheus metrics...');
      const { initializeMetrics } = await import('./utils/metrics.js');
      initializeMetrics();
      httpMetricsRegistered = true;
      logger.info('✅ Prometheus metrics initialized');
    }

    if (config.observability.otelEnabled) {
      logger.info('Initializing OpenTelemetry...');
      const { initializeOpenTelemetry } = await import('./observability/opentelemetry.js');
      await initializeOpenTelemetry();
      logger.info('✅ OpenTelemetry initialized');
    }

    // Initialize Sentry error tracking
    if (process.env.SENTRY_DSN) {
      logger.info('Initializing Sentry error tracking...');
      const { initializeErrorTracking } = await import('./utils/error-tracking.js');
      initializeErrorTracking();
      logger.info('✅ Sentry error tracking initialized');
    }

    // Initialize cache invalidation
    if (isCacheEnabled()) {
      logger.info('Initializing cache invalidation service...');
      // Dynamic import for ESM compatibility
      const { initializeCacheInvalidation } = await import('@/cache/cache-invalidation.js');
      await initializeCacheInvalidation();
      logger.info('✅ Cache invalidation service initialized');
    }

    // Log startup info
    logger.info(
      {
        service: config.observability.serviceName,
        env: config.env,
        port: config.server.port,
        build: {
          version: config.app.version,
          commitSha: config.app.commitSha ?? 'unknown',
          buildTimestamp: config.app.buildTimestamp ?? 'unknown',
        },
        providers: config.providers.map((provider) => provider.name),
        orchestration: config.orchestration,
      },
      'Starting Ailin Dev API'
    );

    // CRITICAL: Always run database migrations before connecting
    // This ensures schema is up-to-date in all environments (dev, staging, production)
    // Migrations are safe to run multiple times (idempotent)
    // TEMPORARILY DISABLED for development (Prisma 7 config issue)
    if (process.env.SKIP_DB_MIGRATIONS !== 'true') {
      logger.info('Running database migrations...');
      try {
        const { runMigrations } = await import('./database/client.js');
        await runMigrations();
        logger.info('✅ Database migrations applied successfully');
      } catch (error: unknown) {
        const { getErrorMessage } = await import('./utils/type-guards.js');
        const errorMessage = getErrorMessage(error);
        logger.error({ error: errorMessage }, 'Failed to apply database migrations');
        // Database migrations are critical - fail fast if they fail
        throw new Error(`Database migration failed: ${errorMessage}. Cannot start server.`);
      }
    } else {
      logger.warn('⚠️ Database migrations skipped (SKIP_DB_MIGRATIONS=true)');
    }

    // Connect to database
    logger.info('Connecting to database...');
    await connectDatabase();

    if (process.env.RBAC_SYNC_ON_BOOT !== 'false') {
      logger.info('Synchronizing default RBAC roles and permissions...');
      const { syncDefaultRoles } = await import('./services/rbac-sync-service.js');
      await syncDefaultRoles();
      logger.info('✅ Default RBAC roles synchronized');
    } else {
      logger.warn('RBAC synchronization skipped on boot (RBAC_SYNC_ON_BOOT=false)');
    }

    markSecretAuditPersistenceReady();
    logger.info('Secret audit persistence enabled');

    if (process.env.MODEL_CATALOG_AUTO_SYNC !== 'false') {
      logger.info('Starting 100% dynamic model discovery in background (non-blocking)...');
      try {
        const { ModelDiscoveryService } = await import('./services/model-discovery-service.js');
        const discoveryService = new ModelDiscoveryService(logger);

        // Start discovery in background to avoid blocking startup
        discoveryService.syncDiscoveredModels()
          .then((result) => {
            logger.info(
              {
                discovered: result.discovered,
                updated: result.updated,
                unchanged: result.unchanged,
              },
              '✅ Dynamic model discovery completed in background - 0 hardcoded models'
            );
          })
          .catch((error) => {
            logger.warn({ error: serializeError(error) }, 'Model discovery failed in background (non-critical, will retry later)');
          });

        // Verify no hardcoded models exist
        const { getAllCatalogModels } = await import('./services/model-catalog-service.js');
        const syncedModels = await getAllCatalogModels();
        logger.info(
          { modelCount: syncedModels.length, source: '100% dynamic discovery' },
          'Model catalog verified - all models from dynamic discovery'
        );

        if (syncedModels.length === 0) {
          logger.warn('⚠️ WARNING: No models discovered. This may indicate provider API issues or missing API keys.');
          logger.warn('The API will continue to start, but model availability may be limited.');
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error(
          { error: errorMessage, stack: errorStack },
          '❌ CRITICAL: Dynamic model discovery failed'
        );
        logger.error('The API will continue to start, but models may not be available.');
        logger.error('Check provider API keys and network connectivity.');
        // Don't throw - allow API to start even if sync fails (graceful degradation)
      }
    } else {
      logger.warn('Model catalog auto-sync disabled via MODEL_CATALOG_AUTO_SYNC');
    }

    try {
      const { startModelDiscoveryRunner } = await import('./services/model-discovery-runner.js');
      await startModelDiscoveryRunner();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Failed to start dynamic model discovery runner');
    }

    // Connect to Redis (if cache enabled)
    if (config.cache.enabled) {
      logger.info('Connecting to Redis...');
      const { checkRedisHealth } = await import('@/cache/redis-client.js');
      const health = await checkRedisHealth();

      if (health.healthy) {
        logger.info({ latency: health.latency }, '✅ Redis connected');
      } else {
        logger.warn({ error: health.error }, '⚠️ Redis connection failed - cache disabled');
        disableCacheRuntime('redis_connection_failed', health.error);
      }
    }

    // Wire the operability health sync bus (Phase 2 control plane).
    // Cross-instance synchronization of ProviderHealthRegistry deltas via
    // Redis pub/sub. Two distinct connections required (subscribe is
    // exclusive on its connection). Failure is non-fatal — bus is no-op
    // and the local registry continues to work.
    if (config.cache.enabled && process.env.OPERABILITY_HEALTH_SYNC_ENABLED !== 'false') {
      try {
        const { getRedisClient, createRedisClient } = await import('@/cache/redis-client.js');
        const { startProviderHealthSync } = await import('@/core/operability');
        const publisher = getRedisClient();
        // createRedisClient() now defaults to the money-path (config.redisQueue)
        // connection (scale-to-100k Phase 5, issue #150) — pub/sub requires the
        // publisher and subscriber to share ONE Redis instance, so this must stay
        // pinned to the general (config.redis) connection the publisher uses,
        // even if an operator points REDIS_QUEUE_* at a separate instance.
        const subscriber = createRedisClient('operability-health-sync-sub', config.redis);
        await startProviderHealthSync({ publisher, subscriber });
        logger.info('✅ Provider health sync bus active (Redis pub/sub)');
      } catch (err) {
        logger.warn(
          { err: serializeError(err) },
          '⚠️ Provider health sync bus failed to start — local registry only',
        );
      }
    }

    // Operability discovery scheduler (Phase 1+3+4 control plane runtime).
    // Reads providers from PROVIDER_CATALOG, runs discovery on a schedule,
    // rebuilds OperationalCandidatePool, and triggers the embedding
    // pipeline so SemanticIndex stays fresh.
    //
    // Failure modes:
    //   - Discovery throws → logged, scheduler continues; pool keeps last
    //     known state.
    //   - Embedding hook throws → logged inside scheduler, pool unaffected.
    //   - TEI unreachable → embedding pipeline no-ops, semantic-resolver
    //     falls back to pool query (no semantic ranking, but path works).
    //
    // Toggle via OPERABILITY_DISCOVERY_SCHEDULER_ENABLED=false (default on).
    // ── ProviderOperabilityHub bootstrap ──────────────────────────────────
    // Seed the hub with every catalog provider that has a configured API
    // key, so an unprobed-but-known provider reports as `unknown` rather
    // than vanishing from getSummary(). Without this, the pre-dispatch
    // validator sees an empty hub and skips every execution with
    // `no_eligible_providers` before any provider call is even tried.
    // Idempotent — safe to re-call. Runs BEFORE the discovery scheduler
    // so even one-tick failures of discovery don't leave the hub blank.
    try {
      const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub.js');
      const { PROVIDER_CATALOG } = await import('@/providers/catalog/providers.catalog.js');
      const hub = getProviderOperabilityHub();
      const eligibleIds = PROVIDER_CATALOG
        .filter((entry) => entry.enabledByDefault)
        .filter((entry) => !entry.apiKeyEnvVar || !!process.env[entry.apiKeyEnvVar])
        .map((entry) => entry.providerId);
      const result = hub.bootstrapKnownProviders(eligibleIds, 'catalog_bootstrap');
      logger.info(
        {
          added: result.added,
          alreadyKnown: result.alreadyKnown,
          total: result.total,
          catalogSize: PROVIDER_CATALOG.length,
        },
        '✅ ProviderOperabilityHub seeded from catalog',
      );
    } catch (err) {
      logger.warn(
        { err: serializeError(err) },
        '⚠️ ProviderOperabilityHub catalog bootstrap failed — hub may remain empty',
      );
    }

    // ── ProviderOperabilityHub persistence (Camada 1a) ─────────────────────
    // Rehydrate the persisted operability overlay so a restarted process keeps
    // its last-known provider states (the fix for "0 distinct healthy providers"
    // right after a deploy/restart), then start periodic flushing. Best-effort —
    // never blocks or fails boot.
    try {
      const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub.js');
      const hub = getProviderOperabilityHub();
      const { loaded } = await hub.hydrateFromStore();
      hub.startPersistence();
      logger.info({ loaded }, '✅ ProviderOperabilityHub overlay hydrated + persistence started');
    } catch (err) {
      logger.warn(
        { err: serializeError(err) },
        '⚠️ ProviderOperabilityHub persistence init failed (non-fatal)',
      );
    }

    // Pre-warm the catalog cache so the FIRST chat request after boot doesn't pay
    // the full ~64k-row catalog load on the hot path (cold-start mitigation). The
    // single-flight guard in model-catalog-service dedups any concurrent first
    // requests onto this same load. Non-fatal.
    try {
      const { getAllCatalogModels } = await import('@/services/model-catalog-service.js');
      const warmed = await getAllCatalogModels();
      logger.info({ models: warmed.length }, '✅ Catalog cache pre-warmed at boot');
    } catch (err) {
      logger.warn({ err: serializeError(err) }, '⚠️ Catalog pre-warm failed (non-fatal)');
    }

    if (process.env.OPERABILITY_DISCOVERY_SCHEDULER_ENABLED !== 'false') {
      try {
        const {
          getDiscoveryScheduler,
          buildCatalogResolvers,
          rebuildEmbeddingIndex,
        } = await import('@/core/operability');
        const resolvers = buildCatalogResolvers();
        // Clamp interval to safe bounds. Floor 30s prevents runaway probes
        // hammering balance endpoints (some hubs rate-limit their billing
        // API). Ceiling 1h prevents pool from going stale beyond the
        // typical credit-replenish window observed in production.
        const rawInterval = Number(process.env.OPERABILITY_DISCOVERY_INTERVAL_MS);
        const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0
          ? Math.min(Math.max(rawInterval, 30_000), 60 * 60 * 1000)
          : 5 * 60 * 1000;
        const rawInitialDelay = Number(process.env.OPERABILITY_DISCOVERY_INITIAL_DELAY_MS);
        const initialDelayMs = Number.isFinite(rawInitialDelay) && rawInitialDelay >= 0
          ? Math.min(rawInitialDelay, 60_000)
          : 5_000;

        getDiscoveryScheduler().start({
          ...resolvers,
          intervalMs,
          initialDelayMs,
          onPoolRebuilt: async () => {
            try {
              const count = await rebuildEmbeddingIndex();
              logger.info({ embeddingsCount: count }, 'Embedding index rebuilt after pool rebuild');
            } catch (err) {
              logger.warn(
                { err: serializeError(err) },
                'Embedding pipeline rebuild failed — semantic resolver will fall back to pool query',
              );
            }
            // Re-warm the catalog cache right after each discovery rebuild so the heavy
            // ~69k-row catalog load never lands on a chat request's hot path. The cache
            // otherwise expires between sparse requests, forcing a cold re-load that
            // contends with the discovery write burst (the ~32s cold-selection tax).
            // invalidate→reload guarantees the warmed cache reflects the just-rebuilt catalog.
            try {
              const { invalidateCatalogCache, getAllCatalogModels } = await import('@/services/model-catalog-service.js');
              invalidateCatalogCache();
              const warmed = await getAllCatalogModels();
              logger.info({ models: warmed.length }, '✅ Catalog cache re-warmed after discovery rebuild');
            } catch (err) {
              logger.warn({ err: serializeError(err) }, '⚠️ Catalog re-warm after rebuild failed (non-fatal)');
            }
          },
        });
        logger.info(
          { intervalMs, initialDelayMs },
          '✅ Operability discovery scheduler active',
        );
      } catch (err) {
        logger.warn(
          { err: serializeError(err) },
          '⚠️ Operability discovery scheduler failed to start',
        );
      }
    }

    // Initialize provider adapters
    logger.info('Initializing provider adapters...');
    const providerRegistryModule = await import('@/providers/provider-registry.js');
    const { initializeProviderRegistry, setProviderRegistry } = providerRegistryModule as {
      initializeProviderRegistry: (providers: unknown[]) => Promise<ProviderRegistry>;
      setProviderRegistry: (registry: ProviderRegistry) => void;
    };
    const providerRegistry = await initializeProviderRegistry(config.providers);
    setProviderRegistry(providerRegistry);

    // ── Provider catalog: runtime wiring ────────────────────────────────────
    //
    // Load the declarative provider catalog into the runtime registry. The
    // loader translates each catalog entry into a `CatalogProviderPlugin`,
    // drives `init → healthCheck → register` via `providerPluginManager`, and
    // ends with `providerRegistry.register(adapter)` — the same register
    // method the legacy switch calls. Running AFTER `initializeProviderRegistry`
    // leverages the registry's log-and-replace semantics so catalog entries
    // win over any switch-registered duplicate. Once Lot B removes the
    // duplicated switch cases, this ordering becomes a pure no-op relative
    // to correctness — we keep the ordering defensive rather than fragile.
    //
    // `loadProviderCatalog` is designed to never throw (returns a structured
    // summary for every catalog row), but a bug in the dynamic import itself
    // would still surface here — wrap in try/warn/continue like the other
    // optional boot-time initializers (credit monitor, MCP, workers).
    // R7 (2026-05-11): DEFER_CATALOG_LOAD=true defers the catalog load to
    // AFTER server.listen() so /health responds early. The catalog load is
    // expensive: 71 catalog entries × healthCheck timeout (5s default) +
    // discovery, which previously ran sequentially BEFORE Fastify listened,
    // causing /health Connection-refused for 6-30 min during boot.
    const deferCatalogLoad = process.env.DEFER_CATALOG_LOAD === 'true';
    if (!deferCatalogLoad) {
      try {
        const { loadProviderCatalog } = await import('@/providers/catalog/catalog-loader.js');
        const catalogSummary = await loadProviderCatalog();
        logger.info(
          {
            attempted: catalogSummary.attempted,
            registered: catalogSummary.registered,
            skipped: catalogSummary.skipped,
            failed: catalogSummary.failed,
            reasonCounts: catalogSummary.reasonCounts,
          },
          'Provider catalog loaded into runtime registry',
        );
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error(
          { error: errorMessage, stack: errorStack },
          'Provider catalog loader threw — legacy switch-registered adapters unaffected, catalog providers NOT registered',
        );
      }
    } else {
      logger.warn('Provider catalog load DEFERRED (DEFER_CATALOG_LOAD=true) — will run post-listen in background');
    }

    // L4: Start proactive credit monitor (polls provider balances every 5 min)
    // Must be after provider registry initialization so probes can access adapters
    try {
      const { getCreditMonitorService } = await import('./services/credit-monitor-service.js');
      getCreditMonitorService().start();
    } catch (error: unknown) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Failed to start credit monitor (non-critical)');
    }

    // Initialize tool registry (shared between chat processor and strategies)
    logger.info('Registering tools in Tool Registry...');
    const { registerToolsInRegistry } = await import('./services/chat-request-processor.js');
    registerToolsInRegistry();

    // Initialize MCP connections (registers MCP tools in Tool Registry)
    try {
      const { mcpClientService } = await import('./core/mcp/mcp-client-service.js');
      await mcpClientService.initialize();
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'MCP initialization failed (non-fatal)');
    }

    // Initialize orchestration engine
    logger.info('Initializing orchestration engine...');
    const { OrchestrationEngine, setOrchestrationEngine } = await import(
      '@/core/orchestration/orchestration-engine.js'
    );
    const enableFeedbackLoop = process.env.ORCHESTRATION_ENABLE_FEEDBACK_LOOP !== 'false';
    const feedbackIterationsRaw = Number.parseInt(
      process.env.ORCHESTRATION_MAX_FEEDBACK_ITERATIONS || '',
      10
    );
    const maxFeedbackIterations =
      Number.isFinite(feedbackIterationsRaw) && feedbackIterationsRaw > 0
        ? Math.min(5, feedbackIterationsRaw)
        : undefined;
    const feedbackQualityThresholdRaw = Number.parseFloat(
      process.env.ORCHESTRATION_FEEDBACK_QUALITY_THRESHOLD || ''
    );
    const feedbackQualityThreshold =
      Number.isFinite(feedbackQualityThresholdRaw) && feedbackQualityThresholdRaw > 0
        ? Math.min(1, feedbackQualityThresholdRaw)
        : undefined;

    const orchestrationEngine = new OrchestrationEngine({
      providerRegistry,
      defaultStrategy: config.orchestration.defaultStrategy,
      enableAutoSelection: true,
      enableTriaging: config.orchestration.enableTriaging,
      triageModel: config.orchestration.triageModel,
      triageStrategy: config.orchestration.triageStrategy,
      triageCollective: config.orchestration.triageCollective,
      triageTemperature: config.orchestration.triageTemperature,
      triageMaxTokens: config.orchestration.triageMaxTokens,
      enableFeedbackLoop,
      maxFeedbackIterations,
      qualityThreshold: feedbackQualityThreshold,
    });
    // Set global instance for access from services
    setOrchestrationEngine(orchestrationEngine);
    const { configureRequestBatching } = await import('./services/request-batching-service.js');
    configureRequestBatching(orchestrationEngine);

    // Keep-warm: refresh the catalog cache + selection pre-warm on a timer
    // shorter than their TTLs, so no client request lands on a cold cache
    // (measured cold-start: ~22s to first token vs ~1.4s warm).
    const { startCacheRefreshAhead } = await import('./services/cache-refresh-ahead.js');
    startCacheRefreshAhead(orchestrationEngine);

    const queueRuntime = getQueueRuntimeState();
    if (queueRuntime.configuration.runWorkersInApiProcess) {
      if (queueRuntime.enabled) {
        logger.info('Initializing request queue workers (in-process)...');
        const { setupChatRequestWorkers } = await import('./workers/chat-request-worker.js');
        await setupChatRequestWorkers(orchestrationEngine);
        logger.info('✅ Request queue workers initialized within API process');
      } else {
        logger.warn(
          { reason: queueRuntime.reason, details: queueRuntime.details },
          'Queue runtime disabled - skipping in-process worker startup'
        );
      }
    } else {
      logger.info('Skipping in-process queue workers (managed by dedicated worker deployment)');
    }

    // Initialize auto-learning system (v5.0)
    await import('./core/learning/error-learning-system.js');
    const { getLearningScopeConfig } = await import('./config/learning-scope.js');
    const learningScope = getLearningScopeConfig();
    logger.info(
      {
        mode: learningScope.mode,
        offlineReflectionEnabled: learningScope.offlineReflectionEnabled,
        offlineReflectionCron: learningScope.offlineReflectionCron,
        localModelTrainingEnabled: learningScope.localModelTrainingEnabled,
      },
      'Collective learning scope configured'
    );
    if (learningScope.localModelTrainingEnabled) {
      logger.warn(
        'CI_LOCAL_MODEL_TRAINING_ENABLED=true detected; ci/api keeps provider-managed training only'
      );
    }
    logger.info('✅ Auto-learning system initialized (error learning, pattern discovery)');

    // P1-3 / LN-02: longitudinal learning snapshots (bandit α/β, archive
    // fitness, triage calibration) — the evidence trail that the learning
    // systems improve over time. Default ON; LEARNING_SNAPSHOTS_ENABLED=false
    // to disable.
    const { startLearningSnapshotsJob } = await import('./jobs/learning-snapshots-job.js');
    startLearningSnapshotsJob();

    // P4 bridge: own-model (self-hosted vLLM) registry. Default OFF — only
    // polls/registers own models when OWN_MODEL_ENABLED=true AND the serving
    // endpoint is provisioned (see providers/own-model/own-model-registry.ts).
    if (process.env.OWN_MODEL_ENABLED === 'true') {
      try {
        const ownModelRegistry = await import('./providers/own-model/own-model-registry.js');
        await ownModelRegistry.refreshOwnModels();
        ownModelRegistry.startOwnModelPolling();
        logger.info('✅ Own-model registry initialized (OWN_MODEL_ENABLED=true)');
      } catch (ownModelError) {
        logger.warn(
          { error: ownModelError instanceof Error ? ownModelError.message : String(ownModelError) },
          'Own-model registry failed to initialize — continuing without own models'
        );
      }
    }

    // ==========================================
    // Phase 4.5: Initialize Collective Intelligence Services (v5.2)
    // Semantic Memory, Semantic Cache, Reasoning Transparency, Agentic Workflows
    // ==========================================
    logger.info('Initializing Collective Intelligence services...');
    
    // Initialize Semantic Cache (requires Redis)
    if (isCacheEnabled()) {
      try {
        const { getSemanticCache } = await import('./core/cache/semantic-cache.js');
        const semanticCache = getSemanticCache();
        logger.info(`✅ Semantic Cache initialized (enabled: ${semanticCache.isEnabled()})`);
      } catch (err) {
        // An optional cache must never kill the boot: BYO-single-provider
        // deployments have no embedder key, so we run without semantic cache.
        logger.warn(
          { err },
          '⚠️ Semantic Cache disabled — embedder unavailable (set an embedder API key to enable)',
        );
      }
    }

    // Initialize Reasoning Transparency
    const { getReasoningTransparency } = await import('./core/transparency/reasoning-transparency.js');
    getReasoningTransparency();
    logger.info('✅ Reasoning Transparency service initialized');

    // Initialize Self-Critique Engine
    const { getSelfCritiqueEngine } = await import('./core/critique/self-critique-engine.js');
    getSelfCritiqueEngine();
    logger.info('✅ Self-Critique Engine initialized');

    // Initialize Agentic Workflow Engine
    const { getAgenticWorkflowEngine } = await import('./core/agentic/agentic-workflow-engine.js');
    getAgenticWorkflowEngine();
    logger.info('✅ Agentic Workflow Engine initialized');

    // Initialize Thread Run Workers (if queue enabled and in-process workers)
    if (queueRuntime.enabled && queueRuntime.configuration.runWorkersInApiProcess) {
      const { setupThreadRunWorkers } = await import('./workers/thread-run-worker.js');
      await setupThreadRunWorkers(orchestrationEngine);
      logger.info('✅ Thread Run Workers initialized (Assistants API async processing)');
    }

    // Initialize Batch Worker (if queue enabled and in-process workers).
    // Phase 1b fix: this was never started anywhere in the API bootstrap, so
    // POST /v1/batches enqueued jobs onto the batch-processing queue that
    // nothing consumed unless a separate queue-runner deployment was running.
    if (queueRuntime.enabled && queueRuntime.configuration.runWorkersInApiProcess) {
      const { setupBatchWorker } = await import('./workers/batch-worker.js');
      await setupBatchWorker();
      logger.info('✅ Batch Worker initialized (async batch processing)');
    }

    logger.info('✅ Collective Intelligence services ready');

    // ==========================================
    // Phase 5: Initialize DI Container (v5.1)
    // Clean Architecture - Dependency Injection
    // ==========================================
    logger.info('Initializing DI Container...');
    const { initializeDIContainer } = await import('./di/container.js');
    initializeDIContainer();
    logger.info('✅ DI Container initialized (Clean Architecture)');

    // ==========================================
    // Phase 6: Setup Event Bus (v5.1)
    // Event-driven architecture
    // ==========================================
    logger.info('Setting up Event Bus...');
    const { setupEventSubscriptions } = await import(
      './infrastructure/events/event-subscriptions.js'
    );
    setupEventSubscriptions();
    logger.info('✅ Event Bus initialized (3 event handlers registered)');

    // R1 fix: Start outbox poller — delivers domain events from outbox table (ADR-001)
    //
    // R6.2 (2026-05-10): gated by OUTBOX_POLLER_ENABLED env (default true).
    // Setting false disables the poller — domain events are still WRITTEN
    // to the outbox table by their producers, but the poll-and-publish
    // loop doesn't run. Use in dev/staging when the poller's transaction
    // pattern competes with auth queries for the Prisma pool. Should
    // remain enabled in production where the load profile justifies the
    // continuous polling.
    if (process.env.OUTBOX_POLLER_ENABLED !== 'false') {
      try {
        const { startOutboxPoller } = await import('./infrastructure/events/outbox-poller.js');
        const { getEventBus } = await import('./infrastructure/events/event-subscriptions.js');
        await startOutboxPoller(getEventBus());
        logger.info('✅ Outbox poller started');
      } catch (err) {
        logger.warn({ err }, 'Failed to start outbox poller — domain event delivery inactive');
      }
    } else {
      logger.warn('Outbox poller disabled via OUTBOX_POLLER_ENABLED=false — events written but not polled');
    }
    // if (config.autoLearning.enabled) {
    //   logger.info('Initializing auto-learning system...');
    //   await initializeAutoLearning();
    // }

    // Create Fastify server
    logger.info('Creating Fastify server...');
    const server = await createServer();

    // WHY: Register request context first so all downstream middleware and routes
    // can rely on stable requestId/correlationId tracing and standardized errors.
    const { registerRequestContext } = await import('./api/middleware/request-context.js');
    await registerRequestContext(server);
    logger.info('Request context middleware registered (request/correlation tracing + error envelope)');

    if (httpMetricsRegistered) {
      const { registerHttpMetrics } = await import('./utils/metrics.js');
      registerHttpMetrics(server);
      logger.info('✅ HTTP metrics middleware registered');
    }

    // ==========================================
    // Middleware Integration (v5.0)
    // ==========================================

    // API Version Management
    const { registerVersionManagement } = await import('./api/versioning/version-manager.js');
    registerVersionManagement(server);
    logger.info('✅ API version management enabled (v1, v2 support)');

    // ==========================================
    // Enterprise-Grade API Key Authentication
    // ==========================================
    // Real database lookup, security validations, audit logging
    // Supports: 100K+ organizations, millions of API keys, sub-50ms latency
    logger.info('Registering API key authentication middleware...');
    const { apiKeyAuthMiddleware } = await import('./api/middleware/api-key-auth-middleware.js');
    server.addHook('preHandler', apiKeyAuthMiddleware);
    logger.info('✅ API key authentication middleware registered (enterprise-grade with real user lookup)');

    // Token Bucket Rate Limiting (after auth)
    const { createTokenBucketMiddleware } = await import(
      './api/middleware/token-bucket-rate-limit.js'
    );
    const tokenBucketMiddleware = createTokenBucketMiddleware({
      perApiKey: true,
      perIP: true,
      perUser: true, // ✅ ENABLED: Per-user rate limiting
      perOrganization: true, // ✅ ENABLED: Per-organization rate limiting (tier-based)
    });
    server.addHook('preHandler', tokenBucketMiddleware);
    logger.info('✅ Token bucket rate limiting enabled (after auth)');

    // Register API routes
    logger.info('Registering API routes...');

    // Clean Architecture routes (v5.1)
    const { authRoutesClean } = await import('./routes/auth/auth-routes-clean.js');
    const { userRoutes } = await import('./routes/user/user-routes-clean.js');
    const { organizationRoutesClean } = await import(
      './routes/organization/organization-routes-clean.js'
    );
    const { apiKeysRoutesClean } = await import('./routes/api-keys/api-keys-routes-clean.js');
    const { internalApiKeysRoutes } = await import('./routes/internal/internal-api-keys-routes.js');
    const { internalUsageRoutes } = await import('./routes/internal/internal-usage-routes.js');
    const { internalWalletRoutes } = await import('./routes/internal/internal-wallet-routes.js');
    const { projectsRoutesClean } = await import(
      './routes/projects/projects-routes-clean.js'
    );

    // Legacy routes (orchestration endpoints)
    const { registerModelRoutes } = await import('@/routes/models/models-routes.js');
    const { registerChatRoutes, registerCapabilityRoutes } = await import('@/routes/chat/chat-routes.js');
    const { registerCapabilitiesRoutes } = await import('@/routes/capabilities/capabilities-routes.js');
    // ADR-022 — HCRA ontology + model-by-capability search routes.
    // The plugin defines its own auth boundary internally (operational
    // /v1/hcra/health is in the OUTER scope — public; product routes are in
    // a NESTED `register(...)` with `addHook('preHandler', authenticate)`).
    // The auth/rate-limit middleware whitelists already include
    // /v1/hcra/health (see api-key-auth-middleware PUBLIC_ROUTES and
    // token-bucket-rate-limit OPERATIONAL_ROUTE_PATHS).
    const { default: hcraSearchRoutes } = await import('@/routes/capabilities/hcra-search-routes.js');
    // Caminho-C Stage 4: singleton-backed search routes mounted at /v1/capabilities/*.
    // Coexists with /v1/hcra/* (above) during the migration window described in
    // hcra-search-routes.ts. The two backends differ — hcraSearchRoutes uses
    // prisma+embedder directly; this one delegates to CapabilitySearchService
    // (the future canonical home for hybrid retrieval).
    const { registerCapabilitySearchRoutes } = await import(
      '@/routes/capabilities/capabilities-search-routes.js'
    );
    const { registerEmbeddingsRoutes } = await import('@/routes/embeddings/embeddings-routes.js');
    const { registerAudioRoutes } = await import('@/routes/audio/audio-routes.js');
    const { registerVideosRoutes } = await import('@/routes/videos/videos-routes.js');
    const { registerImagesRoutes } = await import('@/routes/images/images-routes.js');
    const { registerSearchRoutes } = await import('@/routes/search/search-routes.js');
    const { registerModerationsRoutes } = await import('@/routes/moderations/moderations-routes.js');
    const { registerFilesRoutes } = await import('@/routes/files/files-routes.js');
    const { registerBatchesRoutes } = await import('@/routes/batches/batches-routes.js');
    const { registerFineTuningRoutes } = await import('@/routes/fine-tuning/fine-tuning-routes.js');
    const { registerAssistantsRoutes } = await import('@/routes/assistants/assistants-routes.js');
    const { registerVectorStoresRoutes } = await import('@/routes/vector-stores/vector-stores-routes.js');
    const { registerThreadsRoutes } = await import('@/routes/threads/threads-routes.js');
    const { registerCodeExecutionRoutes } = await import('@/routes/code-execution/code-execution-routes.js');
    const { registerPDFRoutes } = await import('@/routes/pdf/pdf-routes.js');
    const { registerGoogleMapsRoutes } = await import('@/routes/google-maps/google-maps-routes.js');
    const { registerContextCachingRoutes } = await import('@/routes/context-caching/context-caching-routes.js');
    const { registerExtendedThinkingRoutes } = await import('@/routes/extended-thinking/extended-thinking-routes.js');
    const { registerCollectiveRoutes } = await import('@/routes/collective/collective-routes.js');
    const { registerResponsesRoutes } = await import('@/routes/responses/responses-routes.js');
    const { registerRealtimeRoutes } = await import('@/routes/realtime/realtime-routes.js');
    const { registerUsageRoutes } = await import('@/routes/usage/usage-routes.js');
    const { registerUserManagementRoutes } = await import(
      '@/routes/user/user-management-routes.js'
    );
    const { registerApiKeyRotationRoutes } = await import(
      '@/routes/admin/api-key-rotation-routes.js'
    );
    const codebaseRoutesModule = await import('./routes/codebase/codebase-routes.js');
    const { registerCodebaseRoutes } = codebaseRoutesModule as {
      registerCodebaseRoutes: (server: FastifyInstance) => Promise<void>;
    };
    const codebaseAnalysisRoutesModule = await import('./routes/codebase/codebase-analysis-routes.js');
    const { registerCodebaseAnalysisRoutes } = codebaseAnalysisRoutesModule as {
      registerCodebaseAnalysisRoutes: (server: FastifyInstance) => Promise<void>;
    };
    const enterpriseQuotaRoutesModule = await import('./routes/enterprise/quotas-routes.js');
    const { registerEnterpriseQuotaRoutes } = enterpriseQuotaRoutesModule as {
      registerEnterpriseQuotaRoutes: (server: FastifyInstance) => Promise<void>;
    };
    const enterpriseBillingRoutesModule = await import(
      './routes/enterprise/billing-routes.js'
    );
    const { registerEnterpriseBillingRoutes } = enterpriseBillingRoutesModule as {
      registerEnterpriseBillingRoutes: (server: FastifyInstance) => Promise<void>;
    };
    const { registerBillingWebhookRoutes } = await import(
      './routes/enterprise/billing-webhooks.js'
    );
    const enterpriseUsageAnalyticsRoutesModule = await import(
      './routes/enterprise/usage-analytics-routes.js'
    );
    const { registerEnterpriseUsageAnalyticsRoutes } = enterpriseUsageAnalyticsRoutesModule as {
      registerEnterpriseUsageAnalyticsRoutes: (server: FastifyInstance) => Promise<void>;
    };
    const cacheRoutesModule = await import('./routes/cache/cache-routes.js');
    const { registerCacheRoutes } = cacheRoutesModule as {
      registerCacheRoutes: (server: FastifyInstance) => Promise<void>;
    };
    const queueRoutesModule = await import('./routes/queue/queue-routes.js');
    const { registerQueueRoutes } = queueRoutesModule as {
      registerQueueRoutes: (server: FastifyInstance) => Promise<void>;
    };
    const metricsRouteModule = await import('./routes/metrics/metrics-route.js');
    const { registerMetricsRoute } = metricsRouteModule as {
      registerMetricsRoute: (server: FastifyInstance) => Promise<void>;
    };
    const statusRoutesModule = await import('./routes/status/status-routes.js');
    const { registerStatusRoutes } = statusRoutesModule as {
      registerStatusRoutes: FastifyPluginAsync;
    };
    const toolsRoutesModule = await import('./routes/tools/tools-routes.js');
    const { registerToolsRoutes } = toolsRoutesModule as {
      registerToolsRoutes: (server: FastifyInstance) => Promise<void>;
    };
    const { registerProviderHealthRoutes } = await import('./routes/health/provider-health-routes.js');

    // Register Clean Architecture routes
    console.log('🚀 Registering auth routes...');
    await server.register(authRoutesClean); // v5.1: Login, Register, Refresh
    console.log('✅ Auth routes registered in main server');

    console.log('🚀 Registering user routes...');
    await userRoutes(server); // v5.1: User profile, settings
    console.log('✅ User routes registered in main server');

    // Device Flow Auth Page - implementation pending (device flow web UI)
    // const { registerDeviceFlowPage } = await import('./routes/auth/device-flow-page.js');
    // await registerDeviceFlowPage(server); // Device authorization page

    // Admin routes for invites and SSO management - implementation pending for admin invite module
    // const { registerInvitesAdminRoutes } = await import('./routes/admin/invites-admin-routes.js');
    // await registerInvitesAdminRoutes(server); // Admin invite and SSO management
    await server.register(organizationRoutesClean); // v5.1: Organizations
    await server.register(apiKeysRoutesClean); // v5.1: API Keys
    await server.register(internalApiKeysRoutes); // M2M: BFF-managed PATs (/v1/internal/api-keys, service-token auth)
    await server.register(internalUsageRoutes); // M2M: usage summary for the dev portal dashboard (/v1/internal/usage)
    await server.register(internalWalletRoutes); // M2M: prepaid wallet balance (portal) + top-up (billing) (/v1/internal/wallet/*)
    await server.register(projectsRoutesClean); // Slice 1: Projects (resource-layer sub-entity of Organization)

    // Register legacy/orchestration routes
    await registerModelRoutes(server, providerRegistry);
    await registerChatRoutes(server, orchestrationEngine);
    await registerCapabilityRoutes(server, orchestrationEngine); // Intelligent model selection
    await registerCapabilitiesRoutes(server); // Universal capability routes (execute/stream/health)
    await server.register(hcraSearchRoutes); // ADR-022: HCRA ontology search + operational /v1/hcra/health
    await registerCapabilitySearchRoutes(server); // Caminho-C Stage 4: /v1/capabilities/{ontology,models}/search via CapabilitySearchService singleton
    await registerEmbeddingsRoutes(server, providerRegistry);
    await registerAudioRoutes(server); // Audio API (TTS, STT, Translation)
    await registerVideosRoutes(server); // Videos API (Generation)
    await registerImagesRoutes(server); // Images API (Generation, Edit, Variations)
    await registerSearchRoutes(server); // Search & Grounding API (Tavily + web_search models)
    await registerModerationsRoutes(server); // Moderations API (content safety)
    await registerFilesRoutes(server); // Files API (GCS storage)
    await registerBatchesRoutes(server); // Batch API (async processing)
    await registerFineTuningRoutes(server); // Fine-tuning API (7 endpoints)
    await registerAssistantsRoutes(server); // Assistants API (9 endpoints: 5 CRUD + 4 Files)
    await registerVectorStoresRoutes(server); // Vector Stores API (9 endpoints incl. search)
    await registerThreadsRoutes(server); // Threads API (9 endpoints: 7 CRUD + 2 Steps)
    await registerCodeExecutionRoutes(server); // Code Execution API (sandbox)
    await registerPDFRoutes(server); // PDF Processing API
    await registerGoogleMapsRoutes(server); // Google Maps integration
    await registerContextCachingRoutes(server); // Context Caching (1M tokens)
    await registerExtendedThinkingRoutes(server); // Extended/Ultra Thinking modes
    await registerCollectiveRoutes(server); // F1.6: Collective coordination audit (org-scoped)
    await registerResponsesRoutes(server); // OpenAI Responses API
    await registerRealtimeRoutes(server); // Realtime API (WebSocket)
    const { registerTranslationRoutes } = await import('@/routes/translation/translation-routes.js');
    await registerTranslationRoutes(server); // Translation API (Palabra.ai S2S)
    await registerUsageRoutes(server);
    await registerUserManagementRoutes(server);
    await registerApiKeyRotationRoutes(server); // v5.0: API Key Rotation admin endpoints
    const { registerAdminRoutes } = await import('./routes/admin/admin-routes.js');
    await registerAdminRoutes(server); // Admin routes (users, etc.)
    const { registerBenchmarkAdminRoutes } = await import('./routes/admin/benchmark-admin-routes.js');
    await registerBenchmarkAdminRoutes(server); // Benchmark harness admin (OI-01/02/03)
    const { registerEvaluationAdminRoutes } = await import('./routes/admin/evaluation-admin-routes.js');
    await registerEvaluationAdminRoutes(server); // Closed-loop evaluation admin (drift, learning, outcomes)
    const { registerExperimentAdminRoutes } = await import('./routes/admin/experiment-admin-routes.js');
    await registerExperimentAdminRoutes(server); // Comparative experiment framework (Mode A/B/C)
    const { registerTrainingDataAdminRoutes } = await import('./routes/admin/training-data-admin-routes.js');
    await registerTrainingDataAdminRoutes(server); // F3.3: Ad-hoc training-data export trigger + watermark state
    // R3 fix: DLQ admin routes (ADR-003)
    const { registerDLQAdminRoutes } = await import('./routes/admin/dlq-routes.js');
    await registerDLQAdminRoutes(server);
    // Phase 1-5 control plane diagnostic endpoints
    const { registerOperabilityAdminRoutes } = await import('./routes/admin/operability-admin-routes.js');
    await registerOperabilityAdminRoutes(server);
    // Enterprise governance control plane (budget cap, access policy, audit query)
    const { registerOrgGovernanceRoutes } = await import('./routes/admin/org-governance-routes.js');
    await registerOrgGovernanceRoutes(server);
    const { registerModelsConfigRoutes } = await import('./routes/models/models-config-routes.js');
    await registerModelsConfigRoutes(server); // Models configuration routes
    const { registerOrganizationSettingsRoutes } = await import('./routes/organization/organization-settings-routes.js');
    await registerOrganizationSettingsRoutes(server); // Organization settings routes
    await registerCodebaseRoutes(server);
    await registerCodebaseAnalysisRoutes(server);
    
    // Register admin discovery routes
    const { discoveryRoutes } = await import('./api/routes/admin/discovery.js');
    await discoveryRoutes(server);
    logger.info('✅ Admin discovery routes registered');

    // Broadcast / outbound webhooks (F1, ADR-017) — gated by feature flag.
    // Routes register destinations CRUD + admin (DLQ/erasure). The outbox
    // poller that fans staged traces out to destinations is started below
    // (post-listen background section) when the flag is enabled.
    if (process.env.BROADCAST_FEATURE_ENABLED === 'true') {
      try {
        const { broadcastDestinationsRoutes } = await import(
          './broadcast/api/routes/broadcast-destinations.routes.js'
        );
        const { broadcastAdminRoutes } = await import(
          './broadcast/api/routes/broadcast-admin.routes.js'
        );
        await server.register(broadcastDestinationsRoutes);
        await server.register(broadcastAdminRoutes);
        logger.info('✅ Broadcast routes registered (/v1/broadcast/*, /v1/admin/broadcast/*)');
      } catch (err) {
        logger.warn({ err }, 'Failed to register broadcast routes — broadcast surfaces inactive');
      }
    } else {
      logger.info('Broadcast feature disabled (set BROADCAST_FEATURE_ENABLED=true to enable)');
    }
    await registerEnterpriseQuotaRoutes(server);
    await registerEnterpriseBillingRoutes(server);
    await registerBillingWebhookRoutes(server);
    await registerEnterpriseUsageAnalyticsRoutes(server);
    await registerCacheRoutes(server);
    await registerQueueRoutes(server);
    await registerMetricsRoute(server);
    await server.register(registerStatusRoutes);
    await registerToolsRoutes(server);
    logger.info('✅ Tools API routes registered (50+ tool endpoints)');
    
    await registerProviderHealthRoutes(server);
    logger.info('✅ Provider health check routes registered (/v1/health/providers)');

    // Providers routes
    const { registerProvidersRoutes } = await import('./routes/providers/providers-routes.js');
    await registerProvidersRoutes(server);
    logger.info('✅ Providers routes registered (/v1/providers)');

    // Orchestration routes
    const { registerOrchestrationRoutes } = await import('./routes/orchestration/orchestration-routes.js');
    await registerOrchestrationRoutes(server);
    logger.info('✅ Orchestration routes registered (/v1/orchestration/strategies)');

    // Jobs routes
    const { registerJobsRoutes } = await import('./routes/jobs/jobs-routes.js');
    await registerJobsRoutes(server);
    logger.info('✅ Jobs routes registered (/v1/jobs)');

    // Documentation redirect (Swagger UI is at /docs)
    server.get('/documentation', async (request, reply) => {
      return reply.redirect('/docs');
    });

    // Collective Intelligence routes (v5.2)
    const { registerCollectiveIntelligenceRoutes } = await import(
      './routes/collective-intelligence/ci-routes.js'
    );
    await registerCollectiveIntelligenceRoutes(server);
    logger.info('✅ Collective Intelligence routes registered (memory, workflows, reasoning)');

    // CI Dashboard routes (v5.2)
    const { registerCIDashboardRoutes } = await import(
      './routes/observability/ci-dashboard-routes.js'
    );
    await registerCIDashboardRoutes(server);
    logger.info('✅ CI Dashboard routes registered (observability, metrics, analytics)');

    // JWKS routes (RS256 migration support)
    const { initializeJWKS, isJWKSEnabled } = await import('./services/jwks-service.js');
    await initializeJWKS();
    const { registerJWKSRoutes } = await import('./routes/jwks-routes.js');
    await registerJWKSRoutes(server);
    if (isJWKSEnabled()) {
      logger.info('✅ JWKS routes registered (/.well-known/jwks.json, /console/api/v1/jwks)');
    } else {
      logger.info(
        'JWKS routes registered in disabled mode (JWKS_ENABLED=false, endpoints return 503)'
      );
    }

    // Nonce routes for replay attack protection
    const { registerNonceRoutes } = await import('./routes/nonce-routes.js');
    await registerNonceRoutes(server);
    logger.info('✅ Nonce routes registered (/v1/nonce)');

    logger.info(
      '✅ All routes registered (Clean Architecture, orchestration, enterprise extensions, tools API, CI, JWKS)'
    );

    // ==========================================
    // R4 fix: Connect Redis backing for learning state convergence (ADR-004)
    // ==========================================
    try {
      const { strategyBandit } = await import('./core/learning/strategy-bandit.js');
      await strategyBandit.connectRedis();
      const { configurationArchive } = await import('./core/learning/configuration-archive.js');
      await configurationArchive.connectRedis();
    } catch (err) {
      logger.warn({ err }, 'Redis state backing connection failed — learning operates local-only');
    }

    // ==========================================
    // R2 / REL-01: BullMQ scheduled jobs (ADR-002) — the ONLY scheduler.
    //
    // BullMQ distributed crons fire exactly once per tick across every replica
    // (Redis lock). The legacy in-process node-cron scheduler has been REMOVED:
    // it ran independently in each process and duplicated every scheduled run
    // across replicas. `isBullmqCronsEnabled()` in register-scheduled-jobs.ts is
    // the single source of truth for the activation flag, so this entrypoint and
    // the job registry can never disagree again (REL-01 split-brain fix).
    //
    // USE_BULLMQ_CRONS semantics:
    //   - unset / anything except "false" → enabled (default-on)
    //   - "false"                         → fatal misconfiguration: there is no
    //     node-cron fallback to select, and booting with zero scheduled jobs
    //     would silently drop billing reconciliation, secret rotation, log
    //     retention, etc. We fail fast instead of running degraded.
    //
    // A registration failure (e.g. Redis unavailable at boot) propagates to the
    // bootstrap catch and exits non-zero — deliberately NOT swallowed, since the
    // process must never come up believing crons are running when they are not.
    // ==========================================
    {
      const { isBullmqCronsEnabled, registerScheduledJobs, startScheduledTasksWorker } =
        await import('./jobs/register-scheduled-jobs.js');

      if (!isBullmqCronsEnabled()) {
        throw new Error(
          'USE_BULLMQ_CRONS=false is no longer supported: the legacy in-process ' +
            'node-cron scheduler has been removed because it duplicated scheduled ' +
            'runs across replicas. BullMQ distributed crons are now the only ' +
            'scheduler. Unset USE_BULLMQ_CRONS (the default) or set it to "true" ' +
            'to run scheduled jobs.',
        );
      }

      await registerScheduledJobs();
      // Phase 1b: scheduling stays unconditional (cheap, idempotent — every
      // replica registers the same repeatable jobs), but the WORKER that
      // executes payloads (some CPU/IO heavy, e.g. continuous-benchmark,
      // training-data-export) only runs here when a dedicated worker
      // deployment isn't taking over, so it doesn't compete with the HTTP
      // event loop once QUEUE_RUN_WORKERS_IN_API=false.
      if (queueRuntime.configuration.runWorkersInApiProcess) {
        await startScheduledTasksWorker();
        logger.info(
          '✅ Scheduler ACTIVE: BullMQ distributed crons, worker running in-process (single execution across replicas; legacy node-cron removed)',
        );
      } else {
        logger.info(
          '✅ Scheduler ACTIVE: BullMQ distributed crons registered; execution delegated to dedicated worker deployment',
        );
      }
    }

    // Start server
    logger.info('Starting server...');
    await startServer(server);

    // Broadcast outbox poller (F1) — drives the fan-out of staged trace
    // envelopes to destinations. Started post-listen so it never delays the
    // server accepting traffic. Gated by the same flag as the routes.
    if (process.env.BROADCAST_FEATURE_ENABLED === 'true') {
      try {
        const { startBroadcastPoller } = await import(
          './broadcast/application/broadcast-poller-runner.js'
        );
        startBroadcastPoller();
        logger.info('✅ Broadcast outbox poller started');
      } catch (err) {
        logger.warn({ err }, 'Failed to start broadcast poller — staged traces will not be delivered');
      }
    }

    // R7 (2026-05-11): Post-listen deferred heavy init. The Fastify server is
    // now accepting /health and admin requests. We can run the expensive
    // catalog load + discovery in the background without blocking client
    // requests. Any in-flight chat completions will fall back to the legacy
    // switch-registered adapter set until the catalog completes.
    if (process.env.DEFER_CATALOG_LOAD === 'true') {
      setImmediate(async () => {
        try {
          logger.info('Post-listen deferred catalog load started...');
          const t0 = Date.now();
          const { loadProviderCatalog } = await import('@/providers/catalog/catalog-loader.js');
          const summary = await loadProviderCatalog();
          logger.info(
            { ...summary, durationMs: Date.now() - t0 },
            '✅ Post-listen catalog load completed',
          );
        } catch (err) {
          logger.error({ err: err instanceof Error ? err.message : String(err) },
                       'Post-listen catalog load failed');
        }
      });
    }

    // ==========================================
    // Setup graceful shutdown (REL-04)
    // ==========================================
    // Ordering contract — resources are torn down in an order that keeps
    // in-flight requests correct:
    //   1) Close the HTTP server FIRST — stop accepting new connections and
    //      drain in-flight requests, so requests that still touch Redis / DB /
    //      workers can complete before those dependencies are removed.
    //   2) Stop workers, pollers and scheduled jobs.
    //   3) Disconnect Redis.
    //   4) Disconnect the database.
    // A single explicit process.exit happens at the very end. An overall
    // SHUTDOWN_TIMEOUT_MS guard force-exits if the drain/teardown hangs, and
    // the handler is idempotent against duplicate SIGTERM/SIGINT.
    let shuttingDown = false;
    const shutdownHandler = async (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        logger.warn({ signal }, 'Shutdown already in progress — ignoring duplicate signal');
        return;
      }
      shuttingDown = true;
      logger.info({ signal }, 'Received shutdown signal');

      const shutdownTimeoutRaw = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '', 10);
      const shutdownTimeoutMs =
        Number.isFinite(shutdownTimeoutRaw) && shutdownTimeoutRaw > 0 ? shutdownTimeoutRaw : 30_000;

      // Hard backstop: if the graceful sequence hangs, force-exit non-zero.
      const forceExitTimer = setTimeout(() => {
        logger.fatal(
          { shutdownTimeoutMs },
          'Graceful shutdown exceeded SHUTDOWN_TIMEOUT_MS — forcing exit',
        );
        process.exit(1);
      }, shutdownTimeoutMs);

      // Run a cleanup step without letting one failure abort the sequence,
      // so every step is guaranteed to run.
      const runStep = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
        try {
          await fn();
        } catch (err) {
          logger.warn({ err: serializeError(err), step: label }, 'Shutdown step failed (non-fatal)');
        }
      };

      // ── Step 1: stop accepting new traffic + drain in-flight requests ──────
      // Reserve part of the overall budget for teardown (steps 2-4); the
      // SHUTDOWN_TIMEOUT_MS guard above is the hard force-exit backstop.
      const drainTimeoutMs = Math.max(1_000, Math.floor(shutdownTimeoutMs * 0.8));
      await runStep('http-server-close', () => shutdownServer(server, drainTimeoutMs));

      // ── Step 2: stop workers, pollers and scheduled jobs ───────────────────
      // R5 fix: Shutdown remediation infrastructure (outbox, DLQ, scheduled tasks)
      await runStep('outbox-poller', async () => {
        const { stopOutboxPoller } = await import('./infrastructure/events/outbox-poller.js');
        await stopOutboxPoller();
      });
      await runStep('broadcast-poller', async () => {
        const { stopBroadcastPoller } = await import('./broadcast/application/broadcast-poller-runner.js');
        stopBroadcastPoller();
      });
      await runStep('dlq-manager', async () => {
        const { shutdownDLQManager } = await import('./queue/dlq-manager.js');
        await shutdownDLQManager();
      });
      await runStep('scheduled-tasks', async () => {
        const { shutdownScheduledTasks } = await import('./jobs/register-scheduled-jobs.js');
        await shutdownScheduledTasks();
      });

      // Stop scheduled jobs (v5.0)
      await runStep('api-key-jobs', async () => {
        const { stopApiKeyJobs } = await import('./jobs/api-key-maintenance.js');
        stopApiKeyJobs();
        logger.info('✅ Scheduled jobs stopped');
      });
      await runStep('secret-rotation-job', async () => {
        const { stopSecretRotationJob } = await import('./jobs/secret-rotation-job.js');
        await stopSecretRotationJob();
      });
      if (config.security.audit.enabled) {
        await runStep('security-audit-retention-job', async () => {
          const { stopSecurityAuditRetentionJob } = await import(
            './jobs/security-audit-retention-job.js'
          );
          stopSecurityAuditRetentionJob();
        });
      }
      if (config.payments.stripe.enabled) {
        await runStep('stripe-catalog-sync-job', async () => {
          const { stopStripeCatalogSyncJob } = await import('./jobs/stripe-catalog-sync-job.js');
          stopStripeCatalogSyncJob();
        });
        await runStep('billing-usage-reconciliation-job', async () => {
          const { stopBillingUsageReconciliationJob } = await import(
            './jobs/billing-usage-reconciliation-job.js'
          );
          await stopBillingUsageReconciliationJob();
        });
      }
      await runStep('log-retention-job', async () => {
        const { stopLogRetentionJob } = await import('./jobs/log-retention-job.js');
        stopLogRetentionJob();
        logger.info('✅ Log retention job stopped');
      });
      await runStep('context-cache-cleanup-job', async () => {
        const { stopContextCacheCleanupJob } = await import('./jobs/context-cache-cleanup-job.js');
        stopContextCacheCleanupJob();
      });
      await runStep('collective-intelligence-reflection-job', async () => {
        const { stopCollectiveIntelligenceReflectionJob } = await import(
          './jobs/collective-intelligence-reflection-job.js'
        );
        stopCollectiveIntelligenceReflectionJob();
        logger.info('Collective intelligence reflection job stopped');
        logger.info('✅ Context cache cleanup job stopped');
      });
      await runStep('continuous-benchmark-job', async () => {
        const { stopContinuousBenchmarkJob } = await import('./jobs/continuous-benchmark-job.js');
        stopContinuousBenchmarkJob();
        logger.info('✅ Continuous benchmark job stopped');
      });

      // Stop in-process queue workers BEFORE disconnecting Redis (the workers
      // run on the Redis-backed BullMQ connection).
      await runStep('queue-workers', async () => {
        const queueRuntimeForShutdown = getQueueRuntimeState();
        if (queueRuntimeForShutdown.configuration.runWorkersInApiProcess) {
          const { requestQueueService } = await import('@/services/request-queue-service.js');
          await requestQueueService.stopWorkers();
          // Phase 1b fix: thread-run and batch workers are started alongside
          // the chat request workers under the same flag, but were never
          // stopped here — a graceful-shutdown gap (queue-runner.ts already
          // stops all three; index.ts only stopped one of three).
          const { stopThreadRunWorkers } = await import('./workers/thread-run-worker.js');
          await stopThreadRunWorkers();
          const { stopBatchWorker } = await import('./workers/batch-worker.js');
          await stopBatchWorker();
          logger.info('✅ Queue workers stopped');
        }
      });

      // Flush the request logger before Redis/DB are torn down (it persists
      // buffered request logs to those backends).
      await runStep('request-logger', async () => {
        const { shutdownRequestLogger } = await import('@/services/request-logger.js');
        await shutdownRequestLogger();
      });

      // Shutdown Secrets Manager (v5.0)
      await runStep('secrets-manager', async () => {
        const { shutdownSecretsManager } = await import('./config/secrets-manager.js');
        await shutdownSecretsManager();
        logger.info('✅ Secrets Manager shutdown');
      });

      if (config.observability.otelEnabled) {
        await runStep('opentelemetry', async () => {
          const { shutdownOpenTelemetry } = await import('./observability/opentelemetry.js');
          await shutdownOpenTelemetry();
        });
      }

      // ── Step 3: disconnect Redis ───────────────────────────────────────────
      if (config.cache.enabled) {
        await runStep('redis', async () => {
          const { disconnectRedis } = await import('@/cache/redis-client.js');
          await disconnectRedis();
        });
      }

      // ── Step 4: disconnect the database ────────────────────────────────────
      await runStep('database', async () => {
        await disconnectDatabase();
      });

      logger.info('✅ Graceful shutdown complete');
      clearTimeout(forceExitTimer);
      process.exit(0);
    };

    process.on('SIGTERM', shutdownHandler);
    process.on('SIGINT', shutdownHandler);
  } catch (error: unknown) {
    // Log to both logger and console.error to ensure visibility in Cloud Run logs
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    console.error('❌ FATAL ERROR during bootstrap:', errorMessage);
    if (errorStack) {
      console.error('Stack trace:', errorStack);
    }
    console.error('Full error:', error);

    logger.fatal(error, 'Failed to start application');
    process.exit(1);
  }
}

// Start application
bootstrap().catch((error) => {
  // Log to both logger and console.error to ensure visibility in Cloud Run logs
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  console.error('❌ FATAL ERROR in bootstrap catch:', errorMessage);
  if (errorStack) {
    console.error('Stack trace:', errorStack);
  }
  console.error('Full error:', error);

  logger.fatal(error, 'Unhandled error during bootstrap');
  process.exit(1);
});
