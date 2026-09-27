// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Authorization tests for Update/Archive/Restore project handlers.
 *
 * SECURITY: PATCH /v1/projects/:idOrSlug and its /archive + /restore siblings
 * are documented (projects-routes-clean.ts header, this handler's own header)
 * as "admin OR creator" — but the check was never actually wired up: any
 * authenticated member of the org could mutate a project created by someone
 * else. These tests pin the fix: a non-admin, non-creator member is rejected
 * with 'forbidden', while the creator and an admin are both still allowed.
 *
 * Uses a hand-rolled mock IProjectRepository (no DB/testcontainers), mirroring
 * the pattern in register-user-handler-authz.test.ts — these handlers have no
 * other dependencies worth a real Postgres for.
 */

import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

import { UpdateProjectHandler } from '../update-project.handler';
import { ArchiveProjectHandler, RestoreProjectHandler } from '../archive-project.handler';
import { UpdateProjectCommand } from '../../commands/update-project.command';
import { ArchiveProjectCommand, RestoreProjectCommand } from '../../commands/archive-project.command';
import { ProjectEntity, ProjectStatus } from '@/domain/entities/project.entity';
import type { IProjectRepository } from '@/domain/repositories/iproject-repository';

const ORG_ID = 'org-1';
const CREATOR_ID = 'user-creator';
const OTHER_MEMBER_ID = 'user-other-member';
const ADMIN_ID = 'user-admin';

function makeProject(overrides: { status?: ProjectStatus } = {}): ProjectEntity {
  const project = ProjectEntity.create({
    organizationId: ORG_ID,
    name: 'Customer Portal',
    slug: 'customer-portal',
    createdBy: CREATOR_ID,
  });
  if (overrides.status === ProjectStatus.ARCHIVED) {
    project.archive();
  }
  return project;
}

function makeRepository(project: ProjectEntity): IProjectRepository {
  return {
    findById: vi.fn(async () => project),
    findBySlug: vi.fn(async () => project),
    findAll: vi.fn(async () => [project]),
    countByOrganization: vi.fn(async () => 1),
    save: vi.fn(async () => undefined),
    slugExists: vi.fn(async () => true),
  };
}

describe('UpdateProjectHandler authorization (admin OR creator)', () => {
  it('rejects a member who is neither the creator nor an admin', async () => {
    const project = makeProject();
    const repo = makeRepository(project);
    const handler = new UpdateProjectHandler(repo);

    const result = await handler.execute(
      new UpdateProjectCommand(project.id, OTHER_MEMBER_ID, ORG_ID, 'New Name')
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('forbidden');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('allows the creator to update their own project', async () => {
    const project = makeProject();
    const repo = makeRepository(project);
    const handler = new UpdateProjectHandler(repo);

    const result = await handler.execute(
      new UpdateProjectCommand(project.id, CREATOR_ID, ORG_ID, 'New Name')
    );

    expect(result.success).toBe(true);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('allows an admin to update a project they did not create', async () => {
    const project = makeProject();
    const repo = makeRepository(project);
    const handler = new UpdateProjectHandler(repo);

    const result = await handler.execute(
      new UpdateProjectCommand(project.id, ADMIN_ID, ORG_ID, 'New Name', undefined, undefined, true)
    );

    expect(result.success).toBe(true);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });
});

describe('ArchiveProjectHandler / RestoreProjectHandler authorization (admin OR creator)', () => {
  it('rejects a member who is neither the creator nor an admin from archiving', async () => {
    const project = makeProject();
    const repo = makeRepository(project);
    const handler = new ArchiveProjectHandler(repo);

    const result = await handler.execute(
      new ArchiveProjectCommand(project.id, OTHER_MEMBER_ID, ORG_ID)
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('forbidden');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('allows an admin to archive a project they did not create', async () => {
    const project = makeProject();
    const repo = makeRepository(project);
    const handler = new ArchiveProjectHandler(repo);

    const result = await handler.execute(
      new ArchiveProjectCommand(project.id, ADMIN_ID, ORG_ID, true)
    );

    expect(result.success).toBe(true);
  });

  it('rejects a member who is neither the creator nor an admin from restoring', async () => {
    const project = makeProject({ status: ProjectStatus.ARCHIVED });
    const repo = makeRepository(project);
    const handler = new RestoreProjectHandler(repo);

    const result = await handler.execute(
      new RestoreProjectCommand(project.id, OTHER_MEMBER_ID, ORG_ID)
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('forbidden');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('allows the creator to restore their own project', async () => {
    const project = makeProject({ status: ProjectStatus.ARCHIVED });
    const repo = makeRepository(project);
    const handler = new RestoreProjectHandler(repo);

    const result = await handler.execute(
      new RestoreProjectCommand(project.id, CREATOR_ID, ORG_ID)
    );

    expect(result.success).toBe(true);
  });
});
