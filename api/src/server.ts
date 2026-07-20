// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Fastify server setup for Ailin Dev API
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { config, isProduction, isDevelopment } from '@/config';
import { registerHealthProbes } from '@/routes/health/health-probes';
import { logger } from '@/utils/logger';
import { isString, isError, isNodeError, getErrorMessage, getErrorCode, isObject, extractFastifyErrorProperties, getHeaderString } from '@/utils/type-guards';
// Types imported for future use
// import type { ChatRequest, ChatResponse } from '@/types';

/**
 * Create and configure Fastify server
 */
export async function createServer(): Promise<FastifyInstance> {
  // 50 MB default (was 10): a 10M-token context window (~4 chars/token ≈ 40 MB
  // of message text + JSON overhead) must fit through the HTTP body. Still the
  // DoS backstop — override via MAX_REQUEST_SIZE_MB.
  const maxSizeMB = parseInt(process.env.MAX_REQUEST_SIZE_MB || '50');
  const maxSizeBytes = maxSizeMB * 1024 * 1024;

  interface FastifyLoggerConfig {
    level: string;
    base: {
      service: string;
      env: string;
    };
    redact: {
      paths: string[];
      censor: string;
    };
    transport?: {
      target: string;
      options: {
        colorize: boolean;
        translateTime: string;
        ignore: string;
      };
    };
  }

  const fastifyLoggerConfig: FastifyLoggerConfig = {
    level: config.server.logLevel,
    base: {
      service: config.observability.serviceName,
      env: config.env,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'password',
        'apiKey',
        'secret',
        'token',
      ],
      censor: '[REDACTED]',
    },
  };

  if (isDevelopment) {
    fastifyLoggerConfig.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    };
  }

  const server = Fastify({
    logger: fastifyLoggerConfig,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    // WHY: Request logging is handled by request-context middleware with
    // route-level filtering to avoid duplicate noisy access logs.
    disableRequestLogging: true,
    trustProxy: true,
    bodyLimit: maxSizeBytes, // Prevent DoS via large payloads
    // Request timeouts (prevent hung requests)
    connectionTimeout: 300000, // 5 minutes for connection (collective strategies need 2-5 min)
    keepAliveTimeout: 310000, // 5m10s (must be > connectionTimeout)
    requestTimeout: 600000, // 10 minutes for request processing (debate/expert-panel multi-round)
    // REL-04 graceful shutdown: on close() drain in-flight requests but
    // proactively close IDLE keep-alive connections so the drain can resolve
    // instead of hanging on lingering sockets. (This is the Fastify v5 default;
    // set explicitly to document the shutdown contract.)
    forceCloseConnections: 'idle',
  });

  // Ensure JSON content type is properly handled (fixes 415 errors)
  // Fastify has built-in JSON parser, but we ensure it handles edge cases
  // Handle empty body cases (e.g., DELETE requests)
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      // Handle empty body (common in DELETE requests)
      if (!body || (typeof body === 'string' && body.trim().length === 0)) {
        done(null, undefined);
        return;
      }
      // body is typed as string when parseAs: 'string' is set
      if (typeof body !== 'string') {
        done(new Error('Expected string body for JSON parser'), undefined);
        return;
      }
      // JSON.parse returns `unknown`; pass through to the Fastify done
      // callback which itself accepts `any` (no narrowing needed at the
      // boundary, but typing the variable keeps the file lint-clean).
      const json: unknown = JSON.parse(body);
      done(null, json);
    } catch (err) {
      // err is unknown from catch, use type guard to safely handle
      const error = isError(err) ? err : new Error(getErrorMessage(err));
      done(error, undefined);
    }
  });

  const rawBodyPlugin = (await import('fastify-raw-body')).default;
  await server.register(rawBodyPlugin, {
    field: 'rawBody',
    global: false,
    runFirst: true,
  });

  // Multipart parser (required for audio/images/files/pdf upload endpoints)
  const maxUploadFileSizeMB = Math.max(1, Number(process.env.MAX_UPLOAD_FILE_SIZE_MB || 64));
  const maxUploadFiles = Math.max(1, Number(process.env.MAX_UPLOAD_FILES || 16));
  const maxUploadParts = Math.max(1, Number(process.env.MAX_UPLOAD_PARTS || 128));
  await server.register(multipart, {
    limits: {
      fileSize: maxUploadFileSizeMB * 1024 * 1024,
      files: maxUploadFiles,
      parts: maxUploadParts,
    },
    throwFileSizeLimit: true,
  });
  logger.info(
    { maxUploadFileSizeMB, maxUploadFiles, maxUploadParts },
    'Multipart parser configured'
  );

  // ==========================================
  // Security & Performance Plugins
  // ==========================================

  // CORS
  if (config.security.corsEnabled) {
    const { getCORSConfig } = await import('./config/security-config.js');
    const corsConfig = getCORSConfig();
    await server.register(cors, corsConfig);
    logger.info({ origins: corsConfig.origin }, 'CORS configured');
  }

  // Helmet (security headers) - v5.0 Enhanced
  if (config.security.helmetEnabled) {
    const { getHelmetConfig, validateSecurityHeaders } = await import(
      './config/security-headers.js'
    );

    // Validate configuration
    validateSecurityHeaders();

    // Register Helmet with enhanced config
    const helmetConfig = getHelmetConfig();
    await server.register(helmet, helmetConfig);

    logger.info(
      {
        csp: isProduction ? 'strict' : 'development',
        hsts: isProduction,
        frameguard: 'deny',
      },
      'âœ… Enhanced security headers configured (OWASP + SOC 2)'
    );
  }

  // Add custom security headers (v5.0)
  const { CUSTOM_SECURITY_HEADERS, removeServerHeaders } = await import(
    './config/security-headers.js'
  );
  server.addHook('onSend', async (request, reply, payload) => {
    // Add custom headers
    for (const [key, value] of Object.entries(CUSTOM_SECURITY_HEADERS)) {
      if (value) {
        reply.header(key, value);
      }
    }

    // Remove server info headers
    const headers = reply.getHeaders();
    // getHeaders() returns Record<HttpHeader, string | number | string[] | undefined>
    // removeServerHeaders expects Record<string, string | string[] | undefined>
    // Convert to compatible type safely
    const headersRecord: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(headers)) {
      // Filter out number values (Fastify can include numbers)
      if (typeof value === 'string' || Array.isArray(value) || value === undefined) {
        headersRecord[key] = value;
      }
    }
    removeServerHeaders(headersRecord);

    return payload;
  });

  // Compression
  if (config.security.compressionEnabled) {
    await server.register(compress, {
      global: true,
      threshold: 1024, // Only compress responses > 1KB
    });
  }

  // WebSocket support for Realtime API
  await server.register(websocket);
  logger.info('âœ… WebSocket plugin registered');

  // Rate limiting (basic - advanced Token Bucket is registered in index.ts)
  // Note: Token Bucket Rate Limiter (v5.0) with Redis is registered globally in index.ts
  // This is kept as a fallback/secondary layer for basic protection
  // Token Bucket provides more sophisticated rate limiting per API key/IP
  const { getRedisClient } = await import('./cache/redis-client.js');
  const redisClient = getRedisClient();

  // Basic rate limiting - more permissive since Token Bucket handles detailed limits
  // Note: Token Bucket Rate Limiter (v5.0) with Redis is registered globally in index.ts
  // This is kept as a fallback/secondary layer
  await server.register(rateLimit, {
    // In test environment, use higher limits to avoid interfering with tests
    // Only the specific rate limit test should hit the limit
    max: process.env.NODE_ENV === 'test' ? 10000 : 5000, // 10000 requests per timeWindow in tests to avoid interference, 5000 in production
    timeWindow: process.env.NODE_ENV === 'test' ? '1 minute' : '1 hour', // 1 minute window in tests for faster testing
    cache: 10000,
    // In test environment, don't allowList localhost to test rate limiting
    allowList: process.env.NODE_ENV === 'test' ? [] : ['127.0.0.1', '::1'], // Localhost unlimited (except in tests)
    redis: redisClient || undefined, // Use Redis if available for distributed rate limiting
    skipOnError: true, // Don't fail requests if rate limit check fails
    errorResponseBuilder: (request, context) => {
      return {
        error: {
          code: 'rate_limit_exceeded',
          message: `Rate limit exceeded. Maximum ${context.max} requests per hour.`,
          type: 'rate_limit_error',
          retryAfter: Math.ceil(context.ttl / 1000),
        },
      };
    },
  });

  // JWT authentication
  await server.register(jwt, {
    secret: config.security.jwtSecret,
  });

  // ==========================================
  // API Documentation (Swagger)
  // ==========================================

  if (!isProduction || process.env.ENABLE_SWAGGER === 'true') {
    await server.register(swagger, {
      openapi: {
        info: {
          title: 'Ailin Dev Tool API',
          description: 'Enterprise Multi-Model LLM Orchestration Gateway',
          version: '0.1.0',
          contact: {
            name: 'Ailin Team',
            email: 'dev@ailin.dev',
          },
        },
        servers: [
          {
            url: 'http://localhost:3000',
            description: 'Development server',
          },
          {
            url: 'https://api.ailin.one',
            description: 'Production server',
          },
        ],
        tags: [
          { name: 'Health', description: 'Health check endpoints' },
          { name: 'Auth', description: 'Authentication endpoints' },
          { name: 'Models', description: 'Model management' },
          { name: 'Capabilities', description: 'Capability-first universal execution routes' },
          { name: 'Chat', description: 'Chat completion endpoints' },
          { name: 'Embeddings', description: 'Embedding generation' },
          { name: 'Usage', description: 'Usage statistics' },
          { name: 'Collective Intelligence', description: 'Collective Intelligence features: semantic memory, agentic workflows, reasoning transparency' },
          { name: 'Assistants', description: 'OpenAI-compatible Assistants API' },
          { name: 'Threads', description: 'Thread and message management for Assistants' },
          { name: 'Vector Stores', description: 'Vector stores for RAG (Retrieval-Augmented Generation)' },
          { name: 'Files', description: 'File upload, storage, and retrieval' },
          { name: 'Fine-tuning', description: 'Fine-tuning jobs management' },
          { name: 'Batches', description: 'Batch API for asynchronous processing' },
          { name: 'Audio', description: 'Audio API (TTS, STT, Translation)' },
          { name: 'Images', description: 'Image generation, editing, and variations' },
          { name: 'Moderations', description: 'Content moderation and safety' },
          { name: 'Tools', description: 'Code tools and operations' },
          { name: 'Code Execution', description: 'Sandboxed code execution' },
          { name: 'PDF', description: 'PDF analysis and processing' },
          { name: 'Search', description: 'Multi-provider search and grounding' },
          { name: 'Context Caching', description: 'Context caching for long conversations' },
          { name: 'Extended Thinking', description: 'Extended and ultra thinking modes' },
          { name: 'Google Maps', description: 'Google Maps integration' },
          { name: 'Realtime', description: 'Realtime WebSocket communication' },
          { name: 'Responses', description: 'OpenAI Responses API' },
          { name: 'Jobs', description: 'Asynchronous job management' },
          { name: 'Providers', description: 'Provider management and capabilities' },
          { name: 'Orchestration', description: 'Multi-model orchestration strategies' },
          { name: 'Users', description: 'User management' },
          { name: 'Organizations', description: 'Organization management' },
          { name: 'API Keys', description: 'API key management' },
          { name: 'Admin', description: 'Administrative endpoints' },
          { name: 'Enterprise', description: 'Enterprise features (billing, quotas, analytics)' },
          { name: 'Observability', description: 'Observability and monitoring' },
          { name: 'Cache', description: 'Cache management' },
          { name: 'Queue', description: 'Queue management' },
          { name: 'Metrics', description: 'Metrics and analytics' },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
            },
            apiKey: {
              type: 'apiKey',
              name: 'X-API-Key',
              in: 'header',
            },
            apiKeyAuth: {
              type: 'apiKey',
              name: 'X-API-Key',
              in: 'header',
            },
          },
        },
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      },
    });

    await server.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    });
  }

  // ==========================================
  // Custom Decorators
  // ==========================================

  // Decorator for authenticated routes
  server.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    let jwtError: unknown;
    const extendedRequest = request as ExtendedFastifyRequest;

    // Respect upstream authentication context (api-key-auth middleware).
    // Re-authenticating here can override tenant identity and cause cross-tenant cache pollution.
    if (
      typeof extendedRequest.userId === 'string' &&
      extendedRequest.userId.length > 0 &&
      typeof extendedRequest.organizationId === 'string' &&
      extendedRequest.organizationId.length > 0
    ) {
      return;
    }
    if (
      request.user &&
      typeof request.user === 'object' &&
      'userId' in request.user &&
      'organizationId' in request.user
    ) {
      const existingUser = request.user as { userId?: unknown; organizationId?: unknown };
      if (
        typeof existingUser.userId === 'string' &&
        existingUser.userId.length > 0 &&
        typeof existingUser.organizationId === 'string' &&
        existingUser.organizationId.length > 0
      ) {
        extendedRequest.userId = existingUser.userId;
        extendedRequest.organizationId = existingUser.organizationId;
        return;
      }
    }

    try {
      await request.jwtVerify();
      if (request.user && typeof request.user === 'object' && 'organizationId' in request.user) {
        extendedRequest.organizationId = (request.user as { organizationId: string }).organizationId;
      }
      return;
    } catch (error: unknown) {
      jwtError = error instanceof Error ? error : new Error(String(error));
    }

    const rawAuthorization = getHeaderString(request.headers, 'authorization');
    const apiKeyHeader = getHeaderString(request.headers, 'x-api-key');
    const apiKey =
      rawAuthorization && rawAuthorization.startsWith('ak_') ? rawAuthorization : apiKeyHeader;

    if (!apiKey) {
      request.log.warn({ jwtError }, 'Authentication failed: credentials missing');
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or missing authentication credentials',
      });
      return reply;
    }

    try {
      const { getAuthService } = await import('./services/auth-service.js');
      const authService = getAuthService();
      const payload = await authService.verifyApiKey(apiKey);

      if (!payload) {
        request.log.warn({ jwtError }, 'Authentication failed: invalid API key');
        reply.code(401).send({
          error: 'Unauthorized',
          message: 'Invalid API key',
        });
        return reply;
      }

      request.user = {
        ...payload,
        organizationId: payload.organizationId,
      };
      extendedRequest.organizationId = payload.organizationId;
      return;
    } catch (apiKeyError) {
      request.log.error(
        { jwtError, apiKeyError },
        'Authentication failed while processing API key'
      );
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Authentication failed',
      });
      return reply;
    }
  });

  // ==========================================
  // Gateway Middleware (Quota + Signature Validation)
  // ==========================================

  // Apply gateway middlewares (quota + signature validation)
  // These run before authentication and other security middleware
  try {
    const { applyGatewayMiddlewares } = await import('./middleware/gateway_middleware.js');
    await applyGatewayMiddlewares(server);
    logger.info('âœ… Gateway middlewares applied (quota + signature)');
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage }, 'Failed to apply gateway middlewares');
    logger.warn('âš ï¸  Server will continue without gateway middlewares');
  }

  // ──────────────────────────────────────────────────────────────────────
  // Operational-Route Invariant (Caminho C — boot-time fail-fast guard)
  // ──────────────────────────────────────────────────────────────────────
  // Assert that every canonical operational route in OPERATIONAL_ROUTES is
  // honored by all three sibling allowlists (PUBLIC_ROUTES,
  // OPERATIONAL_ROUTE_PATHS, QUOTA_SKIP_ROUTES). If any drift exists — even
  // operator-side via misconfigured GATEWAY_QUOTA_SKIP_ROUTES — the server
  // crashes here with a structured multi-line error. See
  // src/config/operational-routes-invariant.ts for the full contract.
  //
  // Position: AFTER applyGatewayMiddlewares so QUOTA_SKIP_ROUTES has been
  // resolved with env overrides applied. BEFORE listen so the failure
  // mode is "container won't start" rather than "5xx in production".
  {
    const { assertOperationalRouteInvariant } = await import(
      './config/operational-routes-invariant.js'
    );
    assertOperationalRouteInvariant();
    logger.info('Operational-route invariant verified (canonical routes honored by all 3 allowlists)');
  }

  // ==========================================
  // Security Middleware (v5.0)
  // ==========================================

  // Input Sanitization (OWASP Top 10 protection)
  const { sanitizationMiddleware } = await import('./api/middleware/sanitization-middleware.js');
  server.addHook('preHandler', sanitizationMiddleware);
  logger.info('âœ… Input sanitization middleware enabled (OWASP protection)');

  // API Deprecation Policy (RFC 8594)
  const { deprecationMiddleware } = await import('./api/middleware/deprecation-middleware.js');
  server.addHook('preHandler', deprecationMiddleware);
  logger.info('âœ… API deprecation policy enabled (RFC 8594 - Deprecation & Sunset headers)');

  // Gateway Origin Validation (P0 Security Fix)
  // Validates that auth headers come from trusted gateway infrastructure
  const { validateGatewayOrigin } = await import('./middleware/gateway-origin-middleware.js');
  server.addHook('preHandler', validateGatewayOrigin);
  logger.info('âœ… Gateway origin validation enabled (anti-spoofing protection)');

  // Token Revocation Check (P1 Security Fix)
  // Validates that JWT tokens have not been revoked via Redis blacklist
  const { checkTokenRevocation } = await import('./middleware/token-revocation-middleware.js');
  server.addHook('preHandler', checkTokenRevocation);
  logger.info('âœ… Token revocation check enabled (Redis blacklist)');

  // Nonce Validation (P2 Security Fix - T7 Replay Attack)
  // Validates one-time nonces for sensitive operations
  const { validateNonce } = await import('./middleware/nonce-middleware.js');
  server.addHook('preHandler', validateNonce);
  logger.info('âœ… Nonce validation enabled (replay attack protection)');

  // API Key Rate Limiting (P2 Security Fix - T7 Replay Attack)
  // Enforces rate limits per API key based on organization tier
  const { enforceApiKeyRateLimit } = await import('./middleware/api-key-rate-limit-middleware.js');
  server.addHook('preHandler', enforceApiKeyRateLimit);
  logger.info('âœ… API key rate limiting enabled (per-key sliding window)');

  // ==========================================
  // Health Check Routes
  // ==========================================
  registerHealthProbes(server);
  logger.info('✅ Health probes registered (/health, /health/live, /health/ready, /health/startup)');

  // ==========================================
  // AGPL §13 source offer (public, unauthenticated)
  // ==========================================
  const { registerSourceOffer } = await import('@/routes/legal/source-offer');
  registerSourceOffer(server);
  logger.info('✅ AGPL source offer registered (/source, /license)');

  // ==========================================
  // API Routes (registered after plugins)
  // ==========================================

  // Routes will be registered in bootstrap phase
  // - /v1/auth/* (registerAuthRoutes)
  // - /v1/models/* (registerModelRoutes)
  // - /v1/chat/* (registerChatRoutes)
  // - /v1/embeddings (registerEmbeddingsRoutes)
  // - /v1/usage/* (registerUsageRoutes)
  // - /v1/user/* (registerUserRoutes)

  // ==========================================
  // Error Handling
  // ==========================================

  server.setErrorHandler((err, request, reply) => {
    // Fastify error handler receives FastifyError which extends Error
    // Extract FastifyError properties safely using type guards
    // Fastify always passes FastifyError, but we handle edge cases gracefully
    const errorProperties = extractFastifyErrorProperties(err);
    
    // Create error object with all FastifyError properties
    // We create a plain object that satisfies the FastifyError interface
    const error: {
      message: string;
      statusCode?: number;
      code?: string;
      validation?: unknown;
      stack?: string;
    } = {
      message: errorProperties.message,
      statusCode: errorProperties.statusCode,
      code: errorProperties.code,
      validation: errorProperties.validation,
      stack: errorProperties.stack,
    };

    // Extract error details - Fastify may wrap the error in 'err' property
    const errorMsg = error.message?.toLowerCase() || '';
    const errorCd = error.code || getErrorCode(err) || '';
    
    // Safely extract nested error if it exists
    let nestedErr: { message?: string; code?: string } | undefined;
    if (isObject(err) && 'err' in err) {
      const nested = err.err;
      if (isError(nested)) {
        nestedErr = {
          message: nested.message,
          code: isNodeError(nested) ? nested.code : undefined,
        };
      } else if (isObject(nested)) {
        const nestedMessage = 'message' in nested && isString(nested.message) ? nested.message : undefined;
        const nestedCode = 'code' in nested && isString(nested.code) ? nested.code : undefined;
        if (nestedMessage !== undefined || nestedCode !== undefined) {
          nestedErr = {
            message: nestedMessage,
            code: nestedCode,
          };
        }
      }
    }
    
    const isPrematureClose =
      errorMsg === 'premature close' ||
      errorCd === 'ERR_STREAM_PREMATURE_CLOSE' ||
      nestedErr?.message?.toLowerCase() === 'premature close' ||
      nestedErr?.code === 'ERR_STREAM_PREMATURE_CLOSE';

    if (isPrematureClose) {
      // For /metrics endpoint (Prometheus scraping), this is expected behavior
      // Health checks and Prometheus scrapers often close connections after reading headers
      const isMetricsEndpoint = request.url === '/metrics' || request.url?.startsWith('/metrics');
      
      if (isMetricsEndpoint) {
        // Use silent logger level to prevent ERROR logs for expected behavior
        // Prometheus scrapers and health checks frequently close connections early
        // This is completely normal and should not be logged as an error
        const silentLogger = request.log.child({ level: 'silent' });
        silentLogger.debug(
          {
            method: request.method,
            url: request.url,
            requestId: request.id,
          },
          'Metrics endpoint: client connection closed (normal for Prometheus scraping/health checks)'
        );
        
        // Explicitly mark that we've handled this error to prevent default logging
        // by not throwing and returning early
      } else {
        // Warn level for other endpoints - still informational, not critical
        request.log.warn(
          {
            method: request.method,
            url: request.url,
            requestId: request.id,
          },
          'Client connection closed before response was completed'
        );
      }
      
      // Check if connection is already closed before trying to send response
      if (!reply.sent && !reply.raw.destroyed && !reply.raw.writableEnded) {
        try {
          reply.raw.destroy();
        } catch {
          // Ignore errors when destroying already closed connections
        }
      }
      
      // Nothing to send back because the client already closed the connection.
      // Return early to prevent any error response or additional logging
      return;
    }

    // Rate limit errors - check before logging as unhandled
    // @fastify/rate-limit throws errors with statusCode 429
    if (error.statusCode === 429 || error.code === 'FST_ERR_RATE_LIMIT_EXCEEDED' || 
        (error.message && typeof error.message === 'string' && error.message.includes('rate_limit'))) {
      return reply.status(429).send({
        error: {
          code: 'rate_limit_exceeded',
          message: 'Too many requests',
        },
      });
    }

    // Check if error object contains rate_limit_exceeded
    if (isObject(error) && 'error' in error) {
      const innerError = error.error;
      if (isObject(innerError) && 'code' in innerError && innerError.code === 'rate_limit_exceeded') {
        return reply.status(429).send({
          error: {
            code: 'rate_limit_exceeded',
            message: 'Too many requests',
          },
        });
      }
    }

    // Extract error details for logging check (already extracted above)
    // errorMsg, errorCd, and nestedErr are already declared earlier
    
    // Skip error logging for premature close errors on /metrics endpoint
    // They're already handled above and logged at appropriate level (debug for metrics)
    const isPrematureCloseOnMetrics = 
      (errorMsg === 'premature close' || errorCd === 'ERR_STREAM_PREMATURE_CLOSE' ||
       nestedErr?.message?.toLowerCase() === 'premature close' ||
       nestedErr?.code === 'ERR_STREAM_PREMATURE_CLOSE') &&
      (request.url === '/metrics' || request.url?.startsWith('/metrics'));

    if (!isPrematureCloseOnMetrics) {
      request.log.error(
        {
          error,
          method: request.method,
          url: request.url,
          requestId: request.id,
        },
        'Unhandled request error'
      );
    }

    // JWT errors
    // Check if error has name property (FastifyError extends Error which has name)
    const errorName = isError(err) ? err.name : 'Error';
    if (errorName === 'UnauthorizedError') {
      return reply.status(401).send({
        error: {
          code: 'unauthorized',
          message: 'Invalid or missing authentication',
        },
      });
    }

    // Validation errors
    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: error.validation,
        },
      });
    }

    // Default error response
    const statusCode = error.statusCode || 500;
    const errorMessage = error.message || 'Internal server error';
    const errorCode = error.code || 'internal_error';

    // S fix: Capture 5xx errors to Sentry (was in dead-code global-error-handler.ts, now merged here)
    // Fire-and-forget: handler is not async, so we use .catch() instead of await
    if (statusCode >= 500) {
      import('@/utils/error-tracking.js')
        .then(({ captureException }) => {
          const extReq = request as { userId?: string; organizationId?: string };
          captureException(err, {
            requestId: request.id,
            method: request.method,
            url: request.url,
            userId: extReq.userId,
            organizationId: extReq.organizationId,
          });
        })
        .catch(() => {
          // Sentry unavailable — non-fatal, swallow silently
        });
    }

    // Ensure we always send a proper error response
    const errorResponse: {
      error: {
        code: string;
        message: string;
        request_id?: string;
        stack?: string;
      };
    } = {
      error: {
        code: errorCode,
        message: isProduction && statusCode >= 500 ? 'Internal server error' : errorMessage,
        request_id: request.id,
      },
    };

    if (!isProduction && error.stack) {
      errorResponse.error.stack = error.stack;
    }

    return reply.status(statusCode).send(errorResponse);
  });

  // 404 handler
  server.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: 'not_found',
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });

  return server;
}

/**
 * Start server
 */
export async function startServer(server: FastifyInstance): Promise<void> {
  try {
    // Use PORT from environment (Cloud Run) or fallback to 3000 for local development
    const port = parseInt(process.env.PORT || '3000', 10);

    // Use '0.0.0.0' to accept connections from outside the container (Cloud Run requirement)
    const host = '0.0.0.0';

    await server.listen({
      port,
      host,
    });

    server.log.info(`ðŸš€ Ailin Dev API running on http://${host}:${port}`);

    if (!isProduction) {
      server.log.info(`ðŸ“š API Documentation available at http://${host}:${port}/docs`);
    }
  } catch (error: unknown) {
    // Use type guard to safely check for Node.js error with code
    if (isNodeError(error) && error.code === 'EADDRINUSE') {
      const port = parseInt(process.env.PORT || '3000', 10);
      server.log.error(
        {
          error: 'Port already in use',
          port,
          code: error.code,
          message: `Port ${port} is already in use. Please stop the process using this port or use a different PORT environment variable.`,
          suggestion: isDevelopment
            ? `On Windows, run: netstat -ano | findstr :${port} to find the process, then taskkill /PID <PID> /F`
            : `On Linux/Mac, run: lsof -ti:${port} | xargs kill -9`,
        },
        `âŒ Failed to start server: Port ${port} already in use`
      );
      console.error(`\nâŒ ERROR: Port ${port} is already in use.`);
      console.error(`   Please stop the process using this port or set a different PORT environment variable.\n`);
    } else {
      // Safely extract error information using type guards
      const errorMessage = getErrorMessage(error);
      const errorCode = getErrorCode(error);
      const errorStack = isError(error) ? error.stack : undefined;
      
      server.log.error(
        {
          error: errorMessage,
          code: errorCode,
          stack: errorStack,
        },
        'Failed to start server'
      );
    }
    process.exit(1);
  }
}

/**
 * Graceful shutdown — close the HTTP server first (REL-04).
 *
 * Stops accepting new connections and drains in-flight requests before the
 * caller tears down downstream resources (workers, Redis, DB). Idle keep-alive
 * connections are closed via the server's `forceCloseConnections: 'idle'`
 * setting so `close()` can resolve promptly.
 *
 * This function no longer calls `process.exit()` — the full shutdown sequence
 * (workers → Redis → DB) runs in the caller (index.ts), which performs a single
 * explicit exit at the very end and owns the overall shutdown timeout guard.
 *
 * @param drainTimeoutMs Optional bound on the drain. If the server has not
 *   closed within this window (e.g. a stuck long-lived request), this resolves
 *   anyway so the rest of the shutdown sequence can run; the overall
 *   SHUTDOWN_TIMEOUT_MS guard in index.ts is the hard force-exit backstop.
 */
export async function shutdownServer(
  server: FastifyInstance,
  drainTimeoutMs?: number,
): Promise<void> {
  server.log.info('Closing HTTP server — no longer accepting new connections, draining in-flight requests...');

  const closePromise = server
    .close()
    .then(() => true)
    .catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      server.log.error({ error: errorMessage }, 'Error while closing HTTP server (continuing shutdown)');
      return true;
    });

  if (!drainTimeoutMs || drainTimeoutMs <= 0) {
    await closePromise;
    server.log.info('HTTP server closed — in-flight requests drained');
    return;
  }

  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    closePromise,
    new Promise<false>((resolve) => {
      drainTimer = setTimeout(() => resolve(false), drainTimeoutMs);
    }),
  ]);
  if (drainTimer) {
    clearTimeout(drainTimer);
  }

  if (drained) {
    server.log.info('HTTP server closed — in-flight requests drained');
  } else {
    server.log.warn(
      { drainTimeoutMs },
      'HTTP server drain exceeded timeout — proceeding with shutdown; remaining connections will be dropped',
    );
  }
}

