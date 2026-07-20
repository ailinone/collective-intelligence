// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * IProjectRepository Interface
 *
 * Repository contract for Project persistence.
 * DDD Pattern: Repository Interface (Domain Layer).
 */

import { ProjectEntity } from '../entities/project.entity';

export interface ListProjectsOptions {
  organizationId: string;
  status?: 'active' | 'archived';
  limit?: number;
  offset?: number;
}

export interface IProjectRepository {
  /**
   * Find a project by its UUID. Returns null if not found OR if it belongs
   * to a different org than the caller (tenancy isolation enforced upstream).
   */
  findById(projectId: string): Promise<ProjectEntity | null>;

  /**
   * Find a project by (organizationId, slug). Returns null if not found.
   * The unique constraint guarantees at most one match.
   */
  findBySlug(
    organizationId: string,
    slug: string
  ): Promise<ProjectEntity | null>;

  /**
   * List projects for an organization. Default: active only, newest first.
   */
  findAll(options: ListProjectsOptions): Promise<ProjectEntity[]>;

  /**
   * Count projects for an org (used for tier-limit checks if needed later).
   */
  countByOrganization(
    organizationId: string,
    status?: 'active' | 'archived'
  ): Promise<number>;

  /**
   * Persist a project — INSERT on first save, UPDATE on subsequent saves.
   * Upsert semantics keyed by `id`. Concurrent updates are last-write-wins
   * at the repository level; callers needing optimistic concurrency must
   * implement it on top (not required for v1).
   */
  save(project: ProjectEntity): Promise<void>;

  /**
   * Check whether a slug is already taken within an organization.
   * Used at create-time for collision detection.
   */
  slugExists(organizationId: string, slug: string): Promise<boolean>;
}
