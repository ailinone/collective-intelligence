// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * PrismaOrganizationRepository Integration Tests
 * Validates repository behaviour against a real PostgreSQL database.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client.js';
import type { PrismaOrganizationRepository } from '@/infrastructure/repositories/prisma-organization-repository';
import { OrganizationEntity } from '@/domain/entities/organization.entity';
import { TierLevel } from '@/domain/value-objects/organization-tier';
import { OrganizationAggregate } from '@/domain/aggregates/organization.aggregate';
import { UserEntity, UserRole } from '@/domain/entities/user.entity';
import { PasswordHash } from '@/domain/value-objects/password-hash';
import { startTestEnvironment, stopTestEnvironment } from '../../../utils/test-environment';

describe.sequential('PrismaOrganizationRepository (integration)', () => {
  let prisma: PrismaClient;
  let repository: PrismaOrganizationRepository;

beforeAll(async () => {
  await startTestEnvironment();
  const prismaModule = await import('@/database/client');
  prisma = prismaModule.prisma;
  const repositoryModule = await import('@/infrastructure/repositories/prisma-organization-repository');
  const RepositoryCtor = repositoryModule.PrismaOrganizationRepository;
  repository = new RepositoryCtor();
}, 120_000);

afterAll(async () => {
    if (!prisma) {
      return;
    }
    await prisma.user.deleteMany();
    await prisma.organization.deleteMany();
    await stopTestEnvironment();
}, 60_000);

  beforeEach(async () => {
    if (!prisma) {
      throw new Error('Prisma client not initialized');
    }
    await prisma.user.deleteMany();
    await prisma.organization.deleteMany();
  });

  async function seedUser(params: {
    organizationId: string;
    email?: string;
    name?: string;
    role?: string;
    status?: string;
    password?: string;
  }) {
    const passwordHash = await PasswordHash.fromPlainText(params.password ?? 'Passw0rd123!');
  const baseEmail = params.email ?? `${randomUUID()}@integration.test`;
  const [localPart, domain = 'integration.test'] = baseEmail.split('@');
  const uniqueEmail = `${localPart}+${randomUUID()}@${domain}`;
    return prisma.user.create({
      data: {
        id: randomUUID(),
      email: uniqueEmail.toLowerCase(),
        name: params.name ?? 'Integration User',
        passwordHash: passwordHash.getValue(),
        organizationId: params.organizationId,
        role: params.role ?? 'user',
        status: params.status ?? 'active',
      },
    });
  }

  describe('findById', () => {
    it('returns persisted organization with member count', async () => {
      const org = OrganizationEntity.create({ name: 'Find By Id Org', tier: TierLevel.PRO });
      await repository.save(org);
      await seedUser({ organizationId: org.id, email: 'member-find@test.com' });

      const result = await repository.findById(org.id);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('Find By Id Org');
      expect(result?.toDTO().memberCount).toBe(1);
    });

    it('returns null for unknown organization', async () => {
      const result = await repository.findById(randomUUID());
      expect(result).toBeNull();
    });
  });

  describe('findByName', () => {
    it('locates organization by exact name', async () => {
      const org = OrganizationEntity.create({ name: 'Unique Org Name', tier: TierLevel.FREE });
      await repository.save(org);

      const found = await repository.findByName('Unique Org Name');
      expect(found).not.toBeNull();
      expect(found?.id).toBe(org.id);
    });
  });

  describe('findAll', () => {
    it('lists all organizations ordered by creation date', async () => {
      const prefix = randomUUID();
      const freeOrg = OrganizationEntity.create({ name: `${prefix}-Free Org`, tier: TierLevel.FREE });
      const proOrg = OrganizationEntity.create({ name: `${prefix}-Pro Org`, tier: TierLevel.PRO });
      await repository.save(freeOrg);
      await repository.save(proOrg);

      const result = await repository.findAll();
      const filtered = result.filter((org) => org.name.startsWith(`${prefix}-`));
      const names = filtered.map((org) => org.name);
      expect(filtered).toHaveLength(2);
      expect(names).toContain(`${prefix}-Free Org`);
      expect(names).toContain(`${prefix}-Pro Org`);
    });

    it('filters by tier', async () => {
      const prefix = randomUUID();
      const freeOrg = OrganizationEntity.create({ name: `${prefix}-Filter Free`, tier: TierLevel.FREE });
      const proOrg = OrganizationEntity.create({ name: `${prefix}-Filter Pro`, tier: TierLevel.PRO });
      await repository.save(freeOrg);
      await repository.save(proOrg);

      const filtered = await repository.findAll({ tier: 'pro' });
      const targeted = filtered.filter((org) => org.name.startsWith(`${prefix}-`));
      expect(targeted).toHaveLength(1);
      expect(targeted[0].name).toBe(`${prefix}-Filter Pro`);
    });

    it('supports pagination', async () => {
      const prefix = randomUUID();
      const organizations = Array.from({ length: 3 }).map((_, index) =>
        OrganizationEntity.create({ name: `${prefix}-Paged Org ${index}`, tier: TierLevel.FREE })
      );
      for (const org of organizations) {
        await repository.save(org);
      }

      const page = await repository.findAll({ limit: 10, offset: 0 });
      const targeted = page.filter((org) => org.name.startsWith(`${prefix}-`));
      expect(targeted).toHaveLength(3);
      const orderedNames = targeted.map((org) => org.name).sort();
      expect(orderedNames).toEqual([
        `${prefix}-Paged Org 0`,
        `${prefix}-Paged Org 1`,
        `${prefix}-Paged Org 2`,
      ]);
    });
  });

  describe('save', () => {
    it('persists and updates organization data', async () => {
      const org = OrganizationEntity.create({ name: 'Persist Org', tier: TierLevel.ENTERPRISE });
      await repository.save(org);

      let stored = await prisma.organization.findUnique({ where: { id: org.id } });
      expect(stored?.name).toBe('Persist Org');
      expect(stored?.tier).toBe('enterprise');

      org.rename('Persist Org Updated');
      await repository.save(org);

      stored = await prisma.organization.findUnique({ where: { id: org.id } });
      expect(stored?.name).toBe('Persist Org Updated');
    });
  });

  describe('saveAggregate', () => {
    it('replaces members not present in aggregate and upserts new ones', async () => {
      const org = OrganizationEntity.create({ name: 'Aggregate Org', tier: TierLevel.PRO });
      await repository.save(org);
      await seedUser({ organizationId: org.id, email: 'legacy@test.com' });

      const memberHash = await PasswordHash.fromPlainText('Str0ngPass!234');
      const member = UserEntity.create({
        email: 'aggregate@test.com',
        name: 'Aggregate Member',
        organizationId: org.id,
        role: UserRole.ADMIN,
      });
      member.setPasswordHash(memberHash);

      const aggregate = OrganizationAggregate.reconstitute(org, [member]);
      await repository.saveAggregate(aggregate);

      const users = await prisma.user.findMany({ where: { organizationId: org.id } });
      expect(users).toHaveLength(1);
      expect(users[0].email).toBe('aggregate@test.com');
    });
  });

  describe('delete', () => {
    it('removes organization and cascades to users', async () => {
      const org = OrganizationEntity.create({ name: 'Delete Org', tier: TierLevel.FREE });
      await repository.save(org);
      await seedUser({ organizationId: org.id, email: 'delete@test.com' });

      await repository.delete(org.id);

      const storedOrg = await prisma.organization.findUnique({ where: { id: org.id } });
      const storedUsers = await prisma.user.findMany({ where: { organizationId: org.id } });
      expect(storedOrg).toBeNull();
      expect(storedUsers).toHaveLength(0);
    });
  });

  describe('nameExists', () => {
    it('returns true when organization name exists', async () => {
      const org = OrganizationEntity.create({ name: 'Existing Org', tier: TierLevel.FREE });
      await repository.save(org);

      const exists = await repository.nameExists('Existing Org');
      expect(exists).toBe(true);
    });

    it('returns false when organization name does not exist', async () => {
      const exists = await repository.nameExists('Nonexistent Org');
      expect(exists).toBe(false);
    });
  });

  describe('countByTier', () => {
    it('returns counts grouped by tier', async () => {
      // Ensure clean state before test
      await prisma.organization.deleteMany();
      
      const prefix = randomUUID();
      const before = await repository.countByTier();

      await repository.save(OrganizationEntity.create({ name: `${prefix}-Free Tier Org`, tier: TierLevel.FREE }));
      await repository.save(OrganizationEntity.create({ name: `${prefix}-Pro Tier Org`, tier: TierLevel.PRO }));
      await repository.save(OrganizationEntity.create({ name: `${prefix}-Another Pro Org`, tier: TierLevel.PRO }));

      const counts = await repository.countByTier();

      // After creating 1 free and 2 pro, we should have exactly those counts
      expect(counts.free ?? 0).toBe((before.free ?? 0) + 1);
      expect(counts.pro ?? 0).toBe((before.pro ?? 0) + 2);
    });
  });

  describe('countMembers', () => {
    it('counts members for the given organization', async () => {
      const org = OrganizationEntity.create({ name: 'Member Count Org', tier: TierLevel.FREE });
      await repository.save(org);
      await seedUser({ organizationId: org.id, email: 'member1@test.com' });
      await seedUser({ organizationId: org.id, email: 'member2@test.com' });

      const count = await repository.countMembers(org.id);
      expect(count).toBe(2);
    });
  });

  describe('findAggregateById', () => {
    it('returns aggregate with organization and members', async () => {
      const org = OrganizationEntity.create({ name: 'Aggregate Lookup Org', tier: TierLevel.PRO });
      await repository.save(org);
      await seedUser({ organizationId: org.id, email: 'agg-member@test.com' });

      const aggregate = await repository.findAggregateById(org.id);
      expect(aggregate).not.toBeNull();
      expect(aggregate?.getOrganization().name).toBe('Aggregate Lookup Org');
      expect(aggregate?.getAllMembers()).toHaveLength(1);
    });

    it('returns null when organization is missing', async () => {
      const aggregate = await repository.findAggregateById(randomUUID());
      expect(aggregate).toBeNull();
    });
  });
});

