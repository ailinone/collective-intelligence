// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Error Tracking with Sentry
 * Enterprise-grade error monitoring and alerting
 */

import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { logger } from './logger';
import { isApplicationError } from './custom-errors';

const log = logger.child({ component: 'error-tracking' });

/**
 * Initialize Sentry error tracking
 */
export function initializeErrorTracking(): void {
  const sentryDSN = process.env.SENTRY_DSN;
  const environment = process.env.NODE_ENV || 'development';
  const release = process.env.RELEASE_VERSION || 'v4.1.0';

  // Only initialize if DSN is configured
  if (!sentryDSN) {
    log.warn('SENTRY_DSN not configured, error tracking disabled');
    return;
  }

  Sentry.init({
    dsn: sentryDSN,
    environment,
    release,

    // Performance Monitoring
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0, // 10% in prod, 100% in dev

    // Profiling
    profilesSampleRate: environment === 'production' ? 0.1 : 1.0,
    integrations: [nodeProfilingIntegration(), Sentry.httpIntegration()],

    // Filter sensitive data
    beforeSend(event, _hint) {
      // Remove sensitive headers
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['x-api-key'];
        delete event.request.headers['cookie'];
      }

      // Remove API keys from URL
      if (event.request?.url) {
        event.request.url = event.request.url.replace(/sk-[a-zA-Z0-9-_]+/g, 'sk-***');
        event.request.url = event.request.url.replace(/Bearer [a-zA-Z0-9._-]+/g, 'Bearer ***');
      }

      // Remove sensitive data from extra
      if (event.extra?.apiKey) {
        event.extra.apiKey = '***';
      }

      return event;
    },

    // Ignore certain errors
    ignoreErrors: [
      // Rate limit errors (expected)
      'RateLimitError',
      'ProviderRateLimitError',
      // Client validation errors
      'ValidationError',
      'InvalidRequestError',
      // Expected auth errors
      'AuthenticationError',
      'InvalidAPIKeyError',
    ],
  });

  log.info({ environment, release }, '✅ Sentry error tracking initialized');
}

/**
 * Capture exception to Sentry
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  // Add context
  if (context) {
    Sentry.setContext('additional', context);
  }

  // Set user context if available
  if (context?.userId) {
    Sentry.setUser({ id: String(context.userId) });
  }

  // Set tags
  if (context?.provider) {
    Sentry.setTag('provider', String(context.provider));
  }
  if (context?.model) {
    Sentry.setTag('model', String(context.model));
  }
  if (context?.strategy) {
    Sentry.setTag('strategy', String(context.strategy));
  }

  // Capture exception
  if (isApplicationError(error)) {
    // For known application errors, add extra context
    // Safely extract properties without type assertions
    let statusCode: number | undefined;
    let errorCode: string | undefined;
    let errorType = 'Error';
    
    if (typeof error === 'object' && error !== null) {
      const statusCodeDescriptor = Object.getOwnPropertyDescriptor(error, 'statusCode');
      if (statusCodeDescriptor && typeof statusCodeDescriptor.value === 'number') {
        statusCode = statusCodeDescriptor.value;
      }
      
      const codeDescriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (codeDescriptor && typeof codeDescriptor.value === 'string') {
        errorCode = codeDescriptor.value;
      }
      
      // Extract constructor name safely
      if ('constructor' in error && error.constructor && typeof error.constructor === 'object') {
        const constructorNameDescriptor = Object.getOwnPropertyDescriptor(error.constructor, 'name');
        if (constructorNameDescriptor && typeof constructorNameDescriptor.value === 'string') {
          errorType = constructorNameDescriptor.value;
        }
      }
    }
    
    Sentry.captureException(error, {
      level: (statusCode && statusCode >= 500) ? 'error' : 'warning',
      tags: {
        error_type: errorType,
        error_code: errorCode || 'unknown',
        status_code: String(statusCode || 500),
      },
    });
  } else {
    // Unknown errors
    Sentry.captureException(error);
  }
}

/**
 * Capture message to Sentry
 */
export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'info'
): void {
  Sentry.captureMessage(message, level);
}

/**
 * Add breadcrumb for debugging context
 */
export function addBreadcrumb(
  message: string,
  category: string,
  data?: Record<string, unknown>
): void {
  Sentry.addBreadcrumb({
    message,
    category,
    level: 'info',
    data,
    timestamp: Date.now() / 1000,
  });
}

/**
 * Start span for performance tracking (Sentry v10+)
 */
export function startSpan<T>(
  name: string,
  op: string,
  callback: () => T | Promise<T>
): T | Promise<T> {
  return Sentry.startSpan(
    {
      name,
      op,
    },
    callback
  );
}

/**
 * Sentry middleware for Fastify
 */
import type { FastifyRequest, FastifyReply } from 'fastify';

export function createSentryMiddleware() {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    // Set request context for Sentry
    Sentry.setContext('request', {
      url: request.url,
      method: request.method,
      headers: {
        'user-agent': request.headers['user-agent'],
        'x-organization-id': request.headers['x-organization-id'],
        'x-tenant-id': request.headers['x-tenant-id'],
        'x-workspace-id': request.headers['x-workspace-id'],
        'x-request-id': request.headers['x-request-id'],
      },
    });

    // Capture request context as breadcrumb
    addBreadcrumb(`${request.method} ${request.url}`, 'http', {
      method: request.method,
      url: request.url,
      ip: request.ip,
    });
  };
}

/**
 * Close Sentry connection (graceful shutdown)
 */
export async function closeSentry(): Promise<void> {
  log.info('Closing Sentry connection');
  await Sentry.close(2000); // 2 second timeout
  log.info('✅ Sentry connection closed');
}
