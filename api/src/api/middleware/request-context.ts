// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Request Context Middleware
 * Propagates request ID and context through the system
 */

import { randomUUID } from 'crypto';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '@/utils/logger';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { getHeaderString } from '@/utils/type-guards';
import { resolveCanonicalIdentityContext } from '@/utils/context-headers';

const log = logger.child({ component: 'request-context' });
const ROUTINE_LOG_SUPPRESSED_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/liveness',
  '/health/ready',
  '/health/readiness',
  '/metrics',
]);

/**
 * Request context structure
 */
export interface RequestContext {
  requestId: string;
  correlationId: string;
  userId?: string;
  organizationId?: string;
  apiKey?: string;
  startTime: number;
  metadata: Record<string, unknown>;
}

interface StandardErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
  correlationId: string;
  timestamp: string;
}

const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeTraceId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value);
}

function getStatusErrorCode(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 422:
      return 'unprocessable_entity';
    case 429:
      return 'rate_limit_exceeded';
    default:
      return statusCode >= 500 ? 'internal_server_error' : `http_${statusCode}`;
  }
}

function getStatusErrorMessage(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'Bad request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Resource not found';
    case 409:
      return 'Conflict';
    case 422:
      return 'Unprocessable entity';
    case 429:
      return 'Too many requests';
    default:
      return statusCode >= 500 ? 'Internal server error' : 'Request failed';
  }
}

function resolveCorrelationId(request: ExtendedFastifyRequest): string {
  const incoming = getHeaderString(request.headers, 'x-correlation-id')?.trim();
  if (incoming && isSafeTraceId(incoming)) {
    return incoming;
  }

  // WHY: Generate a safe correlation id when the client does not provide one
  // to preserve deterministic cross-service tracing semantics.
  return randomUUID();
}

function normalizePath(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex >= 0 ? url.slice(0, queryIndex) : url;
}

function shouldSuppressRoutineRequestLogs(
  request: Pick<ExtendedFastifyRequest, 'method' | 'url'>
): boolean {
  if (request.method.toUpperCase() !== 'GET') {
    return false;
  }
  return ROUTINE_LOG_SUPPRESSED_PATHS.has(normalizePath(request.url));
}

function logRequestCompleted(
  payload: {
    requestId: string;
    correlationId?: string;
    method: string;
    url: string;
    statusCode: number;
    duration: number;
    metadata: Record<string, unknown> | undefined;
  }
): void {
  if (payload.statusCode >= 500) {
    log.error(payload, 'Request completed');
    return;
  }
  if (payload.statusCode === 404) {
    log.info(payload, 'Request completed');
    return;
  }
  if (payload.statusCode >= 400) {
    log.warn(payload, 'Request completed');
    return;
  }
  log.info(payload, 'Request completed');
}

function normalizeErrorPayload(
  payload: Record<string, unknown>,
  requestId: string,
  correlationId: string,
  statusCode: number
): StandardErrorResponse {
  const defaultCode = getStatusErrorCode(statusCode);
  const defaultMessage = getStatusErrorMessage(statusCode);

  let code = defaultCode;
  let message = defaultMessage;
  let details: unknown;

  const rawError = payload.error;
  if (isRecord(rawError)) {
    if (typeof rawError.code === 'string' && rawError.code.length > 0) {
      code = rawError.code;
    }
    if (typeof rawError.message === 'string' && rawError.message.length > 0) {
      message = rawError.message;
    } else if (typeof payload.message === 'string' && payload.message.length > 0) {
      message = payload.message;
    }
    if (rawError.details !== undefined) {
      details = rawError.details;
    }
  } else if (typeof rawError === 'string' && rawError.length > 0) {
    if (typeof payload.code === 'string' && payload.code.length > 0) {
      code = payload.code;
    }
    if (typeof payload.message === 'string' && payload.message.length > 0) {
      message = payload.message;
    } else {
      message = rawError;
    }
  } else if (typeof payload.message === 'string' && payload.message.length > 0) {
    message = payload.message;
  }

  if (details === undefined && payload.details !== undefined) {
    details = payload.details;
  }

  return {
    error: details === undefined ? { code, message } : { code, message, details },
    requestId,
    correlationId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * AsyncLocalStorage for request context
 * Allows access to request context anywhere in the call stack
 */
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get current request context
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Get current request ID
 */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

/**
 * Get current correlation ID
 */
export function getCorrelationId(): string | undefined {
  return requestContextStorage.getStore()?.correlationId;
}

/**
 * Set metadata in current request context
 */
export function setRequestMetadata(key: string, value: unknown): void {
  const context = requestContextStorage.getStore();
  if (context) {
    context.metadata[key] = value;
  }
}

/**
 * Request Context Middleware
 * Creates context for each request and propagates through async calls
 */
const requestContextMiddleware: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    const extendedRequest = request as ExtendedFastifyRequest;
    const tenantContext = extendedRequest.tenantContext;
    const headerContext = resolveCanonicalIdentityContext(request.headers, request.query);
    const correlationId = resolveCorrelationId(extendedRequest);
    extendedRequest.correlationId = correlationId;

    // Create request context
    const context: RequestContext = {
      requestId: request.id,
      correlationId,
      userId:
        tenantContext?.userId ||
        extendedRequest.userId ||
        headerContext.userId ||
        getHeaderString(request.headers, 'x-user-id'),
      organizationId:
        tenantContext?.organizationId ||
        extendedRequest.organizationId ||
        headerContext.organizationId ||
        getHeaderString(request.headers, 'x-organization-id'),
      apiKey: getHeaderString(request.headers, 'x-api-key'),
      startTime: Date.now(),
      metadata: {},
    };

    // Store context in AsyncLocalStorage
    requestContextStorage.enterWith(context);

    // WHY: Always expose both tracing identifiers so clients can correlate any
    // status code (2xx/4xx/5xx) with backend logs and distributed traces.
    reply.header('X-Request-Id', request.id);
    reply.header('X-Correlation-Id', correlationId);

    // Log request with context
    if (!shouldSuppressRoutineRequestLogs(extendedRequest)) {
      log.info(
        {
          requestId: context.requestId,
          correlationId: context.correlationId,
          method: request.method,
          url: request.url,
          userId: context.userId,
          organizationId: context.organizationId,
          ip: request.ip,
        },
        'Request received'
      );
    }
  });

  // Log response
  fastify.addHook('onResponse', async (request, reply) => {
    const context = getRequestContext();
    const duration = context ? Date.now() - context.startTime : 0;
    const suppressRoutineLogs = shouldSuppressRoutineRequestLogs(
      request as ExtendedFastifyRequest
    );

    if (suppressRoutineLogs && reply.statusCode < 400) {
      return;
    }

    logRequestCompleted({
      requestId: request.id,
      correlationId: context?.correlationId,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      duration,
      metadata: context?.metadata,
    });
  });

  fastify.addHook('preSerialization', async (request, reply, payload) => {
    if (reply.statusCode < 400 || !isRecord(payload)) {
      return payload;
    }

    if (typeof payload.error === 'string') {
      // WHY: Preserve legacy error payload contracts where route serializers
      // still expect `error` as string, avoiding runtime coercion regressions.
      return payload;
    }

    const extendedRequest = request as ExtendedFastifyRequest;
    const correlationId = extendedRequest.correlationId || resolveCorrelationId(extendedRequest);
    extendedRequest.correlationId = correlationId;

    return normalizeErrorPayload(payload, request.id, correlationId, reply.statusCode);
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    const extendedRequest = request as ExtendedFastifyRequest;
    const correlationId = extendedRequest.correlationId || resolveCorrelationId(extendedRequest);
    extendedRequest.correlationId = correlationId;

    reply.header('X-Request-Id', request.id);
    reply.header('X-Correlation-Id', correlationId);
    return payload;
  });
};

export default requestContextMiddleware;

/**
 * Get headers to propagate to external services
 * Includes request-id for distributed tracing
 */
export function getPropagationHeaders(): Record<string, string> {
  const context = getRequestContext();
  const headers: Record<string, string> = {};

  if (context?.requestId) {
    headers['x-request-id'] = context.requestId;
    headers['x-trace-id'] = context.requestId;
  }
  if (context?.correlationId) {
    headers['x-correlation-id'] = context.correlationId;
  }

  return headers;
}

/**
 * Register request context middleware
 */
export async function registerRequestContext(fastify: FastifyInstance): Promise<void> {
  // WHY: Register hooks on the root Fastify instance to avoid plugin encapsulation
  // boundaries that would prevent global tracing/error contracts from applying.
  await requestContextMiddleware(fastify, {});
}
