// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SecretsManager } from '@/config/secrets-manager';
import { EnvSecretsProvider } from '@/config/providers/env-provider';
import type { SecretsConfig, SecretsProviderConfig } from '@/types';
import type { SecretsProvider } from '@/config/providers/secrets-provider';

vi.mock('@/services/secret-audit-service', () => ({
  recordSecretAudit: vi.fn(),
}));

class FailingProvider implements SecretsProvider {
  readonly id = 'failure-provider';
  readonly type = 'vault';
  readonly priority = 1;
  readonly failOpen = true;

  async initialize(): Promise<void> {
    // no-op
  }

  async getSecret(): Promise<string> {
    throw new Error('Vault unavailable');
  }

  async getSecrets(): Promise<Record<string, string>> {
    throw new Error('Vault unavailable');
  }

  async setSecret(): Promise<void> {
    throw new Error('Vault unavailable');
  }

  async deleteSecret(): Promise<void> {
    throw new Error('Vault unavailable');
  }

  async listSecrets(): Promise<string[]> {
    throw new Error('Vault unavailable');
  }

  async healthCheck(): Promise<boolean> {
    return false;
  }

  async disconnect(): Promise<void> {
    // no-op
  }
}

describe('SecretsManager', () => {
  const config: SecretsConfig = {
    cacheTTL: 60,
    autoRefresh: false,
    encryptCache: false,
    serviceAccount: 'test-suite',
    providers: [],
    audit: { enabled: false, persist: false },
    rotation: { cron: '0 3 * * *', managedKeys: [] },
  };

  beforeAll(() => {
    process.env.TEST_SECRET_VALUE = 's3cr3t';
  });

  afterAll(() => {
    delete process.env.TEST_SECRET_VALUE;
  });

  it('retrieves secrets from environment provider', async () => {
    const envProvider = new EnvSecretsProvider({
      id: 'env-primary',
      type: 'env',
      priority: 1,
      failOpen: true,
      options: { prefix: 'TEST' },
    });

    const manager = new SecretsManager(
      {
        ...config,
        providers: [
          {
            id: 'env-primary',
            type: 'env',
            priority: 1,
            failOpen: true,
            options: { prefix: 'TEST' },
          },
        ],
      },
      [envProvider]
    );

    await manager.initialize();

    const value = await manager.getSecret('SECRET_VALUE');
    expect(value).toBe('s3cr3t');

    await manager.shutdown();
  });

  it('fails over when primary provider throws', async () => {
    const failingProvider = new FailingProvider();
    const envProvider = new EnvSecretsProvider({
      id: 'env-fallback',
      type: 'env',
      priority: 2,
      failOpen: true,
      options: { prefix: 'TEST' },
    });

    const manager = new SecretsManager(
      {
        ...config,
        providers: [
          {
            id: failingProvider.id,
            type: failingProvider.type,
            priority: 1,
            failOpen: true,
            options: {},
          } as SecretsProviderConfig,
          {
            id: 'env-fallback',
            type: 'env',
            priority: 2,
            failOpen: true,
            options: { prefix: 'TEST' },
          },
        ],
      },
      [failingProvider, envProvider]
    );

    await manager.initialize();

    const value = await manager.getSecret('SECRET_VALUE');
    expect(value).toBe('s3cr3t');

    await manager.shutdown();
  });
});

