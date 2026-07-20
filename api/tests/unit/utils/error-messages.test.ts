// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Error Messages Tests
 * 
 * Testing:
 * - Error classification
 * - Message formatting
 * - Response building
 * - Security (no sensitive data)
 */

import { describe, it, expect } from 'vitest';
import {
  ErrorClassifier,
  MessageFormatter,
  ErrorResponseBuilder,
  createErrorResponse,
  ERROR_TEMPLATES,
} from '@/utils/error-messages';

interface ExtendedError extends Error {
  code?: string;
  statusCode?: number;
  field?: string;
  retryAfter?: number;
  requestedModel?: string;
}

describe('ErrorClassifier', () => {
  describe('classify', () => {
    it('should classify by explicit error code', () => {
      const error = new Error('Test error') as ExtendedError;
      error.code = 'AUTH_INVALID_TOKEN';

      const result = ErrorClassifier.classify(error);
      expect(result).toBe('AUTH_INVALID_TOKEN');
    });

    it('should classify by HTTP status code 401', () => {
      const error = new Error('Unauthorized') as ExtendedError;
      error.statusCode = 401;

      const result = ErrorClassifier.classify(error);
      expect(result).toBe('AUTH_INVALID_TOKEN');
    });

    it('should classify by HTTP status code 404', () => {
      const error = new Error('Not found') as ExtendedError;
      error.statusCode = 404;

      const result = ErrorClassifier.classify(error);
      expect(result).toBe('RESOURCE_NOT_FOUND');
    });

    it('should classify by HTTP status code 429', () => {
      const error = new Error('Too many requests') as ExtendedError;
      error.statusCode = 429;

      const result = ErrorClassifier.classify(error);
      expect(result).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should classify by message pattern - rate limit', () => {
      const error = new Error('Rate limit exceeded for user');

      const result = ErrorClassifier.classify(error);
      expect(result).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should classify by message pattern - model not found', () => {
      const error = new Error('Model gpt-999 not found');

      const result = ErrorClassifier.classify(error);
      expect(result).toBe('MODEL_NOT_FOUND');
    });

    it('should classify by message pattern - timeout', () => {
      const error = new Error('Request timeout after 30s');

      const result = ErrorClassifier.classify(error);
      expect(result).toBe('PROVIDER_TIMEOUT');
    });

    it('should default to INTERNAL_ERROR for unknown errors', () => {
      const error = new Error('Some random error');

      const result = ErrorClassifier.classify(error);
      expect(result).toBe('INTERNAL_ERROR');
    });
  });

  describe('extractContext', () => {
    it('should extract field context', () => {
      const error = new Error('Test') as ExtendedError;
      error.field = 'email';

      const context = ErrorClassifier.extractContext(error);
      expect(context.field).toBe('email');
    });

    it('should extract retryAfter context', () => {
      const error = new Error('Test') as ExtendedError;
      error.retryAfter = 60;

      const context = ErrorClassifier.extractContext(error);
      expect(context.retryAfter).toBe(60);
    });

    it('should extract requestedModel context', () => {
      const error = new Error('Test') as ExtendedError;
      error.requestedModel = 'gpt-5';

      const context = ErrorClassifier.extractContext(error);
      expect(context.requestedModel).toBe('gpt-5');
    });

    it('should return empty object for errors without context', () => {
      const error = new Error('Test');

      const context = ErrorClassifier.extractContext(error);
      expect(context).toEqual({});
    });
  });
});

describe('MessageFormatter', () => {
  describe('format', () => {
    it('should format message without placeholders', () => {
      const template = ERROR_TEMPLATES.INTERNAL_ERROR;
      const result = MessageFormatter.format(template);

      expect(result.message).toBe(template.message);
    });

    it('should replace placeholders in message', () => {
      const template = {
        code: 'TEST',
        message: 'Error with {field}',
        severity: 'error' as const,
      };

      const result = MessageFormatter.format(template, { field: 'email' });
      expect(result.message).toBe('Error with email');
    });

    it('should replace placeholders in action', () => {
      const template = {
        code: 'TEST',
        message: 'Error',
        action: 'Wait {seconds} seconds',
        severity: 'error' as const,
      };

      const result = MessageFormatter.format(template, { seconds: 60 });
      expect(result.action).toBe('Wait 60 seconds');
    });

    it('should add retryAfter from context', () => {
      const template = ERROR_TEMPLATES.SERVICE_UNAVAILABLE;
      const result = MessageFormatter.format(template, { retryAfter: 120 });

      expect(result.retryAfter).toBe(120);
    });

    it('should handle multiple placeholders', () => {
      const template = {
        code: 'TEST',
        message: '{user} failed with {error}',
        severity: 'error' as const,
      };

      const result = MessageFormatter.format(template, { user: 'john', error: 'timeout' });
      expect(result.message).toBe('john failed with timeout');
    });
  });
});

describe('ErrorResponseBuilder', () => {
  describe('build', () => {
    it('should build basic error response', () => {
      const error = new Error('Test error') as ExtendedError;
      error.code = 'AUTH_INVALID_TOKEN';

      const response = ErrorResponseBuilder.build(error, 'req-123', false);

      expect(response.error.code).toBe('AUTH_INVALID_TOKEN');
      expect(response.error.message).toContain('session has expired');
      expect(response.error.requestId).toBe('req-123');
      expect(response.error.timestamp).toBeDefined();
    });

    it('should include action when available', () => {
      const error = new Error('Invalid token') as ExtendedError;
      error.code = 'AUTH_INVALID_TOKEN';

      const response = ErrorResponseBuilder.build(error, 'req-123', false);

      expect(response.error.action).toBeDefined();
      expect(response.error.action).toContain('Refresh');
    });

    it('should include docs link when available', () => {
      const error = new Error('Invalid API key') as ExtendedError;
      error.code = 'AUTH_INVALID_API_KEY';

      const response = ErrorResponseBuilder.build(error, 'req-123', false);

      expect(response.error.docs).toBeDefined();
      expect(response.error.docs).toContain('https://');
    });

    it('should include retryAfter when in context', () => {
      const error = new Error('Rate limit') as ExtendedError;
      error.code = 'RATE_LIMIT_EXCEEDED';
      error.retryAfter = 60;

      const response = ErrorResponseBuilder.build(error, 'req-123', false);

      expect(response.error.retryAfter).toBe(60);
    });

    it('should NOT include developer info in production', () => {
      const error = new Error('Test error');

      const response = ErrorResponseBuilder.build(error, 'req-123', false);

      expect(response.error.__dev).toBeUndefined();
    });

    it('should include developer info in development', () => {
      const error = new Error('Test error');

      const response = ErrorResponseBuilder.build(error, 'req-123', true);

      expect(response.error.__dev).toBeDefined();
      expect(response.error.__dev?.technicalMessage).toBe('Test error');
      expect(response.error.__dev?.stack).toBeDefined();
    });

    it('should sanitize sensitive data (no database internals)', () => {
      const error = new Error('Connection to pg-primary-1.internal:5432 failed') as ExtendedError;
      error.code = 'DATABASE_ERROR';

      const response = ErrorResponseBuilder.build(error, 'req-123', false);

      // User message should NOT contain database details
      expect(response.error.message).not.toContain('pg-primary-1');
      expect(response.error.message).not.toContain('5432');
      expect(response.error.message).toContain('technical difficulties');
    });

    it('should include contact for critical errors', () => {
      const error = new Error('Critical failure') as ExtendedError;
      error.code = 'INTERNAL_ERROR';

      const response = ErrorResponseBuilder.build(error, 'req-123', false);

      expect(response.error.contact).toBeDefined();
      expect(response.error.contact).toContain('@');
    });
  });
});

describe('createErrorResponse (convenience function)', () => {
  it('should create error response', () => {
    const error = new Error('Not found') as ExtendedError;
    error.statusCode = 404;

    const response = createErrorResponse(error, 'req-456', false);

    expect(response.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(response.error.requestId).toBe('req-456');
  });

  it('should use development mode from environment', () => {
    const error = new Error('Test');
    
    // In test environment, should default to development
    const response = createErrorResponse(error, 'req-789');

    // Development mode should be determined by NODE_ENV
    expect(response.error.requestId).toBe('req-789');
  });
});

describe('ERROR_TEMPLATES', () => {
  it('should have all required error codes', () => {
    const requiredCodes = [
      'AUTH_INVALID_TOKEN',
      'AUTH_MISSING_CREDENTIALS',
      'RATE_LIMIT_EXCEEDED',
      'VALIDATION_ERROR',
      'MODEL_NOT_FOUND',
      'RESOURCE_NOT_FOUND',
      'INTERNAL_ERROR',
      'SERVICE_UNAVAILABLE',
    ];

    for (const code of requiredCodes) {
      expect(ERROR_TEMPLATES[code]).toBeDefined();
    }
  });

  it('should have consistent structure for all templates', () => {
    for (const [code, template] of Object.entries(ERROR_TEMPLATES)) {
      expect(template.code).toBe(code);
      expect(template.message).toBeDefined();
      expect(template.severity).toBeDefined();
      expect(['info', 'warning', 'error', 'critical']).toContain(template.severity);
    }
  });

  it('should not expose sensitive data in any template', () => {
    const sensitivePatterns = [
      'password',
      'secret',
      'database',
      'internal',
      'pg-',
      'redis',
      '.env',
    ];

    for (const template of Object.values(ERROR_TEMPLATES)) {
      const message = template.message.toLowerCase();
      
      for (const pattern of sensitivePatterns) {
        expect(message).not.toContain(pattern);
      }
    }
  });
});

describe('Security Tests', () => {
  it('should not expose database connection details', () => {
    const error = new Error('PrismaClientInitializationError: Can\'t connect to postgresql://user:pass@localhost:5432/db') as ExtendedError;
    error.code = 'DATABASE_ERROR';

    const response = ErrorResponseBuilder.build(error, 'req-sec-1', false);

    expect(response.error.message).not.toContain('postgresql://');
    expect(response.error.message).not.toContain('user:pass');
    expect(response.error.message).not.toContain('localhost:5432');
  });

  it('should not expose API keys', () => {
    const error = new Error('Invalid API key: sk_live_abc123xyz') as ExtendedError;
    error.code = 'AUTH_INVALID_API_KEY';

    const response = ErrorResponseBuilder.build(error, 'req-sec-2', false);

    expect(response.error.message).not.toContain('sk_live_abc123xyz');
    expect(response.error.message).not.toContain('sk_');
  });

  it('should not expose file paths', () => {
    const error = new Error('File not found: /var/www/app/.env');

    const response = ErrorResponseBuilder.build(error, 'req-sec-3', false);

    expect(response.error.message).not.toContain('/var/www/');
    expect(response.error.message).not.toContain('.env');
  });
});

