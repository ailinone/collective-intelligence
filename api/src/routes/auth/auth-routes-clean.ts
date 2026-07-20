// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Auth Routes - Clean Architecture
 * Complete migration from auth-routes.ts
 * Uses CQRS Handlers via DI where available
 *
 * Routes:
 * ✅ POST /v1/auth/email-challenge → RequestEmailChallengeHandler (WORKING)
 * ✅ POST /v1/auth/register → RegisterUserHandler
 * ✅ POST /v1/auth/login → LoginUserHandler + LoginWithCodeHandler
 * ✅ POST /v1/auth/refresh → authService.refreshToken()
 * ✅ POST /v1/auth/api-keys → authService.generateApiKey() (requires auth)
 * ✅ DELETE /v1/auth/api-keys/:id → authService.revokeApiKey() (requires auth)
 *
 * Compatibility aliases:
 * POST /v1/auth/challenge uses the same handler as /v1/auth/email-challenge
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { container } from 'tsyringe';
import { LoginUserHandler } from '../../application/handlers/login-user.handler';
import { RegisterUserHandler } from '../../application/handlers/register-user.handler';
import { RequestEmailChallengeHandler } from '../../application/handlers/request-email-challenge.handler';
import { LoginWithCodeHandler } from '../../application/handlers/login-with-code.handler';
import { LoginUserCommand } from '../../application/commands/login-user.command';
import { RegisterUserCommand } from '../../application/commands/register-user.command';
import { RequestEmailChallengeCommand } from '../../application/commands/request-email-challenge.command';
import { LoginWithCodeCommand } from '../../application/commands/login-with-code.command';
import { initializeDIContainer } from '../../di/container';
import { getAuthService } from '../../services/auth-service';
import { authenticate } from '../../middleware/auth-middleware';
import { prisma } from '@/database/client';
import { getUserRoles } from '@/services/rbac-service';

/**
 * Convert expiresIn string (e.g., "24h", "7d", "60m") to seconds
 */
function parseExpiresIn(expiresIn: string | number | undefined): number {
  if (typeof expiresIn === 'number') {
    return expiresIn;
  }
  if (!expiresIn || typeof expiresIn !== 'string') {
    return 86400; // Default 24 hours
  }
  
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) {
    // Try to parse as pure number
    const num = parseInt(expiresIn, 10);
    return isNaN(num) ? 86400 : num;
  }
  
  const value = parseInt(match[1], 10);
  const unit = match[2];
  
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 86400;
  }
}

function getJsonBodyObject(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

export async function authRoutesClean(server: FastifyInstance): Promise<void> {
  // Initialize DI container for Clean Architecture
  initializeDIContainer();

  // Get handlers from DI container
  const loginHandler = container.resolve(LoginUserHandler);
  const registerHandler = container.resolve(RegisterUserHandler);
  const requestChallengeHandler = container.resolve(RequestEmailChallengeHandler);
  const loginWithCodeHandler = container.resolve(LoginWithCodeHandler);

  // Get auth service for routes that don't have handlers yet
  const authService = getAuthService();

  const handleEmailChallenge = async (request: ExtendedFastifyRequest, reply: FastifyReply) => {
    try {
      const bodyObject = getJsonBodyObject(request.body);
      if (!bodyObject) {
        return reply.code(400).send({
          success: false,
          error: 'Invalid Request',
          message: 'Request body must be a JSON object',
        });
      }

      interface ChallengeRequestBody {
        email?: string;
        organizationId?: string;
      }
      const body = bodyObject as ChallengeRequestBody;
      const email = body.email;
      const organizationId = body.organizationId;

      if (!email || typeof email !== 'string' || !email.includes('@')) {
        server.log.warn({ email }, 'Invalid email format in challenge request');
        return reply.code(400).send({
          success: false,
          error: 'Invalid email format',
        });
      }

      const command = new RequestEmailChallengeCommand(email, organizationId);
      const result = await requestChallengeHandler.execute(command);

      if (!result.success) {
        server.log.warn({ email, error: result.error }, 'Email challenge failed');
        const statusCode = typeof result.statusCode === 'number' ? result.statusCode : 400;
        return reply.code(statusCode).send({
          success: false,
          error: result.error || 'Failed to send verification code',
        });
      }

      return {
        success: true,
        loginMode: result.loginMode || 'email_code',
        challengeId: result.challengeId,
        expiresAt:
          result.expiresAt instanceof Date
            ? result.expiresAt.getTime()
            : typeof result.expiresAt === 'number'
              ? result.expiresAt
              : undefined,
        cooldownExpiresAt: result.cooldownExpiresAt,
        message: result.message || 'Verification code sent to your email',
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      server.log.error(
        { error: errorMessage, stack: errorStack },
        'Email challenge request error'
      );
      return reply.code(500).send({
        error: 'Internal server error',
      });
    }
  };

  /**
   * POST /v1/auth/challenge
   * Request email verification code
   */
  server.post('/v1/auth/challenge', handleEmailChallenge);

  /**
   * POST /v1/auth/email-challenge
   * Request email verification code (WORKING ROUTE)
   */
  server.post('/v1/auth/email-challenge', handleEmailChallenge);

  /**
   * POST /v1/auth/register
   * Register new user with email/password
   */
  server.post('/v1/auth/register', async (request, reply) => {
    try {
      const bodyObject = getJsonBodyObject(request.body);
      if (!bodyObject) {
        return reply.code(400).send({
          success: false,
          error: 'Invalid Request',
          message: 'Request body must be a JSON object',
        });
      }

      const body = bodyObject as {
        email?: string;
        password?: string;
        name?: string;
        organizationId?: string;
      };

      // Validate required fields
      if (!body.email || typeof body.email !== 'string') {
        return reply.code(400).send({
          success: false,
          error: 'Invalid Request',
          message: 'Email is required and must be a string',
        });
      }

      if (!body.password || typeof body.password !== 'string') {
        return reply.code(400).send({
          success: false,
          error: 'Invalid Request',
          message: 'Password is required and must be a string',
        });
      }

      if (!body.name || typeof body.name !== 'string') {
        return reply.code(400).send({
          success: false,
          error: 'Invalid Request',
          message: 'Name is required and must be a string',
        });
      }

      // Sanitize user input to prevent XSS attacks
      const { sanitizeHTML } = await import('@/utils/sanitizers');
      const sanitizedName = sanitizeHTML(body.name);

      const command = new RegisterUserCommand(
        body.email,
        body.password,
        sanitizedName,
        undefined, // organizationName (optional)
        body.organizationId
      );
      const result = await registerHandler.execute(command);

      if (!result.success) {
        // Check if error is about duplicate email
        const isDuplicateEmail = result.error?.toLowerCase().includes('already') || 
                                  result.error?.toLowerCase().includes('duplicate') ||
                                  result.error?.toLowerCase().includes('registered');
        
        // Check if error is about password
        const isPasswordError = result.error?.toLowerCase().includes('password');
        
        return reply.code(isDuplicateEmail ? 409 : 400).send({
          success: false,
          error: isDuplicateEmail 
            ? 'Email already exists' 
            : isPasswordError 
              ? result.error || 'Password validation failed'
              : 'Registration Failed',
          message: result.error,
        });
      }

      // Generate tokens after successful registration
      if (result.userId && result.organizationId) {
        // body.email is validated above and guaranteed to be a string
        const tokens = await authService.generateTokens({
          userId: result.userId,
          organizationId: result.organizationId,
          email: body.email,
          roles: ['admin'], // First user in org is admin
        });

        // Get user details
        const user = await prisma.user.findUnique({
          where: { id: result.userId },
          select: {
            id: true,
            email: true,
            name: true,
            organizationId: true,
          },
        });

        if (!user) {
          return reply.code(500).send({
            error: 'Internal server error',
            message: 'User created but not found',
          });
        }

        const userRoles = await getUserRoles(result.userId, result.organizationId);

        return reply.code(201).send({
          success: true,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            organizationId: user.organizationId,
            roles: userRoles.length > 0 ? userRoles : ['admin'], // Default to admin if no roles
          },
          tokens: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresIn: parseExpiresIn(tokens.expiresIn),
          },
        });
      }

      return reply.code(500).send({
        error: 'Internal server error',
        message: 'Registration succeeded but tokens could not be generated',
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      server.log.error({ error: errorMessage }, 'Registration request error');
      return reply.code(500).send({
        success: false,
        error: 'Internal server error',
        message: errorMessage,
      });
    }
  });

  /**
   * POST /v1/auth/login
   * Authenticate user using password or email code
   */
  server.post(
    '/v1/auth/login',
    {
      // Use permissive schema to allow manual validation in handler
      // This prevents Fastify from returning 404 for invalid formats
      // We'll validate manually to return proper 400 errors
      schema: {
        tags: ['Auth'],
        description: 'Complete authentication',
        // Permissive body schema - accepts any object
        // Manual validation in handler will catch invalid formats
        body: {
          type: 'object',
        },
      },
    },
    async (request, reply) => {
      try {
        // Validate body structure before processing
        if (!request.body || typeof request.body !== 'object') {
          return reply.code(400).send({
            success: false,
            error: 'Invalid Request',
            message: 'Request body must be an object',
          });
        }
        
        const body = request.body as
          | { challengeId: string; code: string; rememberDevice?: boolean }
          | { email: string; password: string };

      // Login with email code (challenge)
      if ('challengeId' in body && 'code' in body) {
        const command = new LoginWithCodeCommand(body.challengeId, body.code);
        const result = await loginWithCodeHandler.execute(command);

        if (!result.success) {
          return reply.code(401).send({
            success: false,
            error: 'Authentication Failed',
            message: result.error,
          });
        }

        // Return full result including tokens in the format expected by CLI
        return reply.send({
          success: result.success,
          loginMode: 'email_code' as const,
          user: result.userId
            ? {
                id: result.userId,
                email: result.email || '',
                name: result.email || '', // Use email as name if not available
                organizationId: result.organizationId || '',
                roles: result.roles || [],
              }
            : undefined,
          tokens: result.accessToken
            ? {
                accessToken: result.accessToken,
                refreshToken: result.refreshToken || '',
                expiresIn: parseExpiresIn(result.expiresIn), // Convert string "24h" to seconds
              }
            : undefined,
        });
      }

      // Login with email/password
      if ('email' in body && 'password' in body) {
        // Validate email is a string (prevent NoSQL injection)
        if (typeof body.email !== 'string' || typeof body.password !== 'string') {
          return reply.code(400).send({
            success: false,
            error: 'Invalid Request',
            message: 'Email and password must be strings',
          });
        }
        
        const command = new LoginUserCommand(body.email, body.password);
        const result = await loginHandler.execute(command);

        if (!result.success) {
          // Use handler error message directly for authentication errors
          const errorMessage = result.error || 'Authentication Failed';
          // Check if error is about account status (suspended, not active)
          const isAccountStatusError = errorMessage.toLowerCase().includes('suspended') || 
                                       errorMessage.toLowerCase().includes('not active') ||
                                       errorMessage.toLowerCase().includes('account is');
          
          return reply.code(isAccountStatusError ? 403 : 401).send({
            success: false,
            error: errorMessage,
            message: errorMessage,
          });
        }

        // Generate tokens after successful login
        if (result.userId && result.organizationId && result.email) {
          const userRoles = await getUserRoles(result.userId, result.organizationId);
          
          const tokens = await authService.generateTokens({
            userId: result.userId,
            organizationId: result.organizationId,
            email: result.email,
            roles: result.roles && result.roles.length > 0 ? result.roles : [result.role || 'user'],
          });

          // Ensure all values are serializable (strings, numbers, arrays)
          const responseBody = {
            success: true,
            user: {
              id: String(result.userId),
              email: String(result.email),
              organizationId: String(result.organizationId),
              roles: Array.isArray(userRoles) && userRoles.length > 0 
                ? userRoles.map(r => String(r))
                : Array.isArray(result.roles) && result.roles.length > 0
                  ? result.roles.map(r => String(r))
                  : [String(result.role || 'user')],
            },
            tokens: {
              accessToken: String(tokens.accessToken),
              refreshToken: String(tokens.refreshToken),
              expiresIn: parseExpiresIn(tokens.expiresIn), // Convert string "24h" to seconds
            },
          };
          return reply.send(responseBody);
        }

        return reply.code(500).send({
          success: false,
          error: 'Internal server error',
          message: 'Login succeeded but tokens could not be generated',
        });
      }

      return reply.code(400).send({
        success: false,
        error: 'InvalidRequest',
        message: 'Unsupported login payload.',
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      server.log.error({ error: errorMessage }, 'Login request error');
      return reply.code(500).send({
        success: false,
        error: 'Internal server error',
        message: errorMessage,
      });
    }
  });

  /**
   * POST /v1/auth/login-with-code
   * Login using email verification code
   */
  server.post(
    '/v1/auth/login-with-code',
    {
      schema: {
        tags: ['Auth'],
        description: 'Login with email verification code',
        body: {
          type: 'object',
          required: ['challengeId', 'code'],
          properties: {
            challengeId: { type: 'string', minLength: 1 },
            code: { type: 'string', minLength: 6, maxLength: 6, pattern: '^[0-9]{6}$' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  organizationId: { type: 'string' },
                  roles: { type: 'array', items: { type: 'string' } },
                },
              },
              tokens: {
                type: 'object',
                properties: {
                  accessToken: { type: 'string' },
                  refreshToken: { type: 'string' },
                  expiresIn: { type: 'number' },
                },
              },
            },
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          401: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
          429: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Validate body
        const bodyObject = getJsonBodyObject(request.body);
        if (!bodyObject) {
          return reply.code(400).send({
            success: false,
            error: 'Invalid Request',
            message: 'Request body must be a JSON object',
          });
        }

        const body = bodyObject as { challengeId?: string; code?: string };

        // Validate code format (must be 6 digits)
        if (!body.code || !/^[0-9]{6}$/.test(body.code)) {
          return reply.code(400).send({
            success: false,
            error: 'Invalid code format',
            message: 'Code must be exactly 6 numeric digits',
          });
        }

        if (!body.challengeId || body.challengeId.trim().length === 0) {
          return reply.code(400).send({
            success: false,
            error: 'Invalid challenge ID',
            message: 'Challenge ID is required',
          });
        }

        // Use LoginWithCodeHandler
        const loginWithCodeHandler = container.resolve(LoginWithCodeHandler);
        const command = new LoginWithCodeCommand(body.challengeId, body.code);
        const result = await loginWithCodeHandler.execute(command);

        if (!result.success) {
          // Determine appropriate status code based on error
          const errorText = (result.error || '').toLowerCase();
          const statusCode =
            errorText.includes('expired') ||
            errorText.includes('invalid') ||
            errorText.includes('used') ||
            errorText.includes('locked') ||
            errorText.includes('attempts')
              ? 401
              : 401;
          
          return reply.code(statusCode).send({
            success: false,
            error: result.error || 'Code verification failed',
          });
        }

        return reply.send({
          success: true,
          user: {
            id: result.userId,
            email: result.email,
            organizationId: result.organizationId,
            roles: result.roles,
          },
          tokens: {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresIn: result.expiresIn,
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Login with code request error');
        return reply.code(500).send({
          success: false,
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * POST /v1/auth/logout
   * Revoke current JWT (add to Redis blacklist)
   */
  server.post(
    '/v1/auth/logout',
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      try {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(400).send({
            success: false,
            error: 'Bad Request',
            message: 'Authorization Bearer token required',
          });
        }
        const token = authHeader.substring(7);
        const { revokeToken } = await import('@/middleware/token-revocation-middleware.js');
        const revoked = await revokeToken(token);
        if (!revoked) {
          return reply.code(503).send({
            success: false,
            error: 'Service Unavailable',
            message: 'Token revocation unavailable',
          });
        }
        return reply.code(204).send();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Logout request error');
        return reply.code(500).send({
          success: false,
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * POST /v1/auth/refresh
   * Refresh access token using refresh token
   */
  server.post('/v1/auth/refresh', async (request, reply) => {
    try {
      const bodyObject = getJsonBodyObject(request.body);
      if (!bodyObject) {
        return reply.code(400).send({
          success: false,
          error: 'Invalid Request',
          message: 'Request body must be a JSON object',
        });
      }

      const refreshToken = typeof bodyObject.refreshToken === 'string' ? bodyObject.refreshToken : '';
      if (!refreshToken) {
        return reply.code(400).send({
          success: false,
          error: 'Invalid Request',
          message: 'refreshToken is required and must be a string',
        });
      }

      const result = await authService.refreshToken(refreshToken);

        if (!result.success) {
          return reply.code(401).send({
            success: false,
            error: 'Invalid Token',
            message: result.error,
            loginMode: result.loginMode,
          });
        }

      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      server.log.error({ error: errorMessage }, 'Refresh token request error');
      return reply.code(500).send({
        success: false,
        error: 'Internal server error',
        message: errorMessage,
      });
    }
  });

  /**
   * GET /v1/auth/api-keys
   * List API keys for authenticated user
   */
  server.get(
    '/v1/auth/api-keys',
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      try {
        // Type guard for user from request
        const extendedRequest = request as ExtendedFastifyRequest;
        const user = extendedRequest.user;
        
        if (!user || typeof user !== 'object' || !('userId' in user) || typeof user.userId !== 'string') {
          return reply.code(401).send({
            success: false,
            error: 'Unauthorized',
            message: 'User not authenticated',
          });
        }

        // Get API keys for user
        const apiKeys = await prisma.apiKey.findMany({
          where: {
            userId: user.userId,
            status: { in: ['active', 'rotating'] },
          },
          select: {
            id: true,
            name: true,
            keyPrefix: true,
            status: true,
            createdAt: true,
            lastUsedAt: true,
            expiresAt: true,
            requestCount: true,
            autoRotate: true,
            rotationIntervalDays: true,
            gracePeriodDays: true,
            ipWhitelist: true,
            permissions: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

        return reply.send({
          object: 'list',
          data: apiKeys.map((key) => ({
            id: key.id,
            object: 'api_key',
            name: key.name,
            key_prefix: key.keyPrefix,
            status: key.status,
            created_at: Math.floor(key.createdAt.getTime() / 1000),
            last_used_at: key.lastUsedAt ? Math.floor(key.lastUsedAt.getTime() / 1000) : null,
            expires_at: key.expiresAt ? Math.floor(key.expiresAt.getTime() / 1000) : null,
            request_count: key.requestCount,
            auto_rotate: key.autoRotate,
            rotation_interval_days: key.rotationIntervalDays,
            grace_period_days: key.gracePeriodDays,
            ip_whitelist: key.ipWhitelist,
            permissions: key.permissions,
          })),
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'List API keys request error');
        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * POST /v1/auth/api-keys
   * Generate new API key (requires authentication)
   */
  server.post(
    '/v1/auth/api-keys',
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      try {
        // Type guard for user from request
        const extendedRequest = request as ExtendedFastifyRequest;
        const user = extendedRequest.user;
        
        if (!user || typeof user !== 'object' || !('userId' in user) || typeof user.userId !== 'string') {
          return reply.code(401).send({
            success: false,
            error: 'Unauthorized',
            message: 'User not authenticated',
          });
        }
        
        const bodyObject = getJsonBodyObject(request.body);
        if (!bodyObject) {
          return reply.code(400).send({
            success: false,
            error: 'Invalid Request',
            message: 'Request body must be a JSON object',
          });
        }

        const name = typeof bodyObject.name === 'string' ? bodyObject.name.trim() : '';
        if (!name) {
          return reply.code(400).send({
            success: false,
            error: 'Invalid Request',
            message: 'name is required and must be a non-empty string',
          });
        }

        const apiKey = await authService.generateApiKey(user.userId, name);

        if (!apiKey) {
          return reply.code(500).send({
            error: 'Failed',
            message: 'Failed to generate API key',
          });
        }

        return {
          success: true,
          apiKey,
          message: 'API key generated successfully',
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Generate API key request error');
        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  /**
   * DELETE /v1/auth/api-keys/:id
   * Revoke API key (requires authentication)
   */
  server.delete(
    '/v1/auth/api-keys/:id',
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      try {
        // Type guard for user from request
        const extendedRequest = request as ExtendedFastifyRequest;
        const user = extendedRequest.user;
        
        if (!user || typeof user !== 'object' || !('userId' in user) || typeof user.userId !== 'string') {
          return reply.code(401).send({
            success: false,
            error: 'Unauthorized',
            message: 'User not authenticated',
          });
        }
        
        const { id } = request.params as { id: string };

        const success = await authService.revokeApiKey(id, user.userId);

        if (!success) {
          return reply.code(404).send({
            success: false,
            error: 'Not Found',
            message: 'API key not found or already revoked',
          });
        }

        return {
          success: true,
          message: 'API key revoked successfully',
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        server.log.error({ error: errorMessage }, 'Revoke API key request error');
        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMessage,
        });
      }
    }
  );

  // SECURITY: the former POST /v1/auth/test-db debug route was REMOVED.
  // It returned the full list of public-schema table names plus user/org row
  // counts to ANY authenticated caller (any valid API key / JWT), leaking the
  // database schema and coarse tenant-size signals with no operational value
  // in production. Connectivity is already covered by the /health and
  // /health/db probes. If a schema/connectivity smoke check is ever needed for
  // local debugging, add it behind requireRole('admin','owner') AND an
  // ENABLE_DEBUG_ROUTES (or NODE_ENV !== 'production') gate so it can never be
  // registered in a production build.

  console.log('✅ Auth routes registered successfully - END OF FUNCTION');
}
