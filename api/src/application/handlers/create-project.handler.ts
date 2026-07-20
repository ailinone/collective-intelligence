// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Create Project Handler
 * Application Layer: CQRS Command Handler
 *
 * Responsibilities:
 *   - Validate input (name required, length caps via entity invariants)
 *   - Derive slug from name (deterministic; collision-resolved by suffix)
 *   - Construct ProjectEntity (entity enforces invariants)
 *   - Persist via repository
 *
 * Permission model: any authenticated member of the org can create
 * projects. RBAC gate (member+ role) is enforced upstream in the
 * Fastify preHandler — not duplicated here, keeping handler pure.
 */

import { injectable, inject } from 'tsyringe';
import { CreateProjectCommand } from '../commands/create-project.command';
import {
  IProjectRepository,
} from '@/domain/repositories/iproject-repository';
import { ProjectEntity } from '@/domain/entities/project.entity';

const MAX_SLUG_COLLISION_ATTEMPTS = 50;

/**
 * Slugify rule:
 *   - lowercase, ASCII-safe
 *   - non-alphanumeric collapsed to single dash
 *   - trim leading/trailing dashes
 *   - cap at 60 chars (leave room for `-N` collision suffix → 64 total)
 *
 * Diacritic-stripping intentionally omitted: predictability over coverage.
 * The entity's regex (SLUG_PATTERN) will reject anything left invalid.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks (basic accent removal)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
}

export interface CreateProjectResult {
  success: boolean;
  project?: ReturnType<ProjectEntity['toDTO']>;
  error?: string;
  errorCode?: 'invalid_payload' | 'slug_unavailable' | 'unknown';
}

@injectable()
export class CreateProjectHandler {
  constructor(
    @inject('IProjectRepository')
    private readonly projectRepository: IProjectRepository
  ) {}

  async execute(command: CreateProjectCommand): Promise<CreateProjectResult> {
    try {
      // Light input gate — entity will re-validate more strictly. We surface
      // the error here as 400 (vs throwing from entity = 500).
      if (!command.name || command.name.trim().length < 2) {
        return {
          success: false,
          error: 'name must be at least 2 characters',
          errorCode: 'invalid_payload',
        };
      }

      // Slug collision resolution: try base slug, then base-2, base-3, ...
      // Cap at MAX_SLUG_COLLISION_ATTEMPTS to prevent pathological loop.
      const baseSlug = slugify(command.name);
      if (!baseSlug || baseSlug.length < 2) {
        return {
          success: false,
          error: 'name produces an empty or invalid slug',
          errorCode: 'invalid_payload',
        };
      }

      let candidateSlug = baseSlug;
      for (let attempt = 1; attempt <= MAX_SLUG_COLLISION_ATTEMPTS; attempt++) {
        const taken = await this.projectRepository.slugExists(
          command.organizationId,
          candidateSlug
        );
        if (!taken) break;
        // Truncate base to leave room for suffix
        const suffix = `-${attempt + 1}`;
        const truncatedBase = baseSlug.slice(0, 64 - suffix.length);
        candidateSlug = `${truncatedBase}${suffix}`;
        if (attempt === MAX_SLUG_COLLISION_ATTEMPTS) {
          return {
            success: false,
            error: 'could not find an available slug after multiple attempts',
            errorCode: 'slug_unavailable',
          };
        }
      }

      const project = ProjectEntity.create({
        organizationId: command.organizationId,
        name: command.name,
        slug: candidateSlug,
        description: command.description ?? null,
        settings: command.settings,
        createdBy: command.createdByUserId,
      });

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
