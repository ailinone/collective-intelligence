// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Configuration loader for Ailin Dev API
 * Loads and validates environment variables
 */

import { config as loadEnv } from 'dotenv';
// Note: Cannot import logger here to avoid circular dependency
// Logger will be available after config is initialized
import { getErrorMessage } from '@/utils/type-guards';
import type {
  AppConfig,
  AuthMode,
  SecretsProviderConfig,
  SecretsProviderType,
  BaseSecretsProviderConfig,
  VaultSecretsProviderConfig,
  AwsSecretsProviderConfig,
  AzureSecretsProviderConfig,
  GcpSecretsProviderConfig,
  EnvSecretsProviderConfig,
  SecretsRotationConfig,
  RedisSentinelNode,
} from '@/types';

// Load .env file
loadEnv();

/**
 * Get environment variable with validation
 */
function getEnv(key: string, defaultValue?: string): string {
  const envValue = process.env[key];
  if (envValue !== undefined) {
    return envValue;
  }
  if (defaultValue !== undefined) {
    return defaultValue;
  }
  throw new Error(`Missing required environment variable: ${key}`);
}

/**
 * Get optional environment variable (returns undefined if not set)
 */
function getEnvOptional(key: string): string | undefined {
  return process.env[key];
}

/**
 * Get number from environment variable
 */
function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for environment variable ${key}: ${value}`);
  }
  return parsed;
}

/**
 * Get boolean from environment variable
 */
function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function getEnvArray(key: string, defaultValue: string[]): string[] {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Branding configuration
 */
export const brandingConfig = {
  // Hide underlying models and show "Ailin1" instead
  hideModels: getEnvBoolean('AILIN_HIDE_MODELS', false),

  // Brand name to display
  brandName: getEnv('AILIN_BRAND_NAME', 'Ailin1'),

  // Show minimal metadata (only cost and time, hide strategy/models)
  minimalMetadata: getEnvBoolean('AILIN_MINIMAL_METADATA', false),

  // Show detailed metadata in logs (for internal tracking)
  logDetailedMetadata: getEnvBoolean('AILIN_LOG_DETAILED_METADATA', true),
};

function isValidSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function parseSemver(value: string): [number, number, number] {
  const [major = '0', minor = '0', patch = '0'] = value.split('.');
  return [parseInt(major, 10) || 0, parseInt(minor, 10) || 0, parseInt(patch, 10) || 0];
}

function compareSemver(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = parseSemver(a);
  const [bMajor, bMinor, bPatch] = parseSemver(b);

  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

/**
 * Get auth mode from environment variable
 */
function getEnvAuthMode(key: string, defaultValue: AuthMode): AuthMode {
  const value = process.env[key];
  if (!value) return defaultValue;

  switch (value.toLowerCase()) {
    case 'email_code':
    case 'email-code':
    case 'magic_link':
    case 'magic-link':
      return 'email_code';
    case 'password':
      return 'password';
    case 'sso':
      return 'sso';
    default:
      console.warn(
        `WARNING: Invalid auth mode "${value}" for ${key}. Using default "${defaultValue}".`
      );
      return defaultValue;
  }
}

function getEnvJson<T>(key: string): T | undefined {
  const value = process.env[key];
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn(`WARNING: Failed to parse JSON for ${key}: ${getErrorMessage(error)}`);
    return undefined;
  }
}

function getAuthEmailConfig(): AppConfig['auth']['email'] {
  const providerRaw = process.env.AUTH_EMAIL_PROVIDER ?? 'sendgrid';
  const provider = providerRaw.toLowerCase();

  const fromEmail =
    process.env.AUTH_EMAIL_FROM_EMAIL ??
    process.env.SENDGRID_FROM_EMAIL ??
    process.env.AWS_SES_FROM_EMAIL ??
    process.env.SMTP_FROM_EMAIL;

  const fromName = process.env.AUTH_EMAIL_FROM_NAME ?? 'Ailin Platform';

  if (provider === 'smtp') {
    const host = process.env.SMTP_HOST || '';
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';
    const secureEnv = process.env.SMTP_SECURE;
    const secure = secureEnv ? secureEnv.toLowerCase() === 'true' : port === 465;

    return {
      provider: 'smtp',
      fromEmail,
      fromName,
      smtp: {
        host,
        port,
        secure,
        auth: {
          user,
          pass,
        },
      },
    };
  }

  if (provider === 'ses') {
    const region = process.env.AWS_SES_REGION || process.env.AWS_REGION || 'us-east-1';
    return {
      provider: 'ses',
      fromEmail,
      fromName,
      ses: {
        region,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    };
  }

  // Default to sendgrid
  return {
    provider: 'sendgrid',
    fromEmail,
    fromName,
    sendgrid: {
      apiKey: process.env.SENDGRID_API_KEY,
    },
  };
}

function getAuthSSOConfig(): AppConfig['auth']['sso'] | undefined {
  const enabled = getEnvBoolean('AUTH_SSO_ENABLED', false);
  if (!enabled) {
    return undefined;
  }

  return {
    enabled: true,
    provider: process.env.AUTH_SSO_PROVIDER,
    metadata: getEnvJson<Record<string, unknown>>('AUTH_SSO_METADATA'),
  };
}

function buildProviderConfig(type: SecretsProviderType, priority: number): SecretsProviderConfig {
  const base: BaseSecretsProviderConfig = {
    id: `${type}-p${priority}`,
    type,
    priority,
    failOpen: getEnvBoolean(`SECRETS_PROVIDER_${type.toUpperCase()}_FAIL_OPEN`, type === 'env'),
  };

  switch (type) {
    case 'vault': {
      const address = getEnv('VAULT_ADDR');
      const token = getEnv('VAULT_TOKEN');
      const namespace = process.env.VAULT_NAMESPACE;
      const secretPath = getEnv('VAULT_SECRET_PATH', 'secret/data/ailin-dev');

      return {
        ...base,
        type: 'vault',
        options: {
          address,
          token,
          namespace,
          secretPath,
        },
      } as VaultSecretsProviderConfig;
    }
    case 'aws': {
      const region = getEnv('AWS_SECRETS_MANAGER_REGION');
      const secretPrefix = getEnv('AWS_SECRETS_MANAGER_PREFIX', 'ailin');
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      const roleArn = process.env.AWS_SECRETS_MANAGER_ROLE_ARN;

      return {
        ...base,
        type: 'aws',
        options: {
          region,
          secretPrefix,
          accessKeyId,
          secretAccessKey,
          roleArn,
        },
      } as AwsSecretsProviderConfig;
    }
    case 'azure': {
      const keyVaultUrl = getEnv('AZURE_KEY_VAULT_URL');
      const tenantId = process.env.AZURE_TENANT_ID;
      const clientId = process.env.AZURE_CLIENT_ID;
      const clientSecret = process.env.AZURE_CLIENT_SECRET;

      return {
        ...base,
        type: 'azure',
        options: {
          keyVaultUrl,
          tenantId,
          clientId,
          clientSecret,
        },
      } as AzureSecretsProviderConfig;
    }
    case 'gcp': {
      // Resolve project ID from the most common GCP variables.
      const projectId =
        process.env.GCP_SECRETS_PROJECT_ID ||
        process.env.GCP_PROJECT_ID ||
        process.env.GCP_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        '';
      
      const secretPrefix = process.env.GCP_SECRETS_PREFIX || 'ailin';
      const credentialsFile =
        process.env.GCP_SECRETS_CREDENTIALS_FILE ||
        process.env.GCP_CREDENTIALS_PATH ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const credentialsJson = process.env.GCP_SECRETS_CREDENTIALS_JSON;

      return {
        ...base,
        type: 'gcp',
        options: {
          projectId,
          secretPrefix,
          credentialsFile,
          credentialsJson,
        },
      } as GcpSecretsProviderConfig;
    }
    case 'env':
    default: {
      const prefix = process.env.SECRETS_ENV_PREFIX;
      return {
        ...base,
        type: 'env',
        options: {
          prefix,
        },
      } as EnvSecretsProviderConfig;
    }
  }
}

function parseSecretsProviders(): SecretsProviderConfig[] {
  // Try to detect GCP project automatically if not set
  let gcpProjectId = process.env.GCP_SECRETS_PROJECT_ID;
  if (!gcpProjectId) {
    // Try GCP_PROJECT_ID (common env var)
    gcpProjectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    // Default to known project if credentials are available
    if (!gcpProjectId && (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCP_APPLICATION_CREDENTIALS)) {
      gcpProjectId = process.env.GCP_PROJECT; // No baked-in default — set a GCP project env var
      // Cannot use logger here to avoid circular dependency
      // Logging will happen after config initialization
    }
  }
  
  const inferredDefault = gcpProjectId ? 'gcp' : 'env';
  const allowedProviders = new Set<SecretsProviderType>(['vault', 'aws', 'azure', 'gcp', 'env']);
  const primaryRaw = (process.env.SECRETS_PROVIDER_PRIMARY || inferredDefault).trim().toLowerCase();
  if (!allowedProviders.has(primaryRaw as SecretsProviderType)) {
    throw new Error(`Unsupported SECRETS_PROVIDER_PRIMARY value: ${primaryRaw}`);
  }
  const primary = primaryRaw as SecretsProviderType;
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  const strictSecretsProd =
    (process.env.FF_STRICT_SECRETS_PROD || '').trim().toLowerCase() === 'true' &&
    nodeEnv === 'production';

  const fallback = (process.env.SECRETS_PROVIDER_FALLBACK || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && allowedProviders.has(value as SecretsProviderType))
    .map((value) => value as SecretsProviderType);

  const effectiveFallback =
    strictSecretsProd && primary !== 'env'
      ? fallback.filter((value) => value !== 'env')
      : fallback;

  const uniqueOrder = Array.from(
    new Set([primary, ...effectiveFallback].filter((value) => value.length > 0))
  );

  if (!strictSecretsProd && !uniqueOrder.includes('env')) {
    uniqueOrder.push('env');
  }

  if (uniqueOrder.length === 0) {
    throw new Error('At least one secrets provider must be configured');
  }

  const providers: SecretsProviderConfig[] = [];
  for (const type of uniqueOrder) {
    try {
      providers.push(buildProviderConfig(type, providers.length + 1));
    } catch (error) {
      if (type === primary) {
        throw new Error(
          `Failed to configure secrets provider "${type}": ${getErrorMessage(error)}`
        );
      }
      console.warn(
        `WARNING: Skipping secrets provider "${type}" due to configuration error: ${getErrorMessage(error)}`
      );
    }
  }

  if (providers.length === 0) {
    throw new Error('At least one secrets provider must be configured');
  }

  if (!providers.some((provider) => provider.type === primary)) {
    throw new Error(`Primary secrets provider "${primary}" is not configured`);
  }

  return providers;
}

function parseRotationConfig(): SecretsRotationConfig {
  const rotationEnv = process.env.SECRETS_ROTATION_KEYS || '';
  const managedKeys = rotationEnv
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [key, lengthRaw, intervalRaw, providerId] = entry.split(':').map((part) => part.trim());
      if (!key) {
        throw new Error(`Invalid entry in SECRETS_ROTATION_KEYS (missing key): "${entry}"`);
      }
      const length = lengthRaw ? parseInt(lengthRaw, 10) : 64;
      if (Number.isNaN(length) || length <= 0) {
        throw new Error(
          `Invalid length in SECRETS_ROTATION_KEYS for "${entry}". Expected positive integer.`
        );
      }
      const intervalDays = intervalRaw ? parseInt(intervalRaw, 10) : 30;
      if (Number.isNaN(intervalDays) || intervalDays <= 0) {
        throw new Error(
          `Invalid rotation interval in SECRETS_ROTATION_KEYS for "${entry}". Expected positive integer (days).`
        );
      }
      return {
        key,
        providerId: providerId || undefined,
        length,
        intervalDays,
      };
    });

  return {
    cron: process.env.SECRETS_ROTATION_CRON || '0 3 * * *',
    managedKeys,
  };
}

const queueWorkerCount = getEnvNumber('QUEUE_WORKER_COUNT', 20);
const queueWorkerConcurrency = getEnvNumber('QUEUE_WORKER_CONCURRENCY', 100);
const queueScaleEnabledDefault = process.env.NODE_ENV !== 'test';
const queueScaleMinWorkers = getEnvNumber(
  'QUEUE_MIN_WORKERS',
  Math.max(1, Math.min(queueWorkerCount, Math.max(1, Math.floor(queueWorkerCount / 2))))
);
const queueScaleMaxWorkers = getEnvNumber(
  'QUEUE_MAX_WORKERS',
  Math.max(queueWorkerCount, queueScaleMinWorkers)
);
const queueScaleStep = getEnvNumber('QUEUE_SCALE_STEP', 2);
const queueScaleUpUtilization = getEnvNumber('QUEUE_SCALE_UP_UTILIZATION', 75);
const queueScaleDownUtilization = getEnvNumber('QUEUE_SCALE_DOWN_UTILIZATION', 30);
const queueScaleUpQueueSize = getEnvNumber('QUEUE_SCALE_UP_QUEUE_SIZE', 50);
const queueScaleDownQueueSize = getEnvNumber('QUEUE_SCALE_DOWN_QUEUE_SIZE', 5);
const queueScaleMonitorIntervalMs = getEnvNumber('QUEUE_SCALE_MONITOR_INTERVAL_MS', 15000);
const queueScaleCooldownMs = getEnvNumber('QUEUE_SCALE_COOLDOWN_MS', 60000);

interface ParsedRedisUrl {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

function parseRedisUrl(url: string | undefined): ParsedRedisUrl | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const dbPath = parsed.pathname?.replace('/', '').trim();
    const db = dbPath ? Number(dbPath) : undefined;
    if (db !== undefined && Number.isNaN(db)) {
      throw new Error(`Invalid Redis database in REDIS_URL: "${dbPath}"`);
    }

    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 6379,
      password: parsed.password || undefined,
      db,
    };
  } catch (error) {
    console.warn(`WARNING: Failed to parse REDIS_URL "${url}":`, error);
    return null;
  }
}

const redisUrlConfig = parseRedisUrl(process.env.REDIS_URL);
const redisHost = redisUrlConfig?.host ?? getEnv('REDIS_HOST', 'localhost');
const redisPort = redisUrlConfig?.port ?? getEnvNumber('REDIS_PORT', 6379);
const redisPassword = redisUrlConfig?.password ?? process.env.REDIS_PASSWORD;
const redisDb = redisUrlConfig?.db ?? getEnvNumber('REDIS_DB', 0);

/**
 * Parse a comma-separated "host:port,host:port" sentinel list (e.g.
 * `REDIS_SENTINELS=sentinel-1:26379,sentinel-2:26379,sentinel-3:26379`).
 */
function parseSentinelList(raw: string | undefined): RedisSentinelNode[] | undefined {
  if (!raw) return undefined;
  const nodes = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, portRaw] = entry.split(':');
      const port = Number(portRaw);
      if (!host || !Number.isFinite(port)) {
        throw new Error(`Invalid entry in sentinel list: "${entry}" (expected "host:port")`);
      }
      return { host, port };
    });
  return nodes.length > 0 ? nodes : undefined;
}

const redisSentinelEnabled = getEnvBoolean('REDIS_SENTINEL_ENABLED', false);
const redisSentinels = parseSentinelList(process.env.REDIS_SENTINELS);
const redisSentinelName = getEnv('REDIS_SENTINEL_NAME', 'mymaster');

// Money-path Redis (BullMQ queues + the idempotency store — see
// getQueueRedisClient()/createRedisClient() in cache/redis-client.ts). Every
// field falls back to the general redis.* value above when its REDIS_QUEUE_*
// override is unset, so an unconfigured deployment keeps today's
// single-instance behavior; pointing REDIS_QUEUE_* at a separate Redis
// isolates the money path from cache/rate-limit churn (docs/audit/16, Phase 5).
const redisQueueUrlConfig = parseRedisUrl(process.env.REDIS_QUEUE_URL);
const redisQueueHost = redisQueueUrlConfig?.host ?? process.env.REDIS_QUEUE_HOST ?? redisHost;
const redisQueuePort = redisQueueUrlConfig?.port ?? getEnvNumber('REDIS_QUEUE_PORT', redisPort);
const redisQueuePassword =
  redisQueueUrlConfig?.password ?? process.env.REDIS_QUEUE_PASSWORD ?? redisPassword;
const redisQueueDb = redisQueueUrlConfig?.db ?? getEnvNumber('REDIS_QUEUE_DB', redisDb);
const redisQueueSentinelEnabled = getEnvBoolean(
  'REDIS_QUEUE_SENTINEL_ENABLED',
  redisSentinelEnabled
);
const redisQueueSentinels = parseSentinelList(process.env.REDIS_QUEUE_SENTINELS) ?? redisSentinels;
const redisQueueSentinelName = process.env.REDIS_QUEUE_SENTINEL_NAME ?? redisSentinelName;

const defaultServiceIdentifier = process.env.SERVICE_NAME || process.env.OTEL_SERVICE_NAME || 'ci-api';
const defaultJwtIssuer = process.env.JWT_ISSUER || defaultServiceIdentifier;
const defaultJwtAudience = process.env.JWT_AUDIENCE || defaultServiceIdentifier;
const defaultJwtAlgorithms = getEnvArray('JWT_ALLOWED_ALGORITHMS', ['HS256']);
const defaultFederationAlgorithms = getEnvArray('AUTH_FEDERATION_ALLOWED_ALGORITHMS', ['HS256']);

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const propertyNames = Object.getOwnPropertyNames(value);
  for (const name of propertyNames) {
    const property = (value as Record<string, unknown>)[name];
    if (property && typeof property === 'object') {
      deepFreeze(property);
    }
  }

  return Object.freeze(value);
}

/**
 * Application configuration
 */
export const config: AppConfig = deepFreeze({
  env: (process.env.NODE_ENV as AppConfig['env']) || 'development',

  app: {
    version: getEnv('APP_VERSION', '0.1.0'),
    cliMinVersion: getEnv('CLI_MIN_VERSION', '0.0.1'),
    cliLatestVersion: getEnv('CLI_LATEST_VERSION', '0.1.0'),
    commitSha: process.env.GIT_COMMIT_SHA,
    buildTimestamp: process.env.BUILD_TIMESTAMP,
  },

  server: {
    port: getEnvNumber('PORT', 3000),
    host: getEnv('HOST', '0.0.0.0'),
    logLevel: (process.env.LOG_LEVEL as AppConfig['server']['logLevel']) || 'info',
  },

  api: {
    baseUrl: getEnv('API_BASE_URL', 'https://api.ailin.one'),
  },

  database: {
    url: getEnv('DATABASE_URL'),
    poolMin: getEnvNumber('DATABASE_POOL_MIN', 10),
    poolMax: getEnvNumber('DATABASE_POOL_MAX', 50),
    connectionTimeout: getEnvNumber('DATABASE_CONNECTION_TIMEOUT', 5000),
    idleTimeout: getEnvNumber('DATABASE_IDLE_TIMEOUT', 30000),
  },

  redis: {
    host: redisHost,
    port: redisPort,
    password: redisPassword,
    db: redisDb,
    clusterEnabled: getEnvBoolean('REDIS_CLUSTER_ENABLED', false),
    clusterNodes: process.env.REDIS_CLUSTER_NODES?.split(','),
    sentinelEnabled: redisSentinelEnabled,
    sentinels: redisSentinels,
    sentinelName: redisSentinelName,
  },

  redisQueue: {
    host: redisQueueHost,
    port: redisQueuePort,
    password: redisQueuePassword,
    db: redisQueueDb,
    clusterEnabled: false,
    sentinelEnabled: redisQueueSentinelEnabled,
    sentinels: redisQueueSentinels,
    sentinelName: redisQueueSentinelName,
  },

  queue: {
    enabled: getEnvBoolean('QUEUE_ENABLED', true),
    queueName: getEnv('QUEUE_NAME', 'chat-requests'),
    workerCount: queueWorkerCount,
    workerConcurrency: queueWorkerConcurrency,
    maxAttempts: getEnvNumber('QUEUE_MAX_ATTEMPTS', 3),
    backoffInitialDelayMs: getEnvNumber('QUEUE_BACKOFF_INITIAL_DELAY_MS', 1000),
    backoffStrategy:
      (process.env.QUEUE_BACKOFF_STRATEGY as AppConfig['queue']['backoffStrategy']) ??
      'exponential',
    resultTtlSeconds: getEnvNumber('QUEUE_RESULT_TTL_SECONDS', 86400),
    statusTtlSeconds: getEnvNumber('QUEUE_STATUS_TTL_SECONDS', 600),
    maxQueueTimeSeconds: getEnvNumber('QUEUE_MAX_QUEUE_TIME_SECONDS', 120),
    pollIntervalMs: getEnvNumber('QUEUE_POLL_INTERVAL_MS', 2000),
    runWorkersInApiProcess: getEnvBoolean('QUEUE_RUN_WORKERS_IN_API', true),
    workerMetricsPort: getEnvNumber('QUEUE_WORKER_METRICS_PORT', 9465),
    forceQueue: getEnvBoolean('QUEUE_FORCE_QUEUE', false),
    priority: {
      enterprise: getEnvNumber('QUEUE_PRIORITY_ENTERPRISE', 500),
      pro: getEnvNumber('QUEUE_PRIORITY_PRO', 3000),
      free: getEnvNumber('QUEUE_PRIORITY_FREE', 7500),
      jitter: getEnvNumber('QUEUE_PRIORITY_JITTER', 250),
    },
    scale: {
      enabled: getEnvBoolean('QUEUE_AUTOSCALE_ENABLED', queueScaleEnabledDefault),
      minWorkers: queueScaleMinWorkers,
      maxWorkers: queueScaleMaxWorkers,
      scaleStep: queueScaleStep,
      scaleUpUtilizationPercent: queueScaleUpUtilization,
      scaleDownUtilizationPercent: queueScaleDownUtilization,
      scaleUpQueueSize: queueScaleUpQueueSize,
      scaleDownQueueSize: queueScaleDownQueueSize,
      monitorIntervalMs: queueScaleMonitorIntervalMs,
      cooldownMs: queueScaleCooldownMs,
    },
  },

  providers: [
    {
      name: 'openai',
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL,
      organization: process.env.OPENAI_ORGANIZATION,
      enabled: !!process.env.OPENAI_API_KEY,
      // Scale-to-100k Phase 2: optional multi-account pool, e.g.
      // OPENAI_API_KEY_POOL=["sk-...","sk-..."] — rotated round-robin
      // alongside OPENAI_API_KEY so this provider's throughput isn't capped
      // by a single account's rate limit. See ProviderConfig.apiKeyPool.
      apiKeyPool: getEnvJson<string[]>('OPENAI_API_KEY_POOL'),
    },
    {
      name: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      enabled: !!process.env.ANTHROPIC_API_KEY,
      // Scale-to-100k Phase 2 follow-up (issue #152): see OPENAI_API_KEY_POOL above.
      apiKeyPool: getEnvJson<string[]>('ANTHROPIC_API_KEY_POOL'),
    },
    {
      name: 'google',
      apiKey: process.env.GOOGLE_API_KEY || '',
      baseUrl: process.env.GOOGLE_BASE_URL,
      enabled: !!process.env.GOOGLE_API_KEY,
      // Scale-to-100k Phase 2 follow-up (issue #152): see OPENAI_API_KEY_POOL above.
      apiKeyPool: getEnvJson<string[]>('GOOGLE_API_KEY_POOL'),
    },
    {
      name: 'deepseek',
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      enabled: !!process.env.DEEPSEEK_API_KEY,
    },
    {
      name: 'xai',
      apiKey: process.env.XAI_API_KEY || '',
      baseUrl: process.env.XAI_BASE_URL,
      enabled: !!process.env.XAI_API_KEY,
    },
    {
      name: 'mistral',
      apiKey: process.env.MISTRAL_API_KEY || '',
      baseUrl: process.env.MISTRAL_BASE_URL,
      enabled: !!process.env.MISTRAL_API_KEY,
    },
    {
      name: 'cohere',
      apiKey: process.env.COHERE_API_KEY || '',
      baseUrl: process.env.COHERE_BASE_URL,
      enabled: !!process.env.COHERE_API_KEY,
    },
    {
      name: 'nvidia',
      apiKey: process.env.NVIDIA_API_KEY || '',
      baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      enabled: !!process.env.NVIDIA_API_KEY,
    },
    {
      name: 'nvidia-hub',
      apiKey: process.env.NVIDIA_API_KEY || '',
      baseUrl: process.env.NVIDIA_HUB_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      enabled: !!process.env.NVIDIA_API_KEY,
    },
    {
      name: 'aihubmix',
      apiKey: process.env.AIHUBMIX_API_KEY || '',
      baseUrl: process.env.AIHUBMIX_BASE_URL || 'https://aihubmix.com/v1',
      enabled: !!process.env.AIHUBMIX_API_KEY,
    },
    {
      name: 'novita',
      apiKey: process.env.NOVITA_API_KEY || '',
      baseUrl: process.env.NOVITA_BASE_URL || 'https://api.novita.ai/openai/v1',
      enabled: !!process.env.NOVITA_API_KEY,
    },
    {
      name: 'moonshot',
      apiKey: process.env.MOONSHOT_API_KEY || '',
      baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1',
      enabled: !!process.env.MOONSHOT_API_KEY,
    },
    {
      name: 'minimax',
      apiKey: process.env.MINIMAX_API_KEY || '',
      baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1',
      enabled: !!process.env.MINIMAX_API_KEY,
    },
    {
      name: 'jina',
      apiKey: process.env.JINA_API_KEY || '',
      baseUrl: process.env.JINA_DEEPSEARCH_BASE_URL || 'https://deepsearch.jina.ai/v1',
      enabled: !!process.env.JINA_API_KEY,
      metadata: {
        apiBaseUrl: process.env.JINA_API_BASE_URL || 'https://api.jina.ai/v1',
        deepSearchBaseUrl: process.env.JINA_DEEPSEARCH_BASE_URL || 'https://deepsearch.jina.ai/v1',
        readerBaseUrl: process.env.JINA_READER_BASE_URL || 'https://r.jina.ai',
        searchBaseUrl: process.env.JINA_SEARCH_BASE_URL || 'https://s.jina.ai',
      },
    },
    {
      name: 'friendli',
      apiKey: process.env.FRIENDLI_API_KEY || '',
      baseUrl: process.env.FRIENDLI_BASE_URL || 'https://api.friendli.ai/serverless/v1',
      enabled: !!process.env.FRIENDLI_API_KEY,
      metadata: {
        extraHeaders: {
          'X-Friendli-Team': process.env.FRIENDLI_TEAM_ID || '',
        },
      },
    },
    {
      name: 'aiml',
      apiKey: process.env.AIML_API_KEY || '',
      baseUrl: process.env.AIML_BASE_URL || 'https://api.aimlapi.com/v1',
      enabled: !!process.env.AIML_API_KEY,
      metadata: {
        modelsBaseUrl: process.env.AIML_MODELS_BASE_URL || 'https://api.aimlapi.com',
      },
    },
    {
      name: 'imagerouter',
      apiKey: process.env.IMAGEROUTER_API_KEY || '',
      baseUrl: process.env.IMAGEROUTER_BASE_URL || 'https://api.imagerouter.io',
      enabled: !!process.env.IMAGEROUTER_API_KEY,
      metadata: {
        imagesPath: '/v1/openai/images/generations',
        imagesEditsPath: '/v1/openai/images/edits',
        videosPath: '/v1/openai/videos/generations',
        modelListPath: '/v1/models',
      },
    },
    {
      name: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY || '',
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      enabled: !!process.env.OPENROUTER_API_KEY,
      metadata: {
        appUrl: process.env.OPENROUTER_APP_URL,
        appName: process.env.OPENROUTER_APP_NAME || 'Ailin1',
      },
    },
    {
      name: 'orqai',
      apiKey: process.env.ORQAI_API_KEY || '',
      baseUrl: process.env.ORQAI_BASE_URL || 'https://api.orq.ai/v2/router',
      enabled: !!process.env.ORQAI_API_KEY,
    },
    {
      name: 'edenai',
      apiKey: process.env.EDENAI_API_KEY || '',
      baseUrl: process.env.EDENAI_BASE_URL || 'https://api.edenai.run/v3/llm',
      enabled: !!process.env.EDENAI_API_KEY,
    },
    {
      name: 'heliconeai',
      apiKey: process.env.HELICONEAI_API_KEY || '',
      baseUrl: process.env.HELICONEAI_BASE_URL || 'https://ai-gateway.helicone.ai/v1',
      enabled: !!process.env.HELICONEAI_API_KEY,
    },
    {
      name: 'vertex-ai',
      apiKey: process.env.VERTEX_AI_API_KEY || '',
      baseUrl: process.env.VERTEX_AI_BASE_URL,
      enabled: !!process.env.VERTEX_AI_PROJECT_ID || !!process.env.VERTEX_AI_API_KEY,
      metadata: {
        projectId: process.env.VERTEX_AI_PROJECT_ID,
        location: process.env.VERTEX_AI_LOCATION || 'us-central1',
        useExpressMode: process.env.VERTEX_AI_USE_EXPRESS_MODE === 'true',
      },
    },

    // ── Additional OpenAI-Compatible Hub Providers ──────────────
    {
      name: 'cometapi',
      apiKey: process.env.COMETAPI_API_KEY || '',
      baseUrl: process.env.COMETAPI_BASE_URL || 'https://api.cometapi.com/v1',
      enabled: !!process.env.COMETAPI_API_KEY,
    },
    {
      name: 'nanogpt',
      apiKey: process.env.NANOGPT_API_KEY || '',
      baseUrl: process.env.NANOGPT_BASE_URL || 'https://nano-gpt.com/api/v1',
      enabled: !!process.env.NANOGPT_API_KEY,
    },
    {
      name: 'requesty',
      apiKey: process.env.REQUESTY_API_KEY || '',
      baseUrl: process.env.REQUESTY_BASE_URL || 'https://router.requesty.ai/v1',
      enabled: !!process.env.REQUESTY_API_KEY,
    },
    {
      // Canonical providerId is `ai302` post-migration (2026-04-22). The
      // alias `302ai` lives in providers.catalog.ts aliases[] for any legacy
      // user configs; the runtime registration path is the catalog-loader.
      name: 'ai302',
      apiKey: process.env.AI302_API_KEY || '',
      baseUrl: process.env.AI302_BASE_URL || 'https://api.302.ai/v1',
      enabled: !!process.env.AI302_API_KEY,
    },
    {
      name: 'poe',
      apiKey: process.env.POE_API_KEY || '',
      baseUrl: process.env.POE_BASE_URL || 'https://api.poe.com/v1',
      enabled: !!process.env.POE_API_KEY,
    },
    {
      name: 'routeway',
      apiKey: process.env.ROUTEWAY_API_KEY || '',
      baseUrl: process.env.ROUTEWAY_BASE_URL || 'https://api.routeway.ai/v1',
      enabled: !!process.env.ROUTEWAY_API_KEY,
    },

    // ── Audio-First Providers (STT, TTS, STS) ──────────────────
    {
      name: 'deepgram',
      apiKey: process.env.DEEPGRAM_API_KEY || '',
      baseUrl: process.env.DEEPGRAM_BASE_URL || 'https://api.deepgram.com/v1',
      enabled: !!process.env.DEEPGRAM_API_KEY,
    },
    {
      name: 'cartesia',
      apiKey: process.env.CARTESIA_API_KEY || '',
      baseUrl: process.env.CARTESIA_BASE_URL || 'https://api.cartesia.ai',
      enabled: !!process.env.CARTESIA_API_KEY,
    },
    {
      name: 'elevenlabs',
      apiKey: process.env.ELEVENLABS_API_KEY || '',
      baseUrl: process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io/v1',
      enabled: !!process.env.ELEVENLABS_API_KEY,
    },
    // ── Translation Provider ──────────────────
    {
      name: 'palabraai',
      apiKey: process.env.PALABRAAI_CLIENT_SECRET || '',
      enabled: !!process.env.PALABRAAI_CLIENT_ID && !!process.env.PALABRAAI_CLIENT_SECRET,
      metadata: {
        clientId: process.env.PALABRAAI_CLIENT_ID,
        clientSecret: process.env.PALABRAAI_CLIENT_SECRET,
      },
    },

    // ── Self-hosted OAI-compat sidecars (ollama + local-llama/kobold/embeddings)
    //    moved OUT of config/index.ts by the 2026-04-22 residue-closure pass B.
    //    The catalog (`providers.catalog.ts`) owns their registration via
    //    `baseUrlEnvVar` opt-in (e.g. `OLLAMA_URL`, `LOCAL_LLAMA_URL`,
    //    `LOCAL_KOBOLD_URL`, `LOCAL_EMBEDDINGS_URL`). The catalog-loader
    //    inspects those env vars directly at boot and registers only when the
    //    user has opted in — identical semantics to the old config entries,
    //    without dual-registration noise in the logs.

    // ── Local CPU Inference Sidecars (non-OAI-compat sidecars only) ────
    //    These are NOT OpenAI-compatible on their normalized surface (OCR,
    //    PDF→JSON, translation, TTS). The catalog's integrationClass enum
    //    does not cover these shapes today, so they remain a switch-case +
    //    config entry exception until a richer class is defined.
    // PaddleOCR: document OCR
    ...(process.env.LOCAL_OCR_URL ? [{
      name: 'local-ocr',
      apiKey: 'local',
      baseUrl: process.env.LOCAL_OCR_URL,
      enabled: true,
    }] : []),
    // Docling: PDF → structured markdown/JSON
    ...(process.env.LOCAL_DOCLING_URL ? [{
      name: 'local-docling',
      apiKey: 'local',
      baseUrl: process.env.LOCAL_DOCLING_URL,
      enabled: true,
    }] : []),
    // Piper TTS: ultra-fast CPU-native TTS
    ...(process.env.LOCAL_PIPER_URL ? [{
      name: 'local-piper',
      apiKey: 'local',
      baseUrl: process.env.LOCAL_PIPER_URL,
      enabled: true,
    }] : []),
    // NLLB-200: neural machine translation (200 languages)
    ...(process.env.LOCAL_NLLB_URL ? [{
      name: 'local-nllb',
      apiKey: 'local',
      baseUrl: process.env.LOCAL_NLLB_URL,
      enabled: true,
    }] : []),
    // CosyVoice2: multilingual streaming TTS (9 languages, 150ms)
    ...(process.env.LOCAL_COSYVOICE_URL ? [{
      name: 'local-cosyvoice',
      apiKey: 'local',
      baseUrl: process.env.LOCAL_COSYVOICE_URL,
      enabled: true,
    }] : []),

    // ── Self-Hosted Inference (sidecar containers) ──────────────────
    ...(process.env.SELF_HOSTED_STT_URL || process.env.SELF_HOSTED_TTS_URL ? [{
      name: 'self-hosted',
      apiKey: 'local',
      enabled: true,
    }] : []),
  ],

  orchestration: {
    maxModels: getEnvNumber('ORCHESTRATION_MAX_MODELS', 9),
    defaultStrategy:
      (process.env
        .ORCHESTRATION_DEFAULT_STRATEGY as AppConfig['orchestration']['defaultStrategy']) || 'auto',
    enableParallel: getEnvBoolean('ORCHESTRATION_ENABLE_PARALLEL', true),
    enableCompetitive: getEnvBoolean('ORCHESTRATION_ENABLE_COMPETITIVE', true),
    enableArbitration: getEnvBoolean('ORCHESTRATION_ENABLE_ARBITRATION', true),
    enableTriaging: getEnvBoolean('ORCHESTRATION_ENABLE_TRIAGE', true),
    // No hardcoded default - will be dynamically discovered if not configured
    triageModel: getEnvOptional('ORCHESTRATION_TRIAGE_MODEL'),
    // Triage strategy: 'speed' | 'cost' | 'quality' | 'balanced' | 'adaptive'
    // Determines how triage models are selected dynamically based on capabilities
    triageStrategy: (process.env.ORCHESTRATION_TRIAGE_STRATEGY as 'speed' | 'cost' | 'quality' | 'balanced' | 'adaptive') || 'balanced',
    // Collective triage: number of models for collective triage (1-3, default: 1)
    // Multiple models will make independent decisions and reach consensus through voting
    triageCollective: getEnvNumber('ORCHESTRATION_TRIAGE_COLLECTIVE', 1),
    triageTemperature: Number(process.env.ORCHESTRATION_TRIAGE_TEMPERATURE ?? 0.0),
    // 256 -> 1024 (2026-07-13): the triage prompt asks for a COMPLETE
    // execution_plan JSON (stages, model_roles, route, recommended_tools,
    // generation_prompt) — 256 tokens truncated the JSON mid-object for any
    // non-trivial plan, failing the parse and silently dropping every LLM
    // triage to heuristics ("Triage model returned unparseable response"
    // observed repeatedly in prod). Cost impact is negligible: the triage
    // model is hard-capped cheap (maxAverageCostPer1k in applyTriageStrategy).
    triageMaxTokens: getEnvNumber('ORCHESTRATION_TRIAGE_MAX_TOKENS', 1024),
  },

  cache: {
    enabled: getEnvBoolean('CACHE_ENABLED', true),
    ttlDefault: getEnvNumber('CACHE_TTL_DEFAULT', 3600),
    ttlModels: getEnvNumber('CACHE_TTL_MODELS', 3600),
    ttlResponses: getEnvNumber('CACHE_TTL_RESPONSES', 86400),
    ttlEmbeddings: getEnvNumber('CACHE_TTL_EMBEDDINGS', 604800),
    maxSizeMb: getEnvNumber('CACHE_MAX_SIZE_MB', 256),
    maxInMemoryEntries: getEnvNumber('CACHE_MAX_IN_MEMORY_ENTRIES', 5000),
    invalidateChannel: getEnv('CACHE_INVALIDATE_CHANNEL', 'ailin:cache:invalidate'),
    circuitBreaker: {
      failureThreshold: getEnvNumber('CACHE_CIRCUIT_FAILURE_THRESHOLD', 5),
      resetTimeoutMs: getEnvNumber('CACHE_CIRCUIT_RESET_TIMEOUT_MS', 30000),
      disableCacheOnOpen: getEnvBoolean('CACHE_CIRCUIT_DISABLE_ON_OPEN', false),
    },
  },

  autoLearning: {
    enabled: getEnvBoolean('AUTO_LEARNING_ENABLED', true),
    bucketSizeHours: getEnvNumber('AUTO_LEARNING_BUCKET_SIZE_HOURS', 1),
    retentionDays: getEnvNumber('AUTO_LEARNING_RETENTION_DAYS', 365),
  },

  security: {
    jwtSecret: getEnv('JWT_SECRET'),
    jwtExpiresIn: getEnv('JWT_EXPIRES_IN', '24h'),
    jwtRefreshExpiresIn: getEnv('JWT_REFRESH_EXPIRES_IN', '30d'),
    jwtIssuer: defaultJwtIssuer,
    jwtAudience: defaultJwtAudience,
    jwtAlgorithms: defaultJwtAlgorithms,
    jwtClockToleranceSeconds: getEnvNumber('JWT_CLOCK_TOLERANCE_SECONDS', 30),
    federation: {
      enabled: getEnvBoolean('AUTH_FEDERATION_ENABLED', true),
      sharedSecret: process.env.AILIN_SHARED_JWT_SECRET,
      jwksUri: process.env.AUTH_FEDERATION_JWKS_URI,
      jwksCacheTtlSeconds: getEnvNumber('AUTH_FEDERATION_JWKS_CACHE_TTL_SECONDS', 300),
      allowSharedSecretFallback: getEnvBoolean('AUTH_FEDERATION_ALLOW_HS256_FALLBACK', true),
      issuer: getEnv('AUTH_FEDERATION_ISSUER', 'https://ailin.id'),
      audience: getEnv('AUTH_FEDERATION_AUDIENCE', defaultJwtAudience),
      algorithms: defaultFederationAlgorithms,
      clockToleranceSeconds: getEnvNumber('AUTH_FEDERATION_CLOCK_TOLERANCE_SECONDS', 30),
      autoProvisionUsers: getEnvBoolean('AUTH_FEDERATION_AUTO_PROVISION_USERS', true),
      autoProvisionOrganizations: getEnvBoolean('AUTH_FEDERATION_AUTO_PROVISION_ORGS', true),
    },
    // Machine-to-machine service-token auth for INTERNAL endpoints
    // (/v1/internal/*). Verifies RS256 tokens minted by the ailin id OIDC
    // provider (client_credentials / token-exchange) against id's JWKS — the
    // same keypair that signs user OIDC tokens. Distinct from `federation`
    // above, which validates *user* tokens and requires user claims.
    serviceAuth: {
      enabled: getEnvBoolean('SERVICE_AUTH_ENABLED', true),
      jwksUri: getEnv('SERVICE_AUTH_JWKS_URI', 'https://ailin.id/.well-known/jwks.json'),
      issuer: getEnv('SERVICE_AUTH_ISSUER', 'https://ailin.id'),
      audience: getEnv('SERVICE_AUTH_AUDIENCE', 'ailin-ci'),
      allowedClients: getEnvArray('SERVICE_AUTH_ALLOWED_CLIENTS', ['ailin-dev-server']),
      jwksCacheTtlSeconds: getEnvNumber('SERVICE_AUTH_JWKS_CACHE_TTL_SECONDS', 300),
      clockToleranceSeconds: getEnvNumber('SERVICE_AUTH_CLOCK_TOLERANCE_SECONDS', 30),
    },
    corsEnabled: getEnvBoolean('CORS_ENABLED', true),
    corsOrigin: getEnv('CORS_ORIGIN', '*'),
    helmetEnabled: getEnvBoolean('HELMET_ENABLED', true),
    compressionEnabled: getEnvBoolean('COMPRESSION_ENABLED', true),
    rbac: {
      defaultRole: getEnv('SECURITY_RBAC_DEFAULT_ROLE', 'viewer'),
      superRoles: (process.env.SECURITY_RBAC_SUPER_ROLES || 'owner,admin')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
      cacheTtlMs: getEnvNumber('SECURITY_RBAC_CACHE_TTL_MS', 60000),
    },
    audit: {
      enabled: getEnvBoolean('SECURITY_AUDIT_ENABLED', true),
      retentionDays: getEnvNumber('SECURITY_AUDIT_RETENTION_DAYS', 365),
    },
  },

  auth: {
    defaultMode: getEnvAuthMode('AUTH_DEFAULT_MODE', 'email_code'),
    allowPasswordFallback: getEnvBoolean('AUTH_ALLOW_PASSWORD_FALLBACK', true),
    code: {
      length: getEnvNumber('AUTH_CODE_LENGTH', 6),
      ttlSeconds: getEnvNumber('AUTH_CODE_TTL_SECONDS', 600),
      cooldownSeconds: getEnvNumber('AUTH_CODE_COOLDOWN_SECONDS', 60),
      maxAttempts: getEnvNumber('AUTH_CODE_MAX_ATTEMPTS', 5),
    },
    email: getAuthEmailConfig(),
    sso: getAuthSSOConfig(),
  },

  notifications: {
    apiKeys: {
      emailEnabled: getEnvBoolean('API_KEY_ROTATION_EMAIL_ENABLED', true),
      includePlainKeyInEmail: getEnvBoolean('API_KEY_ROTATION_EMAIL_INCLUDE_PLAIN_KEY', false),
      webhookEnabled: getEnvBoolean('API_KEY_ROTATION_WEBHOOK_ENABLED', false),
      webhookUrl: process.env.API_KEY_ROTATION_WEBHOOK_URL,
      webhookSecret: process.env.API_KEY_ROTATION_WEBHOOK_SECRET,
      includePlainKeyInWebhook: getEnvBoolean('API_KEY_ROTATION_WEBHOOK_INCLUDE_PLAIN_KEY', false),
      webhookTimeoutMs: getEnvNumber('API_KEY_ROTATION_WEBHOOK_TIMEOUT_MS', 5000),
    },
  },

  observability: {
    otelEnabled: getEnvBoolean('OTEL_ENABLED', false),
    serviceName: getEnv('OTEL_SERVICE_NAME', defaultServiceIdentifier),
    jaegerEndpoint: process.env.OTEL_EXPORTER_JAEGER_ENDPOINT,
    prometheusPort: getEnvNumber('OTEL_EXPORTER_PROMETHEUS_PORT', 9464),
    prometheusToken: process.env.PROMETHEUS_SCRAPE_TOKEN,
  },

  payments: {
    stripe: {
      enabled: getEnvBoolean('STRIPE_ENABLED', false),
      apiVersion: getEnv('STRIPE_API_VERSION', '2024-06-20'),
      secretKey: process.env.STRIPE_SECRET_KEY,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      clientRetryMs: getEnvNumber('STRIPE_CLIENT_RETRY_MS', 500),
      defaultCurrency: getEnv('STRIPE_DEFAULT_CURRENCY', 'usd').toLowerCase(),
      statementDescriptor: process.env.STRIPE_STATEMENT_DESCRIPTOR,
      successUrl: process.env.STRIPE_SUCCESS_URL,
      cancelUrl: process.env.STRIPE_CANCEL_URL,
      customerPortalReturnUrl: process.env.STRIPE_CUSTOMER_PORTAL_RETURN_URL,
      automaticTax: getEnvBoolean('STRIPE_AUTOMATIC_TAX', true),
      invoiceCollectionMethod:
        (process.env
          .STRIPE_INVOICE_COLLECTION_METHOD as AppConfig['payments']['stripe']['invoiceCollectionMethod']) ??
        'charge_automatically',
      invoiceDaysUntilDue: getEnvNumber('STRIPE_INVOICE_DAYS_UNTIL_DUE', 30),
      apiBaseUrl: process.env.STRIPE_API_BASE_URL,
      usageReconciliationCron: getEnv('STRIPE_USAGE_RECONCILIATION_CRON', '0 2 * * *'),
    },
  },

  secrets: {
    cacheTTL: getEnvNumber('SECRETS_CACHE_TTL_SECONDS', 300),
    autoRefresh: getEnvBoolean('SECRETS_AUTO_REFRESH', true),
    encryptCache: getEnvBoolean('SECRETS_ENCRYPT_CACHE', true),
    serviceAccount: process.env.SECRETS_SERVICE_ACCOUNT || 'ci-api',
    providers: parseSecretsProviders(),
    audit: {
      enabled: getEnvBoolean('SECRETS_AUDIT_ENABLED', true),
      persist: getEnvBoolean('SECRETS_AUDIT_PERSIST', true),
    },
    rotation: parseRotationConfig(),
  },
  resilience: {
    forceDistributedCircuits: getEnvBoolean('FORCE_DISTRIBUTED_CIRCUITS', false),
    forceDistributedTokenBuckets: getEnvBoolean('FORCE_DISTRIBUTED_TOKEN_BUCKETS', false),
    forceDistributedBulkheads: getEnvBoolean('FORCE_DISTRIBUTED_BULKHEADS', false),
  },
  featureFlags: {
    configRefreshSeconds: getEnvNumber('FEATURE_FLAGS_REFRESH_SECONDS', 60),
    authStrictClaims: getEnvBoolean('FF_AUTH_STRICT_CLAIMS', true),
    strictSecretsProd: getEnvBoolean('FF_STRICT_SECRETS_PROD', true),
  },
});

/**
 * Validate configuration
 */
export function validateConfig(): void {
  const errors: string[] = [];

  // Validate server config
  if (config.server.port < 1 || config.server.port > 65535) {
    errors.push('Invalid PORT: must be between 1 and 65535');
  }

  // Validate database URL
  if (!config.database.url || !config.database.url.startsWith('postgresql://')) {
    errors.push('Invalid DATABASE_URL: must be a PostgreSQL connection string');
  }

  // Validate JWT secret - only warn in production if too short, don't fail
  if (
    config.env === 'production' &&
    config.security.jwtSecret &&
    config.security.jwtSecret.length < 32
  ) {
    console.warn(
      'WARNING: JWT_SECRET is less than 32 characters. This is not recommended for production but will not block startup.'
    );
    // Don't add to errors - allow startup but warn
  }

  const supportedJwtAlgorithms = new Set([
    'HS256',
    'HS384',
    'HS512',
    'RS256',
    'RS384',
    'RS512',
    'ES256',
    'ES384',
    'ES512',
    'PS256',
    'PS384',
    'PS512',
  ]);
  if (config.security.jwtAlgorithms.length === 0) {
    errors.push('JWT_ALLOWED_ALGORITHMS must include at least one algorithm');
  } else {
    const invalidAlgorithms = config.security.jwtAlgorithms.filter(
      (algorithm) => !supportedJwtAlgorithms.has(algorithm)
    );
    if (invalidAlgorithms.length > 0) {
      errors.push(`JWT_ALLOWED_ALGORITHMS contains unsupported values: ${invalidAlgorithms.join(', ')}`);
    }
  }

  if (config.security.federation.algorithms.length === 0) {
    errors.push('AUTH_FEDERATION_ALLOWED_ALGORITHMS must include at least one algorithm');
  }

  if (config.env === 'production' && config.featureFlags.strictSecretsProd) {
    const requiredSecretKeys = ['JWT_SECRET'];
    if (config.security.federation.allowSharedSecretFallback && !config.security.federation.jwksUri) {
      requiredSecretKeys.push('AILIN_SHARED_JWT_SECRET');
    }
    const insecureValuePattern = /(change[-_]?me|mock|placeholder|example|dummy|test-only)/i;

    for (const key of requiredSecretKeys) {
      const value = process.env[key];
      if (!value || value.trim().length === 0) {
        errors.push(`${key} is required in production`);
        continue;
      }
      if (insecureValuePattern.test(value)) {
        errors.push(`${key} contains a non-production placeholder value`);
      }
    }
  }

  if (
    config.security.federation.enabled &&
    !config.security.federation.jwksUri &&
    !config.security.federation.sharedSecret
  ) {
    console.warn(
      'WARNING: AUTH_FEDERATION_ENABLED=true but neither AUTH_FEDERATION_JWKS_URI nor ' +
      'AILIN_SHARED_JWT_SECRET is set. Federated token validation will be disabled at runtime.'
    );
  }

  // Validate queue configuration
  if (config.queue.workerCount < 1) {
    errors.push('QUEUE_WORKER_COUNT must be at least 1');
  }

  if (config.queue.workerConcurrency < 1) {
    errors.push('QUEUE_WORKER_CONCURRENCY must be at least 1');
  }

  if (config.queue.maxAttempts < 1) {
    errors.push('QUEUE_MAX_ATTEMPTS must be at least 1');
  }

  if (!['exponential', 'fixed'].includes(config.queue.backoffStrategy)) {
    errors.push('QUEUE_BACKOFF_STRATEGY must be either "exponential" or "fixed"');
  }

  if (config.queue.maxQueueTimeSeconds < 1) {
    errors.push('QUEUE_MAX_QUEUE_TIME_SECONDS must be at least 1');
  }

  if (config.notifications.apiKeys.webhookEnabled) {
    if (!config.notifications.apiKeys.webhookUrl) {
      errors.push(
        'API_KEY_ROTATION_WEBHOOK_URL must be set when API_KEY_ROTATION_WEBHOOK_ENABLED=true'
      );
    }
  }

  if (config.notifications.apiKeys.webhookUrl) {
    const url = config.notifications.apiKeys.webhookUrl;
    if (!/^https?:\/\//i.test(url)) {
      errors.push('API_KEY_ROTATION_WEBHOOK_URL must be a valid HTTP(S) URL');
    }
  }

  if (config.notifications.apiKeys.webhookTimeoutMs < 100) {
    errors.push('API_KEY_ROTATION_WEBHOOK_TIMEOUT_MS must be at least 100 milliseconds');
  }

  if (
    config.queue.priority.enterprise <= 0 ||
    config.queue.priority.pro <= 0 ||
    config.queue.priority.free <= 0
  ) {
    errors.push('QUEUE_PRIORITY values must be positive integers');
  }

  if (config.queue.scale.minWorkers < 1) {
    errors.push('QUEUE_MIN_WORKERS must be at least 1');
  }

  if (config.queue.scale.maxWorkers < config.queue.scale.minWorkers) {
    errors.push('QUEUE_MAX_WORKERS must be greater than or equal to QUEUE_MIN_WORKERS');
  }

  if (config.queue.scale.scaleStep < 1) {
    errors.push('QUEUE_SCALE_STEP must be at least 1');
  }

  if (
    config.queue.scale.scaleUpUtilizationPercent < 0 ||
    config.queue.scale.scaleUpUtilizationPercent > 100 ||
    config.queue.scale.scaleDownUtilizationPercent < 0 ||
    config.queue.scale.scaleDownUtilizationPercent > 100
  ) {
    errors.push('QUEUE scale utilization thresholds must be between 0 and 100');
  }

  if (
    config.queue.scale.scaleDownUtilizationPercent > config.queue.scale.scaleUpUtilizationPercent
  ) {
    errors.push('QUEUE_SCALE_DOWN_UTILIZATION cannot exceed QUEUE_SCALE_UP_UTILIZATION');
  }

  if (config.queue.scale.scaleUpQueueSize < 0 || config.queue.scale.scaleDownQueueSize < 0) {
    errors.push('QUEUE scale queue size thresholds must be zero or positive');
  }

  if (config.queue.scale.monitorIntervalMs < 1000) {
    errors.push('QUEUE_SCALE_MONITOR_INTERVAL_MS must be at least 1000 milliseconds');
  }

  if (config.queue.scale.cooldownMs < 1000) {
    errors.push('QUEUE_SCALE_COOLDOWN_MS must be at least 1000 milliseconds');
  }

  if (config.cache.maxInMemoryEntries < 0) {
    errors.push('CACHE_MAX_IN_MEMORY_ENTRIES must be zero or positive');
  }

  if (!config.cache.invalidateChannel) {
    errors.push('CACHE_INVALIDATE_CHANNEL must be provided');
  }

  if (config.cache.circuitBreaker.failureThreshold < 1) {
    errors.push('CACHE_CIRCUIT_FAILURE_THRESHOLD must be at least 1');
  }

  if (config.cache.circuitBreaker.resetTimeoutMs < 1000) {
    errors.push('CACHE_CIRCUIT_RESET_TIMEOUT_MS must be at least 1000 milliseconds');
  }

  // Validate application metadata
  if (!isValidSemver(config.app.version)) {
    errors.push('APP_VERSION must use semantic versioning (e.g., 0.1.0)');
  }
  if (!isValidSemver(config.app.cliMinVersion)) {
    errors.push('CLI_MIN_VERSION must use semantic versioning (e.g., 0.1.0)');
  }
  if (!isValidSemver(config.app.cliLatestVersion)) {
    errors.push('CLI_LATEST_VERSION must use semantic versioning (e.g., 0.1.0)');
  }
  if (compareSemver(config.app.cliMinVersion, config.app.cliLatestVersion) > 0) {
    errors.push('CLI_MIN_VERSION cannot be greater than CLI_LATEST_VERSION');
  }

  // Validate secrets configuration
  if (config.secrets.providers.length === 0) {
    errors.push('At least one secrets provider must be configured');
  }

  const providerIds = new Set<string>();
  for (const provider of config.secrets.providers) {
    if (providerIds.has(provider.id)) {
      errors.push(`Duplicate secrets provider id detected: ${provider.id}`);
    }
    providerIds.add(provider.id);

    switch (provider.type) {
      case 'vault': {
        const options = provider.options as VaultSecretsProviderConfig['options'];
        if (!options.address) {
          errors.push('Vault provider requires VAULT_ADDR');
        }
        if (!options.token) {
          errors.push('Vault provider requires VAULT_TOKEN');
        }
        break;
      }
      case 'aws': {
        const options = provider.options as AwsSecretsProviderConfig['options'];
        if (!options.region) {
          errors.push('AWS Secrets Manager provider requires AWS_SECRETS_MANAGER_REGION');
        }
        break;
      }
      case 'azure': {
        const options = provider.options as AzureSecretsProviderConfig['options'];
        if (!options.keyVaultUrl) {
          errors.push('Azure Key Vault provider requires AZURE_KEY_VAULT_URL');
        }
        break;
      }
      case 'gcp': {
        const options = provider.options as GcpSecretsProviderConfig['options'];
        if (!options.projectId) {
          errors.push('GCP Secrets Manager provider requires GCP_SECRETS_PROJECT_ID');
        }
        break;
      }
      default:
        break;
    }
  }

  if (config.env === 'production' && config.featureFlags.strictSecretsProd) {
    const orderedProviders = [...config.secrets.providers].sort((a, b) => a.priority - b.priority);
    const primarySecretsProvider = orderedProviders[0]?.type;
    if (primarySecretsProvider !== 'gcp') {
      errors.push('SECRETS_PROVIDER_PRIMARY must be "gcp" in production environments');
    }
  }

  if (!config.security.rbac.defaultRole) {
    errors.push('SECURITY_RBAC_DEFAULT_ROLE must be defined');
  }
  if (config.security.rbac.cacheTtlMs < 1000) {
    errors.push('SECURITY_RBAC_CACHE_TTL_MS must be at least 1000');
  }
  if (config.security.audit.retentionDays < 1) {
    errors.push('SECURITY_AUDIT_RETENTION_DAYS must be at least 1');
  }

  if (config.payments.stripe.enabled) {
    if (!config.payments.stripe.secretKey) {
      errors.push('STRIPE_SECRET_KEY must be set when STRIPE_ENABLED=true');
    }
    if (!config.payments.stripe.webhookSecret) {
      errors.push('STRIPE_WEBHOOK_SECRET must be set when STRIPE_ENABLED=true');
    }
    const method = config.payments.stripe.invoiceCollectionMethod;
    if (!['send_invoice', 'charge_automatically'].includes(method)) {
      errors.push(
        'STRIPE_INVOICE_COLLECTION_METHOD must be either "send_invoice" or "charge_automatically"'
      );
    }
    if (!/^[a-z]{3}$/.test(config.payments.stripe.defaultCurrency)) {
      errors.push('STRIPE_DEFAULT_CURRENCY must be a 3-letter ISO currency code (lowercase)');
    }
    if (config.payments.stripe.apiBaseUrl) {
      try {
        const url = new URL(config.payments.stripe.apiBaseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
          errors.push('STRIPE_API_BASE_URL must use http or https protocol');
        }
      } catch (err) {
        errors.push(`Invalid STRIPE_API_BASE_URL: ${getErrorMessage(err)}`);
      }
    }
  }

  // Validate at least one provider is configured
  // NOTE: API can start without providers for health checks and infrastructure validation
  // LLM endpoints will return appropriate errors if no providers are available
  if (config.providers.length === 0) {
    console.warn('WARNING: No LLM providers configured. LLM endpoints will be unavailable.');
    console.warn('    Configure at least one provider via environment variables:');
    console.warn('    - OPENAI_API_KEY');
    console.warn('    - ANTHROPIC_API_KEY');
    console.warn('    - GOOGLE_API_KEY');
    console.warn('    - etc.');
  }

  // Validate orchestration config
  if (config.orchestration.maxModels < 1 || config.orchestration.maxModels > 9) {
    errors.push('ORCHESTRATION_MAX_MODELS must be between 1 and 9');
  }

  // Validate auth configuration
  if (config.auth.code.length < 4 || config.auth.code.length > 12) {
    errors.push('AUTH_CODE_LENGTH must be between 4 and 12 digits');
  }

  if (config.auth.code.ttlSeconds < 60) {
    errors.push('AUTH_CODE_TTL_SECONDS must be at least 60 seconds');
  }

  if (config.auth.code.maxAttempts < 1) {
    errors.push('AUTH_CODE_MAX_ATTEMPTS must be at least 1');
  }

  if (
    config.env === 'production' &&
    config.auth.defaultMode === 'email_code' &&
    config.auth.email.provider === 'sendgrid' &&
    !config.auth.email.sendgrid?.apiKey
  ) {
    console.warn(
      'WARNING: SendGrid API key not configured. Email code authentication will fail.'
    );
  }

  if (config.auth.email.provider === 'smtp') {
    const smtp = config.auth.email.smtp;
    // Check both config and environment variables (secrets may be loaded later)
    const hasConfig = smtp?.host && smtp.auth?.user && smtp.auth?.pass;
    const hasEnv = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;

    if (!hasConfig && !hasEnv) {
      errors.push('SMTP configuration incomplete. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

/**
 * Is development environment
 */
export const isDevelopment = config.env === 'development';

/**
 * Is production environment
 */
export const isProduction = config.env === 'production';

/**
 * Is test environment
 */
export const isTest = config.env === 'test';

