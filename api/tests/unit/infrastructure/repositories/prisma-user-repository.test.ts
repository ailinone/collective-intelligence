// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PrismaUserRepository Integration Tests
 * Validates repository behaviour against a real PostgreSQL database.
 * 
 * Uses TestIsolationManager for robust isolation between test files.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client.js';
import type { PrismaUserRepository } from '@/infrastructure/repositories/prisma-user-repository';
import { UserEntity, UserRole, UserStatus } from '@/domain/entities/user.entity';
import { UserId } from '@/domain/value-objects/user-id';
import { Email } from '@/domain/value-objects/email';
import { PasswordHash } from '@/domain/value-objects/password-hash';
import { ApiKeyStatus } from '@/domain/entities/api-key.entity';
import { startTestEnvironment, stopTestEnvironment } from '../../../utils/test-environment';
import { createIsolation, TestIsolationManager } from '../../../utils/test-isolation';

let prisma: PrismaClient;
let repository: PrismaUserRepository;
let isolation: TestIsolationManager;

async function hashPassword(value = 'S3curePass!234') {
  return PasswordHash.fromPlainText(value);
}

async function createOrganization(name?: string) {
  const organizationId = randomUUID();
  const orgName = name ?? isolation.generateOrgName('Org');
  const organization = await prisma.organization.create({
    data: {
      id: organizationId,
      name: orgName,
      tier: 'free',
      status: 'active',
      settings: {},
    },
  });
  isolation.trackOrganization(organization.id);
  return organization;
}

async function createUserRecord(params: {
  organizationId: string;
  email?: string;
  name?: string;
  role?: string;
  status?: string;
  passwordHash?: PasswordHash;
}) {
  const passwordHash = params.passwordHash ?? (await hashPassword());
  
  // Use transaction to ensure both organization and user are created atomically
  const result = await prisma.$transaction(async (tx) => {
    // Ensure organization exists before creating user (required for foreign key constraint)
    await tx.organization.upsert({
      where: { id: params.organizationId },
      update: {},
      create: {
        id: params.organizationId,
        name: isolation.generateOrgName('AutoOrg'),
        tier: 'free',
        status: 'active',
        settings: {},
      },
    });
    
    // Create user in the same transaction
    return tx.user.create({
      data: {
        id: randomUUID(),
        email: params.email ?? isolation.generateEmail('user'),
        name: params.name ?? 'Integration User',
        passwordHash: passwordHash.getValue(),
        organizationId: params.organizationId,
        role: params.role ?? 'user',
        status: params.status ?? 'active',
      },
    });
  });
  
  isolation.trackOrganization(params.organizationId);
  isolation.trackUser(result.id);
  return result;
}

describe.sequential('PrismaUserRepository (integration)', () => {
  beforeAll(async () => {
    // Create isolation manager for this test file
    isolation = createIsolation(__filename);
    
    await startTestEnvironment();
    const prismaModule = await import('@/database/client');
    prisma = prismaModule.prisma;
    const repositoryModule = await import('@/infrastructure/repositories/prisma-user-repository');
    const RepositoryCtor = repositoryModule.PrismaUserRepository;
    repository = new RepositoryCtor();
    
    // Clean up residual test data from THIS test file only (by namespace)
    await isolation.cleanup(prisma);
  }, 180_000);

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    // Final cleanup
    await isolation.cleanup(prisma);
    await stopTestEnvironment();
  }, 60_000);

  beforeEach(async () => {
    if (!prisma) {
      throw new Error('Prisma client not initialized');
    }
    // Clean before each test to ensure isolation
    await isolation.cleanup(prisma);
  });

  afterEach(async () => {
    // Clean after each test
    await isolation.cleanup(prisma);
  });

  describe('findById', () => {
    it('returns persisted user with password hash', async () => {
      const org = await createOrganization();
      const hash = await hashPassword('FindIdPass!234');
      const created = await createUserRecord({
        organizationId: org.id,
        email: isolation.generateEmail('findid'),
        name: 'Find Id',
        passwordHash: hash,
      });

      const result = await repository.findById(UserId.create(created.id));

      expect(result).not.toBeNull();
      expect(result?.id).toBe(created.id);
      expect(await result?.passwordHash?.verify('FindIdPass!234')).toBe(true);
    });

    it('returns null for unknown user', async () => {
      const result = await repository.findById(UserId.create(randomUUID()));
      expect(result).toBeNull();
    });
  });

  describe('findByEmail', () => {
    it('finds user by email', async () => {
      const org = await createOrganization();
      const email = isolation.generateEmail('findemail');
      await createUserRecord({
        organizationId: org.id,
        email,
        name: 'Email User',
      });

      const result = await repository.findByEmail(Email.create(email));

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Email User');
    });

    it('returns null when email not found', async () => {
      const result = await repository.findByEmail(Email.create('missing@test.com'));
      expect(result).toBeNull();
    });
  });

  describe('findByOrganization', () => {
    it('lists users for an organization', async () => {
      const org = await createOrganization();
      const email1 = isolation.generateEmail('one');
      const email2 = isolation.generateEmail('two');
      await createUserRecord({ organizationId: org.id, email: email1 });
      await createUserRecord({ organizationId: org.id, email: email2 });
      const anotherOrg = await createOrganization();
      await createUserRecord({ organizationId: anotherOrg.id, email: isolation.generateEmail('other') });

      const users = await repository.findByOrganization(org.id);

      expect(users).toHaveLength(2);
      const emails = users.map((user) => user.email);
      expect(emails).toContain(email1);
      expect(emails).toContain(email2);
    });
  });

  describe('save', () => {
    it('persists new user with hashed password', async () => {
      const org = await createOrganization();
      
      // Verify organization exists
      const orgCheck = await prisma.organization.findUnique({ where: { id: org.id } });
      expect(orgCheck).not.toBeNull();
      
      const passwordHash = await hashPassword('CreatePass!234');

      const user = UserEntity.create({
        email: isolation.generateEmail('create'),
        name: 'Create User',
        organizationId: org.id,
        role: UserRole.ADMIN,
        passwordHash,
      });
      isolation.trackUser(user.id);

      await repository.save(user);

      const stored = await prisma.user.findUnique({ where: { id: user.id } });
      expect(stored).not.toBeNull();
      expect(stored?.passwordHash).toBe(passwordHash.getValue());
    });

    it('updates existing user and password hash', async () => {
      const org = await createOrganization();
      
      // Verify organization exists
      const orgCheck = await prisma.organization.findUnique({ where: { id: org.id } });
      expect(orgCheck).not.toBeNull();
      
      const initialHash = await hashPassword('InitialPass!234');
      const user = UserEntity.create({
        email: isolation.generateEmail('update'),
        name: 'Update User',
        organizationId: org.id,
        role: UserRole.USER,
        passwordHash: initialHash,
      });
      isolation.trackUser(user.id);

      await repository.save(user);

      // Ensure organization still exists before second save
      await prisma.organization.upsert({
        where: { id: org.id },
        update: {},
        create: {
          id: org.id,
          name: org.name,
          tier: 'free',
          status: 'active',
          settings: {},
        },
      });

      user.changeName('Updated Name');
      const newHash = await hashPassword('NewPass!567');
      user.setPasswordHash(newHash);
      await repository.save(user);

      const stored = await prisma.user.findUnique({ where: { id: user.id } });
      expect(stored?.name).toBe('Updated Name');
      expect(stored?.passwordHash).toBe(newHash.getValue());
    });

    it('throws when password hash is missing (DB constraint)', async () => {
      const org = await createOrganization();
      
      const user = UserEntity.create({
        email: isolation.generateEmail('nopassword'),
        name: 'No Password',
        organizationId: org.id,
        role: UserRole.USER,
      });
      isolation.trackUser(user.id);

      await expect(repository.save(user)).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('removes user and associated api keys', async () => {
      const org = await createOrganization();
      const hash = await hashPassword();
      const created = await createUserRecord({
        organizationId: org.id,
        email: isolation.generateEmail('delete'),
        passwordHash: hash,
      });

      // Create API key for user
      const apiKey = await prisma.apiKey.create({
        data: {
          id: randomUUID(),
          name: 'Test Key',
          keyHash: '$2a$10$test',
          keyPrefix: 'ak_test',
          quickHash: 'quick_test',
          status: ApiKeyStatus.ACTIVE,
          userId: created.id,
          organizationId: org.id,
        },
      });
      isolation.trackApiKey(apiKey.id);

      await repository.delete(UserId.create(created.id));

      const stored = await prisma.user.findUnique({ where: { id: created.id } });
      expect(stored).toBeNull();

      const storedKey = await prisma.apiKey.findUnique({ where: { id: apiKey.id } });
      expect(storedKey).toBeNull();
    });
  });

  describe('saveAggregate', () => {
    it('atomically saves user with api keys', async () => {
      // Create organization and ensure it exists before test
      const org = await createOrganization();
      
      // Double-check organization exists (required for saveAggregate)
      const orgCheck = await prisma.organization.findUnique({ where: { id: org.id } });
      expect(orgCheck).not.toBeNull();
      
      const passwordHash = await hashPassword('AggregatePass!234');

      const user = UserEntity.create({
        email: isolation.generateEmail('aggregate'),
        name: 'Aggregate User',
        organizationId: org.id,
        role: UserRole.USER,
        passwordHash,
      });
      isolation.trackUser(user.id);

      const { UserAggregate } = await import('@/domain/aggregates/user.aggregate');
      const { ApiKeyEntity } = await import('@/domain/entities/api-key.entity');
      
      const apiKey = ApiKeyEntity.create({
        name: 'Aggregate Key',
        userId: user.id,
        organizationId: org.id,
      });
      isolation.trackApiKey(apiKey.id);

      // Use reconstitute to create aggregate with existing user and API keys
      const aggregate = UserAggregate.reconstitute(user, [apiKey]);
      
      // Ensure organization still exists immediately before saveAggregate
      await prisma.organization.upsert({
        where: { id: org.id },
        update: {},
        create: {
          id: org.id,
          name: org.name,
          tier: 'free',
          status: 'active',
          settings: {},
        },
      });
      
      try {
        await repository.saveAggregate(aggregate);
      } catch (error) {
        console.error('saveAggregate error:', error);
        throw error;
      }

      const storedUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(storedUser).not.toBeNull();

      const storedKey = await prisma.apiKey.findUnique({ where: { id: apiKey.id } });
      expect(storedKey).not.toBeNull();
      expect(storedKey?.name).toBe('Aggregate Key');
    });

    it('handles multiple api keys per user', async () => {
      // Create organization and ensure it exists before test
      const org = await createOrganization();
      
      // Verify organization exists
      const orgCheck = await prisma.organization.findUnique({ where: { id: org.id } });
      expect(orgCheck).not.toBeNull();
      
      const passwordHash = await hashPassword('MultiKeyPass!234');

      const user = UserEntity.create({
        email: isolation.generateEmail('multikey'),
        name: 'MultiKey User',
        organizationId: org.id,
        role: UserRole.USER,
        passwordHash,
      });
      isolation.trackUser(user.id);

      const { UserAggregate } = await import('@/domain/aggregates/user.aggregate');
      const { ApiKeyEntity } = await import('@/domain/entities/api-key.entity');
      
      const key1 = ApiKeyEntity.create({
        name: 'Key 1',
        userId: user.id,
        organizationId: org.id,
      });
      const key2 = ApiKeyEntity.create({
        name: 'Key 2',
        userId: user.id,
        organizationId: org.id,
      });
      isolation.trackApiKey(key1.id);
      isolation.trackApiKey(key2.id);

      // Use reconstitute to create aggregate with existing user and API keys
      const aggregate = UserAggregate.reconstitute(user, [key1, key2]);
      
      // Ensure organization still exists immediately before saveAggregate
      await prisma.organization.upsert({
        where: { id: org.id },
        update: {},
        create: {
          id: org.id,
          name: org.name,
          tier: 'free',
          status: 'active',
          settings: {},
        },
      });
      
      try {
        await repository.saveAggregate(aggregate);
      } catch (error) {
        console.error('saveAggregate error:', error);
        throw error;
      }

      // Verify user was saved
      const storedUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(storedUser).not.toBeNull();

      // Verify API keys were saved
      const storedKeys = await prisma.apiKey.findMany({
        where: { userId: user.id },
      });
      expect(storedKeys).toHaveLength(2);
    });
  });
});
