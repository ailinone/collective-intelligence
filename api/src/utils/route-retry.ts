// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { Logger } from 'pino';
import { RetryPolicy } from '@/core/resilience/retry-policy';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';

export interface RouteRetryOptions {
  operationName: string;
  isIdempotent?: boolean;
  requestId?: string;
  log?: Logger;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  exponentialFactor?: number;
}

export async function executeRouteWithRetry<T>(
  operation: () => Promise<T>,
  options: RouteRetryOptions
): Promise<T> {
  const retryPolicy = new RetryPolicy({
    maxAttempts: options.maxAttempts ?? 3,
    baseDelay: options.baseDelayMs ?? 200,
    maxDelay: options.maxDelayMs ?? 2000,
    exponentialFactor: options.exponentialFactor ?? 2,
    jitter: true,
    idempotentOnly: true,
  });

  const result = await retryPolicy.execute(operation, {
    operationName: options.operationName,
    isIdempotent: options.isIdempotent ?? true,
  });

  const routeLog = options.log ?? logger;

  if (result.success) {
    if (result.attempts > 1) {
      routeLog.warn(
        {
          operation: options.operationName,
          requestId: options.requestId,
          attempts: result.attempts,
          totalBackoffMs: result.totalBackoffMs ?? 0,
          durationMs: result.totalDuration,
        },
        'Route operation recovered via retry'
      );
    }

    return result.data as T;
  }

  const error = result.error ?? new Error(`${options.operationName} failed`);
  routeLog.error(
    {
      operation: options.operationName,
      requestId: options.requestId,
      attempts: result.attempts,
      totalBackoffMs: result.totalBackoffMs ?? 0,
      durationMs: result.totalDuration,
      error: getErrorMessage(error),
    },
    'Route operation failed after retry attempts'
  );
  throw error;
}
