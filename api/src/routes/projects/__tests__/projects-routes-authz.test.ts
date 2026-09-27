// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Route-level authorization tests for the project mutation endpoints.
 *
 * project-authorization.test.ts pins the handler rule (admin OR creator) with
 * an explicit `requesterIsAdmin` flag. This suite pins the WIRING: that
 * PATCH /archive /restore derive `isAdmin` from the caller's `roles: string[]`
 * claims (never the scalar `role` hint), pass it to the handler, and map the
 * handler's 'forbidden' to a 403 instead of a 500.
 */
import 'reflect-metadata';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { container } from 'tsyringe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectEntity } from '@/domain/entities/project.entity';
import type { IProjectRepository } from '@/domain/repositories/iproject-repository';

const ORG_ID = 'org-1';
const CREATOR_ID = 'user-creator';

vi.mock('@/middleware/auth-middleware', () => ({
  authenticate: vi.fn(async (request: FastifyRequest) => {
    const raw = request.headers['x-test-user'];
    (request as unknown as { user: unknown }).user = JSON.parse(String(raw));
  }),
}));

vi.mock('@/api/middleware/route-rate-limit', () => ({
  createRouteRateLimit: () => async () => {
    // no-op: rate limiting isn't under test here
  },
}));

function asHeader(user: Record<string, unknown>): Record<string, string> {
  return { 'x-test-user': JSON.stringify({ organizationId: ORG_ID, ...user }) };
}

describe('projects-routes-clean: admin OR creator on mutation routes', () => {
  let server: FastifyInstance;
  let project: ProjectEntity;
  let repo: IProjectRepository;

  beforeEach(async () => {
    project = ProjectEntity.create({
      organizationId: ORG_ID,
      name: 'Customer Portal',
      slug: 'customer-portal',
      createdBy: CREATOR_ID,
    });
    repo = {
      findById: vi.fn(async () => project),
      findBySlug: vi.fn(async () => project),
      findAll: vi.fn(async () => [project]),
      countByOrganization: vi.fn(async () => 1),
      save: vi.fn(async () => undefined),
      slugExists: vi.fn(async () => true),
    };
    container.registerInstance<IProjectRepository>('IProjectRepository', repo);

    server = Fastify();
    const { projectsRoutesClean } = await import('@/routes/projects/projects-routes-clean');
    await projectsRoutesClean(server);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    container.clearInstances();
  });

  it('403s a member who is neither creator nor admin (PATCH, archive)', async () => {
    const member = asHeader({ userId: 'user-other', roles: ['member'] });

    const patch = await server.inject({
      method: 'PATCH',
      url: '/v1/projects/customer-portal',
      headers: member,
      payload: { name: 'Hijacked' },
    });
    expect(patch.statusCode).toBe(403);

    const archive = await server.inject({
      method: 'POST',
      url: '/v1/projects/customer-portal/archive',
      headers: member,
    });
    expect(archive.statusCode).toBe(403);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('403s restore by a non-creator member', async () => {
    project.archive();
    const restore = await server.inject({
      method: 'POST',
      url: '/v1/projects/customer-portal/restore',
      headers: asHeader({ userId: 'user-other', roles: ['member'] }),
    });
    expect(restore.statusCode).toBe(403);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('does not honour a scalar `role: admin` hint without the roles[] grant', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/v1/projects/customer-portal',
      headers: asHeader({ userId: 'user-other', role: 'admin', roles: ['member'] }),
      payload: { name: 'Hijacked' },
    });
    expect(res.statusCode).toBe(403);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('lets an admin (roles[]) update and archive a project they did not create', async () => {
    const admin = asHeader({ userId: 'user-admin', roles: ['admin'] });

    const patch = await server.inject({
      method: 'PATCH',
      url: '/v1/projects/customer-portal',
      headers: admin,
      payload: { name: 'Renamed By Admin' },
    });
    expect(patch.statusCode).toBe(200);

    const archive = await server.inject({
      method: 'POST',
      url: '/v1/projects/customer-portal/archive',
      headers: admin,
    });
    expect(archive.statusCode).toBe(200);
  });

  it('lets the creator update their own project', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/v1/projects/customer-portal',
      headers: asHeader({ userId: CREATOR_ID, roles: ['member'] }),
      payload: { name: 'Renamed By Creator' },
    });
    expect(res.statusCode).toBe(200);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });
});
