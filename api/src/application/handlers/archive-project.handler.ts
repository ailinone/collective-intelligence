// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Archive / Restore Project Handlers
 * Application Layer: CQRS Command Handlers (paired)
 *
 * Archive is soft-delete (status='archived' + archivedAt). Restore is the
 * reverse. Hard delete is NOT exposed at this layer — admin-only flow lives
 * elsewhere (CWE-274: destructive ops shouldn't share the same authz
 * surface as routine operations).
 */

import { injectable, inject } from 'tsyringe';
import {
  ArchiveProjectCommand,
  RestoreProjectCommand,
} from '../commands/archive-project.command';
import { IProjectRepository } from '@/domain/repositories/iproject-repository';
import { ProjectEntity } from '@/domain/entities/project.entity';

export interface ArchiveProjectResult {
  success: boolean;
  project?: ReturnType<ProjectEntity['toDTO']>;
  error?: string;
  errorCode?: 'not_found' | 'forbidden' | 'invalid_state' | 'unknown';
}

@injectable()
export class ArchiveProjectHandler {
  constructor(
    @inject('IProjectRepository')
    private readonly projectRepository: IProjectRepository
  ) {}

  async execute(command: ArchiveProjectCommand): Promise<ArchiveProjectResult> {
    try {
      const project = await this.projectRepository.findById(command.projectId);
      if (!project || project.organizationId !== command.requesterOrganizationId) {
        return {
          success: false,
          error: 'project not found',
          errorCode: 'not_found',
        };
      }

      try {
        project.archive();
      } catch (e: unknown) {
        return {
          success: false,
          error: e instanceof Error ? e.message : String(e),
          errorCode: 'invalid_state',
        };
      }

      await this.projectRepository.save(project);
      return { success: true, project: project.toDTO() };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: 'unknown',
      };
    }
  }
}

@injectable()
export class RestoreProjectHandler {
  constructor(
    @inject('IProjectRepository')
    private readonly projectRepository: IProjectRepository
  ) {}

  async execute(command: RestoreProjectCommand): Promise<ArchiveProjectResult> {
    try {
      const project = await this.projectRepository.findById(command.projectId);
      if (!project || project.organizationId !== command.requesterOrganizationId) {
        return {
          success: false,
          error: 'project not found',
          errorCode: 'not_found',
        };
      }

      try {
        project.restore();
      } catch (e: unknown) {
        return {
          success: false,
          error: e instanceof Error ? e.message : String(e),
          errorCode: 'invalid_state',
        };
      }

      await this.projectRepository.save(project);
      return { success: true, project: project.toDTO() };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: 'unknown',
      };
    }
  }
}
