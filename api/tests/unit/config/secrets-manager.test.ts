// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Secrets Manager - Unit Tests aligned with current architecture
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsManager, initializeSecretsManager, getSecretsManager, shutdownSecretsManager } from '@/config/secrets-manager';
import { EnvSecretsProvider } from '@/config/providers/env-provider';
import type { SecretsConfig, EnvSecretsProviderConfig } from '@/types';

// Interface to access private properties for testing
interface SecretsManagerWithInternals extends SecretsManager {
  cache: Map<string, unknown>;
}

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock('@/services/secret-audit-service', () => ({
  recordSecretAudit: vi.fn().mockResolvedValue(undefined),
}));

function createEnvProviderConfig(overrides?: Partial<EnvSecretsProviderConfig>): EnvSecretsProviderConfig {
  return {
    id: overrides?.id ?? `env-${Date.now()}`,
    type: 'env',
    priority: overrides?.priority ?? 1,
    failOpen: overrides?.failOpen ?? true,
    options: {
      prefix: overrides?.options?.prefix,
    },
  };
}

function createSecretsConfig(
  overrides?: Partial<SecretsConfig>,
  providerOverrides?: Partial<EnvSecretsProviderConfig>
): SecretsConfig {
  const providerConfig = createEnvProviderConfig(providerOverrides);
  return {
    cacheTTL: overrides?.cacheTTL ?? 5,
    autoRefresh: overrides?.autoRefresh ?? false,
    encryptCache: overrides?.encryptCache ?? false,
    serviceAccount: overrides?.serviceAccount ?? 'svc-test',
    providers: [providerConfig],
    audit: overrides?.audit ?? { enabled: false, persist: false },
    rotation: overrides?.rotation ?? { cron: undefined, managedKeys: [] },
  };
}

async function createEnvSecretsManager(options?: {
  configOverrides?: Partial<SecretsConfig>;
  providerOverrides?: Partial<EnvSecretsProviderConfig>;
}): Promise<{ manager: SecretsManager; config: SecretsConfig }> {
  const config = createSecretsConfig(options?.configOverrides, options?.providerOverrides);
  const providerConfig = config.providers[0] as EnvSecretsProviderConfig;
  const provider = new EnvSecretsProvider(providerConfig);
  const manager = new SecretsManager(config, [provider]);
  await manager.initialize();
  return { manager, config };
}

describe('SecretsManager (Env Provider)', () => {
  const envKeysToCleanup = new Set<string>();

  function setEnv(key: string, value: string): void {
    process.env[key] = value;
    envKeysToCleanup.add(key);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await shutdownSecretsManager();
  });

  afterEach(async () => {
    await shutdownSecretsManager();
    for (const key of envKeysToCleanup) {
      delete process.env[key];
    }
    envKeysToCleanup.clear();
    vi.restoreAllMocks();
  });

  it('initializes and reads secrets from environment', async () => {
    setEnv('TEST_SECRET', 'test-value-123');

    const { manager } = await createEnvSecretsManager();
    const value = await manager.getSecret('test-secret');

    expect(value).toBe('test-value-123');
  });

  it('throws when secret is not found', async () => {
    const { manager } = await createEnvSecretsManager();
    await expect(manager.getSecret('missing-secret')).rejects.toThrow(/Secret not found/);
  });

  it('caches values until TTL expires', async () => {
    setEnv('CACHE_SECRET', 'initial-value');

    const { manager } = await createEnvSecretsManager({
      configOverrides: { cacheTTL: 1 },
    });

    const first = await manager.getSecret('cache-secret');
    setEnv('CACHE_SECRET', 'updated-value');

    const cached = await manager.getSecret('cache-secret');
    expect(first).toBe('initial-value');
    expect(cached).toBe('initial-value');

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const refreshed = await manager.getSecret('cache-secret');
    expect(refreshed).toBe('updated-value');
  });

  it('supports retrieving multiple secrets at once', async () => {
    setEnv('SECRET_ALPHA', 'alpha');
    setEnv('SECRET_BETA', 'beta');

    const { manager } = await createEnvSecretsManager();
    const result = await manager.getSecrets(['secret-alpha', 'secret-beta']);

    expect(result['secret-alpha']).toBe('alpha');
    expect(result['secret-beta']).toBe('beta');
  });

  it('encrypts cache entries when configured', async () => {
    setEnv('ENC_SECRET', 'sensitive');

    const { manager } = await createEnvSecretsManager({
      configOverrides: { encryptCache: true },
    });

    const value = await manager.getSecret('enc-secret');
    expect(value).toBe('sensitive');

    const cache = (manager as SecretsManagerWithInternals).cache;
    const cachedEntry = cache.get('enc-secret') as { value: string; encrypted: boolean };
    expect(cachedEntry).toBeDefined();
    expect(cachedEntry.encrypted).toBe(true);
    expect(cachedEntry.value).not.toBe('sensitive');
    expect(cachedEntry.value).toContain(':');
  });

  it('clears cache entries on demand', async () => {
    setEnv('CLEAR_SECRET', 'value-1');

    const { manager } = await createEnvSecretsManager();
    await manager.getSecret('clear-secret');

    manager.clearSecretCache('clear-secret');
    setEnv('CLEAR_SECRET', 'value-2');

    const refreshed = await manager.getSecret('clear-secret');
    expect(refreshed).toBe('value-2');
  });

  it('lists environment variables via provider', async () => {
    setEnv('LIST_SECRET', 'value');
    const { manager } = await createEnvSecretsManager();
    const keys = await manager.listSecrets();
    expect(keys).toContain('LIST_SECRET');
  });

  it('fails to set secrets when provider is read-only', async () => {
    const { manager } = await createEnvSecretsManager();
    await expect(manager.setSecret('test-key', 'value')).rejects.toThrow('read-only');
  });

  it('fails to delete secrets when provider is read-only', async () => {
    const { manager } = await createEnvSecretsManager();
    await expect(manager.deleteSecret('test-key')).rejects.toThrow('read-only');
  });

  it('refreshes secrets bypassing cache', async () => {
    setEnv('REFRESH_SECRET', 'first');

    const { manager } = await createEnvSecretsManager({
      configOverrides: { cacheTTL: 60 },
    });

    const initial = await manager.getSecret('refresh-secret');
    expect(initial).toBe('first');

    setEnv('REFRESH_SECRET', 'second');
    const refreshed = await manager.refreshSecret('refresh-secret');
    expect(refreshed).toBe('second');
  });
});

describe('SecretsManager singleton lifecycle', () => {
  const envKeysToCleanup = new Set<string>();

  function setEnv(key: string, value: string): void {
    process.env[key] = value;
    envKeysToCleanup.add(key);
  }

  function buildConfig(): SecretsConfig {
    return {
      cacheTTL: 2,
      autoRefresh: false,
      encryptCache: false,
      serviceAccount: 'svc-test',
      providers: [
        {
          id: 'env-shared',
          type: 'env',
          priority: 1,
          failOpen: true,
          options: {},
        },
      ],
      audit: { enabled: false, persist: false },
      rotation: { managedKeys: [] },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await shutdownSecretsManager();
    for (const key of envKeysToCleanup) {
      delete process.env[key];
    }
    envKeysToCleanup.clear();
    vi.restoreAllMocks();
  });

  it('initializes a singleton instance and reuses it', async () => {
    setEnv('GLOBAL_SECRET', 'singleton-value');
    const config = buildConfig();

    const manager1 = await initializeSecretsManager(config);
    const manager2 = await initializeSecretsManager(config);

    expect(manager1).toBe(manager2);
    const value = await manager1.getSecret('global-secret');
    expect(value).toBe('singleton-value');
  });

  it('throws when accessing singleton before initialization', async () => {
    await shutdownSecretsManager();
    expect(() => getSecretsManager()).toThrow('Secrets Manager not initialized');
  });

  it('shuts down and clears instance', async () => {
    const config = buildConfig();
    await initializeSecretsManager(config);
    await shutdownSecretsManager();
    expect(() => getSecretsManager()).toThrow('Secrets Manager not initialized');
  });
});

