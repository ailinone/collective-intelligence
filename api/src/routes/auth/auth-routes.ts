// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Authentication routes
 * POST /v1/auth/register - Register new user
 * POST /v1/auth/login - Login with email/password
 * POST /v1/auth/refresh - Refresh access token
 * POST /v1/auth/api-keys - Generate API key
 * DELETE /v1/auth/api-keys/:id - Revoke API key
 */

import type { FastifyInstance } from 'fastify';
import { config } from '@/config';
import { getAuthService } from '@/services/auth-service';
import { authenticate } from '@/middleware/auth-middleware';
import { createRouteRateLimit } from '@/api/middleware/route-rate-limit';
import { logger } from '@/utils/logger';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';

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

/**
 * Register authentication routes
 */
export async function registerAuthRoutes(server: FastifyInstance): Promise<void> {
  const authService = getAuthService();

  /**
   * POST /v1/auth/register
   * Register new user with email/password
   */
  server.post(
    '/v1/auth/register',
    {
      schema: {
        tags: ['Auth'],
        description: 'Register new user',
        body: {
          type: 'object',
          required: ['email', 'password', 'name'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
            name: { type: 'string', minLength: 1 },
          },
        },
        response: {
          201: {
            description: 'Registration successful',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              loginMode: { type: 'string', enum: ['email_code', 'password', 'sso'] },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  organizationId: { type: 'string' },
                  roles: {
                    type: 'array',
                    items: { type: 'string' },
                  },
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
            description: 'Registration failed',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password, name } = request.body as {
        email: string;
        password: string;
        name: string;
      };

      const requestLog = logger.child({ endpoint: '/v1/auth/register', email });
      requestLog.info('Registration attempt');

      // Sanitize user input to prevent XSS attacks
      const { sanitizeHTML } = await import('@/utils/sanitizers');
      const sanitizedName = sanitizeHTML(name);

      const result = await authService.register({
        email,
        password,
        name: sanitizedName,
      });

      if (!result.success) {
        requestLog.warn({ error: result.error }, 'Registration failed');
        return reply.code(400).send({
          error: 'Registration Failed',
          message: result.error,
        });
      }

      requestLog.info({ userId: result.user?.id }, 'Registration successful');
      
      // Ensure expiresIn is a number for proper serialization
      const response = {
        ...result,
        tokens: result.tokens ? {
          ...result.tokens,
          expiresIn: parseExpiresIn(result.tokens.expiresIn),
        } : undefined,
      };
      
      return reply.code(201).send(response);
    }
  );

  /**
   * POST /v1/auth/challenge
   * Request email verification code
   */
  server.post(
    '/v1/auth/challenge',
    {
      schema: {
        tags: ['Auth'],
        description: 'Request email login challenge code',
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
            organizationId: { type: 'string' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            description: 'Challenge issued or cached',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              loginMode: { type: 'string', enum: ['email_code', 'password', 'sso'] },
              challengeId: { type: 'string' },
              expiresAt: { type: 'number' },
              cooldownExpiresAt: { type: 'number' },
              message: { type: 'string' },
            },
          },
          400: {
            description: 'Invalid request',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
              loginMode: { type: 'string', enum: ['email_code', 'password', 'sso'] },
            },
          },
          403: {
            description: 'Authentication mode disabled',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
              loginMode: { type: 'string', enum: ['email_code', 'password', 'sso'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, organizationId } = request.body as {
        email: string;
        organizationId?: string;
      };

      const requestLog = logger.child({ endpoint: '/v1/auth/challenge', email });
      requestLog.info('Email challenge requested');

      const result = await authService.requestEmailCode(email, organizationId);

      if (!result.success) {
        const statusCode = result.loginMode !== 'email_code' ? 403 : 400;
        requestLog.warn({ error: result.error, statusCode }, 'Email challenge denied');
        return reply.status(statusCode).send({
          error: 'ChallengeFailed',
          message: result.error ?? 'Unable to issue login challenge',
          loginMode: result.loginMode,
        });
      }

      requestLog.info({ challengeId: result.challengeId }, 'Email challenge issued or cached');
      return reply.send(result);
    }
  );

  /**
   * POST /v1/auth/login
   * Authenticate user using password or email code
   */
  server.post(
    '/v1/auth/login',
    {
      // SECURITY (js/missing-rate-limiting): this handler verifies passwords
      // and email codes (CWE-307 — brute-force / credential-stuffing surface).
      // No auth context exists pre-login, so this is scoped by source IP.
      // Route-scoped (not the global per-identity budget) so it adds a real
      // ceiling here without double-spending the global token bucket. See
      // route-rate-limit.ts.
      preHandler: createRouteRateLimit('auth-login', { capacity: 20, refillRate: 0.2 }),
      schema: {
        tags: ['Auth'],
        description: 'Complete authentication',
        body: {
          oneOf: [
            {
              type: 'object',
              required: ['challengeId', 'code'],
              properties: {
                challengeId: { type: 'string', minLength: 10 },
                code: { type: 'string', minLength: 4, maxLength: 12 },
                rememberDevice: { type: 'boolean' },
              },
              additionalProperties: false,
            },
            {
              type: 'object',
              required: ['email', 'password'],
              properties: {
                email: { type: 'string', format: 'email' },
                password: { type: 'string' },
              },
              additionalProperties: false,
            },
          ],
        },
        response: {
          200: {
            description: 'Login successful',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              loginMode: { type: 'string', enum: ['email_code', 'password', 'sso'] },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  organizationId: { type: 'string' },
                  roles: {
                    type: 'array',
                    items: { type: 'string' },
                  },
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
            description: 'Invalid request',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
              loginMode: { type: 'string', enum: ['email_code', 'password', 'sso'] },
            },
          },
          401: {
            description: 'Authentication failed',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
              message: { type: 'string' },
              loginMode: { type: 'string', enum: ['email_code', 'password', 'sso'] },
            },
          },
          500: {
            description: 'Internal server error',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as
        | { challengeId: string; code: string; rememberDevice?: boolean }
        | { email: string; password: string };

      if ('challengeId' in body && 'code' in body) {
        const requestLog = logger.child({
          endpoint: '/v1/auth/login',
          challengeId: body.challengeId,
          mode: 'email_code',
        });
        requestLog.info('Email code verification attempt');

        requestLog.info(
          {
            challengeId: body.challengeId,
            codeLength: body.code?.length,
            codePrefix: body.code ? body.code.substring(0, 2) + '***' : 'missing',
          },
          'Email code verification attempt'
        );

        const result = await authService.verifyEmailCode(body.challengeId, body.code);
        if (!result.success) {
          requestLog.warn(
            {
              error: result.error,
              challengeId: body.challengeId,
              codeLength: body.code?.length,
            },
            'Email code verification failed'
          );
          return reply.code(401).send({
            success: false,
            error: 'Authentication Failed',
            message: result.error,
            loginMode: result.loginMode,
          });
        }

        requestLog.info({ userId: result.user?.id }, 'Email code verification successful');
        return reply.send(result);
      }

      if ('email' in body && 'password' in body) {
        try {
          const requestLog = logger.child({
            endpoint: '/v1/auth/login',
            email: body.email,
            mode: 'password',
          });
          requestLog.info('Password login attempt');

          const result = await authService.login(body.email, body.password);
          if (!result.success) {
            requestLog.warn({ error: result.error }, 'Password login failed');
            return reply.code(401).send({
              success: false,
              error: 'Authentication Failed',
              message: result.error,
              loginMode: result.loginMode,
            });
          }

          requestLog.info({ userId: result.user?.id }, 'Password login successful');
          
          // Ensure expiresIn is a number for proper serialization
          const response = {
            ...result,
            tokens: result.tokens ? {
              ...result.tokens,
              expiresIn: parseExpiresIn(result.tokens.expiresIn),
            } : undefined,
          };
          
          return reply.code(200).send(response);
        } catch (error) {
          const requestLog = logger.child({
            endpoint: '/v1/auth/login',
            email: body.email,
            mode: 'password',
          });
          requestLog.error({ error }, 'Password login error');
          return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'An error occurred during login',
          });
        }
      }

      return reply.code(400).send({
        error: 'InvalidRequest',
        message: 'Unsupported login payload.',
        loginMode: config.auth.defaultMode,
      });
    }
  );

  /**
   * POST /v1/auth/refresh
   * Refresh access token using refresh token
   */
  server.post(
    '/v1/auth/refresh',
    {
      schema: {
        tags: ['Auth'],
        description: 'Refresh access token',
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string' },
          },
        },
        response: {
          200: {
            description: 'Token refreshed',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              loginMode: { type: 'string', enum: ['email_code', 'password', 'sso'] },
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
          401: {
            description: 'Invalid token',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
              message: { type: 'string' },
              loginMode: { type: 'string', enum: ['email_code', 'password', 'sso'] },
            },
          },
          500: {
            description: 'Internal server error',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { refreshToken } = request.body as { refreshToken: string };

      const requestLog = logger.child({ endpoint: '/v1/auth/refresh' });
      requestLog.info('Token refresh attempt');

      const result = await authService.refreshToken(refreshToken);

      if (!result.success) {
        requestLog.warn({ error: result.error }, 'Token refresh failed');
        return reply.status(401).send({
          success: false,
          error: 'Invalid Token',
          message: result.error,
          loginMode: result.loginMode,
        });
      }

      requestLog.info({ userId: result.user?.id }, 'Token refreshed');
      
      // Ensure expiresIn is a number for proper serialization
      const response = {
        ...result,
        tokens: result.tokens ? {
          ...result.tokens,
          expiresIn: parseExpiresIn(result.tokens.expiresIn),
        } : undefined,
      };
      
      return reply.code(200).send(response);
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
      schema: {
        tags: ['Auth'],
        description: 'Generate new API key',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            description: 'API key generated',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              apiKey: { type: 'string' },
              message: { type: 'string' },
            },
          },
          401: {
            description: 'Unauthorized',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          500: {
            description: 'Internal server error',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const extendedRequest = request as ExtendedFastifyRequest;
      const user = extendedRequest.user;
      
      // Type guard for user
      if (!user || typeof user !== 'object' || !('userId' in user) || typeof user.userId !== 'string') {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
      }
      
      const { name } = request.body as { name: string };

      const requestLog = logger.child({ endpoint: '/v1/auth/api-keys', userId: user.userId });
      requestLog.info('API key generation request');

      const apiKey = await authService.generateApiKey(user.userId, name);

      if (!apiKey) {
        requestLog.error('Failed to generate API key');
        return reply.status(500).send({
          error: 'Failed',
          message: 'Failed to generate API key',
        });
      }

      // SECURITY (js/clear-text-logging): do not log any slice of the
      // plaintext key — it is returned to the caller in the response body
      // below, but must never be written to logs.
      requestLog.info('API key generated');
      return reply.send({
        success: true,
        apiKey,
        message: 'API key generated successfully. Save it securely - it will not be shown again.',
      });
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
      schema: {
        tags: ['Auth'],
        description: 'Revoke API key',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
        response: {
          200: {
            description: 'API key revoked',
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
          401: {
            description: 'Unauthorized',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
          404: {
            description: 'API key not found',
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const extendedRequest = request as ExtendedFastifyRequest;
      const user = extendedRequest.user;
      
      // Type guard for user
      if (!user || typeof user !== 'object' || !('userId' in user) || typeof user.userId !== 'string') {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'User not authenticated',
        });
      }
      
      const { id } = request.params as { id: string };

      const requestLog = logger.child({
        endpoint: '/v1/auth/api-keys/:id',
        userId: user.userId,
        keyId: id,
      });
      requestLog.info('API key revocation request');

      const success = await authService.revokeApiKey(id, user.userId);

      if (!success) {
        requestLog.warn('API key not found or already revoked');
        return reply.code(404).send({
          error: 'Not Found',
          message: 'API key not found or already revoked',
        });
      }

      requestLog.info('API key revoked');
      return reply.send({
        success: true,
        message: 'API key revoked successfully',
      });
    }
  );
}
