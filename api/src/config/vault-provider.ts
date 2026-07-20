// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { logger } from '@/utils/logger';
import type { VaultSecretsProviderConfig } from '@/types';
import type { SecretsProvider } from './providers/secrets-provider.js';

interface VaultResponse<T> {
  data?: {
    data?: T & { value?: string };
    keys?: string[];
  };
}

export class VaultSecretsProvider implements SecretsProvider {
  readonly id: string;
  readonly type = 'vault';
  readonly priority: number;
  readonly failOpen: boolean;

  private readonly address: string;
  private readonly token: string;
  private readonly namespace?: string;
  private readonly secretPath: string;
  private readonly baseUrl: string;
  private initialized = false;

  constructor(config: VaultSecretsProviderConfig) {
    this.id = config.id;
    this.priority = config.priority;
    this.failOpen = config.failOpen ?? false;

    this.address = config.options.address;
    this.token = config.options.token;
    this.namespace = config.options.namespace;
    this.secretPath = config.options.secretPath || 'secret/data/ailin-dev';
    this.baseUrl = this.address.replace(/\/$/, '');
  }

  async initialize(): Promise<void> {
    const response = await this.request('GET', '/v1/sys/health');
    const data = (await response.json()) as { sealed?: boolean };
    if (data.sealed) {
      throw new Error('Vault is sealed - secrets unavailable');
    }
    this.initialized = true;
    logger.info({ provider: this.id, address: this.baseUrl }, 'Vault provider initialized');
  }

  async getSecret(key: string): Promise<string> {
    const path = `${this.secretPath}/${key}`;
    const response = await this.request('GET', `/v1/${path}`);
    if (response.status === 404) {
      throw new Error(`Vault secret not found: ${key}`);
    }
    if (!response.ok) {
      throw new Error(`Vault error: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as VaultResponse<Record<string, string>>;
    const value = payload?.data?.data?.[key] ?? payload?.data?.data?.value;
    if (!value) {
      throw new Error(`Vault response did not contain value for key "${key}"`);
    }
    return value;
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    await Promise.all(
      keys.map(async (key) => {
        try {
          result[key] = await this.getSecret(key);
        } catch (error) {
          logger.warn({ key, error }, 'Failed to fetch secret from Vault');
        }
      })
    );
    return result;
  }

  async setSecret(key: string, value: string): Promise<void> {
    const path = `${this.secretPath}/${key}`;
    const response = await this.request('POST', `/v1/${path}`, {
      data: {
        [key]: value,
        value,
      },
    });
    if (!response.ok) {
      throw new Error(`Vault error: ${response.status} ${response.statusText}`);
    }
  }

  async deleteSecret(key: string): Promise<void> {
    const path = `${this.secretPath}/${key}`;
    const response = await this.request('DELETE', `/v1/${path}`);
    if (!response.ok && response.status !== 404) {
      throw new Error(`Vault error: ${response.status} ${response.statusText}`);
    }
  }

  async listSecrets(): Promise<string[]> {
    const response = await this.request('GET', `/v1/${this.secretPath}?list=true`);
    if (!response.ok) {
      throw new Error(`Vault error: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as VaultResponse<never>;
    return payload?.data?.keys ?? [];
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.request('GET', '/v1/sys/health');
      return response.ok;
    } catch (error) {
      logger.error({ error }, 'Vault health check failed');
      return false;
    }
  }

  async rotateSecret(key: string, value: string): Promise<void> {
    await this.setSecret(key, value);
  }

  async disconnect(): Promise<void> {
    this.initialized = false;
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<Response> {
    if (!this.initialized && method !== 'GET') {
      logger.warn({ method, path }, 'Vault provider not fully initialized yet');
    }

    const headers: Record<string, string> = {
      'X-Vault-Token': this.token,
    };
    if (this.namespace) {
      headers['X-Vault-Namespace'] = this.namespace;
    }
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}
