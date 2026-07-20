// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Custom Error Classes
 * Better error handling and differentiation
 */

/**
 * Base Application Error
 */
export class ApplicationError extends Error {
  public statusCode: number;
  public code?: string;
  public details?: unknown;

  constructor(message: string, statusCode: number = 500, code?: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        name: this.name,
        message: this.message,
        code: this.code,
        statusCode: this.statusCode,
        details: this.details,
      },
    };
  }
}

/**
 * Provider Errors
 */
export class ProviderError extends ApplicationError {
  constructor(
    message: string,
    public readonly provider: string,
    statusCode: number = 502,
    code?: string
  ) {
    super(message, statusCode, code, { provider });
    this.name = 'ProviderError';
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(provider: string, message?: string) {
    super(
      message || `Provider ${provider} is temporarily unavailable`,
      provider,
      503,
      'provider_unavailable'
    );
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(provider: string, retryAfter?: number) {
    const details: { provider: string; retryAfter?: number } = { provider };
    if (retryAfter) {
      details.retryAfter = retryAfter;
    }
    super(`Provider ${provider} rate limit exceeded`, provider, 429, 'provider_rate_limit');
    this.name = 'ProviderRateLimitError';
    this.details = details;
  }
}

export class ProviderAuthenticationError extends ProviderError {
  constructor(provider: string) {
    super(`Authentication failed for provider ${provider}`, provider, 401, 'provider_auth_error');
    this.name = 'ProviderAuthenticationError';
  }
}

/**
 * Validation Errors
 */
export class ValidationError extends ApplicationError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'validation_error', details);
    this.name = 'ValidationError';
  }
}

export class ModelNotFoundError extends ValidationError {
  constructor(modelId: string) {
    super(`Model ${modelId} not found`, { modelId });
    this.name = 'ModelNotFoundError';
    this.code = 'model_not_found';
  }
}

export class InvalidRequestError extends ValidationError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = 'InvalidRequestError';
    this.code = 'invalid_request';
  }
}

/**
 * Authentication & Authorization Errors
 */
export class AuthenticationError extends ApplicationError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'authentication_error');
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends ApplicationError {
  constructor(message: string = 'Insufficient permissions') {
    super(message, 403, 'authorization_error');
    this.name = 'AuthorizationError';
  }
}

export class InvalidAPIKeyError extends AuthenticationError {
  constructor() {
    super('Invalid API key');
    this.name = 'InvalidAPIKeyError';
    this.code = 'invalid_api_key';
  }
}

export class ExpiredTokenError extends AuthenticationError {
  constructor() {
    super('Token has expired');
    this.name = 'ExpiredTokenError';
    this.code = 'expired_token';
  }
}

/**
 * Resource Errors
 */
export class ResourceNotFoundError extends ApplicationError {
  constructor(resource: string, id: string) {
    super(`${resource} with id ${id} not found`, 404, 'resource_not_found', {
      resource,
      id,
    });
    this.name = 'ResourceNotFoundError';
  }
}

export class ResourceConflictError extends ApplicationError {
  constructor(resource: string, message: string) {
    super(message, 409, 'resource_conflict', { resource });
    this.name = 'ResourceConflictError';
  }
}

/**
 * Database Errors
 */
export class DatabaseError extends ApplicationError {
  constructor(message: string, details?: unknown) {
    super(message, 500, 'database_error', details);
    this.name = 'DatabaseError';
  }
}

export class DatabaseConnectionError extends DatabaseError {
  constructor(message?: string) {
    super(message || 'Database connection failed');
    this.name = 'DatabaseConnectionError';
    this.code = 'db_connection_error';
  }
}

export class DatabaseQueryError extends DatabaseError {
  constructor(query: string, error: Error) {
    super('Database query failed', { query, originalError: error.message });
    this.name = 'DatabaseQueryError';
    this.code = 'db_query_error';
  }
}

/**
 * Cache Errors
 */
export class CacheError extends ApplicationError {
  constructor(message: string, details?: unknown) {
    super(message, 500, 'cache_error', details);
    this.name = 'CacheError';
  }
}

export class CacheConnectionError extends CacheError {
  constructor() {
    super('Cache connection failed');
    this.name = 'CacheConnectionError';
    this.code = 'cache_connection_error';
  }
}

/**
 * Rate Limiting Errors
 */
export class RateLimitError extends ApplicationError {
  constructor(limit: number, window: string, retryAfter?: number) {
    super(`Rate limit exceeded: ${limit} requests per ${window}`, 429, 'rate_limit_exceeded', {
      limit,
      window,
      retryAfter,
    });
    this.name = 'RateLimitError';
  }
}

/**
 * Orchestration Errors
 */
export class OrchestrationError extends ApplicationError {
  constructor(message: string, details?: unknown) {
    super(message, 500, 'orchestration_error', details);
    this.name = 'OrchestrationError';
  }
}

export class NoAvailableProviderError extends OrchestrationError {
  constructor(modelId?: string) {
    super(modelId ? `No available provider for model ${modelId}` : 'No available providers', {
      modelId,
    });
    this.name = 'NoAvailableProviderError';
    this.code = 'no_available_provider';
    this.statusCode = 503;
  }
}

export class StrategyExecutionError extends OrchestrationError {
  constructor(strategy: string, error: Error) {
    super(`Strategy ${strategy} execution failed`, {
      strategy,
      originalError: error.message,
    });
    this.name = 'StrategyExecutionError';
    this.code = 'strategy_execution_error';
  }
}

/**
 * Configuration Errors
 */
export class ConfigurationError extends ApplicationError {
  constructor(message: string, details?: unknown) {
    super(message, 500, 'configuration_error', details);
    this.name = 'ConfigurationError';
  }
}

/**
 * Timeout Errors
 */
export class TimeoutError extends ApplicationError {
  constructor(operation: string, timeout: number) {
    super(`Operation ${operation} timed out after ${timeout}ms`, 504, 'timeout_error', {
      operation,
      timeout,
    });
    this.name = 'TimeoutError';
  }
}

/**
 * 01C.1B-R/P — Dry-run fail-closed gate errors.
 *
 * Thrown by `applyDryRunFailClosedGate` / the real-branch approved-plan
 * gate in chat-request-processor.ts whenever a request must be refused
 * BEFORE any orchestration setup or provider call. `billable_execution_blocked`
 * is the caller-facing guarantee that refusing this request cannot have
 * incurred any cost — consumers assert on it directly.
 */
export class DryRunGateError extends ApplicationError {
  public readonly billable_execution_blocked = true as const;

  constructor(message: string, statusCode: number, code: string, details?: unknown) {
    super(message, statusCode, code, details);
    this.name = 'DryRunGateError';
  }
}

/**
 * Check if error is an ApplicationError
 */
export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}

/**
 * Convert unknown error to ApplicationError
 */
export function toApplicationError(error: unknown): ApplicationError {
  if (isApplicationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new ApplicationError(error.message, 500, 'internal_error');
  }

  return new ApplicationError('Unknown error occurred', 500, 'unknown_error');
}
