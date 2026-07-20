// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * User Persistence Mapper (Enterprise-Grade)
 * 
 * Responsibility:
 * - Convert domain entities to Prisma-compatible types
 * - NO as any casts - full type safety
 * - Handle complex Prisma relations explicitly
 * - Support all edge cases (optional fields, null handling, JSON serialization)
 * 
 * Clean Architecture:
 * - Domain entities remain pure (no persistence logic)
 * - Mappers handle impedance mismatch between domain and database
 * - Type-safe conversions prevent runtime errors
 */

import { Prisma } from '@/generated/prisma/index.js';
import type { UserEntity } from '@/domain/entities/user.entity';
import type { ApiKeyEntity } from '@/domain/entities/api-key.entity';

/**
 * Map UserEntity to Prisma UserCreateInput
 * 
 * Handles:
 * - Organization relation (connect by ID)
 * - Optional fields (nullable columns)
 * - Timestamps
 * - Password hash
 */
export function mapUserToPrismaCreate(
  user: ReturnType<UserEntity['toPersistence']>
): Prisma.UserCreateInput {
  // Password hash is required by schema and must be a valid bcrypt hash
  // The auth service must always provide a valid hash, even for email code auth users
  // For email code auth, the auth service generates a hash from a random password
  // that will never be used, ensuring security while meeting schema requirements
  const passwordHash = user.passwordHash;
  if (!passwordHash || (typeof passwordHash === 'string' && passwordHash.trim().length === 0)) {
    throw new Error(
      'passwordHash is required and must be a valid bcrypt hash. ' +
      'The auth service must generate a hash before calling mapUserToPrismaCreate. ' +
      'For email code auth users, generate a hash from a cryptographically secure random password.'
    );
  }

  // Validate that it looks like a bcrypt hash (basic format check)
  if (!passwordHash.startsWith('$2a$') && !passwordHash.startsWith('$2b$') && !passwordHash.startsWith('$2y$')) {
    throw new Error(
      'passwordHash must be a valid bcrypt hash (starting with $2a$, $2b$, or $2y$). ' +
      'Use a proper bcrypt library to generate the hash.'
    );
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    passwordHash: passwordHash, // Required by schema - must be valid bcrypt hash
    role: user.role,
    status: user.status,
    statusReason: user.statusReason ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: null, // Default for new users
    // Relation: Connect to existing organization
    organization: {
      connect: {
        id: user.organizationId,
      },
    },
  };
}

/**
 * Map UserEntity to Prisma UserUpdateInput
 * 
 * Only updates mutable fields (never ID, createdAt)
 */
export function mapUserToPrismaUpdate(
  user: ReturnType<UserEntity['toPersistence']>
): Prisma.UserUpdateInput {
  const updateData: Prisma.UserUpdateInput = {
    name: user.name,
    role: user.role,
    status: user.status,
    statusReason: user.statusReason ?? null,
    updatedAt: user.updatedAt,
  };

  // Only update password if provided (optional during updates)
  if (user.passwordHash) {
    updateData.passwordHash = user.passwordHash;
  }

  return updateData;
}

/**
 * Map ApiKeyEntity to Prisma ApiKeyCreateInput
 * 
 * Handles:
 * - User and Organization relations (connect by IDs)
 * - Optional fields (expiration, rotation config, IP whitelist)
 * - JSON fields (permissions, metadata)
 * - Default values
 */
export function mapApiKeyToPrismaCreate(
  apiKey: ReturnType<ApiKeyEntity['toPersistence']>,
  keyHash: string,
  quickHash: string
): Prisma.ApiKeyCreateInput {
  return {
    id: apiKey.id,
    name: apiKey.name,
    keyHash,
    keyPrefix: apiKey.keyPrefix,
    quickHash,
    status: apiKey.status,
    statusReason: apiKey.statusReason ?? null,
    lastUsedAt: apiKey.lastUsedAt,
    requestCount: apiKey.requestCount ?? 0,
    lastRequestIp: apiKey.lastRequestIp ?? null,
    expiresAt: apiKey.expiresAt ?? null,
    createdAt: apiKey.createdAt,
    rotatedAt: apiKey.rotatedAt ?? null,
    revokedAt: apiKey.revokedAt ?? null,
    rotationCount: apiKey.rotationCount ?? 0,
    previousKeyId: apiKey.previousKeyId ?? null,
    nextKeyId: apiKey.nextKeyId ?? null,
    autoRotate: apiKey.autoRotate ?? false,
    rotationIntervalDays: apiKey.rotationIntervalDays ?? null,
    gracePeriodDays: apiKey.gracePeriodDays ?? 7,
    ipWhitelist: apiKey.ipWhitelist ?? [],
    // JSON field: permissions
    permissions: apiKey.permissions
      ? (apiKey.permissions as Prisma.InputJsonValue)
      : Prisma.JsonNull,
    metadata: Prisma.JsonNull,
    // Relations: Connect to existing user and organization
    user: {
      connect: {
        id: apiKey.userId,
      },
    },
    organization: {
      connect: {
        id: apiKey.organizationId,
      },
    },
  };
}

/**
 * Map ApiKeyEntity to Prisma ApiKeyUpdateInput
 * 
 * Only updates mutable fields
 */
export function mapApiKeyToPrismaUpdate(
  apiKey: ReturnType<ApiKeyEntity['toPersistence']>
): Prisma.ApiKeyUpdateInput {
  return {
    name: apiKey.name,
    status: apiKey.status,
    statusReason: apiKey.statusReason ?? null,
    lastUsedAt: apiKey.lastUsedAt,
    requestCount: apiKey.requestCount ?? 0,
    lastRequestIp: apiKey.lastRequestIp ?? null,
    expiresAt: apiKey.expiresAt ?? null,
    rotatedAt: apiKey.rotatedAt ?? null,
    revokedAt: apiKey.revokedAt ?? null,
    rotationCount: apiKey.rotationCount ?? 0,
    previousKeyId: apiKey.previousKeyId ?? null,
    nextKeyId: apiKey.nextKeyId ?? null,
    autoRotate: apiKey.autoRotate ?? false,
    rotationIntervalDays: apiKey.rotationIntervalDays ?? null,
    gracePeriodDays: apiKey.gracePeriodDays ?? 7,
    ipWhitelist: apiKey.ipWhitelist ?? [],
    permissions: apiKey.permissions
      ? (apiKey.permissions as Prisma.InputJsonValue)
      : Prisma.JsonNull,
  };
}

/**
 * Map UserAggregate to Prisma batch operations
 * 
 * Returns typed operations for transaction:
 * - User upsert
 * - API keys upserts (array)
 * 
 * All type-safe, no as any casts
 */
export function mapUserAggregateToPrismaBatch(aggregate: {
  user: ReturnType<UserEntity['toPersistence']>;
  apiKeys: ReturnType<ApiKeyEntity['toPersistence']>[];
}): {
  userUpsert: {
    where: Prisma.UserWhereUniqueInput;
    create: Prisma.UserCreateInput;
    update: Prisma.UserUpdateInput;
  };
  apiKeyUpserts: Array<{
    where: Prisma.ApiKeyWhereUniqueInput;
    create: Prisma.ApiKeyCreateInput;
    update: Prisma.ApiKeyUpdateInput;
    keyHash: string;
    quickHash: string;
  }>;
} {
  return {
    userUpsert: {
      where: { id: aggregate.user.id },
      create: mapUserToPrismaCreate(aggregate.user),
      update: mapUserToPrismaUpdate(aggregate.user),
    },
    apiKeyUpserts: aggregate.apiKeys.map((apiKey) => {
      // Note: keyHash and quickHash must be computed externally (bcrypt/SHA-256)
      // We return placeholders here - caller must replace with actual hashes
      const placeholderCreate: Prisma.ApiKeyCreateInput = {
        id: apiKey.id,
        name: apiKey.name,
        keyHash: '', // Placeholder - caller must compute
        keyPrefix: apiKey.keyPrefix,
        quickHash: '', // Placeholder - caller must compute
        status: apiKey.status,
        user: { connect: { id: apiKey.userId } },
        organization: { connect: { id: apiKey.organizationId } },
      };
      return {
        where: { id: apiKey.id },
        create: placeholderCreate, // Caller should replace with mapApiKeyToPrismaCreate with hashes
        update: mapApiKeyToPrismaUpdate(apiKey),
        keyHash: '', // Placeholder - caller must compute
        quickHash: '', // Placeholder - caller must compute
      };
    }),
  };
}

