// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prisma User Repository
 * Infrastructure Layer: Concrete implementation of IUserRepository
 *
 * Clean Architecture Pattern:
 * - Implements domain interface
 * - Uses Prisma ORM
 * - Converts between domain entities and DB models
 * - No domain logic here (only persistence)
 */

import { IUserRepository } from '@/domain/repositories/iuser-repository';
import { UserEntity, UserRole, UserStatus } from '@/domain/entities/user.entity';
import { UserAggregate } from '@/domain/aggregates/user.aggregate';
import { ApiKeyEntity, ApiKeyStatus } from '@/domain/entities/api-key.entity';
import { ApiKeyValue } from '@/domain/value-objects/api-key-value';
import { UserId } from '@/domain/value-objects/user-id';
import { Email } from '@/domain/value-objects/email';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { injectable } from 'tsyringe';
import {
  mapUserToPrismaCreate,
  mapUserToPrismaUpdate,
  mapApiKeyToPrismaCreate,
  mapApiKeyToPrismaUpdate,
} from '@/infrastructure/mappers/user-persistence-mapper';

const VALID_USER_ROLES = new Set(Object.values(UserRole));
const VALID_USER_STATUSES = new Set(Object.values(UserStatus));
const VALID_API_KEY_STATUSES = new Set(Object.values(ApiKeyStatus));

function normalizeUserRole(role: string): UserRole {
  return VALID_USER_ROLES.has(role as UserRole) ? (role as UserRole) : UserRole.USER;
}

function normalizeUserStatus(status: string): UserStatus {
  return VALID_USER_STATUSES.has(status as UserStatus) ? (status as UserStatus) : UserStatus.ACTIVE;
}

function normalizeApiKeyStatus(status: string): ApiKeyStatus {
  return VALID_API_KEY_STATUSES.has(status as ApiKeyStatus)
    ? (status as ApiKeyStatus)
    : ApiKeyStatus.ACTIVE;
}

/**
 * Type guard to validate permissions is Record<string, boolean> | null
 */
function isValidPermissions(value: unknown): value is Record<string, boolean> | null {
  if (value === null) {
    return true;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return Object.values(obj).every((v) => typeof v === 'boolean');
}

@injectable()
export class PrismaUserRepository implements IUserRepository {
  private log = logger.child({ component: 'prisma-user-repository' });

  /**
   * Find user by ID
   */
  async findById(userId: UserId): Promise<UserEntity | null> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId.getValue() },
      });

      if (!user) {
        return null;
      }

      // Convert DB model to domain entity
      return UserEntity.reconstitute({
        id: user.id,
        email: user.email,
        name: user.name || user.email.split('@')[0],
        role: normalizeUserRole(user.role),
        status: normalizeUserStatus(user.status),
        organizationId: user.organizationId,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        passwordHash: user.passwordHash,
        statusReason: user.statusReason ?? undefined,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, userId: userId.getValue() }, 'Failed to find user by ID');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find user by email
   */
  async findByEmail(email: Email): Promise<UserEntity | null> {
    try {
      const user = await prisma.user.findUnique({
        where: { email: email.getValue() },
      });

      if (!user) {
        return null;
      }

      return UserEntity.reconstitute({
        id: user.id,
        email: user.email,
        name: user.name || user.email.split('@')[0],
        role: normalizeUserRole(user.role),
        status: normalizeUserStatus(user.status),
        organizationId: user.organizationId,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        passwordHash: user.passwordHash,
        statusReason: user.statusReason ?? undefined,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, email: email.getValue() }, 'Failed to find user by email');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find users by organization
   */
  async findByOrganization(organizationId: string): Promise<UserEntity[]> {
    try {
      // Defensive cap — the /v1/organizations/:id/members route has no
      // pagination in its query contract yet (that's a bigger change spanning
      // the query/handler/response schema), but an unbounded findMany here
      // means an enterprise org with thousands of members returns the whole
      // table in one response. This bounds the worst case without changing
      // the API's shape; real pagination is a separate, larger change.
      const users = await prisma.user.findMany({
        where: { organizationId },
        take: 1000,
      });

      return users.map((user) =>
        UserEntity.reconstitute({
          id: user.id,
          email: user.email,
          name: user.name || user.email.split('@')[0],
          role: normalizeUserRole(user.role),
          status: normalizeUserStatus(user.status),
          organizationId: user.organizationId,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          passwordHash: user.passwordHash,
          statusReason: user.statusReason ?? undefined,
        })
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, organizationId }, 'Failed to find users by organization');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Save user (create or update)
   * Type-safe with explicit mappers - NO as any casts
   */
  async save(user: UserEntity): Promise<void> {
    try {
      const data = user.toPersistence();

      await prisma.user.upsert({
        where: { id: data.id },
        create: mapUserToPrismaCreate(data),
        update: mapUserToPrismaUpdate(data),
      });

      this.log.info({ userId: data.id }, 'User saved successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to save user');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Save user aggregate (user + API keys)
   * Type-safe with explicit mappers - NO as any casts
   * Enterprise-grade: Atomic transaction, proper error handling
   *
   * C1 fix: accepts optional external transactionClient so that the caller can
   * include outbox writes in the same atomic commit.
   */
  async saveAggregate(aggregate: UserAggregate, transactionClient?: unknown): Promise<void> {
    try {
      const { user, apiKeys } = aggregate.toPersistence();

      // Type-narrow `tx` to the subset we actually use (user + apiKey upserts).
      // This works for both full PrismaClient and the interactive transaction
      // client (which omits $transaction etc.) without the `any` escape hatch.
      type UpsertTx = {
        user: { upsert: (args: Parameters<typeof prisma.user.upsert>[0]) => Promise<unknown> };
        apiKey: { upsert: (args: Parameters<typeof prisma.apiKey.upsert>[0]) => Promise<unknown> };
      };
      const doSave = async (tx: UpsertTx) => {
        // Save user with type-safe mappers
        await tx.user.upsert({
          where: { id: user.id },
          create: mapUserToPrismaCreate(user),
          update: mapUserToPrismaUpdate(user),
        });

        // Save API keys with type-safe mappers
        for (const apiKey of apiKeys) {
          // Compute hashes (security: bcrypt for storage, SHA-256 for quick lookup)
          const keyHash = await bcrypt.hash(apiKey.keyValue, 10);
          const quickHash = await this.createQuickHash(apiKey.keyValue);

          await tx.apiKey.upsert({
            where: { id: apiKey.id },
            create: mapApiKeyToPrismaCreate(apiKey, keyHash, quickHash),
            update: mapApiKeyToPrismaUpdate(apiKey),
          });
        }
      };

      // C1: If an external transaction was provided, use it (no nested $transaction).
      // This allows the caller to atomically persist business data AND outbox events.
      if (transactionClient) {
        await doSave(transactionClient as typeof prisma);
      } else {
        await prisma.$transaction(doSave);
      }

      this.log.info(
        { userId: user.id, apiKeyCount: apiKeys.length },
        'User aggregate saved successfully (type-safe, atomic transaction)'
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to save user aggregate');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Delete user
   */
  async delete(userId: UserId): Promise<void> {
    try {
      await prisma.user.delete({
        where: { id: userId.getValue() },
      });

      this.log.info({ userId: userId.getValue() }, 'User deleted successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to delete user');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Check if email exists
   */
  async emailExists(email: Email): Promise<boolean> {
    try {
      const count = await prisma.user.count({
        where: { email: email.getValue() },
      });

      return count > 0;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to check email existence');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find user aggregate (user + API keys)
   */
  async findAggregateById(userId: UserId): Promise<UserAggregate | null> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId.getValue() },
        include: {
          apiKeys: true,
        },
      });

      if (!user) {
        return null;
      }

      // Reconstitute user entity
      const userEntity = UserEntity.reconstitute({
        id: user.id,
        email: user.email,
        name: user.name || user.email.split('@')[0],
        role: normalizeUserRole(user.role),
        status: normalizeUserStatus(user.status),
        organizationId: user.organizationId,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        passwordHash: user.passwordHash,
        statusReason: user.statusReason ?? undefined,
      });

      // Reconstitute API key entities
      const apiKeyEntities = user.apiKeys.map((key) => {
        let keyValue = key.keyHash;
        try {
          keyValue = ApiKeyValue.create(key.keyHash).getValue();
        } catch {
          // If stored hash is masked, fallback to prefix with placeholder
          keyValue = `ak_live_${key.id}`;
        }

        return ApiKeyEntity.reconstitute({
          id: key.id,
          name: key.name,
          keyValue,
          userId: key.userId,
          organizationId: key.organizationId,
          status: normalizeApiKeyStatus(key.status),
          statusReason: key.statusReason ?? undefined,
          lastUsedAt: key.lastUsedAt,
          requestCount: key.requestCount,
          lastRequestIp: key.lastRequestIp,
          expiresAt: key.expiresAt,
          createdAt: key.createdAt,
          rotatedAt: key.rotatedAt,
          revokedAt: key.revokedAt,
          rotationCount: key.rotationCount,
          previousKeyId: key.previousKeyId,
          nextKeyId: key.nextKeyId,
          autoRotate: key.autoRotate,
          rotationIntervalDays: key.rotationIntervalDays,
          gracePeriodDays: key.gracePeriodDays,
          ipWhitelist: key.ipWhitelist,
          permissions: isValidPermissions(key.permissions) ? key.permissions : null,
        });
      });

      // Reconstitute aggregate
      return UserAggregate.reconstitute(userEntity, apiKeyEntities);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, userId: userId.getValue() }, 'Failed to find user aggregate');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Create SHA-256 hash for quick lookup of API keys
   */
  private async createQuickHash(keyValue: string): Promise<string> {
    return createHash('sha256').update(keyValue).digest('hex');
  }
}
