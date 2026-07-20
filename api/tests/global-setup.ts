// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { startTestEnvironment, stopTestEnvironment } from './utils/test-environment';

export default async function globalSetup() {
  if (!process.env.AUTH_DEFAULT_MODE) {
    process.env.AUTH_DEFAULT_MODE = 'password';
  }

  if (!process.env.AUTH_ALLOW_PASSWORD_FALLBACK) {
    process.env.AUTH_ALLOW_PASSWORD_FALLBACK = 'true';
  }

  // Docker Desktop on macOS can return bridge metadata that breaks
  // Testcontainers host-port resolution unless host override is explicit.
  if (!process.env.TESTCONTAINERS_HOST_OVERRIDE && process.platform === 'darwin') {
    process.env.TESTCONTAINERS_HOST_OVERRIDE = '127.0.0.1';
  }

  const hasLocalDatabase = Boolean(process.env.DATABASE_URL);

  if (!process.env.TEST_USE_LOCAL_SERVICES) {
    process.env.TEST_USE_LOCAL_SERVICES = hasLocalDatabase ? 'true' : 'false';
  } else if (process.env.TEST_USE_LOCAL_SERVICES === 'true' && !hasLocalDatabase) {
    process.env.TEST_USE_LOCAL_SERVICES = 'false';
  }

  if (process.env.TEST_FORCE_SKIP_MIGRATIONS !== 'true') {
    process.env.TEST_SKIP_DB_RESET = 'false';
    process.env.TEST_SKIP_MIGRATIONS = 'false';
  }

  const useRealKeys = process.env.TEST_USE_REAL_API_KEYS === 'true';
  const externalProviderKeyVars = [
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'MISTRAL_API_KEY',
    'DEEPSEEK_API_KEY',
    'XAI_API_KEY',
    'COHERE_API_KEY',
    'STRIPE_SECRET_KEY',
  ];

  const scrubExternalProviderKeys = () => {
    for (const key of externalProviderKeyVars) {
      process.env[key] = '';
    }
  };

  if (useRealKeys) {
    try {
      console.log('[global-setup] TEST_USE_REAL_API_KEYS=true, loading provider secrets from GCP');
      const { config } = await import('@/config');
      const { initializeSecretsManager } = await import('@/config/secrets-manager.js');
      await initializeSecretsManager(config.secrets);
      const { loadSecretsIntoEnv } = await import('@/config/load-secrets-into-env.js');
      await loadSecretsIntoEnv();
      process.env.TEST_SKIP_EXTERNAL_APIS = 'false';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error('Failed to load real provider credentials (TEST_USE_REAL_API_KEYS=true): ' + message);
    }
  } else {
    console.log(
      '[global-setup] TEST_USE_REAL_API_KEYS is not true; running deterministic local mode without external provider calls.'
    );
    process.env.TEST_SKIP_EXTERNAL_APIS = 'true';
    scrubExternalProviderKeys();
  }

  await startTestEnvironment();
  const { initializeDIContainer, resetDIContainer } = await import('@/di/container');
  initializeDIContainer();

  const { resetMetrics } = await import('@/utils/metrics');
  try {
    resetMetrics();
  } catch {
    // Ignore errors during reset (metrics may not be initialized yet)
  }

  return async () => {
    console.log('[global-teardown] Starting cleanup...');

    const teardownTimeout = 25_000;
    const teardownPromise = performTeardown(resetDIContainer, resetMetrics);

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        console.warn('[global-teardown] Teardown timeout reached, forcing completion');
        reject(new Error('Teardown timeout'));
      }, teardownTimeout);
    });

    try {
      await Promise.race([teardownPromise, timeoutPromise]);
      console.log('[global-teardown] Cleanup completed successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('[global-teardown] Cleanup completed with warnings:', errorMessage);
    }

    clearAllPendingTimers();
  };
}

async function performTeardown(
  resetDIContainer: () => void,
  resetMetrics: () => void
): Promise<void> {
  try {
    resetDIContainer();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[global-teardown] Error resetting DI container:', errorMessage);
  }

  try {
    resetMetrics();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[global-teardown] Error resetting metrics:', errorMessage);
  }

  try {
    const { clearTestServerInstance, clearAuthOnlyServerInstance } = await import('./utils/test-server');
    clearTestServerInstance();
    clearAuthOnlyServerInstance();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[global-teardown] Error clearing test server instances:', errorMessage);
  }

  try {
    process.env.TEST_PERSIST_TEST_ENV = 'false';
    await stopTestEnvironment();

    try {
      const { disconnectDatabase } = await import('@/database/client');
      await disconnectDatabase();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('[global-teardown] Error disconnecting database:', errorMessage);
    }

    try {
      const { disconnectRedis } = await import('@/cache/redis-client');
      await disconnectRedis();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('[global-teardown] Error disconnecting Redis:', errorMessage);
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[global-teardown] Error during cleanup:', errorMessage);
  }
}

function clearAllPendingTimers(): void {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {
      // Ignore GC errors
    }
  }

  setImmediate(() => {
    const forceExitTimer = setTimeout(() => {
      console.log('[global-teardown] Process exit (cleanup complete; open handles closed)');
      const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
      process.exit(exitCode);
    }, 3000);

    forceExitTimer.unref();
  });
}
