// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Project Routes — Clean Architecture (CQRS via DI)
 *
 * Endpoints:
 *   GET    /v1/projects                 List org's projects
 *   POST   /v1/projects                 Create project (any member)
 *   GET    /v1/projects/:idOrSlug       Get one (id or slug)
 *   PATCH  /v1/projects/:idOrSlug       Update name/description/settings
 *   POST   /v1/projects/:idOrSlug/archive    Soft-delete
 *   POST   /v1/projects/:idOrSlug/restore    Un-archive
 *
 * Permission model:
 *   - All endpoints require `authenticate` (JWT or ak_*)
 *   - Create/List/Get: any active member of the org
 *   - Update/Archive/Restore: admin OR creator (creator check in handler)
 *
 * Tenancy isolation: every operation reads/writes scoped to the caller's
 * organizationId — never accepts an arbitrary org_id from the body.
 */

import { FastifyInstance } from 'fastify';
import { container } from 'tsyringe';
import { authenticate } from '@/middleware/auth-middleware';
import { CreateProjectHandler } from '@/application/handlers/create-project.handler';
import { ListProjectsHandler } from '@/application/handlers/list-projects.handler';
import { GetProjectHandler } from '@/application/handlers/get-project.handler';
import { UpdateProjectHandler } from '@/application/handlers/update-project.handler';
import {
  ArchiveProjectHandler,
  RestoreProjectHandler,
} from '@/application/handlers/archive-project.handler';
import { CreateProjectCommand } from '@/application/commands/create-project.command';
import { ListProjectsQuery } from '@/application/queries/list-projects.query';
import { GetProjectQuery } from '@/application/queries/get-project.query';
import { UpdateProjectCommand } from '@/application/commands/update-project.command';
import {
  ArchiveProjectCommand,
  RestoreProjectCommand,
} from '@/application/commands/archive-project.command';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

interface AuthContext {
  userId: string;
  organizationId: string;
}

function extractAuthContext(request: unknown): AuthContext | null {
  const r = request as ExtendedFastifyRequest;
  if (
    !r.user ||
    typeof r.user !== 'object' ||
    !('userId' in r.user) ||
    !('organizationId' in r.user)
  ) {
    return null;
  }
  const userId = (r.user as { userId: unknown }).userId;
  const organizationId = (r.user as { organizationId: unknown }).organizationId;
  if (typeof userId !== 'string' || typeof organizationId !== 'string') {
    return null;
  }
  return { userId, organizationId };
}

export async function projectsRoutesClean(server: FastifyInstance): Promise<void> {
  const createHandler = container.resolve(CreateProjectHandler);
  const listHandler = container.resolve(ListProjectsHandler);
  const getHandler = container.resolve(GetProjectHandler);
  const updateHandler = container.resolve(UpdateProjectHandler);
  const archiveHandler = container.resolve(ArchiveProjectHandler);
  const restoreHandler = container.resolve(RestoreProjectHandler);

  // ─── GET /v1/projects ──────────────────────────────────────────────────
  server.get<{
    Querystring: {
      status?: 'active' | 'archived';
      limit?: number;
      offset?: number;
    };
  }>(
    '/v1/projects',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['Projects'],
        description: "List projects in the caller's organization",
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['active', 'archived'] },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 50 },
            offset: { type: 'number', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = extractAuthContext(request);
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      const { status, limit, offset } = request.query;
      const result = await listHandler.execute(
        new ListProjectsQuery(auth.organizationId, status, limit, offset)
      );
      if (!result.success) {
        return reply.status(500).send({ error: result.error });
      }
      return { projects: result.projects, total: result.total };
    }
  );

  // ─── POST /v1/projects ─────────────────────────────────────────────────
  server.post<{
    Body: {
      name: string;
      description?: string | null;
      settings?: Record<string, unknown>;
    };
  }>(
    '/v1/projects',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['Projects'],
        description: 'Create a project in the caller organization',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 100 },
            description: { type: 'string', maxLength: 1000, nullable: true },
            settings: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = extractAuthContext(request);
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      const { name, description, settings } = request.body ?? { name: '' };
      const result = await createHandler.execute(
        new CreateProjectCommand(
          auth.organizationId,
          auth.userId,
          name,
          description ?? null,
          settings
        )
      );
      if (!result.success) {
        if (result.errorCode === 'invalid_payload') {
          return reply.status(400).send({ error: result.error });
        }
        if (result.errorCode === 'slug_unavailable') {
          return reply.status(409).send({ error: result.error });
        }
        return reply.status(500).send({ error: result.error });
      }
      return reply.status(201).send({ project: result.project });
    }
  );

  // ─── GET /v1/projects/:idOrSlug ────────────────────────────────────────
  server.get<{
    Params: { idOrSlug: string };
  }>(
    '/v1/projects/:idOrSlug',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['Projects'],
        description: 'Get a project by id or slug (scoped to caller org)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['idOrSlug'],
          properties: { idOrSlug: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const auth = extractAuthContext(request);
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      const result = await getHandler.execute(
        new GetProjectQuery(auth.organizationId, request.params.idOrSlug)
      );
      if (!result.success) {
        if (result.errorCode === 'not_found') {
          return reply.status(404).send({ error: result.error });
        }
        return reply.status(500).send({ error: result.error });
      }
      return { project: result.project };
    }
  );

  // ─── PATCH /v1/projects/:idOrSlug ──────────────────────────────────────
  server.patch<{
    Params: { idOrSlug: string };
    Body: {
      name?: string;
      description?: string | null;
      settings?: Record<string, unknown>;
    };
  }>(
    '/v1/projects/:idOrSlug',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['Projects'],
        description: 'Update a project (name/description/settings)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['idOrSlug'],
          properties: { idOrSlug: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 100 },
            description: { type: 'string', maxLength: 1000, nullable: true },
            settings: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = extractAuthContext(request);
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      // PATCH accepts id-or-slug — resolve to a project first so we know id.
      const found = await getHandler.execute(
        new GetProjectQuery(auth.organizationId, request.params.idOrSlug)
      );
      if (!found.success || !found.project) {
        return reply.status(404).send({ error: 'project not found' });
      }

      const body = request.body ?? {};
      const result = await updateHandler.execute(
        new UpdateProjectCommand(
          found.project.id,
          auth.userId,
          auth.organizationId,
          body.name,
          body.description,
          body.settings
        )
      );
      if (!result.success) {
        if (result.errorCode === 'not_found') {
          return reply.status(404).send({ error: result.error });
        }
        if (result.errorCode === 'invalid_payload') {
          return reply.status(400).send({ error: result.error });
        }
        if (result.errorCode === 'forbidden') {
          return reply.status(403).send({ error: result.error });
        }
        return reply.status(500).send({ error: result.error });
      }
      return { project: result.project };
    }
  );

  // ─── POST /v1/projects/:idOrSlug/archive ───────────────────────────────
  server.post<{
    Params: { idOrSlug: string };
  }>(
    '/v1/projects/:idOrSlug/archive',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['Projects'],
        description: 'Archive a project (reversible soft-delete)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const auth = extractAuthContext(request);
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      const found = await getHandler.execute(
        new GetProjectQuery(auth.organizationId, request.params.idOrSlug)
      );
      if (!found.success || !found.project) {
        return reply.status(404).send({ error: 'project not found' });
      }
      const result = await archiveHandler.execute(
        new ArchiveProjectCommand(found.project.id, auth.userId, auth.organizationId)
      );
      if (!result.success) {
        if (result.errorCode === 'invalid_state') {
          return reply.status(409).send({ error: result.error });
        }
        if (result.errorCode === 'not_found') {
          return reply.status(404).send({ error: result.error });
        }
        return reply.status(500).send({ error: result.error });
      }
      return { project: result.project };
    }
  );

  // ─── POST /v1/projects/:idOrSlug/restore ───────────────────────────────
  server.post<{
    Params: { idOrSlug: string };
  }>(
    '/v1/projects/:idOrSlug/restore',
    {
      onRequest: [authenticate],
      schema: {
        tags: ['Projects'],
        description: 'Restore an archived project',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const auth = extractAuthContext(request);
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      const found = await getHandler.execute(
        new GetProjectQuery(auth.organizationId, request.params.idOrSlug)
      );
      if (!found.success || !found.project) {
        return reply.status(404).send({ error: 'project not found' });
      }
      const result = await restoreHandler.execute(
        new RestoreProjectCommand(found.project.id, auth.userId, auth.organizationId)
      );
      if (!result.success) {
        if (result.errorCode === 'invalid_state') {
          return reply.status(409).send({ error: result.error });
        }
        if (result.errorCode === 'not_found') {
          return reply.status(404).send({ error: result.error });
        }
        return reply.status(500).send({ error: result.error });
      }
      return { project: result.project };
    }
  );
}
