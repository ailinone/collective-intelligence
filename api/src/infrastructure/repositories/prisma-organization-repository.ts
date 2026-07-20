// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prisma Organization Repository
 * Infrastructure Layer: Implements IOrganizationRepository
 *
 * Clean Architecture Pattern:
 * - Implements domain interface
 * - Domain ↔ Prisma mapping
 * - Transaction support for aggregates
 */

import { injectable } from 'tsyringe';
import { IOrganizationRepository } from '@/domain/repositories/iorganization-repository';
import { OrganizationEntity, OrganizationStatus } from '@/domain/entities/organization.entity';
import { OrganizationAggregate } from '@/domain/aggregates/organization.aggregate';
import { UserEntity } from '@/domain/entities/user.entity';
import { prisma } from '@/database/client';
import { Prisma } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';

const VALID_ORGANIZATION_STATUSES = new Set(Object.values(OrganizationStatus));

function normalizeOrganizationStatus(status: string): OrganizationStatus {
  return VALID_ORGANIZATION_STATUSES.has(status as OrganizationStatus)
    ? (status as OrganizationStatus)
    : OrganizationStatus.ACTIVE;
}

function getStatusReason(record: unknown): string | undefined {
  if (record && typeof record === 'object' && 'statusReason' in record) {
    const recordObj = record as { statusReason?: unknown };
    const value = recordObj.statusReason;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

@injectable()
export class PrismaOrganizationRepository implements IOrganizationRepository {
  private log = logger.child({ component: 'prisma-organization-repository' });

  /**
   * Find organization by ID
   */
  async findById(organizationId: string): Promise<OrganizationEntity | null> {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        include: {
          _count: {
            select: { users: true },
          },
        },
      });

      if (!org) {
        return null;
      }

      return OrganizationEntity.reconstitute({
        id: org.id,
        name: org.name,
        tier: org.tier,
        status: normalizeOrganizationStatus(org.status),
        statusReason: getStatusReason(org),
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
        memberCount: org._count?.users,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, organizationId }, 'Failed to find organization');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find organization by name
   */
  async findByName(name: string): Promise<OrganizationEntity | null> {
    try {
      const org = await prisma.organization.findFirst({
        where: { name },
      });

      if (!org) {
        return null;
      }

      return OrganizationEntity.reconstitute({
        id: org.id,
        name: org.name,
        tier: org.tier,
        status: normalizeOrganizationStatus(org.status),
        statusReason: getStatusReason(org),
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, name }, 'Failed to find organization by name');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * List all organizations with filters
   */
  async findAll(options?: {
    limit?: number;
    offset?: number;
    tier?: string;
    status?: string;
  }): Promise<OrganizationEntity[]> {
    try {
      const orgs = await prisma.organization.findMany({
        where: {
          ...(options?.tier && { tier: options.tier }),
          ...(options?.status && { status: options.status }),
        },
        include: {
          _count: {
            select: { users: true },
          },
        },
        take: options?.limit,
        skip: options?.offset,
        orderBy: { createdAt: 'desc' },
      });

      return orgs.map((org) =>
        OrganizationEntity.reconstitute({
          id: org.id,
          name: org.name,
          tier: org.tier,
          status: normalizeOrganizationStatus(org.status),
          statusReason: getStatusReason(org),
          createdAt: org.createdAt,
          updatedAt: org.updatedAt,
          memberCount: org._count?.users,
        })
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to list organizations');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Save organization
   */
  async save(organization: OrganizationEntity): Promise<void> {
    try {
      const persistable = organization.toPersistence();

      await prisma.organization.upsert({
        where: { id: persistable.id },
        create: {
          id: persistable.id,
          name: persistable.name,
          tier: persistable.tier,
          status: persistable.status,
          statusReason: persistable.statusReason ?? undefined,
          createdAt: persistable.createdAt,
          updatedAt: persistable.updatedAt,
        } satisfies Prisma.OrganizationCreateInput,
        update: {
          name: persistable.name,
          tier: persistable.tier,
          status: persistable.status,
          statusReason: persistable.statusReason ?? undefined,
          updatedAt: persistable.updatedAt,
        },
      });

      this.log.info({ organizationId: persistable.id }, 'Organization saved');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to save organization');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Count organization members
   */
  async countMembers(organizationId: string): Promise<number> {
    try {
      const count = await prisma.user.count({
        where: { organizationId },
      });

      return count;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, organizationId }, 'Failed to count organization members');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Save organization aggregate (org + members)
   */
  async saveAggregate(aggregate: OrganizationAggregate): Promise<void> {
    try {
      const { organization, members } = aggregate.toPersistence();

      await prisma.$transaction(async (tx) => {
        // Save organization
        await tx.organization.upsert({
          where: { id: organization.id },
          create: {
            id: organization.id,
            name: organization.name,
            tier: organization.tier,
            status: organization.status,
            statusReason: organization.statusReason ?? undefined,
            createdAt: organization.createdAt,
            updatedAt: organization.updatedAt,
          } satisfies Prisma.OrganizationCreateInput,
          update: {
            name: organization.name,
            tier: organization.tier,
            status: organization.status,
            statusReason: organization.statusReason ?? undefined,
            updatedAt: organization.updatedAt,
          },
        });

        // Save members (users)
        const memberIds = members.map((member) => member.id);

        if (memberIds.length === 0) {
          await tx.user.deleteMany({
            where: { organizationId: organization.id },
          });
        } else {
          await tx.user.deleteMany({
            where: {
              organizationId: organization.id,
              id: { notIn: memberIds },
            },
          });
        }

        for (const member of members) {
          if (!member.passwordHash) {
            throw new Error(`Missing password hash for member ${member.id}`);
          }

          await tx.user.upsert({
            where: { id: member.id },
            create: {
              id: member.id,
              email: member.email,
              name: member.name,
              role: member.role,
              status: member.status,
              organization: { connect: { id: member.organizationId } },
              createdAt: member.createdAt,
              updatedAt: member.updatedAt,
              passwordHash: member.passwordHash,
            } satisfies Prisma.UserCreateInput,
            update: {
              name: member.name,
              role: member.role,
              status: member.status,
              updatedAt: member.updatedAt,
              passwordHash: member.passwordHash,
            },
          });
        }
      });

      this.log.info(
        { organizationId: organization.id, memberCount: members.length },
        'Organization aggregate saved'
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to save organization aggregate');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Delete organization
   */
  async delete(organizationId: string): Promise<void> {
    try {
      await prisma.organization.delete({
        where: { id: organizationId },
      });

      this.log.info({ organizationId }, 'Organization deleted');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to delete organization');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Check if name exists
   */
  async nameExists(name: string): Promise<boolean> {
    try {
      const count = await prisma.organization.count({
        where: { name },
      });

      return count > 0;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to check name existence');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Find organization aggregate (org + members)
   */
  async findAggregateById(organizationId: string): Promise<OrganizationAggregate | null> {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
      });

      // Fetch members separately
      const members = await prisma.user.findMany({
        where: { organizationId },
      });

      if (!org) {
        return null;
      }

      // Reconstitute organization
      const orgEntity = OrganizationEntity.reconstitute({
        id: org.id,
        name: org.name,
        tier: org.tier,
        status: normalizeOrganizationStatus(org.status),
        statusReason: getStatusReason(org),
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
        memberCount: members.length,
      });

      // Reconstitute members
      const memberEntities = members.map((member) =>
        UserEntity.reconstitute({
          id: member.id,
          email: member.email,
          name: member.name || member.email.split('@')[0],
          role: member.role,
          status: member.status,
          organizationId: member.organizationId,
          createdAt: member.createdAt,
          updatedAt: member.updatedAt,
          passwordHash: member.passwordHash,
        })
      );

      return OrganizationAggregate.reconstitute(orgEntity, memberEntities);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to find organization aggregate');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Get organization count by tier
   */
  async countByTier(): Promise<Record<string, number>> {
    try {
      const counts = await prisma.organization.groupBy({
        by: ['tier'],
        _count: true,
      });

      const result: Record<string, number> = {};
      for (const item of counts) {
        result[item.tier] = item._count;
      }

      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage }, 'Failed to count by tier');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
