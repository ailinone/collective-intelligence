// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Secrets Manager (multi-provider with failover, caching, and auditing)
 */

import crypto from 'crypto';
import { logger } from '@/utils/logger';
import type { SecretsConfig, SecretsProviderConfig } from '@/types';
import {
  EnvSecretsProvider,
  VaultSecretsProvider,
  AwsSecretsProvider,
  AzureSecretsProvider,
  GcpSecretsProvider,
} from './providers/index.js';
import type { SecretsProvider } from './providers/secrets-provider.js';
import { recordSecretAudit } from '@/services/secret-audit-service';

interface CacheEntry {
  value: string;
  expiresAt: number;
  encrypted: boolean;
  providerId: string;
}

function generateRandomSecret(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += alphabet[bytes[i] % alphabet.length];
  }
  return result;
}

export class SecretsManager {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly encryptionKey = crypto.randomBytes(32);
  private readonly providers: SecretsProvider[];
  private readonly config: SecretsConfig;
  private initialized = false;

  constructor(config: SecretsConfig, providers: SecretsProvider[]) {
    this.config = config;
    this.providers = providers.sort((a, b) => a.priority - b.priority);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Use allSettled so that a single provider failure (e.g. expired GCP ADC)
    // does not prevent the application from starting with remaining providers.
    const results = await Promise.allSettled(
      this.providers.map((provider) => provider.initialize())
    );

    const failed: { id: string; type: string; error: string }[] = [];
    const succeeded: typeof this.providers = [];

    results.forEach((result, idx) => {
      const provider = this.providers[idx];
      if (result.status === 'fulfilled') {
        succeeded.push(provider);
      } else {
        const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failed.push({ id: provider.id, type: provider.type, error: errorMsg });
        logger.error(
          { provider: provider.id, type: provider.type, error: errorMsg },
          `Failed to initialize secrets provider "${provider.id}" — skipping`
        );
      }
    });

    if (succeeded.length === 0) {
      throw new Error(
        `All secrets providers failed to initialize.\n` +
        failed.map((f) => `  - ${f.id} (${f.type}): ${f.error}`).join('\n')
      );
    }

    // Keep only the providers that initialized successfully
    this.providers.length = 0;
    this.providers.push(...succeeded);
    this.initialized = true;

    if (failed.length > 0) {
      logger.warn(
        { failed, active: succeeded.map((p) => p.id) },
        `⚠️ ${failed.length} secrets provider(s) failed — running with ${succeeded.length} provider(s)`
      );
    }

    logger.info(
      {
        providers: this.providers.map((provider) => ({
          id: provider.id,
          type: provider.type,
          priority: provider.priority,
          failOpen: provider.failOpen,
        })),
      },
      '✅ Secrets providers initialized'
    );
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.providers.map((provider) => provider.disconnect()));
    this.cache.clear();
    this.initialized = false;
    logger.info('✅ Secrets manager shutdown complete');
  }

  async getSecret(key: string): Promise<string> {
    const cacheEntry = this.getCached(key);
    const start = Date.now();
    if (cacheEntry) {
      await recordSecretAudit({
        event: 'accessed',
        secretKey: key,
        providerId: cacheEntry.providerId,
        providerType: this.findProvider(cacheEntry.providerId)?.type || 'env',
        success: true,
        cacheHit: true,
        durationMs: Date.now() - start,
      });
      return cacheEntry.value;
    }

    let lastError: Error | undefined;

    for (const provider of this.providers) {
      try {
        const value = await provider.getSecret(key);
        this.setCache(key, value, provider.id);
        await recordSecretAudit({
          event: 'accessed',
          secretKey: key,
          providerId: provider.id,
          providerType: provider.type,
          success: true,
          cacheHit: false,
          durationMs: Date.now() - start,
        });
        return value;
      } catch (error) {
        lastError = error as Error;
        await recordSecretAudit({
          event: 'accessed',
          secretKey: key,
          providerId: provider.id,
          providerType: provider.type,
          success: false,
          cacheHit: false,
          durationMs: Date.now() - start,
          errorMessage: lastError.message,
        });
        if (!provider.failOpen) {
          throw lastError;
        }
        logger.warn(
          { provider: provider.id, error: lastError.message },
          'Secret retrieval failed, trying next provider'
        );
      }
    }

    throw lastError || new Error(`Secret "${key}" not found in any provider`);
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const key of keys) {
      result[key] = await this.getSecret(key);
    }
    return result;
  }

  async getSecretsMultiple(keys: string[]): Promise<Record<string, string>> {
    return this.getSecrets(keys);
  }

  async setSecret(key: string, value: string): Promise<void> {
    const start = Date.now();
    let lastError: Error | undefined;

    for (const provider of this.providers) {
      try {
        await provider.setSecret(key, value);
        this.setCache(key, value, provider.id);
        await recordSecretAudit({
          event: 'updated',
          secretKey: key,
          providerId: provider.id,
          providerType: provider.type,
          success: true,
          cacheHit: false,
          durationMs: Date.now() - start,
        });
        return;
      } catch (error) {
        lastError = error as Error;
        await recordSecretAudit({
          event: 'updated',
          secretKey: key,
          providerId: provider.id,
          providerType: provider.type,
          success: false,
          cacheHit: false,
          durationMs: Date.now() - start,
          errorMessage: lastError.message,
        });
        if (!provider.failOpen) {
          throw lastError;
        }
      }
    }

    throw lastError || new Error(`Unable to persist secret "${key}" in any provider`);
  }

  async deleteSecret(key: string): Promise<void> {
    const start = Date.now();
    let success = false;
    let lastError: Error | undefined;

    for (const provider of this.providers) {
      try {
        await provider.deleteSecret(key);
        success = true;
        await recordSecretAudit({
          event: 'deleted',
          secretKey: key,
          providerId: provider.id,
          providerType: provider.type,
          success: true,
          cacheHit: false,
          durationMs: Date.now() - start,
        });
      } catch (error) {
        lastError = error as Error;
        await recordSecretAudit({
          event: 'deleted',
          secretKey: key,
          providerId: provider.id,
          providerType: provider.type,
          success: false,
          cacheHit: false,
          durationMs: Date.now() - start,
          errorMessage: lastError.message,
        });
        if (!provider.failOpen) {
          throw lastError;
        }
      }
    }

    if (!success && lastError) {
      throw lastError;
    }

    this.cache.delete(key);
  }

  async refreshSecret(key: string): Promise<string> {
    this.cache.delete(key);
    return this.getSecret(key);
  }

  clearSecretCache(key?: string): void {
    if (key) {
      this.cache.delete(key);
      return;
    }
    this.cache.clear();
  }

  async listSecrets(): Promise<string[]> {
    const primary = this.providers[0];
    return primary.listSecrets();
  }

  async rotateSecret(key: string, length: number, providerId?: string): Promise<string> {
    const provider = providerId ? this.findProvider(providerId) : this.providers[0];

    if (!provider) {
      throw new Error(`Provider "${providerId}" not found for rotation`);
    }

    const newValue = generateRandomSecret(length);
    await provider.setSecret(key, newValue);
    this.setCache(key, newValue, provider.id);
    await recordSecretAudit({
      event: 'rotated',
      secretKey: key,
      providerId: provider.id,
      providerType: provider.type,
      success: true,
      cacheHit: false,
      durationMs: 0,
    });
    return newValue;
  }

  private findProvider(id: string): SecretsProvider | undefined {
    return this.providers.find((provider) => provider.id === id);
  }

  getProviders(): SecretsProvider[] {
    return [...this.providers];
  }

  private getCached(key: string): { value: string; providerId: string } | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    const value = this.config.encryptCache ? this.decrypt(cached.value) : cached.value;
    return { value, providerId: cached.providerId };
  }

  private setCache(key: string, value: string, providerId: string): void {
    const ttl = this.config.cacheTTL * 1000;
    let storedValue = value;
    let encrypted = false;
    if (this.config.encryptCache) {
      storedValue = this.encrypt(value);
      encrypted = true;
    }
    this.cache.set(key, {
      value: storedValue,
      expiresAt: Date.now() + ttl,
      encrypted,
      providerId,
    });
  }

  private encrypt(plain: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    let encrypted = cipher.update(plain, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  private decrypt(payload: string): string {
    const [ivHex, authTagHex, encrypted] = payload.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

async function instantiateProvider(config: SecretsProviderConfig): Promise<SecretsProvider> {
  switch (config.type) {
    case 'vault':
      return new VaultSecretsProvider(config);
    case 'aws':
      return new AwsSecretsProvider(config);
    case 'azure':
      return new AzureSecretsProvider(config);
    case 'gcp':
      return new GcpSecretsProvider(config);
    case 'env':
      return new EnvSecretsProvider(config);
    default:
      throw new Error('Unsupported secrets provider type');
  }
}

let secretsManagerInstance: SecretsManager | null = null;

export async function initializeSecretsManager(config: SecretsConfig): Promise<SecretsManager> {
  if (secretsManagerInstance) {
    return secretsManagerInstance;
  }

  const providers: SecretsProvider[] = [];
  for (const providerConfig of config.providers) {
    providers.push(await instantiateProvider(providerConfig));
  }

  const manager = new SecretsManager(config, providers);
  await manager.initialize();
  secretsManagerInstance = manager;
  return manager;
}

export function getSecretsManager(): SecretsManager {
  if (!secretsManagerInstance) {
    throw new Error('Secrets Manager not initialized');
  }
  return secretsManagerInstance;
}

export async function shutdownSecretsManager(): Promise<void> {
  if (secretsManagerInstance) {
    await secretsManagerInstance.shutdown();
    secretsManagerInstance = null;
  }
}
