// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@/database/client';
import { getTierConfig } from '@/config/multi-tenancy-config';
import { getUserRoles } from '@/services/rbac-service';
import { recordSecurityEvent } from '@/services/security-audit-service';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { getHeaderString } from '@/utils/type-guards';

export interface TenantContext {
  organizationId: string;
  userId: string;
  tier: string;
  roles: string[];
  features?: Record<string, boolean>;
  quotas?: {
    requestsPerMinute: number;
    requestsPerHour: number;
    concurrentRequests: number;
  };
}

type CustomUser = {
  userId: string;
  organizationId: string;
  roles: string[];
  tier?: string;
};

const PUBLIC_ROUTE_PREFIXES = ['/v1/auth/', '/v1/health', '/metrics', '/docs', '/documentation'];

function isCustomUser(user: unknown): user is CustomUser {
  if (!user || typeof user !== 'object') return false;
  const candidate = user as Record<string, unknown>;
  return (
    typeof candidate.userId === 'string' &&
    typeof candidate.organizationId === 'string' &&
    Array.isArray(candidate.roles)
  );
}

function isTenantOptionalRoute(rawUrl: string): boolean {
  const url = rawUrl.split('?')[0] ?? rawUrl;
  if (url === '/v1/models' || url.startsWith('/v1/models/')) return true;
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function defaultTierPayload(tier: string): Pick<TenantContext, 'features' | 'quotas'> {
  try {
    const tierConfig = getTierConfig(tier);
    return {
      features: tierConfig.features ?? {},
      quotas: {
        requestsPerMinute: tierConfig.requestsPerMinute ?? 60,
        requestsPerHour: tierConfig.requestsPerHour ?? 600,
        concurrentRequests: tierConfig.concurrentRequests ?? 5,
      },
    };
  } catch {
    return {
      features: {},
      quotas: {
        requestsPerMinute: 60,
        requestsPerHour: 600,
        concurrentRequests: 5,
      },
    };
  }
}

function deriveUserId(request: ExtendedFastifyRequest): string {
  const headerUserId = getHeaderString(request.headers, 'x-user-id');
  if (headerUserId) return headerUserId;

  if (typeof request.userId === 'string' && request.userId.length > 0) {
    return request.userId;
  }

  if (isCustomUser(request.user)) {
    return request.user.userId;
  }

  return 'anonymous';
}

function deriveOrganizationId(request: ExtendedFastifyRequest): string | null {
  const headerOrgId = getHeaderString(request.headers, 'x-organization-id');
  if (headerOrgId) return headerOrgId;

  if (typeof request.organizationId === 'string' && request.organizationId.length > 0) {
    return request.organizationId;
  }

  if (isCustomUser(request.user) && request.user.organizationId) {
    return request.user.organizationId;
  }

  return null;
}

export async function tenantIsolationMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const extendedRequest = request as ExtendedFastifyRequest;

  if (extendedRequest.tenantContext?.organizationId) {
    return;
  }

  if (isTenantOptionalRoute(request.url)) {
    return;
  }

  const organizationId = deriveOrganizationId(extendedRequest);
  const userId = deriveUserId(extendedRequest);

  if (!organizationId) {
    reply.status(401).send({
      error: {
        code: 'organization_required',
        message: 'Organization context is required.',
      },
    });
    return;
  }

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { tier: true },
  });

  if (!organization) {
    await recordSecurityEvent({
      eventType: 'tenant_context_invalid',
      severity: 'warning',
      message: 'Tenant organization not found for request context.',
      organizationId: undefined,
      userId: userId !== 'anonymous' ? userId : undefined,
      metadata: {
        attemptedOrganizationId: organizationId,
        route: request.url,
        method: request.method,
      },
    });

    reply.status(404).send({
      error: {
        code: 'organization_not_found',
        message: 'Organization not found.',
      },
    });
    return;
  }

  let roles: string[] = [];
  if (userId !== 'anonymous') {
    try {
      roles = await getUserRoles(userId, organizationId);
    } catch {
      // Ignore RBAC lookup failures and keep fallback roles.
    }
  }

  if (roles.length === 0 && isCustomUser(extendedRequest.user)) {
    roles = extendedRequest.user.roles;
  }

  if (roles.length === 0) {
    roles = ['viewer'];
  }

  const tier =
    organization.tier || (isCustomUser(extendedRequest.user) ? extendedRequest.user.tier : undefined) || 'free';
  const tierPayload = defaultTierPayload(tier);

  extendedRequest.tenantContext = {
    organizationId,
    userId,
    tier,
    roles,
    features: tierPayload.features,
    quotas: tierPayload.quotas,
  };
}

export function requireTenantContext(options: { requireUser?: boolean } = {}) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const extendedRequest = request as ExtendedFastifyRequest;

    if (!extendedRequest.tenantContext?.organizationId && isCustomUser(extendedRequest.user)) {
      const tierPayload = defaultTierPayload(extendedRequest.user.tier || 'free');
      extendedRequest.tenantContext = {
        organizationId: extendedRequest.user.organizationId,
        userId: extendedRequest.user.userId,
        tier: extendedRequest.user.tier || 'free',
        roles: extendedRequest.user.roles,
        features: tierPayload.features,
        quotas: tierPayload.quotas,
      };
    }

    if (!extendedRequest.tenantContext?.organizationId) {
      reply.status(403).send({
        error: {
          code: 'tenant_context_required',
          message: 'Organization context is required to access this resource.',
        },
      });
      return;
    }

    if (
      options.requireUser &&
      (!extendedRequest.tenantContext.userId || extendedRequest.tenantContext.userId === 'anonymous')
    ) {
      reply.status(401).send({
        error: {
          code: 'user_identity_required',
          message: 'User identity is required to access this resource.',
        },
      });
    }
  };
}

export function getTenantContext(
  request: FastifyRequest,
  _options?: { requireUser?: boolean }
): TenantContext {
  const extendedRequest = request as ExtendedFastifyRequest;

  if (extendedRequest.tenantContext?.organizationId) {
    return extendedRequest.tenantContext;
  }

  if (isCustomUser(extendedRequest.user)) {
    const tierPayload = defaultTierPayload(extendedRequest.user.tier || 'free');
    const derivedContext: TenantContext = {
      organizationId: extendedRequest.user.organizationId,
      userId: extendedRequest.user.userId,
      tier: extendedRequest.user.tier || 'free',
      roles: extendedRequest.user.roles,
      features: tierPayload.features,
      quotas: tierPayload.quotas,
    };
    extendedRequest.tenantContext = derivedContext;
    return derivedContext;
  }

  throw new Error('Tenant context missing; ensure requireTenantContext pre-handler is registered.');
}
