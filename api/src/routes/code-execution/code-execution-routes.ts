// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Code Execution API Routes
 * Gemini-compatible code execution endpoints
 * 
 * Features:
 * - Multi-model orchestration (Gemini models with code_interpreter capability)
 * - Sandbox execution (E2B, Docker, etc.)
 * - Multiple languages (Python, JavaScript, etc.)
 * 
 * NO HARDCODED MODELS - Dynamic selection based on code_interpreter capability
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { CodeExecutionService } from '@/services/code-execution-service';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import { executeRouteWithRetry } from '@/utils/route-retry';

const log = logger.child({ module: 'code-execution-routes' });

export async function registerCodeExecutionRoutes(server: FastifyInstance): Promise<void> {
  const codeExecService = new CodeExecutionService();

  // POST /v1/code/execute
  server.post('/v1/code/execute', {
    schema: {
      tags: ['Code Execution'],
      summary: 'Execute code in sandbox',
      description: 'Executes code using dynamic capability routing with multi-backend sandbox policy (E2B primary, Daytona fallback, Local dev/emergency fallback). Automatically selects the best execution path based on runtime availability and policy.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['code', 'language'],
        properties: {
          code: {
            type: 'string',
            description: 'Code to execute',
          },
          language: {
            type: 'string',
            enum: ['javascript', 'typescript', 'python', 'java', 'csharp', 'go'],
            description: 'Programming language',
          },
          functionName: {
            type: 'string',
            description: 'Optional function name to execute',
          },
          tests: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                args: { type: 'array' },
                expected: {},
              },
            },
            description: 'Optional test cases to validate execution',
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1000,
            maximum: 300000,
            default: 30000,
            description: 'Execution timeout in milliseconds (1000-300000)',
          },
        },
      },
      response: {
        200: {
          description: 'Code executed successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            output: { type: 'string' },
            error: { type: 'string', nullable: true },
            executionTime: { type: 'number' },
            testsPassed: { type: 'integer', nullable: true },
            testsTotal: { type: 'integer', nullable: true },
            sandboxBackend: { type: 'string', nullable: true },
            sandboxFallbackChain: {
              type: 'array',
              items: { type: 'string' },
            },
            _ailin: {
              type: 'object',
              properties: {
                model_used: { type: 'string' },
                provider_used: { type: 'string' },
                duration_ms: { type: 'number' },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid input)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_code", "unsupported_language", "invalid_parameter")' },
              },
            },
          },
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., sandbox environment or model unavailable)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticateRequest,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const userContext = createOrchestrationContext(request, {
        taskType: 'code-generation',
        contextSize: 0,
      });
      
      try {
        const body = request.body;
        if (!body || typeof body !== 'object' || !('code' in body) || !('language' in body)) {
          return reply.code(400).send({
            error: {
              message: 'Missing required fields: code, language',
              type: 'invalid_request_error',
              code: 'missing_required_field',
            },
          });
        }
        
        // Safely extract code and language without type assertions
        let codeValue: unknown;
        let languageValue: unknown;
        
        if (body && typeof body === 'object' && body !== null) {
          const codeDescriptor = Object.getOwnPropertyDescriptor(body, 'code');
          if (codeDescriptor) {
            codeValue = codeDescriptor.value;
          }
          
          const languageDescriptor = Object.getOwnPropertyDescriptor(body, 'language');
          if (languageDescriptor) {
            languageValue = languageDescriptor.value;
          }
        }
        
        if (typeof codeValue !== 'string' || typeof languageValue !== 'string') {
          return reply.code(400).send({
            error: {
              message: 'Invalid field types: code and language must be strings',
              type: 'invalid_request_error',
              code: 'invalid_field_type',
            },
          });
        }
        
        const validLanguages = ['javascript', 'typescript', 'python', 'java', 'csharp', 'go'];
        if (!validLanguages.includes(languageValue)) {
          return reply.code(400).send({
            error: {
              message: `Invalid language. Must be one of: ${validLanguages.join(', ')}`,
              type: 'invalid_request_error',
              code: 'invalid_language',
            },
          });
        }
        
        const functionNameValue = 'functionName' in body && typeof (body as { functionName?: unknown }).functionName === 'string'
          ? (body as { functionName: string }).functionName
          : undefined;
        const testsValue = 'tests' in body && Array.isArray((body as { tests?: unknown }).tests)
          ? (body as { tests: Array<{ args: unknown[]; expected: unknown }> }).tests
          : undefined;
        const timeoutMsValue = 'timeoutMs' in body && typeof (body as { timeoutMs?: unknown }).timeoutMs === 'number'
          ? (body as { timeoutMs: number }).timeoutMs
          : 30000;

        const result = await executeRouteWithRetry(
          () =>
            codeExecService.executeCode({
              code: codeValue,
              language: languageValue as
                | 'javascript'
                | 'typescript'
                | 'python'
                | 'java'
                | 'csharp'
                | 'go',
              functionName: functionNameValue,
              tests: testsValue,
              timeoutMs: timeoutMsValue,
              userContext,
              requestId: request.id,
            }),
          {
            operationName: 'POST /v1/code/execute',
            requestId: request.id,
            log,
            isIdempotent: true,
            maxAttempts: 3,
            baseDelayMs: 200,
            maxDelayMs: 1200,
          }
        );

        return reply.send(result);
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Code execution failed';
        const statusCode = extractStatusCode(error) ?? 500;
        const errorType = extractErrorType(error) ?? 'internal_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'internal_error';
        
        log.error({ error: errorMessage, requestId: request.id }, 'Code execution failed');
        return reply.code(statusCode).send({
          error: {
            message: errorMessage,
            type: errorType,
            code: errorCode,
          },
        });
      }
    },
  });

  log.info('Code Execution API routes registered successfully');
}

