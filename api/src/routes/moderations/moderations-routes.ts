// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Moderations API Routes
 * OpenAI-compatible content moderation endpoints
 * 
 * Features:
 * - Multi-provider orchestration (OpenAI Moderation, Google Safety, Azure Content Safety, etc.)
 * - Dynamic model selection based on capabilities
 * - Detects hate, harassment, self-harm, sexual, violence, etc.
 * - Multi-language support
 * 
 * NO HARDCODED MODELS - All model selection is dynamic via capabilities
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { requireTenantContext } from '@/api/middleware/tenant-isolation-middleware';
import { ModerationsOrchestrationService } from '@/services/moderations-orchestration-service';
import {
  createPolicy,
  listPolicies,
  getPolicy,
  deletePolicy,
  applyPolicy,
  type ModerationAction,
  type ModerationThresholds,
  type CustomCategory,
  type BaseModerationItem,
} from '@/services/moderation-policy-service';
import type { OrchestrationContext } from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { createOrchestrationContext } from '@/utils/orchestration-context';

const log = logger.child({ module: 'moderations-routes' });

// ============================================
// Request Schemas (OpenAI-compatible)
// ============================================

const ModerationRequestSchema = z.object({
  input: z.union([
    z.string(),
    z.array(z.string()),
  ]),
  model: z.string().optional().default('auto'), // 'auto' triggers dynamic selection
  // Optional per-tenant custom policy. When set, the policy is loaded (org-scoped)
  // and its thresholds / custom categories are layered on top of the base result.
  policy_id: z.string().min(1).optional(),
});

// Custom policy CRUD payload schemas.
const ThresholdsSchema = z.record(z.string(), z.number());
const CustomCategorySchema = z.object({
  name: z.string().min(1),
  keywords: z.array(z.string()),
  description: z.string().optional(),
});
const CreatePolicySchema = z.object({
  name: z.string().min(1).max(120),
  thresholds: ThresholdsSchema.optional(),
  customCategories: z.array(CustomCategorySchema).optional(),
  action: z.enum(['flag', 'block']).optional(),
  enabled: z.boolean().optional(),
});

// ============================================
// Types
// ============================================

interface ModerationRequest {
  input: string | string[];
  model?: string;
  policy_id?: string;
}

interface CreatePolicyBody {
  name: string;
  thresholds?: ModerationThresholds;
  customCategories?: CustomCategory[];
  action?: ModerationAction;
  enabled?: boolean;
}

/** Resolve the caller's org id from the tenant context / extended request. */
function resolveOrganizationId(request: FastifyRequest): string | null {
  const ext = request as ExtendedFastifyRequest;
  if (ext.tenantContext?.organizationId) return ext.tenantContext.organizationId;
  if (typeof ext.organizationId === 'string' && ext.organizationId.length > 0) {
    return ext.organizationId;
  }
  return null;
}

// ============================================
// Register Routes
// ============================================

export async function registerModerationsRoutes(server: FastifyInstance): Promise<void> {
  const moderationsService = new ModerationsOrchestrationService();

  // ==========================================
  // POST /v1/moderations
  // ==========================================
  server.post('/v1/moderations', {
    schema: {
      tags: ['Moderations'],
      summary: 'Classify content for policy violations',
      description: 'Classifies if text violates content policy using multi-provider orchestration. Automatically selects the best moderation model based on language and content type.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['input'],
        properties: {
          input: { 
            anyOf: [
              { 
                type: 'string',
                description: 'Single text string to classify for policy violations',
              },
              { 
                type: 'array', 
                items: { 
                  type: 'string',
                  description: 'Text string in the array',
                },
                description: 'Array of text strings to classify (batch moderation)',
              },
            ],
            description: 'Text to classify for policy violations. Can be a single string or array of strings for batch processing.',
          },
          model: {
            type: 'string',
            default: 'auto',
            description: 'Model ID or "auto" for intelligent selection. When "auto", Ailin orchestrates across multiple moderation providers.',
          },
          policy_id: {
            type: 'string',
            description: 'Optional ID of a custom per-tenant moderation policy (created via POST /v1/moderations/policies). When set, the policy thresholds and custom categories are layered on top of the base result. Omit for the default OpenAI-style behavior.',
          },
        },
      },
      response: {
        200: {
          description: 'Moderation completed successfully',
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Moderation request ID' },
            model: { type: 'string', description: 'Model used for moderation' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                // additionalProperties lets the optional policy-layer fields
                // (blocked, policy_triggered) and custom-category keys reach the
                // client when a `policy_id` is applied; without it Fastify's
                // serializer would strip them.
                additionalProperties: true,
                properties: {
                  flagged: { type: 'boolean', description: 'Whether content was flagged' },
                  blocked: {
                    type: 'boolean',
                    description: "Present only when a policy with action='block' flagged the content. Signals the caller MUST reject it.",
                  },
                  policy_triggered: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Category keys re-flagged by the applied custom policy (threshold re-flags + custom-category matches). Present only when a policy_id was applied.',
                  },
                  categories: {
                    type: 'object',
                    additionalProperties: { type: 'boolean' },
                    properties: {
                      sexual: { type: 'boolean' },
                      hate: { type: 'boolean' },
                      harassment: { type: 'boolean' },
                      'self-harm': { type: 'boolean' },
                      'sexual/minors': { type: 'boolean' },
                      'hate/threatening': { type: 'boolean' },
                      'violence/graphic': { type: 'boolean' },
                      'self-harm/intent': { type: 'boolean' },
                      'self-harm/instructions': { type: 'boolean' },
                      'harassment/threatening': { type: 'boolean' },
                      violence: { type: 'boolean' },
                    },
                  },
                  category_scores: {
                    type: 'object',
                    additionalProperties: { type: 'number' },
                    properties: {
                      sexual: { type: 'number' },
                      hate: { type: 'number' },
                      harassment: { type: 'number' },
                      'self-harm': { type: 'number' },
                      'sexual/minors': { type: 'number' },
                      'hate/threatening': { type: 'number' },
                      'violence/graphic': { type: 'number' },
                      'self-harm/intent': { type: 'number' },
                      'self-harm/instructions': { type: 'number' },
                      'harassment/threatening': { type: 'number' },
                      violence: { type: 'number' },
                    },
                  },
                },
              },
            },
            _ailin: {
              type: 'object',
              additionalProperties: true,
              description: 'Ailin diagnostics: provider used, duration, and the applied policy (when a policy_id was supplied).',
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
                code: { type: 'string', description: 'Error code (e.g., "invalid_input", "empty_input")' },
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
          description: 'Resource not found (e.g., moderation service unavailable)',
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
                message: { type: 'string', description: 'Error message describing the server error' },
                type: { type: 'string', description: 'Error type (e.g., "server_error")' },
                code: { type: 'string', description: 'Error code (e.g., "internal_error")' },
              },
            },
          },
        },
      },
    },
    preHandler: [authenticateRequest, requireTenantContext()],
    handler: async (request: FastifyRequest<{ Body: ModerationRequest }>, reply: FastifyReply) => {
      const requestId = request.id;
      const extendedRequest = request as ExtendedFastifyRequest;
      const userContext: OrchestrationContext = extendedRequest.userContext || createOrchestrationContext(request);

      log.info({ requestId, model: request.body.model }, 'Moderation request received');

      try {
        // Validate request body
        const validated = ModerationRequestSchema.parse(request.body);

        const inputs = Array.isArray(validated.input) ? validated.input : [validated.input];

        // When a policy is requested, resolve it BEFORE running the base
        // classifier so a missing / cross-tenant policy_id fails fast with 404
        // (no wasted provider call). Org-scoped: getPolicy filters by org, so a
        // cross-tenant id is indistinguishable from a missing one → 404.
        let policy = null;
        if (validated.policy_id) {
          const organizationId = resolveOrganizationId(request);
          if (!organizationId) {
            return reply.code(401).send({
              error: {
                message: 'Authentication required to apply a moderation policy.',
                type: 'authentication_error',
                code: 'unauthorized',
              },
            });
          }
          policy = await getPolicy(organizationId, validated.policy_id);
          if (!policy) {
            return reply.code(404).send({
              error: {
                message: `Moderation policy "${validated.policy_id}" not found.`,
                type: 'not_found_error',
                code: 'policy_not_found',
              },
            });
          }
        }

        // Execute moderation via orchestration service
        const result = await moderationsService.moderateContent({
          inputs,
          model: validated.model === 'auto' ? undefined : validated.model,
          userContext,
          requestId,
        });

        // Layer the custom policy on top of the base result (no-op when no
        // policy was requested → behavior is byte-for-byte unchanged).
        const results = policy
          ? applyPolicy(policy, narrowAs<BaseModerationItem[]>(result.results), inputs)
          : result.results;

        // Return OpenAI-compatible response
        return reply.send({
          id: `modr-${requestId}`,
          model: result.modelUsed,
          results,
          _ailin: {
            provider_used: result.provider,
            duration_ms: result.durationMs,
            ...(policy
              ? { policy: { id: policy.id, name: policy.name, action: policy.action } }
              : {}),
          },
        });
      } catch (error: unknown) {
        const { getErrorMessage, extractStatusCode, extractErrorType, extractErrorCodeFromObject } = await import('@/utils/type-guards');
        
        const errorMessage = getErrorMessage(error) || 'Moderation request failed';
        const statusCode = extractStatusCode(error) ?? 500;
        const errorType = extractErrorType(error) ?? 'moderation_error';
        const errorCode = extractErrorCodeFromObject(error) ?? 'internal_error';
        
        log.error({ requestId, error: errorMessage }, 'Moderation request failed');
        
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

  // ==========================================
  // Custom moderation policies (per-tenant CRUD)
  // ==========================================
  const policyPreHandler = [authenticateRequest, requireTenantContext()];

  // POST /v1/moderations/policies — create a policy for the caller's org.
  server.post<{ Body: CreatePolicyBody }>(
    '/v1/moderations/policies',
    {
      schema: {
        tags: ['Moderations'],
        summary: 'Create a custom moderation policy',
        description:
          "Creates a per-tenant moderation policy (category thresholds + optional custom categories + action). Scoped to the caller's organization. The policy id can then be passed as `policy_id` to POST /v1/moderations.",
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120, description: 'Unique policy name within the organization.' },
            thresholds: {
              type: 'object',
              additionalProperties: { type: 'number', minimum: 0, maximum: 1 },
              description: 'Map of category key -> threshold in [0,1]. A base score >= threshold re-flags that category.',
            },
            customCategories: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'keywords'],
                properties: {
                  name: { type: 'string', minLength: 1 },
                  keywords: { type: 'array', items: { type: 'string' } },
                  description: { type: 'string' },
                },
              },
              description: 'Org-defined categories matched against the input text via case-insensitive keywords.',
            },
            action: { type: 'string', enum: ['flag', 'block'], default: 'flag' },
            enabled: { type: 'boolean', default: true },
          },
        },
      },
      preHandler: policyPreHandler,
    },
    async (request: FastifyRequest<{ Body: CreatePolicyBody }>, reply: FastifyReply) => {
      const organizationId = resolveOrganizationId(request);
      if (!organizationId) {
        return reply.code(401).send({
          error: { message: 'Authentication required.', type: 'authentication_error', code: 'unauthorized' },
        });
      }

      const parsed = CreatePolicySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            message: parsed.error.issues[0]?.message ?? 'Invalid policy payload.',
            type: 'invalid_request_error',
            code: 'invalid_request',
          },
        });
      }

      const result = await createPolicy(organizationId, parsed.data);
      if (!result.ok) {
        const status = result.code === 'name_conflict' ? 409 : result.code === 'organization_not_found' ? 404 : 400;
        return reply.code(status).send({
          error: { message: result.message, type: 'invalid_request_error', code: result.code },
        });
      }
      return reply.code(201).send({ policy: result.policy });
    }
  );

  // GET /v1/moderations/policies — list the caller's org policies.
  server.get(
    '/v1/moderations/policies',
    {
      schema: {
        tags: ['Moderations'],
        summary: 'List custom moderation policies',
        description: "Lists all moderation policies belonging to the caller's organization (newest-first).",
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      },
      preHandler: policyPreHandler,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = resolveOrganizationId(request);
      if (!organizationId) {
        return reply.code(401).send({
          error: { message: 'Authentication required.', type: 'authentication_error', code: 'unauthorized' },
        });
      }
      const policies = await listPolicies(organizationId);
      return reply.send({ object: 'list', data: policies });
    }
  );

  // GET /v1/moderations/policies/:id — fetch one (org-scoped, 404 cross-tenant).
  server.get<{ Params: { id: string } }>(
    '/v1/moderations/policies/:id',
    {
      schema: {
        tags: ['Moderations'],
        summary: 'Get a custom moderation policy',
        description: "Fetches one policy by id, scoped to the caller's organization. Cross-tenant ids return 404.",
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
      },
      preHandler: policyPreHandler,
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const organizationId = resolveOrganizationId(request);
      if (!organizationId) {
        return reply.code(401).send({
          error: { message: 'Authentication required.', type: 'authentication_error', code: 'unauthorized' },
        });
      }
      const policy = await getPolicy(organizationId, request.params.id);
      if (!policy) {
        return reply.code(404).send({
          error: { message: 'Moderation policy not found.', type: 'not_found_error', code: 'policy_not_found' },
        });
      }
      return reply.send({ policy });
    }
  );

  // DELETE /v1/moderations/policies/:id — delete one (org-scoped, 404 cross-tenant).
  server.delete<{ Params: { id: string } }>(
    '/v1/moderations/policies/:id',
    {
      schema: {
        tags: ['Moderations'],
        summary: 'Delete a custom moderation policy',
        description: "Deletes one policy by id, scoped to the caller's organization. Cross-tenant ids return 404.",
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
      },
      preHandler: policyPreHandler,
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const organizationId = resolveOrganizationId(request);
      if (!organizationId) {
        return reply.code(401).send({
          error: { message: 'Authentication required.', type: 'authentication_error', code: 'unauthorized' },
        });
      }
      const deleted = await deletePolicy(organizationId, request.params.id);
      if (!deleted) {
        return reply.code(404).send({
          error: { message: 'Moderation policy not found.', type: 'not_found_error', code: 'policy_not_found' },
        });
      }
      return reply.send({ id: request.params.id, deleted: true, object: 'moderation.policy.deleted' });
    }
  );

  log.info('Moderations API routes registered successfully');
}
