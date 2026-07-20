// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Client as PgClient } from 'pg';
import type { StartedTestContainer } from 'testcontainers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { prisma, connectDatabase, disconnectDatabase, recreatePrismaClient } from '@/database/client';
import { PrismaClient } from '@/generated/prisma/client.js';
import { disconnectRedis } from '@/cache/redis-client';
import { PasswordHash } from '@/domain/value-objects/password-hash';
import { TIER_CONFIGS } from '@/config/multi-tenancy-config';
import { syncDefaultRoles } from '@/services/rbac-sync-service';
import {
  TEST_TENANT_FEATURES,
  TEST_TENANT_ORGANIZATION_ID,
  TEST_TENANT_ORGANIZATION_NAME,
  TEST_TENANT_QUOTAS,
  TEST_TENANT_TIER,
  TEST_TENANT_USER_EMAIL,
  TEST_TENANT_USER_ID,
  TEST_TENANT_USER_NAME,
  TEST_TENANT_USER_PASSWORD,
} from './test-tenant';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

type TestContainerState = {
  postgresContainer: StartedPostgreSqlContainer | null;
  redisContainer: StartedTestContainer | null;
};

type ProcessWithContainerState = NodeJS.Process & {
  __ailinTestContainerState?: TestContainerState;
};

const processWithContainerState = process as ProcessWithContainerState;

if (!processWithContainerState.__ailinTestContainerState) {
  processWithContainerState.__ailinTestContainerState = {
    postgresContainer: null,
    redisContainer: null,
  };
}

const testContainerState = processWithContainerState.__ailinTestContainerState;

type TestEnvironmentMode = 'local' | 'testcontainers';

type TestEnvironmentState = {
  initializing?: Promise<void>;
  initialized: boolean;
  refCount: number;
  mode?: TestEnvironmentMode;
};

type ProcessWithTestEnvironmentState = NodeJS.Process & {
  __ailinTestEnvironmentState?: TestEnvironmentState;
};

const processWithTestEnvironmentState = process as ProcessWithTestEnvironmentState;


if (!processWithTestEnvironmentState.__ailinTestEnvironmentState) {
  processWithTestEnvironmentState.__ailinTestEnvironmentState = {
    initialized: false,
    refCount: 0,
  };
}

const testEnvironmentState = processWithTestEnvironmentState.__ailinTestEnvironmentState;

export async function startTestEnvironment(): Promise<void> {
  ensureAuthDefaults();

  if (!testEnvironmentState.initialized) {
    if (!testEnvironmentState.initializing) {
      testEnvironmentState.initializing = initializeTestEnvironment()
        .then(() => {
          testEnvironmentState.initialized = true;
        })
        .finally(() => {
          testEnvironmentState.initializing = undefined;
        });
    }

    await testEnvironmentState.initializing;
  }

  // Some suites call vi.resetModules() and/or disconnect Prisma explicitly.
  // Re-validate critical singletons on every start to keep full-suite runs stable.
  await ensureDatabaseConnection();
  await ensureRuntimeSingletonsHealthy();

  testEnvironmentState.refCount += 1;
}

export async function stopTestEnvironment(): Promise<void> {
  if (testEnvironmentState.refCount === 0) {
    return;
  }

  testEnvironmentState.refCount -= 1;

  if (testEnvironmentState.refCount > 0) {
    return;
  }

  const persistEnvironment = process.env.TEST_PERSIST_TEST_ENV !== 'false';
  if (persistEnvironment) {
    return;
  }

  const initializing = testEnvironmentState.initializing;
  if (initializing) {
    await initializing.catch(() => undefined);
  }

  testEnvironmentState.initialized = false;

  try {
    await disconnectRedis();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[test-environment] Failed to disconnect Redis clients gracefully:', errorMessage);
  }

  try {
    await disconnectDatabase();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[test-environment] Failed to disconnect Prisma client gracefully:', errorMessage);
  }

  if (testEnvironmentState.mode === 'testcontainers') {
    if (testContainerState.redisContainer) {
      await stopContainerSafely(testContainerState.redisContainer);
      testContainerState.redisContainer = null;
    }

    if (testContainerState.postgresContainer) {
      await stopContainerSafely(testContainerState.postgresContainer);
      testContainerState.postgresContainer = null;
    }
  }

  testEnvironmentState.mode = undefined;
  markDatabaseResetAsDirty();
}

async function initializeTestEnvironment(): Promise<void> {
  const usingLocalServices = await shouldUseLocalServices();
  const mode: TestEnvironmentMode = usingLocalServices ? 'local' : 'testcontainers';

  try {
    if (!usingLocalServices) {
      await ensureTestcontainersStarted();
    }

    ensureAuthDefaults();
    await resetDatabaseIfAllowed();

    // Prisma can be imported before the reset happens (test files import '@/database/client' at module load time).
    // After dropping/recreating the public schema, we MUST recreate the Prisma client to avoid using stale pooled
    // connections (and to ensure it points at the latest DATABASE_URL in Testcontainers mode).
    recreatePrismaClient();

    // Ensure RBAC default roles exist before seeding the default tenant (tenant seeding assigns roles).
    await syncDefaultRoles();

    // Seed a default tenant/org/user to prevent FK failures in tests that create users directly.
    await seedDefaultTenant();

    // Ensure runtime singletons exist for tests that call getProviderRegistry/getOrchestrationEngine
    // directly without explicit test bootstrap.
    await initializeRuntimeSingletons();
    
    // Dynamic discovery is expensive and depends on valid external credentials.
    // Keep local/dev test bootstrap deterministic by running it only when explicitly enabled.
    const shouldRunDynamicDiscovery =
      process.env.TEST_USE_REAL_API_KEYS === 'true' &&
      process.env.TEST_SKIP_DYNAMIC_MODEL_DISCOVERY !== 'true';

    if (shouldRunDynamicDiscovery) {
      try {
        const { ensureModelsDiscovered } = await import('./dynamic-model-discovery');
        await ensureModelsDiscovered();
        console.log('[test-environment] Dynamic model discovery completed - all models from real providers');
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(
          '[test-environment] Dynamic model discovery failed (non-critical, tests may discover models later):',
          errorMessage
        );
      }
    } else {
      console.log('[test-environment] Dynamic model discovery skipped (set TEST_USE_REAL_API_KEYS=true to enable)');
    }

    testEnvironmentState.mode = mode;
  } catch (error: unknown) {
    if (mode === 'testcontainers') {
      await disposeManagedContainers();
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorToThrow = error instanceof Error ? error : new Error(errorMessage);
    throw errorToThrow;
  }
}

async function ensureTestcontainersStarted(): Promise<void> {
  try {
    if (!testContainerState.postgresContainer) {
      // Use pgvector/pgvector image to support vector extension required by semantic memory
      testContainerState.postgresContainer = await new PostgreSqlContainer('pgvector/pgvector:pg16')
        .withDatabase('ailin_dev_test')
        .withUsername('ailin_dev')
        .withPassword('ailin_dev_password')
        .start();

      const newDatabaseUrl = testContainerState.postgresContainer.getConnectionUri();
      process.env.DATABASE_URL = newDatabaseUrl;
      
      console.log('[test-environment] Testcontainer PostgreSQL started:', {
        host: testContainerState.postgresContainer.getHost(),
        port: testContainerState.postgresContainer.getPort(),
        database: 'ailin_dev_test',
        url: newDatabaseUrl,
      });
    }

    if (!testContainerState.redisContainer) {
      testContainerState.redisContainer = await new RedisContainer('redis:7-alpine').start();
      process.env.REDIS_HOST = testContainerState.redisContainer.getHost();
      process.env.REDIS_PORT = testContainerState.redisContainer.getMappedPort(6379).toString();
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isContainerRuntimeError = errorMessage.includes('container runtime') || errorMessage.includes('Docker');
    
    if (isContainerRuntimeError) {
      const helpMessage = `
╔══════════════════════════════════════════════════════════════════════════════╗
║                    TEST ENVIRONMENT SETUP REQUIRED                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

To run tests, you need ONE of the following:

OPTION 1: Use Docker (Recommended)
  • Start Docker Desktop
  • Tests will automatically use Testcontainers to manage PostgreSQL and Redis

OPTION 2: Use Local Database
  • Ensure PostgreSQL is running locally
  • Set DATABASE_URL in .env.test (e.g., postgresql://user:pass@localhost:5432/db)
  • Set TEST_USE_LOCAL_SERVICES=true in .env.test
  • Ensure Redis is running on localhost:6379

Current Configuration:
  • DATABASE_URL: ${process.env.DATABASE_URL ? '✅ Set' : '❌ Not set'}
  • TEST_USE_LOCAL_SERVICES: ${process.env.TEST_USE_LOCAL_SERVICES || 'false'}

Original Error: ${errorMessage}
`;
      throw new Error(helpMessage);
    }
    
    throw error instanceof Error ? error : new Error(errorMessage);
  }
}

// Create test-specific Prisma client with correct DATABASE_URL
function getTestPrismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });
}

async function disposeManagedContainers(): Promise<void> {
  if (testContainerState.redisContainer) {
    await stopContainerSafely(testContainerState.redisContainer);
    testContainerState.redisContainer = null;
  }

  if (testContainerState.postgresContainer) {
    await stopContainerSafely(testContainerState.postgresContainer);
    testContainerState.postgresContainer = null;
  }
}

async function seedModelCatalog(): Promise<void> {
  const deterministicLocalMode =
    process.env.TEST_USE_REAL_API_KEYS !== 'true' || process.env.TEST_SKIP_EXTERNAL_APIS === 'true';

  if (deterministicLocalMode) {
    const [{ createMockProviderRegistry, syncMockModelsToCatalog }, { setProviderRegistry }] =
      await Promise.all([import('./mock-provider'), import('@/providers/provider-registry')]);

    const mockRegistry = createMockProviderRegistry();
    await syncMockModelsToCatalog(mockRegistry);
    setProviderRegistry(mockRegistry);
    return;
  }

  const [{ config }, providerRegistryModule] = await Promise.all([
    import('@/config'),
    import('@/providers/provider-registry'),
  ]);

  const { initializeProviderRegistry, setProviderRegistry } = providerRegistryModule;
  const registry = await initializeProviderRegistry(config.providers);
  setProviderRegistry(registry);
}

async function initializeRuntimeSingletons(): Promise<void> {
  // Initialize provider registry singleton.
  await seedModelCatalog();

  // Initialize orchestration engine singleton if needed.
  const orchestrationModule = await import('@/core/orchestration/orchestration-engine');
  const { OrchestrationEngine, isOrchestrationEngineInitialized, setOrchestrationEngine } =
    orchestrationModule;

  if (!isOrchestrationEngineInitialized()) {
    const { getProviderRegistry } = await import('@/providers/provider-registry');
    const providerRegistry = getProviderRegistry();
    const engine = new OrchestrationEngine({
      providerRegistry,
      defaultStrategy: 'auto',
      enableAutoSelection: true,
    });
    setOrchestrationEngine(engine);
  }
}

async function ensureRuntimeSingletonsHealthy(): Promise<void> {
  let registryReady = false;

  try {
    const { getProviderRegistry } = await import('@/providers/provider-registry');
    const registry = getProviderRegistry();
    registryReady = registry.count() > 0;
  } catch {
    registryReady = false;
  }

  const orchestrationModule = await import('@/core/orchestration/orchestration-engine');
  const engineReady =
    typeof orchestrationModule.isOrchestrationEngineInitialized === 'function' &&
    orchestrationModule.isOrchestrationEngineInitialized();

  if (!registryReady || !engineReady) {
    await initializeRuntimeSingletons();
  }
}

async function ensureDatabaseConnection(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    await connectDatabase();
  }
}

type SeedQuotaDefinition = {
  period: 'hourly' | 'daily' | 'monthly';
  periodStart: Date;
  periodEnd: Date;
  requestLimit: number;
};

function buildUsageQuotaDefinitions(): SeedQuotaDefinition[] {
  const tierConfig = TIER_CONFIGS[TEST_TENANT_TIER];
  const now = new Date();

  const hourlyStart = new Date(now);
  hourlyStart.setMinutes(0, 0, 0);
  const hourlyEnd = new Date(hourlyStart.getTime() + 60 * 60 * 1000);

  const dailyStart = new Date(now);
  dailyStart.setHours(0, 0, 0, 0);
  const dailyEnd = new Date(dailyStart.getTime() + 24 * 60 * 60 * 1000);

  const monthlyStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthlyEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const dailyRequestLimit = tierConfig.requestsPerMinute * 60 * 24;
  const monthlyRequestLimit = dailyRequestLimit * 30;

  return [
    {
      period: 'hourly',
      periodStart: hourlyStart,
      periodEnd: hourlyEnd,
      requestLimit: tierConfig.requestsPerHour,
    },
    {
      period: 'daily',
      periodStart: dailyStart,
      periodEnd: dailyEnd,
      requestLimit: dailyRequestLimit,
    },
    {
      period: 'monthly',
      periodStart: monthlyStart,
      periodEnd: monthlyEnd,
      requestLimit: monthlyRequestLimit,
    },
  ];
}

async function seedDefaultTenant(): Promise<void> {
  const organizationSettings = {
    quotas: { ...TEST_TENANT_QUOTAS },
    features: { ...TEST_TENANT_FEATURES },
    billing: {
      plan: TEST_TENANT_TIER,
      status: 'active',
    },
  };

  const passwordHash = await PasswordHash.fromPlainText(TEST_TENANT_USER_PASSWORD);
  const hashedPassword = passwordHash.getValue();
  const quotaDefinitions = buildUsageQuotaDefinitions();

  await prisma.$transaction(async (tx) => {
    await tx.organization.upsert({
      where: { id: TEST_TENANT_ORGANIZATION_ID },
      update: {
        name: TEST_TENANT_ORGANIZATION_NAME,
        tier: TEST_TENANT_TIER,
        status: 'active',
        settings: organizationSettings,
      },
      create: {
        id: TEST_TENANT_ORGANIZATION_ID,
        name: TEST_TENANT_ORGANIZATION_NAME,
        tier: TEST_TENANT_TIER,
        status: 'active',
        settings: organizationSettings,
      },
    });

    const user = await tx.user.upsert({
      where: { email: TEST_TENANT_USER_EMAIL },
      update: {
        name: TEST_TENANT_USER_NAME,
        organizationId: TEST_TENANT_ORGANIZATION_ID,
        status: 'active',
        role: 'owner',
        passwordHash: hashedPassword,
      },
      create: {
        id: TEST_TENANT_USER_ID,
        email: TEST_TENANT_USER_EMAIL,
        name: TEST_TENANT_USER_NAME,
        organizationId: TEST_TENANT_ORGANIZATION_ID,
        status: 'active',
        role: 'owner',
        passwordHash: hashedPassword,
      },
    });

    const roleRecords = await tx.role.findMany({
      where: {
        name: {
          in: ['owner', 'admin', 'developer', 'viewer'],
        },
      },
      select: {
        id: true,
        name: true,
      },
    });

    for (const role of roleRecords) {
      await tx.userRole.upsert({
        where: {
          userId_organizationId_roleId: {
            userId: user.id,
            organizationId: TEST_TENANT_ORGANIZATION_ID,
            roleId: role.id,
          },
        },
        update: {},
        create: {
          userId: user.id,
          organizationId: TEST_TENANT_ORGANIZATION_ID,
          roleId: role.id,
        },
      });
    }

    for (const quota of quotaDefinitions) {
      await tx.usageQuota.upsert({
        where: {
          organizationId_period_periodStart: {
            organizationId: TEST_TENANT_ORGANIZATION_ID,
            period: quota.period,
            periodStart: quota.periodStart,
          },
        },
        update: {
          periodEnd: quota.periodEnd,
          requestLimit: quota.requestLimit,
        },
        create: {
          organizationId: TEST_TENANT_ORGANIZATION_ID,
          period: quota.period,
          periodStart: quota.periodStart,
          periodEnd: quota.periodEnd,
          requestLimit: quota.requestLimit,
        },
      });
    }
  });
}

function ensureAuthDefaults(): void {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
  process.env.AUTH_DEFAULT_MODE = process.env.AUTH_DEFAULT_MODE || 'password';
  process.env.AUTH_ALLOW_PASSWORD_FALLBACK = 'true';
  // Tests should never depend on external email providers.
  process.env.AUTH_EMAIL_PROVIDER = 'console';
  // Keep SendGrid key for tests that explicitly need it
  process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || 'sg.test-key';
  // Disable gateway middlewares in tests to avoid cross-service dependency/401 noise.
  process.env.GATEWAY_MIDDLEWARE_ENABLED = 'false';
}

async function shouldUseLocalServices(): Promise<boolean> {
  if (process.env.TEST_USE_LOCAL_SERVICES !== 'true') {
    return false;
  }

  const url = process.env.DATABASE_URL;

  if (!url) {
    // eslint-disable-next-line no-console
    console.warn(
      'TEST_USE_LOCAL_SERVICES=true but DATABASE_URL is undefined. Falling back to Testcontainers-managed PostgreSQL.',
    );
    process.env.TEST_USE_LOCAL_SERVICES = 'false';
    process.env.TEST_SKIP_DB_RESET = 'false';
    process.env.TEST_SKIP_MIGRATIONS = 'false';
    return false;
  }

  const timeoutMs = 5_000;
  const probe = new PgClient({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
  });

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Timed out probing PostgreSQL after ${timeoutMs}ms`)), timeoutMs);
  });

  let success = false;

  try {
    await Promise.race([probe.connect(), timeout]);
    success = true;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.warn(
      'Local PostgreSQL unavailable, falling back to Testcontainers-managed instance',
      errorMessage,
    );
    process.env.TEST_USE_LOCAL_SERVICES = 'false';
    process.env.TEST_SKIP_DB_RESET = 'false';
    process.env.TEST_SKIP_MIGRATIONS = 'false';
    return false;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    await probe.end().catch(() => undefined);
  }

  if (success) {
    const masked = maskDatabaseUrl(url);
    // eslint-disable-next-line no-console
    console.log('Using externally managed PostgreSQL for test environment', masked);
    return true;
  }

  return false;
}

function maskDatabaseUrl(url: string): Record<string, string | undefined> {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.replace('/', ''),
      user: parsed.username,
    };
  } catch {
    return { url: 'unparsable' };
  }
}

async function resetDatabaseIfAllowed(): Promise<void> {
  if (process.env.TEST_SKIP_DB_RESET === 'true' || process.env.TEST_SKIP_MIGRATIONS === 'true') {
    return;
  }

  const databaseUrl = process.env.DATABASE_URL ?? '';
  const state = getDatabaseResetState();

  if (state.completedForDatabaseUrl && state.completedForDatabaseUrl === databaseUrl) {
    return;
  }

  if (!state.promise) {
    const targetDatabaseUrl = databaseUrl;
    state.promise = performDatabaseReset()
      .then(() => {
        state.completedForDatabaseUrl = targetDatabaseUrl;
      })
      .finally(() => {
        state.promise = undefined;
      });
  }

  await state.promise;
}

type DatabaseResetState = {
  promise?: Promise<void>;
  completedForDatabaseUrl?: string;
};

type ProcessWithDatabaseResetState = NodeJS.Process & {
  __ailinResetState?: DatabaseResetState;
};

const processWithDatabaseResetState = process as ProcessWithDatabaseResetState;

function getDatabaseResetState(): DatabaseResetState {
  if (!processWithDatabaseResetState.__ailinResetState) {
    processWithDatabaseResetState.__ailinResetState = {};
  }

  return processWithDatabaseResetState.__ailinResetState;
}

function markDatabaseResetAsDirty(): void {
  const state = getDatabaseResetState();
  state.completedForDatabaseUrl = undefined;
}

async function performDatabaseReset(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be defined to reset the database');
  }

  // eslint-disable-next-line no-console
  console.info('[test-environment] Resetting database schema using migrations', {
    databaseUrl: maskDatabaseUrl(process.env.DATABASE_URL),
  });

  const client = new PgClient({
    connectionString: process.env.DATABASE_URL,
  });

  await client.connect();

  const schemaPath = path.resolve(projectRoot, 'prisma', 'schema.prisma');
  const migrationsDir = path.resolve(projectRoot, 'prisma', 'migrations');
  const advisoryKey = process.env.DATABASE_URL;

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [advisoryKey]);
    // eslint-disable-next-line no-console
    console.info('[test-environment] Advisory lock acquired for database reset');

    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');
    await client.query('GRANT ALL ON SCHEMA public TO public');
    await client.query('SET search_path TO public, pg_catalog');
    // eslint-disable-next-line no-console
    console.info('[test-environment] Public schema recreated successfully');

    // Ensure required extensions exist before migrations that depend on them
    await ensureExtension(client, 'uuid-ossp', true);
    await ensureExtension(client, 'pgcrypto', true);
    await ensureExtension(client, 'pg_trgm', false);

    const migrations = await listMigrationDirectories(migrationsDir);

    for (const migration of migrations) {
      const migrationSqlPath = path.resolve(migrationsDir, migration, 'migration.sql');
      const sql = await readFile(migrationSqlPath, 'utf-8');
      if (!sql.trim()) {
        // eslint-disable-next-line no-console
        console.warn(`Skipping empty migration: ${migration}`);
        continue;
      }

      try {
        // eslint-disable-next-line no-console
        console.info('[test-environment] Applying migration', { migration });
        await client.query(sql);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.error('[test-environment] Failed to apply migration', { migration, message: errorMessage });
        throw new Error(`Failed to apply migration "${migration}" from ${schemaPath}: ${errorMessage}`);
      }
    }
    // eslint-disable-next-line no-console
    console.info('[test-environment] All migrations applied successfully');
    const state = getDatabaseResetState();
    state.completedForDatabaseUrl = process.env.DATABASE_URL ?? '';
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', [advisoryKey])
      .catch(() => undefined);
    await client.end().catch(() => undefined);
    // eslint-disable-next-line no-console
    console.info('[test-environment] Advisory lock released and connection closed');
  }
}

async function listMigrationDirectories(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function ensureExtension(client: PgClient, extension: string, allowSchemaOverride: boolean): Promise<void> {
  try {
    if (allowSchemaOverride) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "${extension}" WITH SCHEMA public`);
    } else {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.warn(`Failed to ensure extension "${extension}":`, errorMessage);
  }
}

async function stopContainerSafely(container: StartedTestContainer): Promise<void> {
  try {
    await container.stop();
  } catch (error: unknown) {
    if (isContainerAlreadyStoppedError(error)) {
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    throw error instanceof Error ? error : new Error(errorMessage);
  }
}

function isContainerAlreadyStoppedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const message = String((error as { message?: unknown }).message ?? '');

  if (!message) {
    return false;
  }

  return message.includes('no such container');
}


