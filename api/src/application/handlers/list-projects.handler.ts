// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * List Projects Handler
 * Application Layer: CQRS Query Handler
 *
 * Always scoped to the caller's organizationId — no cross-tenant reads.
 * The route handler's `authenticate` middleware sets the org context.
 */

import { injectable, inject } from 'tsyringe';
import { ListProjectsQuery } from '../queries/list-projects.query';
import { IProjectRepository } from '@/domain/repositories/iproject-repository';
import { ProjectEntity } from '@/domain/entities/project.entity';

export interface ListProjectsResult {
  success: boolean;
  projects?: Array<ReturnType<ProjectEntity['toDTO']>>;
  total?: number;
  error?: string;
}

@injectable()
export class ListProjectsHandler {
  constructor(
    @inject('IProjectRepository')
    private readonly projectRepository: IProjectRepository
  ) {}

  async execute(query: ListProjectsQuery): Promise<ListProjectsResult> {
    try {
      const [projects, total] = await Promise.all([
        this.projectRepository.findAll({
          organizationId: query.organizationId,
          status: query.status,
          limit: query.limit,
          offset: query.offset,
        }),
        this.projectRepository.countByOrganization(
          query.organizationId,
          query.status
        ),
      ]);

      return {
        success: true,
        projects: projects.map((p) => p.toDTO()),
        total,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
