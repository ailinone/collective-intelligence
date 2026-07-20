// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration test — Project lifecycle end-to-end.
 *
 * Exercises the CQRS chain (handler → repository → Prisma → Postgres) against
 * the real DB. Proves:
 *   1. Full lifecycle: create → list → get → update → archive → restore
 *   2. Slug collision resolves via auto-suffix (-2, -3, ...)
 *   3. Tenancy isolation: project of Org A is invisible to Org B caller
 *   4. Invariants enforced at entity level surface as 'invalid_payload'
 *
 * Why integration (not unit):
 *   - The composite UNIQUE constraint `(organization_id, slug)` is a DB-level
 *     guarantee; only a real Postgres can prove collision-suffix correctness
 *   - The Prisma upsert mapping (settings JSONB, archivedAt nullable) has
 *     subtle nullability that only a live driver exercises
 *   - The repository's `findBySlug` uses the composite unique input —
 *     a typo in the field name would silently fail in mocked tests
 *
 * Cleanup: each test creates its own Organization row + scoped projects;
 * `afterAll` cascade-deletes via Organization (FK ON DELETE CASCADE).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/database/client';
import { ProjectEntity, ProjectStatus } from '@/domain/entities/project.entity';
import { PrismaProjectRepository } from '@/infrastructure/repositories/prisma-project-repository';

import { CreateProjectHandler } from '../create-project.handler';
import { ListProjectsHandler } from '../list-projects.handler';
import { GetProjectHandler } from '../get-project.handler';
import { UpdateProjectHandler } from '../update-project.handler';
import {
  ArchiveProjectHandler,
  RestoreProjectHandler,
} from '../archive-project.handler';

import { CreateProjectCommand } from '../../commands/create-project.command';
import { ListProjectsQuery } from '../../queries/list-projects.query';
import { GetProjectQuery } from '../../queries/get-project.query';
import { UpdateProjectCommand } from '../../commands/update-project.command';
import {
  ArchiveProjectCommand,
  RestoreProjectCommand,
} from '../../commands/archive-project.command';

describe('Project lifecycle (integration)', () => {
  const repo = new PrismaProjectRepository();
  const createH = new CreateProjectHandler(repo);
  const listH = new ListProjectsHandler(repo);
  const getH = new GetProjectHandler(repo);
  const updateH = new UpdateProjectHandler(repo);
  const archiveH = new ArchiveProjectHandler(repo);
  const restoreH = new RestoreProjectHandler(repo);

  // Two isolated orgs to prove tenancy boundaries.
  let orgAId: string;
  let orgBId: string;
  let orgAUserId: string;
  let orgBUserId: string;

  beforeAll(async () => {
    // Bootstrap two orgs + users. Use unique names to avoid collision with
    // anything else in the test DB.
    const suffix = randomUUID().slice(0, 8);

    const orgA = await prisma.organization.create({
      data: {
        name: `test-org-A-${suffix}`,
        slug: `test-org-a-${suffix}`,
        tier: 'free',
        status: 'active',
      },
    });
    orgAId = orgA.id;

    const orgB = await prisma.organization.create({
      data: {
        name: `test-org-B-${suffix}`,
        slug: `test-org-b-${suffix}`,
        tier: 'free',
        status: 'active',
      },
    });
    orgBId = orgB.id;

    const userA = await prisma.user.create({
      data: {
        email: `user-a-${suffix}@test.ailin.one`,
        name: `Test User A ${suffix}`,
        passwordHash: '$2b$10$test.hash.not.used.for.auth.in.this.test',
        organizationId: orgAId,
        role: 'admin',
        status: 'active',
      },
    });
    orgAUserId = userA.id;

    const userB = await prisma.user.create({
      data: {
        email: `user-b-${suffix}@test.ailin.one`,
        name: `Test User B ${suffix}`,
        passwordHash: '$2b$10$test.hash.not.used.for.auth.in.this.test',
        organizationId: orgBId,
        role: 'admin',
        status: 'active',
      },
    });
    orgBUserId = userB.id;
  }, 60_000);

  afterAll(async () => {
    // Cascade deletes projects + users via FK ON DELETE CASCADE.
    await prisma.organization.deleteMany({
      where: { id: { in: [orgAId, orgBId] } },
    });
  });

  it('full lifecycle: create → list → get-by-slug → get-by-id → update → archive → restore', async () => {
    // 1. CREATE
    const created = await createH.execute(
      new CreateProjectCommand(
        orgAId,
        orgAUserId,
        'Customer Portal',
        'Initial description'
      )
    );
    expect(created.success).toBe(true);
    expect(created.project).toBeDefined();
    expect(created.project!.name).toBe('Customer Portal');
    expect(created.project!.slug).toBe('customer-portal');
    expect(created.project!.status).toBe(ProjectStatus.ACTIVE);
    expect(created.project!.description).toBe('Initial description');
    expect(created.project!.archivedAt).toBeNull();
    const projectId = created.project!.id;

    // 2. LIST — should include our project
    const listed = await listH.execute(new ListProjectsQuery(orgAId, 'active'));
    expect(listed.success).toBe(true);
    expect(listed.projects!.some((p) => p.id === projectId)).toBe(true);
    expect(listed.total).toBeGreaterThanOrEqual(1);

    // 3. GET BY SLUG
    const bySlug = await getH.execute(
      new GetProjectQuery(orgAId, 'customer-portal')
    );
    expect(bySlug.success).toBe(true);
    expect(bySlug.project!.id).toBe(projectId);

    // 4. GET BY ID (UUID format detected by handler)
    const byId = await getH.execute(new GetProjectQuery(orgAId, projectId));
    expect(byId.success).toBe(true);
    expect(byId.project!.slug).toBe('customer-portal');

    // 5. UPDATE name + description
    const updated = await updateH.execute(
      new UpdateProjectCommand(
        projectId,
        orgAUserId,
        orgAId,
        'Customer Portal V2',
        'Updated description'
      )
    );
    expect(updated.success).toBe(true);
    expect(updated.project!.name).toBe('Customer Portal V2');
    expect(updated.project!.description).toBe('Updated description');
    expect(updated.project!.slug).toBe('customer-portal'); // slug immutable

    // 6. ARCHIVE
    const archived = await archiveH.execute(
      new ArchiveProjectCommand(projectId, orgAUserId, orgAId)
    );
    expect(archived.success).toBe(true);
    expect(archived.project!.status).toBe(ProjectStatus.ARCHIVED);
    expect(archived.project!.archivedAt).not.toBeNull();

    // 6a. List active → should NOT find it now
    const listedAfterArchive = await listH.execute(
      new ListProjectsQuery(orgAId, 'active')
    );
    expect(
      listedAfterArchive.projects!.find((p) => p.id === projectId)
    ).toBeUndefined();

    // 6b. List archived → should find it
    const listedArchived = await listH.execute(
      new ListProjectsQuery(orgAId, 'archived')
    );
    expect(
      listedArchived.projects!.find((p) => p.id === projectId)
    ).toBeDefined();

    // 7. RESTORE
    const restored = await restoreH.execute(
      new RestoreProjectCommand(projectId, orgAUserId, orgAId)
    );
    expect(restored.success).toBe(true);
    expect(restored.project!.status).toBe(ProjectStatus.ACTIVE);
    expect(restored.project!.archivedAt).toBeNull();
  });

  it('slug collision auto-suffix: second project with same name gets "-2", third gets "-3"', async () => {
    const r1 = await createH.execute(
      new CreateProjectCommand(orgAId, orgAUserId, 'Twin App')
    );
    expect(r1.success).toBe(true);
    expect(r1.project!.slug).toBe('twin-app');

    const r2 = await createH.execute(
      new CreateProjectCommand(orgAId, orgAUserId, 'Twin App')
    );
    expect(r2.success).toBe(true);
    expect(r2.project!.slug).toBe('twin-app-2');

    const r3 = await createH.execute(
      new CreateProjectCommand(orgAId, orgAUserId, 'Twin App')
    );
    expect(r3.success).toBe(true);
    expect(r3.project!.slug).toBe('twin-app-3');
  });

  it('tenancy isolation: project of Org A is not retrievable by Org B caller', async () => {
    // Create in Org A
    const created = await createH.execute(
      new CreateProjectCommand(orgAId, orgAUserId, 'A-Only Project')
    );
    expect(created.success).toBe(true);
    const projectId = created.project!.id;
    const projectSlug = created.project!.slug;

    // Try to read via Org B caller — must return 404 (not 403, to avoid info leak)
    const tryById = await getH.execute(new GetProjectQuery(orgBId, projectId));
    expect(tryById.success).toBe(false);
    expect(tryById.errorCode).toBe('not_found');

    const tryBySlug = await getH.execute(
      new GetProjectQuery(orgBId, projectSlug)
    );
    expect(tryBySlug.success).toBe(false);
    expect(tryBySlug.errorCode).toBe('not_found');

    // List of Org B must not contain Org A's project
    const orgBList = await listH.execute(new ListProjectsQuery(orgBId));
    expect(orgBList.projects!.find((p) => p.id === projectId)).toBeUndefined();
  });

  it('invariant violation: empty name → invalid_payload (not 500)', async () => {
    const r = await createH.execute(
      new CreateProjectCommand(orgAId, orgAUserId, '')
    );
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('invalid_payload');
  });

  it('invariant violation: name producing empty slug → invalid_payload', async () => {
    // Pure non-alphanumeric collapses to nothing after slugify
    const r = await createH.execute(
      new CreateProjectCommand(orgAId, orgAUserId, '---')
    );
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('invalid_payload');
  });

  it('archive idempotency guard: archiving an already-archived project → invalid_state', async () => {
    const created = await createH.execute(
      new CreateProjectCommand(orgAId, orgAUserId, 'Double Archive Test')
    );
    expect(created.success).toBe(true);
    const projectId = created.project!.id;

    const first = await archiveH.execute(
      new ArchiveProjectCommand(projectId, orgAUserId, orgAId)
    );
    expect(first.success).toBe(true);

    const second = await archiveH.execute(
      new ArchiveProjectCommand(projectId, orgAUserId, orgAId)
    );
    expect(second.success).toBe(false);
    expect(second.errorCode).toBe('invalid_state');
  });
});
