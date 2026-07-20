// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { SecretClient } from '@azure/keyvault-secrets';
import { ClientSecretCredential, DefaultAzureCredential } from '@azure/identity';
import { logger } from '@/utils/logger';
import type { AzureSecretsProviderConfig } from '@/types';
import type { SecretsProvider } from './secrets-provider.js';

export class AzureSecretsProvider implements SecretsProvider {
  readonly id: string;
  readonly type = 'azure';
  readonly priority: number;
  readonly failOpen: boolean;

  private readonly options: AzureSecretsProviderConfig['options'];
  private client!: SecretClient;

  constructor(config: AzureSecretsProviderConfig) {
    this.id = config.id;
    this.priority = config.priority;
    this.failOpen = config.failOpen ?? false;
    this.options = config.options;
  }

  async initialize(): Promise<void> {
    const credential = this.buildCredential();
    this.client = new SecretClient(this.options.keyVaultUrl, credential);
    logger.info(
      { provider: this.id, vault: this.options.keyVaultUrl },
      'Azure Key Vault provider initialized'
    );
  }

  async getSecret(key: string): Promise<string> {
    const result = await this.client.getSecret(key);
    if (!result.value) {
      throw new Error(`Azure Key Vault secret "${key}" has no value`);
    }
    return result.value;
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    await Promise.all(
      keys.map(async (key) => {
        try {
          result[key] = await this.getSecret(key);
        } catch (error) {
          logger.warn({ key, error }, 'Failed to fetch Azure secret');
        }
      })
    );
    return result;
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.client.setSecret(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    const poller = await this.client.beginDeleteSecret(key);
    await poller.pollUntilDone();
    await this.client.purgeDeletedSecret(key);
  }

  async listSecrets(): Promise<string[]> {
    const result: string[] = [];
    for await (const props of this.client.listPropertiesOfSecrets()) {
      if (props.name) {
        result.push(props.name);
      }
    }
    return result;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.listSecrets();
      return true;
    } catch (error) {
      logger.error({ error }, 'Azure Key Vault health check failed');
      return false;
    }
  }

  async rotateSecret(key: string, value: string): Promise<void> {
    await this.setSecret(key, value);
  }

  async disconnect(): Promise<void> {
    // No explicit disconnect required for SecretClient
  }

  private buildCredential() {
    const { tenantId, clientId, clientSecret } = this.options;
    if (tenantId && clientId && clientSecret) {
      return new ClientSecretCredential(tenantId, clientId, clientSecret);
    }

    logger.warn({ provider: this.id }, 'Using DefaultAzureCredential for Key Vault access');
    return new DefaultAzureCredential();
  }
}
