// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';
import { logger } from '@/utils/logger';
import type { AwsSecretsProviderConfig } from '@/types';
import type { SecretsProvider } from './secrets-provider.js';

export class AwsSecretsProvider implements SecretsProvider {
  readonly id: string;
  readonly type = 'aws';
  readonly priority: number;
  readonly failOpen: boolean;

  private readonly region: string;
  private readonly prefix: string;
  private readonly credentials?: {
    accessKeyId?: string;
    secretAccessKey?: string;
  };

  private readonly roleArn?: string;
  private client!: SecretsManagerClient;

  constructor(config: AwsSecretsProviderConfig) {
    this.id = config.id;
    this.priority = config.priority;
    this.failOpen = config.failOpen ?? false;

    this.region = config.options.region;
    this.prefix = config.options.secretPrefix.replace(/\/?$/, '/');
    this.credentials = {
      accessKeyId: config.options.accessKeyId,
      secretAccessKey: config.options.secretAccessKey,
    };
    this.roleArn = config.options.roleArn;
  }

  async initialize(): Promise<void> {
    const credentials =
      this.credentials?.accessKeyId && this.credentials?.secretAccessKey
        ? {
            accessKeyId: this.credentials.accessKeyId,
            secretAccessKey: this.credentials.secretAccessKey,
          }
        : undefined;

    this.client = new SecretsManagerClient({
      region: this.region,
      credentials,
    });
    logger.info({ provider: this.id, region: this.region }, 'AWS Secrets Manager initialized');
  }

  async getSecret(key: string): Promise<string> {
    const secretId = this.toSecretId(key);
    const command = new GetSecretValueCommand({ SecretId: secretId });
    const response = await this.client.send(command);
    if (!response.SecretString) {
      throw new Error(`AWS Secret ${secretId} has no string value`);
    }
    return response.SecretString;
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    await Promise.all(
      keys.map(async (key) => {
        try {
          result[key] = await this.getSecret(key);
        } catch (error) {
          logger.warn({ key, error }, 'Failed to fetch AWS secret');
        }
      })
    );
    return result;
  }

  async setSecret(key: string, value: string): Promise<void> {
    const secretId = this.toSecretId(key);
    try {
      await this.client.send(
        new PutSecretValueCommand({
          SecretId: secretId,
          SecretString: value,
        })
      );
    } catch (error: unknown) {
      // Safely extract error name without type assertion
      let errorName: string | undefined;
      if (typeof error === 'object' && error !== null && 'name' in error) {
        const nameDescriptor = Object.getOwnPropertyDescriptor(error, 'name');
        if (nameDescriptor && typeof nameDescriptor.value === 'string') {
          errorName = nameDescriptor.value;
        }
      }
      
      if (errorName !== 'ResourceNotFoundException') {
        throw error;
      }
      await this.client.send(
        new CreateSecretCommand({
          Name: secretId,
          SecretString: value,
        })
      );
    }
  }

  async deleteSecret(key: string): Promise<void> {
    const secretId = this.toSecretId(key);
    await this.client.send(
      new DeleteSecretCommand({
        SecretId: secretId,
        ForceDeleteWithoutRecovery: true,
      })
    );
  }

  async listSecrets(): Promise<string[]> {
    const command = new ListSecretsCommand({});
    const response = await this.client.send(command);
    const results =
      response.SecretList?.map((entry) => entry.Name || '')
        .filter((name) => name.startsWith(this.prefix))
        .map((name) => name.substring(this.prefix.length)) ?? [];
    return results;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.listSecrets();
      return true;
    } catch (error) {
      logger.error({ error }, 'AWS Secrets Manager health check failed');
      return false;
    }
  }

  async rotateSecret(key: string, value: string): Promise<void> {
    await this.setSecret(key, value);
  }

  async disconnect(): Promise<void> {
    await this.client.destroy();
  }

  private toSecretId(key: string): string {
    return `${this.prefix}${key}`;
  }
}
