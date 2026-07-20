// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Get Project Handler
 * Application Layer: CQRS Query Handler
 *
 * Accepts either UUID or slug. UUID format is detected; anything else
 * is treated as slug. This lets routes use /v1/projects/:idOrSlug
 * uniformly without forcing the caller to know which they have.
 */

import { injectable, inject } from 'tsyringe';
import { GetProjectQuery } from '../queries/get-project.query';
import { IProjectRepository } from '@/domain/repositories/iproject-repository';
import { ProjectEntity } from '@/domain/entities/project.entity';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GetProjectResult {
  success: boolean;
  project?: ReturnType<ProjectEntity['toDTO']>;
  error?: string;
  errorCode?: 'not_found' | 'forbidden' | 'unknown';
}

@injectable()
export class GetProjectHandler {
  constructor(
    @inject('IProjectRepository')
    private readonly projectRepository: IProjectRepository
  ) {}

  async execute(query: GetProjectQuery): Promise<GetProjectResult> {
    try {
      const looksLikeUuid = UUID_REGEX.test(query.idOrSlug);

      const project = looksLikeUuid
        ? await this.projectRepository.findById(query.idOrSlug)
        : await this.projectRepository.findBySlug(
            query.organizationId,
            query.idOrSlug
          );

      if (!project) {
        return {
          success: false,
          error: 'project not found',
          errorCode: 'not_found',
        };
      }

      // Tenancy isolation: even if found by UUID (skipping the slug index
      // which already filters by org), enforce org match here.
      if (project.organizationId !== query.organizationId) {
        return {
          success: false,
          error: 'project not found',
          errorCode: 'not_found', // intentionally not 'forbidden' — don't leak existence
        };
      }

      return {
        success: true,
        project: project.toDTO(),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
        errorCode: 'unknown',
      };
    }
  }
}
