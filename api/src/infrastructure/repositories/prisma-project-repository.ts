// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prisma Project Repository
 *
 * Infrastructure Layer: implements IProjectRepository against Prisma.
 * Maps domain ProjectEntity ↔ persistence rows.
 */

import { injectable } from 'tsyringe';
import {
  IProjectRepository,
  ListProjectsOptions,
} from '@/domain/repositories/iproject-repository';
import { ProjectEntity } from '@/domain/entities/project.entity';
import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

@injectable()
export class PrismaProjectRepository implements IProjectRepository {
  private log = logger.child({ component: 'prisma-project-repository' });

  async findById(projectId: string): Promise<ProjectEntity | null> {
    try {
      const row = await prisma.project.findUnique({
        where: { id: projectId },
      });
      if (!row) return null;
      return this.toEntity(row);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error({ error: errorMessage, projectId }, 'Failed to find project by id');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async findBySlug(
    organizationId: string,
    slug: string
  ): Promise<ProjectEntity | null> {
    try {
      const row = await prisma.project.findUnique({
        where: {
          organizationId_slug: {
            organizationId,
            slug,
          },
        },
      });
      if (!row) return null;
      return this.toEntity(row);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { error: errorMessage, organizationId, slug },
        'Failed to find project by slug'
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async findAll(options: ListProjectsOptions): Promise<ProjectEntity[]> {
    try {
      const rows = await prisma.project.findMany({
        where: {
          organizationId: options.organizationId,
          ...(options.status ? { status: options.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: options.limit ?? 50,
        skip: options.offset ?? 0,
      });
      return rows.map((r) => this.toEntity(r));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { error: errorMessage, options },
        'Failed to list projects'
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async countByOrganization(
    organizationId: string,
    status?: 'active' | 'archived'
  ): Promise<number> {
    try {
      return await prisma.project.count({
        where: {
          organizationId,
          ...(status ? { status } : {}),
        },
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { error: errorMessage, organizationId, status },
        'Failed to count projects'
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async save(project: ProjectEntity): Promise<void> {
    const data = project.toPersistence();
    try {
      // Upsert keyed by id. New projects → INSERT. Existing → UPDATE.
      // Settings is cast to Prisma.InputJsonValue for type-safety.
      await prisma.project.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          organizationId: data.organizationId,
          name: data.name,
          slug: data.slug,
          description: data.description,
          status: data.status,
          settings: data.settings as object,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          archivedAt: data.archivedAt,
          createdBy: data.createdBy,
        },
        update: {
          name: data.name,
          // slug is NOT updated — it's immutable post-create (URL stability)
          description: data.description,
          status: data.status,
          settings: data.settings as object,
          updatedAt: data.updatedAt,
          archivedAt: data.archivedAt,
        },
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { error: errorMessage, projectId: data.id, organizationId: data.organizationId },
        'Failed to save project'
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async slugExists(organizationId: string, slug: string): Promise<boolean> {
    try {
      const count = await prisma.project.count({
        where: { organizationId, slug },
      });
      return count > 0;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        { error: errorMessage, organizationId, slug },
        'Failed to check slug existence'
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Map Prisma row → domain entity.
   */
  private toEntity(row: {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    description: string | null;
    status: string;
    settings: unknown;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
    createdBy: string;
  }): ProjectEntity {
    // settings is JSONB — Prisma returns `unknown`. Defensive coerce.
    const settings =
      row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
        ? (row.settings as Record<string, unknown>)
        : {};
    return ProjectEntity.reconstitute({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      slug: row.slug,
      description: row.description,
      status: row.status,
      settings,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      createdBy: row.createdBy,
    });
  }
}
