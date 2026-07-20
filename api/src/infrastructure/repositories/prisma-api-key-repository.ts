// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prisma ApiKey Repository
 * Infrastructure Layer: Implements IApiKeyRepository
 *
 * Clean Architecture Pattern:
 * - Domain ↔ Prisma mapping
 * - bcrypt hashing for security
 * - Prefix indexing for performance
 */

import { injectable } from 'tsyringe';
import { IApiKeyRepository } from '@/domain/repositories/iapi-key-repository';
import { ApiKeyEntity } from '@/domain/entities/api-key.entity';
import { ApiKeyValue } from '@/domain/value-objects/api-key-value';
import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';
import bcrypt from 'bcrypt';

@injectable()
export class PrismaApiKeyRepository implements IApiKeyRepository {
  private log = logger.child({ component: 'prisma-api-key-repository' });

  /**
   * Find API key by ID
   */
  async findById(keyId: string): Promise<ApiKeyEntity | null> {
    try {
      const key = await prisma.apiKey.findUnique({
        where: { id: keyId },
      });

      if (!key) {
        return null;
      }

      return this.toDomain(key);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, keyId }, 'Failed to find API key');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find API key by value (for authentication)
   */
  async findByKeyValue(keyValue: ApiKeyValue): Promise<ApiKeyEntity | null> {
    try {
      const prefix = keyValue.getPrefix();

      // Find keys with matching prefix
      const keys = await prisma.apiKey.findMany({
        where: {
          keyPrefix: prefix,
          status: 'active',
        },
      });

      // Check each key with bcrypt
      for (const key of keys) {
        const isValid = await bcrypt.compare(keyValue.getValue(), key.keyHash);
        if (isValid) {
          return this.toDomain(key);
        }
      }

      return null;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to find API key by value');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find API keys by user
   */
  async findByUser(userId: string): Promise<ApiKeyEntity[]> {
    try {
      const keys = await prisma.apiKey.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });

      return keys.map((k) => this.toDomain(k));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, userId }, 'Failed to find API keys by user');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find API keys by organization
   */
  async findByOrganization(organizationId: string): Promise<ApiKeyEntity[]> {
    try {
      const keys = await prisma.apiKey.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
      });

      return keys.map((k) => this.toDomain(k));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, organizationId }, 'Failed to find API keys by organization');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find active API keys
   */
  async findActive(options?: {
    userId?: string;
    organizationId?: string;
  }): Promise<ApiKeyEntity[]> {
    try {
      const keys = await prisma.apiKey.findMany({
        where: {
          status: 'active',
          ...(options?.userId && { userId: options.userId }),
          ...(options?.organizationId && { organizationId: options.organizationId }),
        },
        orderBy: { lastUsedAt: 'desc' },
      });

      return keys.map((k) => this.toDomain(k));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to find active API keys');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find keys due for auto-rotation
   */
  async findDueForRotation(): Promise<ApiKeyEntity[]> {
    try {
      const keys = await prisma.apiKey.findMany({
        where: {
          autoRotate: true,
          status: 'active',
        },
      });

      // Filter in-memory for rotation due (domain logic)
      const entities = keys.map((k) => this.toDomain(k));
      return entities.filter((e) => e.isRotationDue());
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to find keys due for rotation');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find expired keys
   */
  async findExpired(): Promise<ApiKeyEntity[]> {
    try {
      const now = new Date();

      const keys = await prisma.apiKey.findMany({
        where: {
          expiresAt: {
            lt: now,
          },
          status: {
            in: ['active', 'rotating'],
          },
        },
      });

      return keys.map((k) => this.toDomain(k));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to find expired keys');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Save API key
   */
  async save(apiKey: ApiKeyEntity): Promise<void> {
    try {
      const data = apiKey.toPersistence();

      // Hash the key value before storage
      const keyHash = await bcrypt.hash(data.keyValue, 10);
      const quickHash = await this.createQuickHash(data.keyValue);

      await prisma.apiKey.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          name: data.name,
          keyHash,
          keyPrefix: data.keyPrefix,
          quickHash,
          userId: data.userId,
          organizationId: data.organizationId,
          status: data.status,
          lastUsedAt: data.lastUsedAt,
          requestCount: data.requestCount,
          lastRequestIp: data.lastRequestIp,
          expiresAt: data.expiresAt,
          createdAt: data.createdAt,
          rotatedAt: data.rotatedAt,
          revokedAt: data.revokedAt,
          rotationCount: data.rotationCount,
          previousKeyId: data.previousKeyId,
          nextKeyId: data.nextKeyId,
          autoRotate: data.autoRotate,
          rotationIntervalDays: data.rotationIntervalDays,
          gracePeriodDays: data.gracePeriodDays,
          ipWhitelist: data.ipWhitelist,
          permissions: data.permissions 
            ? (data.permissions as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        },
        update: {
          name: data.name,
          status: data.status,
          lastUsedAt: data.lastUsedAt,
          requestCount: data.requestCount,
          lastRequestIp: data.lastRequestIp,
          rotatedAt: data.rotatedAt,
          revokedAt: data.revokedAt,
          rotationCount: data.rotationCount,
          nextKeyId: data.nextKeyId,
        },
      });

      this.log.info({ keyId: data.id }, 'API key saved');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to save API key');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Delete API key
   */
  async delete(keyId: string): Promise<void> {
    try {
      await prisma.apiKey.delete({
        where: { id: keyId },
      });

      this.log.info({ keyId }, 'API key deleted');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to delete API key');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Save many (batch for rotation)
   */
  async saveMany(apiKeys: ApiKeyEntity[]): Promise<void> {
    try {
      await prisma.$transaction(async (tx) => {
        for (const apiKey of apiKeys) {
          const data = apiKey.toPersistence();
          const keyHash = await bcrypt.hash(data.keyValue, 10);
          const quickHash = await this.createQuickHash(data.keyValue);

          await tx.apiKey.upsert({
            where: { id: data.id },
            create: {
              id: data.id,
              name: data.name,
              keyHash,
              keyPrefix: data.keyPrefix,
              quickHash,
              user: { connect: { id: data.userId } },
              organization: { connect: { id: data.organizationId } },
              status: data.status,
              lastUsedAt: data.lastUsedAt,
              requestCount: data.requestCount,
              createdAt: data.createdAt,
              rotatedAt: data.rotatedAt,
              rotationCount: data.rotationCount,
              autoRotate: data.autoRotate,
              rotationIntervalDays: data.rotationIntervalDays,
              gracePeriodDays: data.gracePeriodDays,
              ipWhitelist: data.ipWhitelist,
              permissions: data.permissions 
                ? (data.permissions as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            } satisfies Prisma.ApiKeyCreateInput,
            update: {
              status: data.status,
              rotatedAt: data.rotatedAt,
              rotationCount: data.rotationCount,
            },
          });
        }
      });

      this.log.info({ count: apiKeys.length }, 'API keys batch saved');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to save API keys batch');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Count by user
   */
  async countByUser(userId: string): Promise<number> {
    return await prisma.apiKey.count({
      where: { userId },
    });
  }

  /**
   * Count by organization
   */
  async countByOrganization(organizationId: string): Promise<number> {
    return await prisma.apiKey.count({
      where: { organizationId },
    });
  }

  /**
   * Convert Prisma model to Domain entity
   */
  private toDomain(prismaKey: {
    id: string;
    name: string;
    keyPrefix: string;
    userId: string;
    organizationId: string;
    status: string;
    lastUsedAt: Date;
    requestCount: number;
    lastRequestIp: string | null;
    expiresAt: Date | null;
    createdAt: Date;
    rotatedAt: Date | null;
    revokedAt: Date | null;
    rotationCount: number;
    previousKeyId: string | null;
    nextKeyId: string | null;
    autoRotate: boolean;
    rotationIntervalDays: number | null;
    gracePeriodDays: number;
    ipWhitelist: string[];
    permissions: unknown;
  }): ApiKeyEntity {
    const placeholderValue = this.buildSafePlaceholderValue(prismaKey.keyPrefix);

    return ApiKeyEntity.reconstitute({
      id: prismaKey.id,
      name: prismaKey.name,
      keyValue: placeholderValue,
      userId: prismaKey.userId,
      organizationId: prismaKey.organizationId,
      status: prismaKey.status,
      lastUsedAt: prismaKey.lastUsedAt,
      requestCount: prismaKey.requestCount,
      lastRequestIp: prismaKey.lastRequestIp,
      expiresAt: prismaKey.expiresAt,
      createdAt: prismaKey.createdAt,
      rotatedAt: prismaKey.rotatedAt,
      revokedAt: prismaKey.revokedAt,
      rotationCount: prismaKey.rotationCount,
      previousKeyId: prismaKey.previousKeyId,
      nextKeyId: prismaKey.nextKeyId,
      autoRotate: prismaKey.autoRotate,
      rotationIntervalDays: prismaKey.rotationIntervalDays,
      gracePeriodDays: prismaKey.gracePeriodDays,
      ipWhitelist: prismaKey.ipWhitelist,
      permissions: (prismaKey.permissions as Record<string, boolean> | null) ?? null,
    });
  }

  /**
   * Build a domain-safe placeholder API key from persisted prefix.
   * Some legacy rows may contain prefixes outside ak_live_/ak_test_.
   * Listing endpoints should not fail for those historical records.
   */
  private buildSafePlaceholderValue(keyPrefix: string): string {
    const environmentPrefix = keyPrefix.startsWith('ak_test_') ? 'ak_test_' : 'ak_live_';
    const sanitizedSeed = keyPrefix.replace(/^ak_(live|test)_/, '').replace(/[^A-Za-z0-9_-]/g, '');
    const filler = 'placeholderplaceholderplaceholderplaceholderplaceholderplaceholder';
    let randomPart = `${sanitizedSeed}${filler}`;

    // Keep key size inside validator bounds (40..100 total chars).
    if (randomPart.length < 40) {
      randomPart = `${randomPart}${filler}`;
    }
    randomPart = randomPart.slice(0, 92);

    let candidate = `${environmentPrefix}${randomPart}`;
    if (candidate.length < 40) {
      candidate = `${environmentPrefix}${filler}`.slice(0, 40);
    }

    try {
      ApiKeyValue.create(candidate);
      return candidate;
    } catch {
      // Last-resort fallback keeps repository reads resilient to malformed legacy data.
      return 'ak_live_placeholderplaceholderplaceholderplaceholder';
    }
  }

  /**
   * Create SHA-256 hash for quick lookup
   */
  private async createQuickHash(keyValue: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(keyValue).digest('hex');
  }
}
