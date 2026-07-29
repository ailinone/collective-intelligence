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

// ── Data-leakage scrubbing (2026-07-28 security review) ─────────────────────
// This is an LLM router: adapters across api/src/providers/** and
// api/src/client/adapters/** sometimes embed raw provider response/request
// body text directly into thrown Error messages (e.g.
// client/adapters/openai-adapter.ts's "Invalid JSON from OpenAI: <content>",
// where <content> is the model's raw completion). If such an error reaches
// Sentry.captureException (see server.ts's global 5xx handler), that text —
// which can be a reflection of a user prompt, a model completion, or
// proprietary business data run through the router — would ride along in
// event.exception.values[].value, bypassing the header/URL scrubbing below
// entirely (that scrubbing only touches event.request).
//
// Patching every adapter call site to stop embedding raw content in Error
// messages is the "real" fix but is a large, diffuse change across dozens of
// provider files with real behavior-change risk — out of scope here. Instead
// this hook adds a generic, defense-in-depth scrub that runs over every
// string reachable from a Sentry event: the same API-key/bearer-token
// patterns already applied to URLs are also applied to exception messages,
// contexts, extra, and breadcrumbs, and any string longer than a normal
// diagnostic message is truncated. Legitimate error messages are short;
// anything blowing past the cap is far more likely to be echoed request or
// response content than genuine diagnostic text.
//
// This reduces exposure (long prompts/completions get truncated instead of
// shipped whole) but is NOT a substitute for fixing the adapters — a prompt
// or completion shorter than the cap still passes through intact. See the
// PR description / final report for the specific adapter call sites that
// should be fixed at the source.
const SECRET_LIKE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-[a-zA-Z0-9-_]+/g, 'sk-***'],
  [/Bearer [a-zA-Z0-9._-]+/g, 'Bearer ***'],
];

const MAX_EVENT_STRING_LENGTH = 500;
const MAX_SCRUB_DEPTH = 6;

/**
 * Redact secret-like substrings and cap the length of a string bound for
 * Sentry. Exported (in addition to being used by beforeSend below) so it can
 * be unit-tested directly without spinning up a real Sentry.init() client.
 */
export function scrubString(value: string): string {
  let scrubbed = value;
  for (const [pattern, replacement] of SECRET_LIKE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  if (scrubbed.length > MAX_EVENT_STRING_LENGTH) {
    const omitted = scrubbed.length - MAX_EVENT_STRING_LENGTH;
    scrubbed = `${scrubbed.slice(0, MAX_EVENT_STRING_LENGTH)}... [${omitted} more chars truncated by Sentry beforeSend — see application logs for full detail]`;
  }
  return scrubbed;
}

/**
 * Recursively scrub string leaves of an arbitrary value (object/array/
 * primitive). Used for event.contexts / event.extra / breadcrumb.data,
 * whose shape is caller-defined (Record<string, unknown>) and could in
 * principle carry prompt/completion text from a future captureException()
 * or addBreadcrumb() call site.
 * Exported for the same unit-testability reason as scrubString() above.
 */
export function scrubValueDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH || value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValueDeep(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = scrubValueDeep(val, depth + 1);
    }
    return result;
  }
  return value;
}

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

      // Generic scrub pass (see the "Data-leakage scrubbing" comment above
      // this function): redact secret-like patterns and cap string length
      // across exception messages, contexts, extra, and breadcrumbs, so a
      // provider adapter that embeds raw prompt/completion/response-body
      // text into an Error message doesn't ship that content to Sentry
      // wholesale.
      if (event.exception?.values) {
        for (const exceptionValue of event.exception.values) {
          if (exceptionValue.value) {
            exceptionValue.value = scrubString(exceptionValue.value);
          }
        }
      }

      if (event.message) {
        event.message = scrubString(event.message);
      }

      if (event.contexts) {
        for (const key of Object.keys(event.contexts)) {
          event.contexts[key] = scrubValueDeep(event.contexts[key]) as Record<string, unknown> | undefined;
        }
      }

      if (event.extra) {
        for (const key of Object.keys(event.extra)) {
          event.extra[key] = scrubValueDeep(event.extra[key]);
        }
      }

      if (event.breadcrumbs) {
        for (const breadcrumb of event.breadcrumbs) {
          if (breadcrumb.message) {
            breadcrumb.message = scrubString(breadcrumb.message);
          }
          if (breadcrumb.data) {
            breadcrumb.data = scrubValueDeep(breadcrumb.data) as Record<string, unknown>;
          }
        }
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
 *
 * NOTE (2026-07-28 security review): as of this commit, this middleware is
 * defined but not registered anywhere (no `app.addHook`/`onRequest` call
 * references it) — grep the codebase for `createSentryMiddleware` and the
 * only hit is this definition. It is effectively dead code today, but is
 * reviewed here on the assumption it may be wired up later.
 *
 * On the x-organization-id / x-tenant-id / x-workspace-id headers below:
 * these are treated as safe to forward, deliberately, and are NOT scrubbed
 * like authorization/x-api-key/cookie are. Reasoning:
 *   - They are opaque tenant/org identifiers (database IDs), not credentials
 *     and not free-form PII — the same class of value already sent via
 *     Sentry.setUser({ id: userId }) and the `organizationId` tag in
 *     captureException() below, which is the normal, intended use of
 *     Sentry's user/tag facets for triage (e.g. "is this tenant hitting the
 *     same bug repeatedly").
 *   - x-request-id and user-agent are standard, low-sensitivity diagnostic
 *     metadata.
 * That said, sending a tenant ID to a third-party SaaS at all IS a data-
 * governance decision, not just a code one: it tells Sentry (a
 * sub-processor) which customer experienced which error. If any customer
 * contract/DPA restricts disclosing customer identity to sub-processors,
 * that's a legal/contractual question this code change cannot resolve —
 * flagged here for the operator to weigh, not silently decided either way.
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
