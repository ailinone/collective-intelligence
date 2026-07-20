// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Secrets Loader Helper (v5.0)
 *
 * Centralized helper for loading secrets from Secrets Manager
 * with graceful fallback to environment variables
 *
 * Usage:
 *   const apiKey = await loadSecret('openai-api-key');
 *   const secrets = await loadSecrets(['jwt-secret', 'database-url']);
 */

import { getSecretsManager } from './secrets-manager.js';
import { logger } from '../utils/logger.js';

// ============================================
// Secret Key Mapping
// ============================================

/**
 * Map of application secret keys to Secrets Manager keys
 *
 * Format:
 * - Secrets Manager: kebab-case (e.g., 'openai-api-key')
 * - Environment Var: UPPER_SNAKE_CASE (e.g., 'OPENAI_API_KEY')
 */
const SECRET_KEY_MAP: Record<string, string> = {
  // Database
  'database-url': 'DATABASE_URL',
  'database-password': 'DATABASE_PASSWORD',

  // Redis
  'redis-password': 'REDIS_PASSWORD',

  // JWT
  'jwt-secret': 'JWT_SECRET',
  'jwt-refresh-secret': 'JWT_REFRESH_SECRET',

  // Encryption
  'encryption-key': 'ENCRYPTION_KEY',

  // LLM Providers
  'openai-api-key': 'OPENAI_API_KEY',
  'openai-key': 'OPENAI_API_KEY',
  'anthropic-api-key': 'ANTHROPIC_API_KEY',
  'anthropic-key': 'ANTHROPIC_API_KEY',
  'google-api-key': 'GOOGLE_API_KEY',
  'google-key': 'GOOGLE_API_KEY',
  'deepseek-api-key': 'DEEPSEEK_API_KEY',
  'deepseek-key': 'DEEPSEEK_API_KEY',
  'xai-api-key': 'XAI_API_KEY',
  'xai-key': 'XAI_API_KEY',
  'mistral-api-key': 'MISTRAL_API_KEY',
  'mistral-key': 'MISTRAL_API_KEY',
  'cohere-api-key': 'COHERE_API_KEY',
  'cohere-key': 'COHERE_API_KEY',
  'nvidia-api-key': 'NVIDIA_API_KEY',
  'nvidia-key': 'NVIDIA_API_KEY',
  'nvidia-hub-api-key': 'NVIDIA_API_KEY',
  'nvidia-hub-key': 'NVIDIA_API_KEY',
  'aihubmix-api-key': 'AIHUBMIX_API_KEY',
  'aihubmix-key': 'AIHUBMIX_API_KEY',
  'novita-api-key': 'NOVITA_API_KEY',
  'novita-key': 'NOVITA_API_KEY',
  'moonshot-api-key': 'MOONSHOT_API_KEY',
  'moonshot-key': 'MOONSHOT_API_KEY',
  'minimax-api-key': 'MINIMAX_API_KEY',
  'minimax-key': 'MINIMAX_API_KEY',
  'jina-api-key': 'JINA_API_KEY',
  'jina-key': 'JINA_API_KEY',
  'friendli-api-key': 'FRIENDLI_API_KEY',
  'friendli-key': 'FRIENDLI_API_KEY',
  'friendli-team-id': 'FRIENDLI_TEAM_ID',
  'aiml-api-key': 'AIML_API_KEY',
  'aiml-key': 'AIML_API_KEY',
  'imagerouter-api-key': 'IMAGEROUTER_API_KEY',
  'imagerouter-key': 'IMAGEROUTER_API_KEY',
  'orqai-api-key': 'ORQAI_API_KEY',
  'orqai-key': 'ORQAI_API_KEY',
  'edenai-api-key': 'EDENAI_API_KEY',
  'edenai-key': 'EDENAI_API_KEY',
  'heliconeai-api-key': 'HELICONEAI_API_KEY',
  'heliconeai-key': 'HELICONEAI_API_KEY',
  'cometapi-api-key': 'COMETAPI_API_KEY',
  'cometapi-key': 'COMETAPI_API_KEY',
  'nanogpt-api-key': 'NANOGPT_API_KEY',
  'nanogpt-key': 'NANOGPT_API_KEY',
  'requesty-api-key': 'REQUESTY_API_KEY',
  'requesty-key': 'REQUESTY_API_KEY',
  '302-key': 'AI302_API_KEY',
  '302ai-key': 'AI302_API_KEY',
  '302-api-key': 'AI302_API_KEY',
  'poe-api-key': 'POE_API_KEY',
  'poe-key': 'POE_API_KEY',
  'routeway-api-key': 'ROUTEWAY_API_KEY',
  'routeway-key': 'ROUTEWAY_API_KEY',

  // Cloud Hubs
  'vertex-ai-credentials': 'VERTEX_AI_CREDENTIALS',
  'azure-openai-api-key': 'AZURE_OPENAI_API_KEY',
  'aws-bedrock-access-key': 'AWS_BEDROCK_ACCESS_KEY',
  'oci-api-key': 'OCI_API_KEY',

  // Monitoring
  'sentry-dsn': 'SENTRY_DSN',
  'prometheus-password': 'PROMETHEUS_PASSWORD',

  // Notifications (future)
  'sendgrid-api-key': 'SENDGRID_API_KEY',
  'slack-webhook-url': 'SLACK_WEBHOOK_URL',
};

const SECRET_KEY_ALIASES: Record<string, string[]> = {
  'openai-api-key': ['openai-key'],
  'anthropic-api-key': ['anthropic-key'],
  'google-api-key': ['google-key'],
  'deepseek-api-key': ['deepseek-key'],
  'xai-api-key': ['xai-key'],
  'mistral-api-key': ['mistral-key'],
  'cohere-api-key': ['cohere-key'],
  'nvidia-api-key': ['nvidia-key', 'nvidia-hub-api-key', 'nvidia-hub-key'],
  'aihubmix-api-key': ['aihubmix-key'],
  'novita-api-key': ['novita-key'],
  'moonshot-api-key': ['moonshot-key'],
  'minimax-api-key': ['minimax-key'],
  'jina-api-key': ['jina-key'],
  'friendli-api-key': ['friendli-key'],
  'aiml-api-key': ['aiml-key'],
  'imagerouter-api-key': ['imagerouter-key'],
  'orqai-api-key': ['orqai-key'],
  'edenai-api-key': ['edenai-key'],
  'heliconeai-api-key': ['heliconeai-key'],
  'cometapi-api-key': ['cometapi-key'],
  'nanogpt-api-key': ['nanogpt-key'],
  'requesty-api-key': ['requesty-key'],
  '302-api-key': ['302-key', '302ai-key'],
  'poe-api-key': ['poe-key'],
  'routeway-api-key': ['routeway-key'],
};

function getSecretCandidates(key: string): string[] {
  const directAliases = SECRET_KEY_ALIASES[key] || [];
  const reverseAliases = Object.entries(SECRET_KEY_ALIASES)
    .filter(([, aliases]) => aliases.includes(key))
    .map(([primary]) => primary);

  return Array.from(new Set([key, ...directAliases, ...reverseAliases]));
}

// ============================================
// Load Single Secret
// ============================================

/**
 * Load a single secret from Secrets Manager with fallback
 *
 * Priority:
 * 1. Secrets Manager (if initialized)
 * 2. Environment variable (fallback)
 *
 * @param key - Secret key (kebab-case, e.g., 'openai-api-key')
 * @param required - Throw error if not found
 * @returns Secret value or undefined
 */
export async function loadSecret(
  key: string,
  required: boolean = false
): Promise<string | undefined> {
  const candidates = getSecretCandidates(key);
  let managerLookupError: Error | undefined;

  try {
    const secretsManager = getSecretsManager();

    for (const candidate of candidates) {
      try {
        const value = await secretsManager.getSecret(candidate);
        logger.debug({ requestedKey: key, resolvedKey: candidate }, 'Secret loaded from Secrets Manager');
        return value;
      } catch (error) {
        managerLookupError = error as Error;
      }
    }
  } catch (error) {
    managerLookupError = error as Error;
  }

  // Fallback to environment variable
  for (const candidate of candidates) {
    const envKey = SECRET_KEY_MAP[candidate] || candidate.toUpperCase().replace(/-/g, '_');
    const value = process.env[envKey];
    if (value) {
      logger.debug(
        { requestedKey: key, resolvedKey: candidate, envKey, source: 'environment' },
        'Secret loaded from environment (fallback)'
      );
      return value;
    }
  }

  if (required) {
    throw new Error(
      `Required secret not found: ${key} (tried aliases: ${candidates.join(', ')})` +
        (managerLookupError ? `; manager error: ${managerLookupError.message}` : '')
    );
  }

  return undefined;
}

/**
 * Load a required secret (throws if not found)
 */
export async function loadSecretRequired(key: string): Promise<string> {
  const value = await loadSecret(key, true);
  if (!value) {
    throw new Error(`Required secret not found: ${key}`);
  }
  return value;
}

// ============================================
// Load Multiple Secrets
// ============================================

/**
 * Load multiple secrets in parallel
 *
 * More efficient than calling loadSecret multiple times
 */
export async function loadSecrets(keys: string[]): Promise<Record<string, string | undefined>> {
  const entries = await Promise.all(
    keys.map(async (key) => [key, await loadSecret(key, false)] as const)
  );
  return Object.fromEntries(entries);
}

// ============================================
// Batch Loader (for Config)
// ============================================

/**
 * Load all secrets needed for application config
 * Called once at startup
 */
export async function loadAllApplicationSecrets(): Promise<{
  database: {
    url: string;
    password?: string;
  };
  redis: {
    password?: string;
  };
  jwt: {
    secret: string;
    refreshSecret?: string;
  };
  providers: Record<string, string>;
  monitoring: {
    sentryDsn?: string;
    prometheusPassword?: string;
  };
}> {
  logger.info('Loading all application secrets...');

  const secretKeys = [
    'database-url',
    'database-password',
    'redis-password',
    'jwt-secret',
    'jwt-refresh-secret',
    'openai-api-key',
    'anthropic-api-key',
    'google-api-key',
    'deepseek-api-key',
    'xai-api-key',
    'mistral-api-key',
    'cohere-api-key',
    'nvidia-api-key',
    'aihubmix-api-key',
    'novita-api-key',
    'moonshot-api-key',
    'minimax-api-key',
    'jina-api-key',
    'friendli-api-key',
    'aiml-api-key',
    'imagerouter-api-key',
    'orqai-api-key',
    'edenai-api-key',
    'heliconeai-api-key',
    'sentry-dsn',
  ];

  const secrets = await loadSecrets(secretKeys);

  // Validate critical secrets
  if (!secrets['database-url']) {
    throw new Error('DATABASE_URL is required');
  }
  if (!secrets['jwt-secret']) {
    throw new Error('JWT_SECRET is required');
  }

  logger.info(
    {
      loaded: Object.keys(secrets).filter((k) => secrets[k]).length,
      total: secretKeys.length,
    },
    '✅ Application secrets loaded'
  );

  return {
    database: {
      url: secrets['database-url']!,
      password: secrets['database-password'],
    },
    redis: {
      password: secrets['redis-password'],
    },
    jwt: {
      secret: secrets['jwt-secret']!,
      refreshSecret: secrets['jwt-refresh-secret'],
    },
    providers: {
      openai: secrets['openai-api-key'] || '',
      anthropic: secrets['anthropic-api-key'] || '',
      google: secrets['google-api-key'] || '',
      deepseek: secrets['deepseek-api-key'] || '',
      xai: secrets['xai-api-key'] || '',
      mistral: secrets['mistral-api-key'] || '',
      cohere: secrets['cohere-api-key'] || '',
      nvidia: secrets['nvidia-api-key'] || '',
      aihubmix: secrets['aihubmix-api-key'] || '',
      novita: secrets['novita-api-key'] || '',
      moonshot: secrets['moonshot-api-key'] || '',
      minimax: secrets['minimax-api-key'] || '',
      jina: secrets['jina-api-key'] || '',
      friendli: secrets['friendli-api-key'] || '',
      aiml: secrets['aiml-api-key'] || '',
      imagerouter: secrets['imagerouter-api-key'] || '',
      orqai: secrets['orqai-api-key'] || '',
      edenai: secrets['edenai-api-key'] || '',
      heliconeai: secrets['heliconeai-api-key'] || '',
    },
    monitoring: {
      sentryDsn: secrets['sentry-dsn'],
    },
  };
}

// ============================================
// Refresh Helper
// ============================================

/**
 * Refresh a secret (useful before expiry)
 */
export async function refreshSecret(key: string): Promise<void> {
  try {
    const secretsManager = getSecretsManager();
    await secretsManager.refreshSecret(key);
    logger.info({ key }, 'Secret refreshed in cache');
  } catch (error) {
    logger.warn({ key, error }, 'Failed to refresh secret');
  }
}

/**
 * Clear secret cache (force reload)
 */
export function clearSecretCache(key?: string): void {
  try {
    const secretsManager = getSecretsManager();
    secretsManager.clearSecretCache(key);
    logger.info({ key: key || 'all' }, 'Secret cache cleared');
  } catch (error) {
    logger.warn('Secrets Manager not initialized, cannot clear cache');
  }
}
