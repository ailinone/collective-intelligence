// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Test Server Helper
 * Creates a Fastify server instance with all routes registered for integration tests
 * 
 * Singleton Pattern: Prevents multiple server instances in tests to avoid:
 * - Port conflicts
 * - Resource leaks
 * - State inconsistencies
 */

import type { FastifyInstance } from 'fastify';
import { createServer } from '@/server';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { OrchestrationEngine } from '@/core/orchestration/orchestration-engine';

/**
 * Global test server instance (singleton pattern)
 * Prevents multiple server instances in tests
 */
let testServerInstance: FastifyInstance | null = null;
let testServerInitializing: Promise<FastifyInstance> | null = null;

async function ensureRuntimeSingletons(): Promise<{
  providerRegistry: ProviderRegistry;
  orchestrationEngine: OrchestrationEngine;
}> {
  const providerRegistryModule = await import('@/providers/provider-registry');
  const { getProviderRegistry, initializeProviderRegistry, setProviderRegistry } = providerRegistryModule;
  const { config } = await import('@/config');

  let providerRegistry: ProviderRegistry;
  try {
    providerRegistry = getProviderRegistry();
  } catch {
    providerRegistry = await initializeProviderRegistry(config.providers);
    setProviderRegistry(providerRegistry);
  }

  const orchestrationModule = await import('@/core/orchestration/orchestration-engine');
  const {
    OrchestrationEngine,
    getOrchestrationEngine,
    isOrchestrationEngineInitialized,
    setOrchestrationEngine,
  } = orchestrationModule;

  if (!isOrchestrationEngineInitialized()) {
    const engine = new OrchestrationEngine({
      providerRegistry,
      defaultStrategy: 'auto',
      enableAutoSelection: true,
    });
    setOrchestrationEngine(engine);
  }

  return {
    providerRegistry,
    orchestrationEngine: getOrchestrationEngine(),
  };
}

/**
 * Create a test server with all routes registered (singleton)
 * This ensures that integration tests can access all endpoints
 * and prevents multiple server instances from being created
 */
export async function createTestServerWithRoutes(): Promise<FastifyInstance> {
  // Return existing instance if available
  if (testServerInstance) {
    return testServerInstance;
  }

  // If initialization is in progress, wait for it
  if (testServerInitializing) {
    return testServerInitializing;
  }

  // Create new instance
  testServerInitializing = (async () => {
    const server = await createServer();

  // Import and register all route modules
  // Clean Architecture routes (v5.1)
  const { authRoutesClean } = await import('@/routes/auth/auth-routes-clean');
  const { userRoutes } = await import('@/routes/user/user-routes-clean');
  const { organizationRoutesClean } = await import('@/routes/organization/organization-routes-clean');
  const { apiKeysRoutesClean } = await import('@/routes/api-keys/api-keys-routes-clean');

  // Register Clean Architecture routes
  await server.register(authRoutesClean);
  await userRoutes(server);
  await server.register(organizationRoutesClean);
  await server.register(apiKeysRoutesClean);

  // Import provider registry and orchestration engine for legacy routes.
  // Auto-bootstrap if tests haven't initialized runtime singletons yet.
  const { providerRegistry, orchestrationEngine } = await ensureRuntimeSingletons();

  // Register legacy/orchestration routes
  const { registerModelRoutes } = await import('@/routes/models/models-routes');
  const { registerChatRoutes, registerCapabilityRoutes } = await import('@/routes/chat/chat-routes');
  const { registerEmbeddingsRoutes } = await import('@/routes/embeddings/embeddings-routes');
  const { registerAudioRoutes } = await import('@/routes/audio/audio-routes');
  const { registerImagesRoutes } = await import('@/routes/images/images-routes');
  const { registerSearchRoutes } = await import('@/routes/search/search-routes');
  const { registerModerationsRoutes } = await import('@/routes/moderations/moderations-routes');
  const { registerFilesRoutes } = await import('@/routes/files/files-routes');
  const { registerBatchesRoutes } = await import('@/routes/batches/batches-routes');
  const { registerFineTuningRoutes } = await import('@/routes/fine-tuning/fine-tuning-routes');
  const { registerAssistantsRoutes } = await import('@/routes/assistants/assistants-routes');
  const { registerThreadsRoutes } = await import('@/routes/threads/threads-routes');
  const { registerUsageRoutes } = await import('@/routes/usage/usage-routes');
  const { registerUserManagementRoutes } = await import('@/routes/user/user-management-routes');

  if (providerRegistry) {
    await registerModelRoutes(server, providerRegistry);
    await registerEmbeddingsRoutes(server, providerRegistry);
  }

  if (orchestrationEngine) {
    await registerChatRoutes(server, orchestrationEngine);
    await registerCapabilityRoutes(server, orchestrationEngine);
  }

  await registerAudioRoutes(server);
  await registerImagesRoutes(server);
  await registerSearchRoutes(server);
  await registerModerationsRoutes(server);
  await registerFilesRoutes(server);
  await registerBatchesRoutes(server);
  await registerFineTuningRoutes(server);
  await registerAssistantsRoutes(server);
  await registerThreadsRoutes(server);
  await registerUsageRoutes(server);
  await registerUserManagementRoutes(server);

  // Register Vector Stores routes
  const { registerVectorStoresRoutes } = await import('@/routes/vector-stores/vector-stores-routes');
  await registerVectorStoresRoutes(server);

  // Register Code Execution routes
  const { registerCodeExecutionRoutes } = await import('@/routes/code-execution/code-execution-routes');
  await registerCodeExecutionRoutes(server);

  // Register PDF routes
  const { registerPDFRoutes } = await import('@/routes/pdf/pdf-routes');
  await registerPDFRoutes(server);

  // Register Context Caching routes
  const { registerContextCachingRoutes } = await import('@/routes/context-caching/context-caching-routes');
  await registerContextCachingRoutes(server);

  // Register Extended Thinking and Responses routes
  const { registerExtendedThinkingRoutes } = await import('@/routes/extended-thinking/extended-thinking-routes');
  const { registerResponsesRoutes } = await import('@/routes/responses/responses-routes');
  await registerExtendedThinkingRoutes(server);
  await registerResponsesRoutes(server);

  // Register admin routes
  const { registerApiKeyRotationRoutes } = await import('@/routes/admin/api-key-rotation-routes');
  await registerApiKeyRotationRoutes(server);
  const { registerAdminRoutes } = await import('@/routes/admin/admin-routes');
  await registerAdminRoutes(server);

  // Register models configuration routes
  const { registerModelsConfigRoutes } = await import('@/routes/models/models-config-routes');
  await registerModelsConfigRoutes(server);

  // Register organization settings routes
  const { registerOrganizationSettingsRoutes } = await import('@/routes/organization/organization-settings-routes');
  await registerOrganizationSettingsRoutes(server);

    // Register status route (used by comprehensive endpoint tests)
    const { registerStatusRoutes } = await import('@/routes/status/status-routes');
    await server.register(registerStatusRoutes);

    // Store singleton instance
    testServerInstance = server;
    testServerInitializing = null;
    
    return server;
  })();

  return testServerInitializing;
}

/**
 * Clear test server singleton instance
 * Should be called in afterAll hooks to allow cleanup
 */
export function clearTestServerInstance(): void {
  testServerInstance = null;
  testServerInitializing = null;
}

/**
 * Global auth-only test server instance (singleton pattern)
 */
let authOnlyServerInstance: FastifyInstance | null = null;
let authOnlyServerInitializing: Promise<FastifyInstance> | null = null;

/**
 * Create a minimal test server with only auth routes (singleton)
 * Useful for tests that only need authentication endpoints
 */
export async function createTestServerWithAuthOnly(): Promise<FastifyInstance> {
  // Return existing instance if available
  if (authOnlyServerInstance) {
    return authOnlyServerInstance;
  }

  // If initialization is in progress, wait for it
  if (authOnlyServerInitializing) {
    return authOnlyServerInitializing;
  }

  // Create new instance
  authOnlyServerInitializing = (async () => {
    const server = await createServer();

    const { authRoutesClean } = await import('@/routes/auth/auth-routes-clean');
    await server.register(authRoutesClean);

    const { userRoutes } = await import('@/routes/user/user-routes-clean');
    await server.register(userRoutes);

    // Store singleton instance
    authOnlyServerInstance = server;
    authOnlyServerInitializing = null;

    return server;
  })();

  return authOnlyServerInitializing;
}

/**
 * Clear auth-only test server singleton instance
 * Should be called in afterAll hooks to allow cleanup
 */
export function clearAuthOnlyServerInstance(): void {
  authOnlyServerInstance = null;
  authOnlyServerInitializing = null;
}

