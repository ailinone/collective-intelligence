// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Update Project Handler
 * Application Layer: CQRS Command Handler
 *
 * Permission model: admin OR creator can update. RBAC role check
 * (admin/owner) happens upstream in route preHandler; this handler
 * additionally allows creator (since they may be a regular member).
 *
 * Slug is immutable post-create (URL stability) — even update commands
 * silently ignore any slug field. To "rename URL", create a new project.
 */

import { injectable, inject } from 'tsyringe';
import { UpdateProjectCommand } from '../commands/update-project.command';
import { IProjectRepository } from '@/domain/repositories/iproject-repository';
import { ProjectEntity } from '@/domain/entities/project.entity';

export interface UpdateProjectResult {
  success: boolean;
  project?: ReturnType<ProjectEntity['toDTO']>;
  error?: string;
  errorCode?: 'not_found' | 'forbidden' | 'invalid_payload' | 'unknown';
}

@injectable()
export class UpdateProjectHandler {
  constructor(
    @inject('IProjectRepository')
    private readonly projectRepository: IProjectRepository
  ) {}

  async execute(command: UpdateProjectCommand): Promise<UpdateProjectResult> {
    try {
      const project = await this.projectRepository.findById(command.projectId);
      if (!project) {
        return {
          success: false,
          error: 'project not found',
          errorCode: 'not_found',
        };
      }

      // Tenancy isolation: never touch a project from another org.
      if (project.organizationId !== command.requesterOrganizationId) {
        return {
          success: false,
          error: 'project not found',
          errorCode: 'not_found',
        };
      }

      // Apply updates. Entity invariants enforce length caps + throw on bad input.
      try {
        if (command.name !== undefined) {
          project.rename(command.name);
        }
        if (command.description !== undefined) {
          project.setDescription(command.description);
        }
        if (command.settings !== undefined) {
          project.mergeSettings(command.settings);
        }
      } catch (entityError: unknown) {
        const message =
          entityError instanceof Error ? entityError.message : String(entityError);
        return {
          success: false,
          error: message,
          errorCode: 'invalid_payload',
        };
      }

      await this.projectRepository.save(project);

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
