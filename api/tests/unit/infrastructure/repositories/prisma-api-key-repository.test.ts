// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PrismaApiKeyRepository Integration Tests
 * Validates repository behaviour against a real PostgreSQL database.
 * 
 * Uses TestIsolationManager for robust isolation between test files.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client.js';
import type { PrismaApiKeyRepository } from '@/infrastructure/repositories/prisma-api-key-repository';
import { ApiKeyEntity, ApiKeyStatus } from '@/domain/entities/api-key.entity';
import { ApiKeyValue } from '@/domain/value-objects/api-key-value';
import { PasswordHash } from '@/domain/value-objects/password-hash';
import { startTestEnvironment, stopTestEnvironment } from '../../../utils/test-environment';
import { createIsolation, TestIsolationManager } from '../../../utils/test-isolation';
import bcrypt from 'bcrypt';

let prisma: PrismaClient;
let repository: PrismaApiKeyRepository;
let isolation: TestIsolationManager;

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

async function createUser(params: {
  organizationId: string;
  email?: string;
  name?: string;
  password?: string;
}) {
  // Use transaction to ensure both organization and user are created atomically
  const result = await prisma.$transaction(async (tx) => {
    // Ensure organization exists
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
    
    const passwordHash = await PasswordHash.fromPlainText(params.password ?? 'S3curePass!234');
    const email = params.email ?? isolation.generateEmail('user');
    
    return tx.user.create({
      data: {
        id: randomUUID(),
        email: email.toLowerCase(),
        name: params.name ?? 'Integration User',
        passwordHash: passwordHash.getValue(),
        organizationId: params.organizationId,
        role: 'user',
        status: 'active',
      },
    });
  });
  
  isolation.trackOrganization(params.organizationId);
  isolation.trackUser(result.id);
  return result;
}

describe.sequential('PrismaApiKeyRepository (integration)', () => {
  beforeAll(async () => {
    // Create isolation manager for this test file
    isolation = createIsolation(__filename);
    
    await startTestEnvironment();
    const prismaModule = await import('@/database/client');
    prisma = prismaModule.prisma;
    const repositoryModule = await import('@/infrastructure/repositories/prisma-api-key-repository');
    const RepositoryCtor = repositoryModule.PrismaApiKeyRepository;
    repository = new RepositoryCtor();
    
    // Clean up residual test data from THIS test file only (by namespace)
    await isolation.cleanup(prisma);
  }, 120_000);

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
    // Clean before each test
    await isolation.cleanup(prisma);
  });

  afterEach(async () => {
    // Clean after each test
    await isolation.cleanup(prisma);
  });

  describe('save', () => {
    it('hashes API key before persistence', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('save') });
      const apiKey = ApiKeyEntity.create({
        name: 'Hash Test Key',
        userId: user.id,
        organizationId: org.id,
      });

      const rawKey = apiKey.toPersistence().keyValue;

      await repository.save(apiKey);
      isolation.trackApiKey(apiKey.id);

      const stored = await prisma.apiKey.findUnique({ where: { id: apiKey.id } });
      expect(stored).not.toBeNull();
      expect(stored?.keyHash).not.toBe(rawKey);
      const isMatching = await bcrypt.compare(rawKey, stored!.keyHash);
      expect(isMatching).toBe(true);
      expect(stored?.quickHash).toBeTruthy();
    });

    it('updates metadata without rehashing when key unchanged', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('update') });
      const apiKey = ApiKeyEntity.create({
        name: 'Update Key',
        userId: user.id,
        organizationId: org.id,
      });

      const rawKey = apiKey.toPersistence().keyValue;
      await repository.save(apiKey);
      isolation.trackApiKey(apiKey.id);

      apiKey.recordUsage('1.1.1.1');
      await repository.save(apiKey);

      const stored = await prisma.apiKey.findUnique({ where: { id: apiKey.id } });
      expect(stored?.lastRequestIp).toBe('1.1.1.1');
      const isMatching = await bcrypt.compare(rawKey, stored!.keyHash);
      expect(isMatching).toBe(true);
    });
  });

  describe('findById', () => {
    it('retrieves domain entity for stored key', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('findid') });
      const apiKey = ApiKeyEntity.create({
        name: 'FindId Key',
        userId: user.id,
        organizationId: org.id,
      });
      await repository.save(apiKey);
      isolation.trackApiKey(apiKey.id);

      const found = await repository.findById(apiKey.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(apiKey.id);
      expect(found?.status).toBe(ApiKeyStatus.ACTIVE);
    });

    it('returns null for unknown key', async () => {
      const result = await repository.findById(randomUUID());
      expect(result).toBeNull();
    });
  });

  describe('findByKeyValue', () => {
    it('validates value via bcrypt', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('auth') });
      const apiKey = ApiKeyEntity.create({
        name: 'Auth Key',
        userId: user.id,
        organizationId: org.id,
      });
      const rawValue = ApiKeyValue.create(apiKey.toPersistence().keyValue);
      await repository.save(apiKey);
      isolation.trackApiKey(apiKey.id);

      const found = await repository.findByKeyValue(rawValue);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(apiKey.id);
    });

    it('returns null for invalid value', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('authfail') });
      const apiKey = ApiKeyEntity.create({
        name: 'Auth Fail Key',
        userId: user.id,
        organizationId: org.id,
      });
      await repository.save(apiKey);
      isolation.trackApiKey(apiKey.id);

      const invalid = ApiKeyValue.generate();
      const found = await repository.findByKeyValue(invalid);
      expect(found).toBeNull();
    });
  });

  describe('listing queries', () => {
    it('findByUser returns keys ordered by creation date', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('list') });
      const keyA = ApiKeyEntity.create({ name: 'Key A', userId: user.id, organizationId: org.id });
      const keyB = ApiKeyEntity.create({ name: 'Key B', userId: user.id, organizationId: org.id });
      await repository.save(keyA);
      await repository.save(keyB);
      isolation.trackApiKey(keyA.id);
      isolation.trackApiKey(keyB.id);

      const list = await repository.findByUser(user.id);
      expect(list).toHaveLength(2);
      expect(list[0].createdAt.getTime()).toBeGreaterThanOrEqual(list[1].createdAt.getTime());
      const names = list.map((item) => item.name).sort();
      expect(names).toEqual(['Key A', 'Key B']);
    });

    it('findByUser tolerates legacy key prefixes', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('legacy-prefix') });

      const legacyRawValue = 'ak_live_legacyplaceholderplaceholderplaceholder1234';
      const keyHash = await bcrypt.hash(legacyRawValue, 10);
      const keyId = randomUUID();

      await prisma.apiKey.create({
        data: {
          id: keyId,
          name: 'Legacy Prefix Key',
          keyHash,
          keyPrefix: 'ak_WX88iDm',
          userId: user.id,
          organizationId: org.id,
          status: 'active',
          requestCount: 0,
          permissions: {},
          ipWhitelist: [],
          autoRotate: false,
          gracePeriodDays: 7,
        },
      });
      isolation.trackApiKey(keyId);

      const list = await repository.findByUser(user.id);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(keyId);
      expect(list[0].name).toBe('Legacy Prefix Key');
    });

    it('findActive filters by user and organization', async () => {
      const org = await createOrganization();
      const otherOrg = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('active') });
      const otherUser = await createUser({ organizationId: otherOrg.id, email: isolation.generateEmail('other') });

      const keyActive = ApiKeyEntity.create({ name: 'Active', userId: user.id, organizationId: org.id });
      const keyOther = ApiKeyEntity.create({ name: 'Other', userId: otherUser.id, organizationId: otherOrg.id });
      await repository.save(keyActive);
      await repository.save(keyOther);
      isolation.trackApiKey(keyActive.id);
      isolation.trackApiKey(keyOther.id);

      const list = await repository.findActive({ userId: user.id });
      expect(list).toHaveLength(1);
      expect(list[0].userId).toBe(user.id);
    });
  });

  describe('count operations', () => {
    it('counts keys by user and organization', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('count') });
      const keyCountA = ApiKeyEntity.create({ name: 'Count A', userId: user.id, organizationId: org.id });
      const keyCountB = ApiKeyEntity.create({ name: 'Count B', userId: user.id, organizationId: org.id });
      await repository.save(keyCountA);
      await repository.save(keyCountB);
      isolation.trackApiKey(keyCountA.id);
      isolation.trackApiKey(keyCountB.id);

      const countUser = await repository.countByUser(user.id);
      const countOrg = await repository.countByOrganization(org.id);
      expect(countUser).toBe(2);
      expect(countOrg).toBe(2);
    });
  });

  describe('rotation and expiration', () => {
    it('findDueForRotation returns only keys past interval', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('rotation') });
      const key = ApiKeyEntity.create({
        name: 'Rotation Key',
        userId: user.id,
        organizationId: org.id,
      });
      await repository.save(key);
      isolation.trackApiKey(key.id);

      await prisma.apiKey.update({
        where: { id: key.id },
        data: {
          autoRotate: true,
          rotationIntervalDays: 1,
          rotatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        },
      });

      const due = await repository.findDueForRotation();
      expect(due.map((k) => k.id)).toContain(key.id);
    });

    it('findExpired returns keys with past expiration', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('expired') });
      const key = ApiKeyEntity.create({
        name: 'Expired Key',
        userId: user.id,
        organizationId: org.id,
      });
      await repository.save(key);
      isolation.trackApiKey(key.id);

      const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const expiresAt = new Date(Date.now() - 30 * 60 * 1000);
      await prisma.apiKey.update({
        where: { id: key.id },
        data: {
          createdAt,
          expiresAt,
        },
      });

      const expired = await repository.findExpired();
      expect(expired.map((k) => k.id)).toContain(key.id);
    });
  });

  describe('saveMany', () => {
    it('saves multiple keys in a transaction', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('batch') });
      const keyA = ApiKeyEntity.create({ name: 'Batch A', userId: user.id, organizationId: org.id });
      const keyB = ApiKeyEntity.create({ name: 'Batch B', userId: user.id, organizationId: org.id });

      await repository.saveMany([keyA, keyB]);
      isolation.trackApiKey(keyA.id);
      isolation.trackApiKey(keyB.id);

      const stored = await prisma.apiKey.findMany({ where: { userId: user.id } });
      expect(stored).toHaveLength(2);
    });
  });

  describe('delete', () => {
    it('removes key from database', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('delete') });
      const apiKey = ApiKeyEntity.create({ name: 'Delete Key', userId: user.id, organizationId: org.id });
      await repository.save(apiKey);
      isolation.trackApiKey(apiKey.id);

      await repository.delete(apiKey.id);

      const stored = await prisma.apiKey.findUnique({ where: { id: apiKey.id } });
      expect(stored).toBeNull();
    });
  });

  describe('findAggregate behavior placeholders', () => {
    it('returns domain entity with placeholder value but keeps metadata', async () => {
      const org = await createOrganization();
      const user = await createUser({ organizationId: org.id, email: isolation.generateEmail('placeholder') });
      const apiKey = ApiKeyEntity.create({ name: 'Placeholder Key', userId: user.id, organizationId: org.id });
      await repository.save(apiKey);
      isolation.trackApiKey(apiKey.id);

      const found = await repository.findById(apiKey.id);
      expect(found).not.toBeNull();
      expect(found?.getActiveApiKeys?.length).toBeUndefined(); // ensure still ApiKeyEntity
      expect(found?.requestCount).toBe(0);
    });
  });
});
