// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Logger configuration using Pino
 * 
 * NOTE: This module must NOT import from @/config to avoid circular dependencies.
 * Instead, it uses environment variables directly.
 */

import pino, { stdSerializers } from 'pino';

// Get config from environment directly to avoid circular dependency
const logLevel = process.env.LOG_LEVEL || 'info';
const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'staging';
const serviceName = process.env.SERVICE_NAME || process.env.OTEL_SERVICE_NAME || 'ci-api';
const env = process.env.NODE_ENV || 'development';

/**
 * Create logger instance
 */
export const logger = pino({
  level: logLevel,

  // Pretty print in development
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      }
    : undefined,

  // Production formatting (JSON)
  ...(!isDevelopment && {
    formatters: {
      level: (label: string) => {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  }),

  // Base fields
  base: {
    service: serviceName,
    env: env,
  },

  // Redact sensitive data
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

  // Custom serializer to filter out expected errors
  serializers: {
    err: (err: unknown) => {
      // Safely extract error message and code without type assertions
      let errorMessage = '';
      let errorCode = '';
      
      if (err && typeof err === 'object' && err !== null && 'message' in err) {
        const messageDescriptor = Object.getOwnPropertyDescriptor(err, 'message');
        if (messageDescriptor) {
          errorMessage = String(messageDescriptor.value || '').toLowerCase();
        }
      }
      
      if (err && typeof err === 'object' && err !== null && 'code' in err) {
        const codeDescriptor = Object.getOwnPropertyDescriptor(err, 'code');
        if (codeDescriptor && typeof codeDescriptor.value === 'string') {
          errorCode = codeDescriptor.value;
        }
      }
      
      // Don't serialize premature close errors - they're expected for metrics endpoint
      // This prevents them from being logged as errors
      if (
        errorMessage === 'premature close' ||
        errorCode === 'ERR_STREAM_PREMATURE_CLOSE'
      ) {
        // Return minimal info for premature close (these are expected)
        return {
          type: 'PrematureCloseError',
          message: 'Client connection closed before response completed (expected for /metrics scraping)',
          code: errorCode || 'ERR_STREAM_PREMATURE_CLOSE',
        };
      }
      
      // Use default pino error serialization for other errors
      // Safe to cast to Error here since stdSerializers.err handles unknown types
      if (err instanceof Error) {
        return stdSerializers.err(err);
      }
      
      // For non-Error types, return a basic error object
      // Safely extract stack property without type assertion
      let stackValue: string | undefined;
      if (err && typeof err === 'object' && err !== null && 'stack' in err) {
        const stackDescriptor = Object.getOwnPropertyDescriptor(err, 'stack');
        if (stackDescriptor && typeof stackDescriptor.value === 'string') {
          stackValue = stackDescriptor.value;
        }
      }
      
      return {
        type: 'UnknownError',
        message: typeof err === 'string' ? err : 'Unknown error',
        stack: stackValue,
      };
    },
  },
});

/**
 * Create child logger with additional context
 */
export function createLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
