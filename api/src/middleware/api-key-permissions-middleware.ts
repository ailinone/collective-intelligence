// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * API Key Permissions Middleware
 * 
 * Validates API key permissions before allowing access to protected routes
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'api-key-permissions' });

/**
 * Check if API key has required permission
 */
function hasPermission(
  permissions: Record<string, unknown> | null | undefined,
  requiredPermission: string
): boolean {
  if (!permissions || typeof permissions !== 'object') {
    return true; // No restrictions if permissions not set
  }

  // Check if permission is explicitly denied
  if (permissions[requiredPermission] === false) {
    return false;
  }

  // Check if permission is explicitly allowed
  if (permissions[requiredPermission] === true) {
    return true;
  }

  // Check for write permission (required for POST, PUT, PATCH, DELETE)
  if (requiredPermission === 'write' && permissions.write === false) {
    return false;
  }

  // Check for admin permission
  if (requiredPermission === 'admin' && permissions.admin === false) {
    return false;
  }

  // Default: allow if not explicitly denied
  return true;
}

/**
 * Require API key permission
 */
export function requireApiKeyPermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const extendedRequest = request as ExtendedFastifyRequest;
    const apiKey = extendedRequest.apiKey;

    // If no API key is used (JWT auth), skip permission check
    if (!apiKey) {
      return;
    }

    // Check permission
    if (!hasPermission(apiKey.permissions, permission)) {
      log.warn(
        {
          apiKeyId: apiKey.id,
          permission,
          method: request.method,
          url: request.url,
        },
        'API key permission denied'
      );

      return reply.code(403).send({
        error: 'Forbidden',
        message: `API key does not have required permission: ${permission}`,
      });
    }
  };
}

/**
 * Check if request method requires write permission
 */
function requiresWritePermission(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}

/**
 * Middleware to check API key permissions based on HTTP method
 */
export async function checkApiKeyPermissions(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // If reply was already sent by a previous middleware (e.g., requireRole), stop here
  if (reply.sent) {
    return;
  }
  
  const extendedRequest = request as ExtendedFastifyRequest;
  const apiKey = extendedRequest.apiKey;

  // If no API key is used (JWT auth), skip permission check
  if (!apiKey || !apiKey.permissions) {
    return;
  }

  const method = request.method;
  const permissions = apiKey.permissions;

  // Check write permission for write methods
  if (requiresWritePermission(method)) {
    if (permissions.write === false) {
      log.warn(
        {
          apiKeyId: apiKey.id,
          method,
          url: request.url,
        },
        'API key write permission denied'
      );

      return reply.code(403).send({
        error: 'Forbidden',
        message: 'API key does not have write permission',
      });
    }
  }

  // Check admin permission for admin endpoints
  if (request.url.startsWith('/v1/admin/')) {
    if (permissions.admin === false) {
      log.warn(
        {
          apiKeyId: apiKey.id,
          method,
          url: request.url,
        },
        'API key admin permission denied'
      );

      return reply.code(403).send({
        error: 'Forbidden',
        message: 'API key does not have admin permission',
      });
    }
  }
}

