// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { EnvSecretsProviderConfig } from '@/types';
import type { SecretsProvider } from './secrets-provider.js';
import { logger } from '@/utils/logger';

export class EnvSecretsProvider implements SecretsProvider {
  readonly id: string;
  readonly type = 'env';
  readonly priority: number;
  readonly failOpen: boolean;
  private readonly prefix?: string;
  private initialized = false;

  constructor(config: EnvSecretsProviderConfig) {
    this.id = config.id;
    this.priority = config.priority;
    this.failOpen = config.failOpen ?? true;
    this.prefix = config.options.prefix;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
    logger.info({ provider: this.id }, 'Environment secrets provider initialized');
  }

  async getSecret(key: string): Promise<string> {
    const envKey = this.toEnvKey(key);
    const value = process.env[envKey];
    if (value === undefined) {
      throw new Error(`Secret not found in environment variables: ${envKey}`);
    }
    return value;
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const key of keys) {
      const envKey = this.toEnvKey(key);
      const value = process.env[envKey];
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  async setSecret(): Promise<void> {
    throw new Error('Environment provider is read-only');
  }

  async deleteSecret(): Promise<void> {
    throw new Error('Environment provider is read-only');
  }

  async listSecrets(): Promise<string[]> {
    return Object.keys(process.env);
  }

  async healthCheck(): Promise<boolean> {
    return this.initialized;
  }

  async disconnect(): Promise<void> {
    this.initialized = false;
  }

  private toEnvKey(key: string): string {
    const normalized = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (this.prefix) {
      return `${this.prefix.toUpperCase()}_${normalized}`;
    }
    return normalized;
  }
}
