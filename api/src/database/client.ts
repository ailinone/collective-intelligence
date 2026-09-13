// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prisma database client
 * Updated for Prisma 7.x compatibility
 *
 * Prisma 7 requires either:
 * - adapter: For direct database connections (requires @prisma/adapter-pg)
 * - accelerateUrl: For Prisma Accelerate connections
 */

import { PrismaClient, Prisma } from '@/generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { config, isDevelopment } from '@/config';
import { logger } from '@/utils/logger';
import { dbSlowQueries, dbQueryDuration } from '@/utils/metrics';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { extractErrorCodeFromObject } from '@/utils/type-guards';
import {
  assertMigrationTargetIsDirect,
  buildPrismaDatabaseUrl,
  describeDatabaseTarget,
  resolveTransactionOptions,
} from './connection-url';
import { attachPoolMetrics } from './pool-metrics';

const execAsync = promisify(exec);

/**
 * Global Prisma client instance (singleton pattern)
 * Prevents multiple instances in development/test environments
 */
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

/**
 * Create Prisma client with enterprise-grade configuration
 *
 * Connection Pooling Strategy:
 * - Development: Small pool (5 connections)
 * - Production: Large pool (100 connections per instance)
 * - Staging: Medium pool (20 connections)
 *
 * Pool Configuration:
 * - connection_limit: Max connections from this client
 * - pool_timeout: Max wait time for connection (seconds)
 * - connect_timeout: Max time to establish connection (seconds)
 *
 * For massive scale (100K+ orgs), deploy PgBouncer:
 * - Transaction pooling mode
 * - 10K+ connections supported
 * - Sub-millisecond connection acquisition
 */

// Build connection string with pool configuration
function buildDatabaseUrl(): string {
  // In test environment, use process.env.DATABASE_URL directly
  // This allows Testcontainers to override at runtime
  const baseUrl =
    process.env.NODE_ENV === 'test' && process.env.DATABASE_URL
      ? process.env.DATABASE_URL
      : config.database.url;

  // Direct vs. pooler resolution lives in connection-url.ts (shared with the
  // capability pool and the SAB worker so every pool follows the same target).
  return buildPrismaDatabaseUrl(baseUrl, process.env, { isDevelopment });
}

// Re-evaluate database URL on each access in test mode
function getDatabaseUrl(): string {
  if (process.env.NODE_ENV === 'test') {
    return buildDatabaseUrl();
  }
  return databaseUrl;
}

const databaseUrl = buildDatabaseUrl();

// Store pool reference for cleanup in test mode
let pgPoolInstance: pg.Pool | null = null;
let pgPoolMetricsSampler: NodeJS.Timeout | null = null;
let databaseTargetLogged = false;

// Create PostgreSQL connection pool for Prisma 7 adapter
// Pool size is configured based on environment
/**
 * Build the pg.Pool options used by the Prisma adapter's underlying
 * connection pool.
 *
 * `max`/`min` come ONLY from `config.database.poolMax`/`poolMin` —
 * `config/index.ts`'s `resolveDatabasePoolMax()`/`resolveDatabasePoolMin()`
 * are the single source of truth for pool sizing (2026-09 footgun fix: this
 * file used to read an undocumented `process.env.DB_POOL_MAX` directly,
 * completely bypassing the discoverable `config.database.poolMax` field —
 * see the resolver functions in config/index.ts for the full history and
 * the deprecated-alias fallback that keeps existing `DB_POOL_MAX`
 * deployments working). Exported so tests can assert the pool actually
 * traces back to config without booting the full Prisma client singleton.
 */
export function buildPgPoolOptions(connectionString: string): pg.PoolConfig {
  return {
    connectionString,
    max: config.database.poolMax,
    min: config.database.poolMin,
    idleTimeoutMillis: 60000,
    // Increase connection timeout to handle slower connections (e.g., Cloud SQL proxy)
    // In production, connections may need more time due to network latency
    connectionTimeoutMillis: parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS || '20000', 10), // 20 seconds default
  };
}

// C3 dev fix (2026-06-09): the model-selection fan-out fires dozens-to-hundreds of concurrent
// queries while background workers also draw from the pool. A dev pool of 5 forced queueing up to
// the connection timeout, surfacing as PrismaClientKnownRequestError and multi-second stalls. Raise
// the dev pool (config.database.poolMax, overridable via DATABASE_POOL_MAX). Pairs with the
// per-model query batching below so the extra connections reduce, not amplify, DB load.
function createPgPool(): pg.Pool {
  const connectionString = getDatabaseUrl();
  const pool = new pg.Pool(buildPgPoolOptions(connectionString));

  // IMPORTANT: pg.Pool can emit 'error' events on idle clients (e.g., when the DB is restarted
  // or a Testcontainers-managed instance is stopped). If nobody listens, Node will crash with
  // "Unhandled 'error' event". We always attach a handler to keep the process stable.
  pool.on('error', (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = extractErrorCodeFromObject(error);

    // In tests, Postgres may terminate connections during teardown (57P01). This is expected.
    const isExpectedTestShutdown = process.env.NODE_ENV === 'test' && code === '57P01';
    if (isExpectedTestShutdown) {
      // Defensive: vitest's module-graph can leave logger as a partial mock.
      if (typeof logger?.debug === 'function') {
        logger.debug({ code, message }, 'PostgreSQL pool error');
      }
      return;
    }

    if (typeof logger?.warn === 'function') {
      logger.warn({ code, message }, 'PostgreSQL pool error');
    } else {
      // eslint-disable-next-line no-console -- last-resort fallback when logger is unavailable
      console.warn('[db pool] error', { code, message });
    }
  });

  if (pgPoolMetricsSampler) {
    clearInterval(pgPoolMetricsSampler);
  }
  pgPoolMetricsSampler = attachPoolMetrics(pool, 'prisma');

  // Grep anchor for the pooler canary runbook: 'Database target'.
  if (!databaseTargetLogged && process.env.NODE_ENV !== 'test') {
    databaseTargetLogged = true;
    if (typeof logger?.info === 'function') {
      logger.info(describeDatabaseTarget(connectionString), 'Database target');
    }
  }

  // Store pool reference for cleanup
  pgPoolInstance = pool;

  return pool;
}

// Create PrismaClient instance - use singleton pattern to prevent multiple instances
// In test mode, we still use the global singleton to avoid multiple Query Engine instances
// which can cause NAPI reference issues and Rust panics during cleanup
//
// Prisma 7: Uses adapter for direct database connection
// The old datasourceUrl/datasources options have been removed
function createPrismaClient(): PrismaClient {
  // Ensure DATABASE_URL is set for Prisma 7
  // In test mode, this is set by Testcontainers; in other modes, from config
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = getDatabaseUrl();
  }

  const pool = createPgPool();
  const adapter = new PrismaPg(pool);

  const logConfig =
    isDevelopment || process.env.NODE_ENV === 'test'
      ? [
          { emit: 'event' as const, level: 'query' as const },
          { emit: 'event' as const, level: 'error' as const },
          { emit: 'event' as const, level: 'warn' as const },
        ]
      : [
          { emit: 'event' as const, level: 'query' as const }, // Enable in prod for slow query monitoring
          { emit: 'event' as const, level: 'error' as const },
          { emit: 'event' as const, level: 'warn' as const },
        ];

  return new PrismaClient({
    adapter,
    log: logConfig,
    // undefined in direct mode (Prisma defaults); see connection-url.ts.
    transactionOptions: resolveTransactionOptions(),
  });
}

// Use singleton pattern to prevent multiple PrismaClient instances
// Multiple instances can cause NAPI reference issues and Rust panics
let prismaInstance: PrismaClient = global.__prisma ?? createPrismaClient();

// Store singleton in global scope for development/test to prevent multiple instances
if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prismaInstance;
}

/**
 * Get current Prisma Client instance
 * This getter ensures that modules always get the latest instance,
 * even if it was recreated (e.g., in test mode after Testcontainers starts)
 */
function getPrismaInstance(): PrismaClient {
  // In test mode, always check if global instance exists and use it if available
  // This allows recreatePrismaClient to update the global instance
  if (process.env.NODE_ENV === 'test' && global.__prisma && global.__prisma !== prismaInstance) {
    prismaInstance = global.__prisma;
  }
  return prismaInstance;
}

/**
 * Recreate Prisma Client with updated DATABASE_URL
 * Useful in test environment when Testcontainers updates DATABASE_URL after initial import
 *
 * Note: This function does NOT disconnect/close the old instance, as it may still be in use.
 * Instead, it creates a new instance and updates the global reference. The old instance
 * will be garbage collected when no longer referenced.
 */
export function recreatePrismaClient(): PrismaClient {
  if (process.env.NODE_ENV === 'test') {
    // Store old instance reference (will be garbage collected)
    const oldInstance = prismaInstance;
    const oldPool = pgPoolInstance;

    // Clear global instance to force new creation
    global.__prisma = undefined;

    // Create new instance with updated DATABASE_URL
    prismaInstance = createPrismaClient();
    global.__prisma = prismaInstance;

    logger.info(
      {
        oldUrl: oldInstance ? 'previous' : 'none',
        newUrl: process.env.DATABASE_URL?.substring(0, 50) + '...',
      },
      'Prisma Client recreated with updated DATABASE_URL'
    );

    // Asynchronously disconnect old instance and its pool if they exist.
    // Don't await to avoid blocking test boot, but ensure resources are released.
    if (oldInstance) {
      oldInstance.$disconnect().catch((error: unknown) => {
        logger.debug({ error }, 'Error disconnecting old Prisma client (expected in some cases)');
      });
    }

    // Close the previous pool to avoid leaking connections across resets (important with Testcontainers).
    // Note: Prisma does not manage the external pg.Pool lifecycle for adapter-based connections.
    if (oldPool && oldPool !== pgPoolInstance) {
      oldPool.end().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(
          { error: message },
          'Error closing old PostgreSQL pool (expected in some cases)'
        );
      });
    }
  }

  return prismaInstance;
}

/**
 * Prisma Client singleton instance
 *
 * In test mode, this getter ensures that modules always get the latest instance,
 * even if it was recreated after Testcontainers updates DATABASE_URL.
 *
 * Note: We export as a getter function proxy to ensure modules always get
 * the current instance, not a stale reference.
 */
const prismaProxy = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const instance = getPrismaInstance();
    const value = instance[prop as keyof PrismaClient];
    // If it's a function, bind it to the instance
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  },
});

export const prisma = prismaProxy as PrismaClient;

// Query performance monitoring (production + development)
interface PrismaQueryEvent {
  duration: number;
  query: string;
  params: string;
  target: string;
  timestamp: Date;
}

function truncateForLogs(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

function parseSlowQueryThresholdMs(isTestEnv: boolean): number {
  const envValue = process.env.DB_SLOW_QUERY_MS;
  if (!envValue) {
    return isTestEnv ? 5000 : 500;
  }
  const parsed = Number.parseInt(envValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return isTestEnv ? 5000 : 500;
  }
  return parsed;
}

function isBenignMigrationStderr(stderr: string): boolean {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return true;
  }

  const benignLinePatterns = [
    /^Loaded Prisma config from /,
    /^Prisma schema loaded from /,
    /^Datasource /,
    /^Database schema /,
    /^No pending migrations to apply\./,
  ];

  return lines.every((line) => benignLinePatterns.some((pattern) => pattern.test(line)));
}
prisma.$on('query' as never, (e: PrismaQueryEvent) => {
  const duration = e.duration;
  const query = e.query;

  const isTestEnv = process.env.NODE_ENV === 'test';
  const slowQueryThreshold = parseSlowQueryThresholdMs(isTestEnv);

  // Log slow queries (500ms prod, 5s in tests to avoid noise)
  if (duration > slowQueryThreshold) {
    const logPayload = {
      query: truncateForLogs(query, 200),
      params: truncateForLogs(e.params, 600),
      duration,
      threshold: `${slowQueryThreshold}ms`,
    };
    if (isDevelopment || process.env.NODE_ENV === 'test') {
      logger.info(logPayload, 'Slow query detected');
    } else {
      logger.warn(logPayload, 'SLOW QUERY DETECTED - Performance optimization needed');
    }

    // Export to monitoring system (Prometheus)
    const operation = query.split(' ')[0]?.toUpperCase() || 'UNKNOWN';
    const tableMatch =
      query.match(/FROM\s+"?(\w+)"?/i) ||
      query.match(/INTO\s+"?(\w+)"?/i) ||
      query.match(/UPDATE\s+"?(\w+)"?/i);
    const table = tableMatch?.[1] || 'unknown';

    dbSlowQueries.inc({ operation, table });
    dbQueryDuration.observe({ operation, table }, duration / 1000);
  }

  // Log all queries in development
  if (isDevelopment) {
    logger.debug(
      {
        query,
        params: e.params,
        duration,
      },
      'Database query'
    );
  }
});

// Log errors
interface PrismaLogEvent {
  message: string;
  target: string;
  timestamp: Date;
}
prisma.$on('error' as never, (e: PrismaLogEvent) => {
  // Defensive: vitest's module-graph can leave the captured `logger` ref
  // pointing at a partial mock in some test orderings. Fall back to console
  // so the event handler never throws "logger.error is not a function".
  if (typeof logger?.error === 'function') {
    logger.error(e, 'Database error');
  } else {
    // eslint-disable-next-line no-console -- last-resort fallback when logger is unavailable
    console.error('[db] error', e);
  }
});

// Log warnings
prisma.$on('warn' as never, (e: PrismaLogEvent) => {
  if (typeof logger?.warn === 'function') {
    logger.warn(e, 'Database warning');
  } else {
    // eslint-disable-next-line no-console -- last-resort fallback when logger is unavailable
    console.warn('[db] warn', e);
  }
});

/**
 * Run Prisma migrations in production
 * Uses `prisma migrate deploy` which is safe for production environments
 */
/**
 * `SKIP_DB_MIGRATIONS` is the canonical flag (it is what index.ts checks
 * before even calling runMigrations). `SKIP_MIGRATIONS` used to be checked
 * only here, so the two names silently disagreed; it is kept as a deprecated
 * alias so an environment already setting it keeps working.
 */
export function shouldSkipMigrations(env: Record<string, string | undefined> = process.env): boolean {
  if (env.SKIP_DB_MIGRATIONS === 'true') {
    return true;
  }
  if (env.SKIP_MIGRATIONS === 'true') {
    logger.warn(
      'SKIP_MIGRATIONS is a deprecated alias and will stop being read; set SKIP_DB_MIGRATIONS=true instead'
    );
    return true;
  }
  return false;
}

export async function runMigrations(): Promise<void> {
  // Migrations run on every boot so the schema is up-to-date in all
  // environments; skipping is an explicit operator decision.
  if (shouldSkipMigrations()) {
    logger.warn('Migrations skipped via SKIP_DB_MIGRATIONS');
    return;
  }

  // In containerized environments (Docker), always use migrate deploy
  // In local development, we can use migrate dev for interactive development
  // But for consistency and safety, we always run migrate deploy unless explicitly disabled
  const isContainerized =
    process.env.DATABASE_AUTO_MIGRATE === 'true' ||
    process.env.CI === 'true' ||
    process.env.NODE_ENV === 'production' ||
    process.env.IN_DOCKER === 'true';

  if (!isContainerized && (isDevelopment || process.env.NODE_ENV === 'test')) {
    // In local development, log info but still apply migrations for consistency
    logger.info('Development mode detected - migrations will still be applied for consistency');
  }

  try {
    logger.info('Running database migrations...');
    const prismaSchemaPath = join(process.cwd(), 'prisma', 'schema.prisma');
    const prismaConfigPath = join(process.cwd(), 'prisma', 'prisma.config.ts');
    const prismaBinPath = join(process.cwd(), 'node_modules', '.bin', 'prisma');

    // Use absolute path to ensure we're using the correct Prisma binary
    // In Docker/container environments, node_modules may be in a different location
    const _prismaBinAbsolute = join(process.cwd(), 'node_modules', '@prisma', 'client', 'prisma');
    const prismaBinToUse = process.platform === 'win32' ? `${prismaBinPath}.cmd` : prismaBinPath;

    // Execute prisma migrate deploy - use sh to execute the shell script
    logger.info(
      {
        schemaPath: prismaSchemaPath,
        configPath: prismaConfigPath,
        binPath: prismaBinToUse,
        cwd: process.cwd(),
      },
      'Running database migrations'
    );

    // Deliberately the BASE (direct) URL, never getRuntimeDatabaseUrl():
    // prisma migrate's Schema Engine takes a session-level pg_advisory_lock
    // on a single connection, which pgbouncer's transaction pooling cannot
    // honour. config.database.url is direct by construction (compose builds
    // it from DB_HOST:-db); DATABASE_USE_POOLER only reroutes query traffic.
    const databaseUrl = config.database.url || process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required to run migrations');
    }
    assertMigrationTargetIsDirect(databaseUrl);
    const migrationTarget = describeDatabaseTarget(databaseUrl, {});
    logger.info(
      { host: migrationTarget.host, port: migrationTarget.port },
      'Migration target (always direct, never via pooler)'
    );

    const { stdout, stderr } = await execAsync(
      `"${prismaBinToUse}" migrate deploy --schema "${prismaSchemaPath}" --config "${prismaConfigPath}"`,
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
        },
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        cwd: process.cwd(),
      }
    );

    if (stdout) {
      logger.info({ output: stdout }, 'Migration output');
    }
    if (stderr && !stderr.includes('No pending migrations')) {
      if (isBenignMigrationStderr(stderr)) {
        logger.debug({ output: stderr }, 'Migration diagnostics');
      } else {
        logger.warn({ error: stderr }, 'Migration warnings');
      }
    }

    logger.info('✅ Database migrations completed');
  } catch (error: unknown) {
    // Log the full error for debugging
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Safely extract process execution error properties
    let stdout: string | undefined;
    let stderr: string | undefined;
    let code: number | string | undefined;
    let signal: string | undefined;

    // Safely extract process execution error properties without type assertions
    if (typeof error === 'object' && error !== null) {
      const errorRecord = error;

      // Extract stdout using Object.getOwnPropertyDescriptor for safety
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(errorRecord, 'stdout');
      if (stdoutDescriptor && typeof stdoutDescriptor.value === 'string') {
        stdout = stdoutDescriptor.value;
      }

      // Extract stderr using Object.getOwnPropertyDescriptor for safety
      const stderrDescriptor = Object.getOwnPropertyDescriptor(errorRecord, 'stderr');
      if (stderrDescriptor && typeof stderrDescriptor.value === 'string') {
        stderr = stderrDescriptor.value;
      }

      // Extract code safely (PropertyDescriptor.value is `any`; narrow to unknown)
      const codeDescriptor = Object.getOwnPropertyDescriptor(errorRecord, 'code');
      if (codeDescriptor) {
        const codeValue: unknown = codeDescriptor.value;
        if (typeof codeValue === 'number') {
          code = codeValue;
        } else if (typeof codeValue === 'string') {
          code = codeValue;
        }
      }

      // Extract signal safely
      const signalDescriptor = Object.getOwnPropertyDescriptor(errorRecord, 'signal');
      if (signalDescriptor && typeof signalDescriptor.value === 'string') {
        signal = signalDescriptor.value;
      }
    }

    logger.error(
      {
        error: errorMessage,
        stdout,
        stderr,
        code,
        signal,
      },
      'Failed to run migrations'
    );

    // Only throw if it's not a "no pending migrations" or "already applied" error
    const errorText = (stderr || errorMessage || '').toLowerCase();
    if (
      !errorText.includes('no pending migrations') &&
      !errorText.includes('already applied') &&
      !errorText.includes('database schema is up to date')
    ) {
      throw error;
    }

    logger.warn('Continuing despite migration warnings (migrations may already be applied)');
  }
}

/**
 * Connect to database with retry logic
 * CRITICAL: Migrations should be run BEFORE calling this function
 * This function only handles connection retry logic, not schema management
 */
export async function connectDatabase(): Promise<void> {
  // Migrations are now run separately in bootstrap() before calling this function
  // This separation ensures migrations are applied before any connection attempts

  const maxRetries = 10; // Increased from 5 to 10 for Cloud Run
  const retryDelay = 5000; // Increased from 3s to 5s for Cloud SQL connection

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await prisma.$connect();
      logger.info({ attempt }, '✅ Database connected');
      return;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage, attempt, maxRetries }, 'Failed to connect to database');

      if (attempt === maxRetries) {
        logger.fatal('Max database connection retries exceeded');
        throw error;
      }

      const delay = retryDelay * attempt; // Exponential backoff
      logger.info({ delay, nextAttempt: attempt + 1 }, 'Retrying database connection');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Disconnect from database
 *
 * Note: In test environments, this may be called multiple times.
 * Prisma's $disconnect() is idempotent and safe to call multiple times.
 *
 * IMPORTANT: There's a known issue with Prisma Query Engine and Rust panics
 * during cleanup when the process terminates. This is a Prisma bug and doesn't
 * affect test results - it only occurs during process shutdown.
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    // Add a small delay to allow any pending queries to complete
    // This helps reduce the chance of NAPI reference issues during cleanup
    await new Promise((resolve) => setTimeout(resolve, 50));

    await prisma.$disconnect();
    logger.info('Database disconnected');

    // Additional delay to allow Query Engine to clean up NAPI references
    // This is a workaround for a known Prisma issue where Rust panics can occur
    // during process exit if cleanup happens too quickly
    await new Promise((resolve) => setTimeout(resolve, 50));
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, 'Error disconnecting from database');
  }
}

/**
 * Health check for database with circuit breaker
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const { databaseCircuitBreaker } = await import('@/utils/circuit-breaker.js');

    await databaseCircuitBreaker.execute(async () => {
      await prisma.$queryRaw`SELECT 1`;
    });

    return true;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, 'Database health check failed');
    return false;
  }
}

export { Prisma };
