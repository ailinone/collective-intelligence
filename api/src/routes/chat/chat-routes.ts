// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Chat completion routes
 * POST /v1/chat/completions (streaming and non-streaming)
 *
 * ARCHITECTURE DECISION: Only chat completions implemented
 * - No assistants/threads/responses endpoints (Assistants API)
 * - CLI operates in one-shot mode, not conversational
 * - Each command is independent, context prepared locally
 * - Future: Consider assistants for persistent agents/refactoring sessions
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChatRequest, ChatResponse, ChatMessage, MessageContent, Model } from '@/types';
import type { Logger } from 'pino';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { TierContext } from '@/services/pricing-tier-billing';
import { OrchestrationEngine, detectMediaGenerationModality } from '@/core/orchestration/orchestration-engine';
import { inferCapabilities } from '@/core/orchestration/capability-inference';
import { authenticate as _authenticate } from '@/middleware/auth-middleware';
import {
  requireTenantContext as _requireTenantContext,
  getTenantContext as _getTenantContext,
} from '@/api/middleware/tenant-isolation-middleware';
import { logger } from '@/utils/logger';
import { nanoid } from 'nanoid';
import { processChatRequest } from '@/services/chat-request-processor';
import { enqueueIfNeeded, queueManagerMiddleware as _queueManagerMiddleware } from '@/api/middleware/queue-manager';
import { getRequestLogger } from '@/services/request-logger';
import {
  setupSSEHeaders,
  sendSSEChunk,
  sendSSEDone,
  sendSSEError,
  StreamHandler,
} from '@/utils/sse';
import { getProviderRegistry } from '@/providers/provider-registry';
import { computeDynamicFirstChunkTimeoutMs } from '@/routes/chat/streaming-first-chunk-timeout';
import { getFailoverService } from '@/services/provider-failover-service';
import { checkQuota } from '@/services/quota-service';
import { evaluateGovernance } from '@/services/org-governance-service';
import { gateChatRequest } from '@/services/prepaid-wallet-gate';
import { recordSecurityEvent } from '@/services/security-audit-service';
import { trackChatUsage } from '@/services/billing-usage-tracker';
import { getIntelligentModelSelectionService } from '@/services/intelligent-model-selection-service';
import { providerAvailabilityService } from '@/services/provider-availability-service';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import { ensureStringArray } from '@/utils/type-guards';
import { isDevelopment } from '@/config';
import { resolveAilinVirtualModelAlias } from '@/services/ailin-virtual-model-service';
import {
  debitTierRequest,
  estimatePromptTokens,
  extractTierContext,
  gateTierRequest,
  isTierBillingEnabled,
} from '@/services/pricing-tier-billing';
import { executeRouteWithRetry } from '@/utils/route-retry';
import { withIdempotency } from '@/middleware/idempotency-middleware';
import {
  STRATEGY_INPUT_VALUES,
  canonicalizeStrategyInput,
  resolveExecutionStrategy,
} from '@/core/orchestration/strategy-contract';

/**
 * Request body schema
 */
const chatCompletionSchema = {
  body: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        description:
          'Model ID (e.g., "gpt-4", "claude-3-opus"), "auto", or Ailin virtual aliases (e.g., "ailin-auto", "ailin-best", "ailin-fast", "ailin-economy", "ailin-consensus"). Virtual aliases map to autonomous orchestration profiles and still use dynamic provider/model discovery.',
      },
      messages: {
        type: 'array',
        items: {
          type: 'object',
          required: ['role', 'content'],
          properties: {
            role: {
              type: 'string',
              enum: ['system', 'user', 'assistant', 'function', 'tool'],
              description: 'Message role: system (instructions), user (user input), assistant (model response), function/tool (tool results)',
            },
            content: {
              oneOf: [
                { type: 'string', description: 'Text content' },
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { 
                        type: 'string', 
                        enum: ['text', 'image_url'],
                        description: 'Content part type: text (plain text) or image_url (image reference)',
                      },
                      text: { 
                        type: 'string',
                        description: 'Text content (required when type is "text")',
                      },
                      image_url: {
                        type: 'object',
                        description: 'Image URL object (required when type is "image_url")',
                        properties: {
                          url: { 
                            type: 'string',
                            description: 'Image URL (must be publicly accessible or use data URI format)',
                          },
                          detail: { 
                            type: 'string', 
                            enum: ['low', 'high', 'auto'],
                            description: 'Image detail level: low (cost-effective, 512x512), high (full resolution), auto (adaptive based on image size)',
                          },
                        },
                      },
                    },
                  },
                  description: 'Array of content parts (text and/or images) for multimodal messages',
                },
                {
                  type: 'object',
                  properties: {
                    type: { 
                      type: 'string',
                      description: 'Content type (e.g., "text", "image_url")',
                    },
                    text: { 
                      type: 'string',
                      description: 'Text content (when type is "text")',
                    },
                    image_url: { 
                      type: 'object',
                      description: 'Image URL object (when type is "image_url")',
                    },
                  },
                  additionalProperties: true,
                  description: 'Content object format (alternative to array format for multimodal content)',
                },
              ],
              description: 'Message content (string, array of parts, or object)',
            },
            name: { type: 'string', description: 'Optional name for the message (for function/tool messages)' },
            tool_calls: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: 'Tool calls made by the assistant',
            },
            tool_call_id: { type: 'string', description: 'ID of the tool call this message responds to' },
          },
        },
        minItems: 1,
        description: 'Array of messages in the conversation. Must contain at least one message.',
      },
      temperature: {
        type: 'number',
        minimum: 0,
        maximum: 2,
        default: 1,
        description: 'Sampling temperature (0-2). Higher values make output more random. Lower values make it more focused and deterministic.',
      },
      max_tokens: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum number of tokens to generate in the completion. Model-dependent limits apply.',
      },
      top_p: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Nucleus sampling parameter. Consider tokens with top_p probability mass. Alternative to temperature.',
      },
      frequency_penalty: {
        type: 'number',
        minimum: -2,
        maximum: 2,
        default: 0,
        description: 'Penalty for frequent tokens (-2 to 2). Positive values reduce repetition.',
      },
      presence_penalty: {
        type: 'number',
        minimum: -2,
        maximum: 2,
        default: 0,
        description: 'Penalty for new topics (-2 to 2). Positive values encourage new topics.',
      },
      stop: {
        oneOf: [
          { type: 'string', description: 'Single stop sequence' },
          { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Up to 4 stop sequences' },
        ],
        description: 'Stop sequences. Generation stops when any sequence is encountered.',
      },
      stream: {
        type: 'boolean',
        default: false,
        description: 'Enable streaming mode. Returns Server-Sent Events (SSE) stream of completion chunks.',
      },
      tools: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['function'] },
            function: {
              type: 'object',
              description: 'Function tool definition. Required when type is "function".',
              properties: {
                name: { 
                  type: 'string',
                  description: 'Function name (must be unique, lowercase/underscore, a-z, 0-9, _). Used by the model to identify which function to call.',
                },
                description: { 
                  type: 'string',
                  description: 'Function description explaining what the function does. The model uses this to decide when to call the function.',
                },
                parameters: { 
                  type: 'object', 
                  additionalProperties: true,
                  description: 'JSON Schema object defining function parameters. Must be valid JSON Schema describing the expected input structure.',
                },
              },
            },
          },
        },
        description: 'List of tools (functions) available to the model. Model may choose to call these tools.',
      },
      tool_choice: {
        oneOf: [
          { type: 'string', enum: ['none', 'auto'], description: 'Tool choice mode: none (no tools) or auto (model decides)' },
          { type: 'object', additionalProperties: true, description: 'Force specific tool call' },
        ],
        description: 'Controls which tool (if any) the model calls. "none" disables tools, "auto" lets model decide.',
      },
      response_format: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['json_object', 'text'] },
        },
        description: 'Response format. Use { type: "json_object" } to force JSON output.',
      },
      // Ailin-specific extensions
      strategy: {
        type: 'string',
        enum: STRATEGY_INPUT_VALUES,
        description:
          'Ailin-specific: Canonical strategy contract with compatibility aliases. Canonical: single, cost, speed, quality, balanced, parallel, debate, quality_multipass, dynamic.',
      },
      max_cost: {
        type: 'number',
        minimum: 0,
        description: 'Ailin-specific: Maximum cost in USD for this request. Orchestration will select models within budget.',
      },
      quality_target: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Ailin-specific: Quality target (0-1). Higher values prioritize quality over cost/speed.',
      },
      task_type: {
        type: 'string',
        description: 'Ailin-specific: Task type hint (e.g., "code-generation", "analysis", "creative") for better model selection',
      },
      no_cache: {
        type: 'boolean',
        description: 'Ailin-specific: Skip semantic cache lookup. Used for experiment validation to force real LLM calls.',
      },
      freeze_learning: {
        type: 'boolean',
        description: 'Ailin-specific: Do not feed learning/bandit updates from this request. Used by the experiment harness during the frozen measurement phase to keep the system fixed.',
      },
      rag_config: {
        type: 'object',
        description:
          'Ailin-specific (native RAG): retrieve the most relevant chunks from the named vector stores (scoped to your organization) using the last user message as the query, and inject them as a grounding context message before the conversation runs. Retrieved sources are returned in ailin_metadata.retrieval.',
        properties: {
          vector_store_ids: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Vector store IDs to search. Only stores owned by your organization are queried.',
          },
          top_k: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'Per-store nearest-neighbour depth (default 5).',
          },
          max_chunks: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'Hard cap on total chunks injected across all stores (default 8).',
          },
          score_threshold: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Drop retrieved chunks whose cosine similarity is below this value.',
          },
        },
        required: ['vector_store_ids'],
      },
    },
    required: ['messages'],
  },
};

const chatCompletionResponseSchema = {
  type: 'object',
  required: ['id', 'object', 'created', 'model', 'choices', 'usage'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', description: 'Unique identifier for the completion' },
    object: { type: 'string', description: 'Object type identifier (always "chat.completion")' },
    created: { type: 'integer', description: 'Unix timestamp when the completion was created' },
    model: { type: 'string', description: 'Model ID used for this completion' },
    choices: {
      type: 'array',
      description: 'Array of completion choices. Usually contains one choice unless n > 1',
    items: {
        type: 'object',
        required: ['index', 'message', 'finish_reason'],
        additionalProperties: true,
        description: 'A completion choice containing the generated message',
        properties: {
          index: { type: 'integer', description: 'Index of the choice (0-based)' },
          finish_reason: { type: 'string', description: 'Reason for completion: stop (natural end), length (token limit), tool_calls (tool usage required), content_filter (content filtered), or function_call (deprecated)' },
          logprobs: {
            anyOf: [
              { type: 'null', description: 'No logprobs returned' },
              { type: 'object', additionalProperties: true, description: 'Log probability information for tokens' },
            ],
            description: 'Log probabilities for tokens (if requested)',
          },
          message: {
            type: 'object',
            required: ['role', 'content'],
            additionalProperties: true,
            description: 'The generated message from the model',
            properties: {
              role: { type: 'string', description: 'Message role: assistant (model response)' },
              content: {
                oneOf: [
                  { type: 'string', description: 'Text content as a string' },
                  {
                    type: 'array',
                    description: 'Array of content parts (for multimodal responses)',
                    items: { type: 'object', additionalProperties: true, description: 'Content part object (text, image_url, etc.)' },
                  },
                ],
                description: 'Message content (string or array of parts)',
              },
              refusal: {
                anyOf: [
                  { type: 'null', description: 'No refusal reason' },
                  { type: 'string', description: 'Reason why the model refused to respond (safety/content policy)' },
                ],
                description: 'Refusal reason if the model declined to respond',
              },
              tool_calls: {
                anyOf: [
                  { type: 'null', description: 'No tool calls made' },
                  {
                    type: 'array',
                    description: 'Array of tool calls made by the model',
                    items: { type: 'object', additionalProperties: true, description: 'Tool call object containing function name and arguments' },
                  },
                ],
                description: 'Tool calls made by the model (if tools were used)',
              },
            },
          },
        },
      },
    },
    usage: {
      type: 'object',
      required: ['prompt_tokens', 'completion_tokens', 'total_tokens'],
      additionalProperties: true,
      description: 'Token usage statistics for this completion',
      properties: {
        prompt_tokens: { type: 'integer', description: 'Number of tokens in the prompt' },
        completion_tokens: { type: 'integer', description: 'Number of tokens in the completion' },
        total_tokens: { type: 'integer', description: 'Total tokens used (prompt + completion)' },
      },
    },
    system_fingerprint: { 
      anyOf: [
        { type: 'null', description: 'No system fingerprint available' },
        { type: 'string', description: 'System fingerprint for reproducibility' },
      ],
      description: 'System fingerprint identifying the backend configuration used',
    },
    ailin_metadata: { 
      type: 'object', 
      additionalProperties: true,
      description: 'Ailin-specific metadata about the completion (model used, provider, cost, etc.)',
    },
  },
};

function normalizeChatRequest(chatRequest: ChatRequest): ChatRequest {
  const normalizedMessages = (chatRequest.messages ?? []).map((message) =>
    normalizeChatMessage(message)
  );

  const normalizedStrategyInput =
    typeof chatRequest.strategy === 'string'
      ? canonicalizeStrategyInput(chatRequest.strategy)
      : undefined;
  const resolvedStrategy =
    typeof chatRequest.strategy === 'string'
      ? resolveExecutionStrategy(chatRequest.strategy)
      : undefined;

  const modelValue = typeof chatRequest.model === 'string' ? chatRequest.model.trim() : '';
  const aliasResolution = resolveAilinVirtualModelAlias(modelValue);
  const modelProvided = modelValue.length > 0;
  const explicitlyAuto = modelValue.toLowerCase() === 'auto' || aliasResolution !== null;
  const hasUserFlag = 'user_specified_model' in chatRequest;
  const strategyFromAlias =
    !chatRequest.strategy && aliasResolution?.strategy
      ? aliasResolution.strategy
      : undefined;

  const normalizedRequest: ChatRequest = {
    ...chatRequest,
    model: aliasResolution ? aliasResolution.model : chatRequest.model,
    strategy: resolvedStrategy ?? (normalizedStrategyInput === 'dynamic' ? 'auto' : chatRequest.strategy),
    messages: normalizedMessages,
  };

  if (strategyFromAlias) {
    normalizedRequest.strategy = strategyFromAlias;
  }
  if (aliasResolution?.qualityTarget !== undefined && normalizedRequest.quality_target === undefined) {
    normalizedRequest.quality_target = aliasResolution.qualityTarget;
  }
  if (aliasResolution?.maxCost !== undefined && normalizedRequest.max_cost === undefined) {
    normalizedRequest.max_cost = aliasResolution.maxCost;
  }
  if (aliasResolution?.taskType && normalizedRequest.task_type === undefined) {
    normalizedRequest.task_type = aliasResolution.taskType;
  }
  if (aliasResolution?.constraints) {
    normalizedRequest.ailin_constraints = mergeRuntimeConstraints(
      aliasResolution.constraints,
      normalizedRequest.ailin_constraints
    );
  }
  // Preserve the `<strategy>:<tier>` pricing context across normalization (the model
  // id is rewritten to 'auto' above). SERVER-side: the client cannot inject a tier
  // rate — it only ever comes from the resolved alias.
  if (aliasResolution?.tier && aliasResolution.tierRate) {
    normalizedRequest.ailin_tier = aliasResolution.tier;
    normalizedRequest.ailin_tier_rate = aliasResolution.tierRate;
  } else {
    delete normalizedRequest.ailin_tier;
    delete normalizedRequest.ailin_tier_rate;
  }
  // SECURITY (billing precedence): the billing profile (markup multipliers, flat
  // fees, minimum/maximum charge) is a SERVER-side revenue policy keyed off the
  // resolved alias. It MUST NOT be overridable by the client — previously a
  // request could send `ailin_billing: { enabled: false }` (or lowered
  // multipliers/fees) and `enabled === false` short-circuits applyBillingProfile()
  // in billing-usage-tracker.ts, zeroing the platform markup the caller should be
  // charged. We therefore make the alias profile authoritative and DROP any
  // client-supplied ailin_billing:
  //   - if the alias carries a billing profile, that profile always wins;
  //   - if it does not, we strip the client value entirely (a client cannot
  //     inject a more-favorable profile when none was server-configured).
  // This matches responses-routes.ts, which already uses aliasResolution?.billing
  // directly and ignores any client-sent value.
  if (aliasResolution?.billing) {
    normalizedRequest.ailin_billing = aliasResolution.billing;
  } else {
    delete normalizedRequest.ailin_billing;
  }
  if (aliasResolution?.alias) {
    normalizedRequest.ailin_alias = aliasResolution.alias;
  }

  if (aliasResolution) {
    normalizedRequest.user_specified_model = false;
  } else if (!hasUserFlag) {
    normalizedRequest.user_specified_model = modelProvided && !explicitlyAuto;
  }

  return normalizedRequest;
}

function mergeRuntimeConstraints(
  base: NonNullable<ChatRequest['ailin_constraints']>,
  overrides: ChatRequest['ailin_constraints']
): ChatRequest['ailin_constraints'] {
  if (!overrides) {
    return base;
  }

  const mergeStringArray = (a?: string[], b?: string[]): string[] | undefined => {
    const merged = [...(a ?? []), ...(b ?? [])].map((entry) => entry.trim()).filter(Boolean);
    return merged.length > 0 ? Array.from(new Set(merged)) : undefined;
  };

  return {
    requiredCapabilities:
      overrides.requiredCapabilities && overrides.requiredCapabilities.length > 0
        ? Array.from(new Set(overrides.requiredCapabilities))
        : base.requiredCapabilities,
    requiredTools: mergeStringArray(base.requiredTools, overrides.requiredTools),
    requiredEndpoint: overrides.requiredEndpoint ?? base.requiredEndpoint,
    preferredProviders: mergeStringArray(base.preferredProviders, overrides.preferredProviders),
    excludedProviders: mergeStringArray(base.excludedProviders, overrides.excludedProviders),
    maxInputCostPer1k: overrides.maxInputCostPer1k ?? base.maxInputCostPer1k,
    maxOutputCostPer1k: overrides.maxOutputCostPer1k ?? base.maxOutputCostPer1k,
    maxAverageCostPer1k: overrides.maxAverageCostPer1k ?? base.maxAverageCostPer1k,
    minContextWindow: overrides.minContextWindow ?? base.minContextWindow,
  };
}

function normalizeChatMessage(message: ChatMessage): ChatMessage {
  const normalizedContent = normalizeMessageContent(message.content);

  return {
    ...message,
    content: normalizedContent,
  };
}

function normalizeMessageContent(content: ChatMessage['content']): ChatMessage['content'] {
  if (Array.isArray(content)) {
    return content.map((item) => normalizeContentItem(item));
  }

  if (typeof content === 'string') {
    return content;
  }

  if (content == null) {
    return '';
  }

  return String(content);
}

function normalizeContentItem(item: MessageContent | string | Record<string, unknown>): MessageContent {
  if (typeof item === 'string') {
    return { type: 'text', text: item };
  }

  if (typeof item === 'object' && item !== null) {
    const typed = item as Record<string, unknown>;

    if (typed.type === 'text') {
      const text = typeof typed.text === 'string' ? typed.text : String(typed.text ?? '');
      return { type: 'text', text };
    }

    if (typed.type === 'image_url') {
      const imageUrl = typed.image_url;
      if (
        typeof imageUrl === 'object' &&
        imageUrl !== null &&
        'url' in imageUrl &&
        typeof imageUrl.url === 'string'
      ) {
        const detail =
          'detail' in imageUrl && typeof imageUrl.detail === 'string'
            ? (imageUrl.detail as 'low' | 'high' | 'auto')
            : undefined;
        return {
          type: 'image_url',
          image_url: {
            url: imageUrl.url,
            detail,
          },
        };
      }
    }
  }

  return {
    type: 'text',
    text: typeof item === 'object' ? JSON.stringify(item) : String(item ?? ''),
  };
}

/**
 * Register chat routes
 */
export async function registerChatRoutes(
  server: FastifyInstance,
  orchestrationEngine: OrchestrationEngine
): Promise<void> {
  /**
   * POST /v1/chat/completions
   * Chat completion endpoint (streaming and non-streaming)
   */
  server.post<{ Body: ChatRequest }>(
    '/v1/chat/completions',
    {
      schema: {
        tags: ['Chat'],
        summary: 'Create a chat completion',
        description: 'Create a chat completion with intelligent multi-model orchestration. Supports streaming and non-streaming modes. Automatically selects the best model based on requirements, cost, and quality targets.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          ...chatCompletionSchema.body,
          required: ['messages'],
          additionalProperties: true,
        },
        response: {
          200: {
            description: 'Successful completion',
            ...chatCompletionResponseSchema,
          },
          202: {
            description: 'Request queued for asynchronous processing',
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['queued'], description: 'Queue status' },
              message: { type: 'string', description: 'Queue message' },
              queueId: { type: 'string', description: 'Queue ID for tracking' },
              position: { type: 'integer', description: 'Position in queue' },
              estimatedWaitTimeMs: { type: 'integer', description: 'Estimated wait time in milliseconds' },
              priority: { type: 'integer', description: 'Request priority' },
              tier: { type: 'string', enum: ['enterprise', 'pro', 'free'], description: 'User tier' },
              systemLoad: { type: 'number', description: 'Current system load' },
              reason: { type: 'string', description: 'Reason for queueing' },
              pollAfterMs: { type: 'integer', description: 'Recommended polling interval in milliseconds' },
              statusUrl: { type: 'string', description: 'URL to check request status' },
              expiresAt: { type: 'integer', description: 'Unix timestamp when request expires' },
            },
          },
          400: {
            description: 'Bad request (invalid input)',
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  message: { type: 'string', description: 'Error message' },
                  type: { type: 'string', description: 'Error type' },
                  code: { type: 'string', description: 'Error code' },
                },
              },
            },
          },
          401: {
            description: 'Unauthorized',
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
          429: {
            description: 'Rate limit exceeded',
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
      preHandler: [_authenticate],
    },
    async (request, reply) => {
      const chatRequest = normalizeChatRequest(request.body);
      const userContext = createOrchestrationContext(request);
      const organizationId = userContext.organizationId;
      const userId = userContext.userId || '';

      if (!organizationId || !userId) {
        return reply.status(401).send({
          error: {
            code: 'unauthorized',
            message: 'Tenant context required',
          },
        });
      }

      // Three independent gates against three different data sources (quota
      // counters, org governance settings, prepaid wallet) — none depends on
      // another's result, so run them concurrently instead of one DB round-trip
      // after another. The priority of which error wins when multiple gates
      // reject (quota > governance > wallet) is preserved below by checking the
      // results in the same order the sequential code did.
      const [quotaCheck, governanceDecision, walletGate] = await Promise.all([
        checkQuota(organizationId, {
          organizationId,
          userId,
          operation: { requests: 1 },
        }),
        evaluateGovernance(organizationId, {
          strategy: chatRequest.strategy,
          model: chatRequest.model,
        }),
        gateChatRequest(organizationId, chatRequest),
      ]);

      if (!quotaCheck.allowed) {
        return reply.status(429).send({
          error: {
            code: 'quota_exceeded',
            message: quotaCheck.reason ?? 'Organization quota exceeded for chat completions.',
            remaining: quotaCheck.remaining,
            reset_at: quotaCheck.resetAt,
          },
        });
      }

      // Enterprise governance enforcement: monthly budget cap + access policy.
      // Fail-OPEN — orgs without governance configured are unaffected. A
      // configured cap (organization_budget_exceeded) or allow/block list
      // (policy_violation) is the only thing that can deny here, with 403.
      if (!governanceDecision.allowed) {
        await recordSecurityEvent({
          eventType:
            governanceDecision.code === 'organization_budget_exceeded'
              ? 'governance.budget.blocked'
              : 'governance.policy.blocked',
          severity: 'warning',
          message: governanceDecision.message ?? 'Request denied by organization governance.',
          userId,
          organizationId,
          metadata: {
            code: governanceDecision.code,
            requestedModel: chatRequest.model,
            requestedStrategy: chatRequest.strategy,
            ...(governanceDecision.details ?? {}),
          },
        });
        return reply.status(403).send({
          error: {
            code: governanceDecision.code,
            message: governanceDecision.message,
            ...(governanceDecision.details ?? {}),
          },
        });
      }

      // Prepaid-balance gate. Flag-gated (PREPAID_WALLET_GATE_ENABLED) and a
      // no-op for non-tiered models — only `<strategy>:<tier>` pricing cells are
      // gated. Rejects 402 insufficient_funds when the org wallet can't cover the
      // worst-case charge. Fail-open on wallet errors (see prepaid-wallet-gate).
      // (walletGate itself was already resolved above, concurrently with quota/governance.)
      if (!walletGate.allowed) {
        return reply.status(walletGate.status ?? 402).send(walletGate.body);
      }

      const requestId = nanoid();
      const startTime = Date.now();

      const requestLog = logger.child({
        endpoint: '/v1/chat/completions',
        organizationId,
        userId,
        requestId,
        requestedModel: chatRequest.model,
        requestedStrategy: chatRequest.strategy,
        stream: chatRequest.stream,
      });

      requestLog.info('Chat completion request received');

      // Check if providers are available
      const providerRegistry = getProviderRegistry();
      const availableProviders = providerRegistry.getProviderNames();
      if (availableProviders.length === 0) {
        requestLog.error('No LLM providers configured');
        return reply.status(503).send({
          error: {
            code: 'service_unavailable',
            message:
              'No LLM providers are configured. Please configure at least one provider (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)',
          },
        });
      }

      // Prepaid spend gate for `<strategy>:<tier>` products. Flag-gated (default OFF)
      // and fail-open; covers BOTH streaming and non-streaming (runs before the split).
      // `tierCtx` is reused at the debit site inside the idempotency handler below.
      const tierCtx = isTierBillingEnabled()
        ? extractTierContext({ tier: chatRequest.ailin_tier, tierRate: chatRequest.ailin_tier_rate })
        : null;
      if (tierCtx) {
        const gate = await gateTierRequest(
          organizationId,
          tierCtx,
          estimatePromptTokens(chatRequest.messages),
          chatRequest.max_tokens ?? 4096
        );
        if (!gate.ok) {
          requestLog.warn(
            { tier: tierCtx.tier, balanceUsd: gate.balanceUsd, requiredUsd: gate.requiredUsd },
            'Tier request gated: insufficient prepaid balance'
          );
          return reply.status(402).send({
            error: {
              code: 'insufficient_funds',
              type: 'insufficient_funds',
              message: `Insufficient prepaid balance for tier '${tierCtx.tier}'. Balance $${gate.balanceUsd.toFixed(4)}, required ~$${gate.requiredUsd.toFixed(4)}. Add credits to continue.`,
            },
          });
        }
      }

      try {
        // Handle streaming (no cache for streaming)
        if (chatRequest.stream) {
          return handleStreamingRequest(
            request,
            reply,
            chatRequest,
            orchestrationEngine,
            organizationId,
            userId,
            requestLog,
            requestId,
            tierCtx
          );
        }

        // Attempt to enqueue if queue recommends (non-streaming only).
        // NOTE: queueing returns a 202 async-acknowledgment, not the final
        // completion, so it runs BEFORE idempotency and is never cached as a
        // replayable response.
        const queueDecision = await enqueueIfNeeded(request, requestId, chatRequest);
        if (queueDecision.queued) {
          requestLog.info(
            {
              queueId: queueDecision.response?.queueId,
              position: queueDecision.response?.position,
              tier: queueDecision.response?.tier,
              systemLoad: queueDecision.response?.systemLoad,
            },
            'Request routed to queue'
          );
          return reply.status(202).send(queueDecision.response);
        }

        // Wrap the billable execution with Idempotency-Key support. Without
        // the header this is a transparent passthrough; with it, identical
        // retries replay the original 200 response instead of re-billing.
        return await withIdempotency({
          request,
          reply,
          organizationId,
          requestBody: chatRequest,
          isStreaming: false,
          handler: async () => {
            const { response } = await executeRouteWithRetry(
              () =>
                processChatRequest({
                  chatRequest,
                  orchestrationEngine,
                  organizationId,
                  userId,
                  requestId,
                  log: requestLog,
                }),
              {
                operationName: 'POST /v1/chat/completions',
                requestId,
                log: requestLog,
                isIdempotent: true,
                maxAttempts: 3,
                baseDelayMs: 200,
                maxDelayMs: 1200,
              }
            );

            // Debit the prepaid wallet on the user's ACTUAL tokens at the tier rate.
            // Inside the idempotency handler → idempotent replays do NOT re-bill.
            if (tierCtx) {
              await debitTierRequest(
                organizationId,
                tierCtx,
                response?.usage?.prompt_tokens ?? 0,
                response?.usage?.completion_tokens ?? 0,
                requestId
              );
            }

            return { httpStatus: 200, body: response };
          },
        });
      } catch (error: unknown) {
        const durationMs = Date.now() - startTime;
        const errorObj = error instanceof Error ? error : new Error(String(error));

        // Extract error details safely using type guards
        const { extractStatusCode } = await import('@/utils/type-guards');
        const statusCode = extractStatusCode(error);
        
        const errorMessage = error instanceof Error 
          ? error.message 
          : typeof error === 'string' 
            ? error 
            : 'An unexpected error occurred';
        
        const errorStack = error instanceof Error ? error.stack : undefined;
        
        // Log error details for debugging
        requestLog.error(
          {
            error: errorMessage,
            stack: errorStack,
            statusCode: statusCode,
            errorType: error instanceof Error ? error.constructor.name : typeof error,
            errorName: error instanceof Error ? error.name : undefined,
          },
          'Chat completion failed'
        );

        // Log error to database asynchronously (don't await - non-blocking)
        const requestLogger = getRequestLogger();
        requestLogger
          .logError(
            organizationId,
            userId,
            requestId,
            '/v1/chat/completions',
            'POST',
            errorObj,
            durationMs,
            chatRequest
          )
          .catch((logError: unknown) => {
            const logErrorMessage = logError instanceof Error ? logError.message : String(logError);
            requestLog.error({ error: logErrorMessage }, 'Failed to log error to database');
          });

        // Handle specific error status codes
        if (statusCode === 429) {
          return reply.code(429).type('application/json').send({
            error: {
              code: 'rate_limit_exceeded',
              message: 'Rate limit exceeded. Please try again later.',
            },
          });
        }

        if (statusCode === 401) {
          return reply.code(401).type('application/json').send({
            error: {
              code: 'unauthorized',
              message: 'Invalid or missing authentication.',
            },
          });
        }

        if (statusCode && statusCode >= 400 && statusCode < 500) {
          const { extractErrorCodeFromObject } = await import('@/utils/type-guards');
          const clientErrorCode = extractErrorCodeFromObject(error) || 'bad_request';
          return reply.code(statusCode).type('application/json').send({
            error: {
              code: clientErrorCode,
              message: errorMessage || 'Request could not be processed',
            },
          });
        }

        // Handle Prisma errors specifically
        const { extractErrorCodeFromObject } = await import('@/utils/type-guards');
        const prismaCode = extractErrorCodeFromObject(error);
        if (prismaCode === 'P2002') {
          return reply.code(409).type('application/json').send({
            error: {
              code: 'duplicate_entry',
              message: 'A record with this value already exists',
            },
          });
        }
        if (prismaCode === 'P2003' || prismaCode === 'P2014') {
          return reply.code(400).type('application/json').send({
            error: {
              code: 'foreign_key_constraint',
              message: 'Invalid reference to related record',
            },
          });
        }
        if (prismaCode === 'P2025') {
          return reply.code(404).type('application/json').send({
            error: {
              code: 'record_not_found',
              message: 'The requested record was not found',
            },
          });
        }
        
        // Default error response - ensure proper serialization
        const errorResponse: {
          error: {
            code: string;
            message: string;
            stack?: string;
          };
        } = {
          error: {
            code: 'internal_error',
            message: errorMessage || 'An unexpected error occurred',
          },
        };

        // Add stack trace in development
        if (isDevelopment && errorStack) {
          errorResponse.error.stack = errorStack;
        }
        
        return reply.code(500).type('application/json').send(errorResponse);
      }
    }
  );
}

/**
 * Handle streaming request (SSE)
 */
/**
 * Extract a bounded, TEXT-ONLY excerpt of the LAST user turn, for the
 * streaming media/file-artifact gate below. Two deliberate constraints, both
 * from confirmed defects in an earlier design (2026-07-16 adversarial
 * review):
 *  - LAST TURN ONLY, not the full joined history — inferCapabilities'
 *    underlying regex layer scans whatever text it's given, and the
 *    non-streaming heuristic-fallback path already joins ALL user turns
 *    (that's correct for ITS purpose, a one-shot classification of the whole
 *    conversation-so-far). Reusing that same join here would mean a single
 *    "generate a pdf" earlier in a long-running chat permanently redirects
 *    every later streaming turn — confirmed by execution to reproduce
 *    exactly that way.
 *  - TEXT PARTS ONLY, capped — a multipart message's non-text parts
 *    (image_url, primarily) can carry multi-megabyte base64 payloads;
 *    JSON.stringify-ing the whole content array and running the full regex
 *    battery over it measured ~2s of synchronous event-loop blocking per 2MB
 *    payload (paid on EVERY streaming request, hit or not) and could even
 *    spuriously match a media-generation token inside random base64 bytes.
 *    Skipping non-text parts entirely and capping the extracted text bounds
 *    the cost to a few microseconds regardless of attachment size.
 */
export const STREAMING_MEDIA_GATE_TEXT_CAP = 4000;

export function extractLastUserTurnTextForMediaGate(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
    return text.slice(0, STREAMING_MEDIA_GATE_TEXT_CAP);
  }
  return '';
}

async function handleStreamingRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  chatRequest: ChatRequest,
  orchestrationEngine: OrchestrationEngine,
  organizationId: string,
  userId: string | undefined,
  requestLog: Logger,
  requestId: string,
  tierCtx: TierContext | null
): Promise<void> {
  const requestLogger = getRequestLogger();
  const streamHandler = new StreamHandler();
  const providerRegistry = getProviderRegistry();
  const failoverService = getFailoverService();
  const startTime = Date.now();

  // File-generation artifact coverage on streaming (2026-07-16/17 architecture
  // audit, v2 after an earlier all-modality design was rejected by adversarial
  // review, and this v2 itself fixed 3 further confirmed defects from a
  // SECOND adversarial review — see the three points below marked "v2 fix").
  // Scope is DELIBERATELY narrower than the original attempt:
  //  - FILE modality only (docx/csv/json/pdf/.../code_file_generation), NOT
  //    image/video/audio. Those media regexes (IMAGE_GEN_KEYWORDS etc.) have
  //    no tool-noun guard the way the file-format regexes do. Media-modality
  //    streaming coverage needs that guard hardening done first; it stays a
  //    zero-coverage gap for now, same as before this change.
  //  - (v2 fix) Narrowing the GATE to file-modality does NOT, by itself,
  //    prevent chat-request-processor's separate, more permissive
  //    detectVideoGenerationIntent from firing once stream:false is forced —
  //    confirmed by execution: "Render a clip of the intro, and also
  //    generate a downloadable pdf report" is classified file-only by THIS
  //    gate (its own VIDEO_GEN_KEYWORDS verb list doesn't include "render"),
  //    forces stream:false, and detectVideoGenerationIntent's independent,
  //    wider verb list DOES include "render" — triggering a real video
  //    generation call instead of the requested PDF. Fixed by passing
  //    `disableVideoEarlyPath: true` through to processChatRequest, which
  //    unconditionally skips that early path regardless of the stream flag —
  //    see its doc comment in chat-request-processor.ts.
  //  - Routed through the SAME billing-complete pipeline as the non-streaming
  //    handler (withIdempotency + processChatRequest + debitTierRequest) —
  //    the v1 attempt called processChatRequest directly and skipped
  //    debitTierRequest entirely, generating artifacts for free under tier
  //    billing.
  //  - (v2 fix) NOT passing `isStreaming: true` to withIdempotency: an
  //    earlier draft of this v2 did, which made a client-supplied
  //    Idempotency-Key give ZERO de-dup protection (that flag unconditionally
  //    bypasses the store) — newly consequential here because this is the
  //    first isStreaming:true caller with a real billing side effect
  //    (confirmed by execution: a same-key SSE retry re-ran processChatRequest
  //    + debitTierRequest in full, double-billing). This redirect's response
  //    is a single, complete ChatResponse (not genuine token-by-token
  //    streaming), so it's exactly as cacheable/replayable as the ordinary
  //    non-streaming handler's response — the `sendResponse` hook below
  //    already re-frames a REPLAYED response as SSE too, so full idempotency
  //    (lock + cache + replay) is correct here, not just safe.
  //  - (v2 fix) Wrapped in a real try/catch with setupSSEHeaders called once
  //    up front and sendSSEDone/reply.raw.end() unconditionally afterward,
  //    mirroring the COLLECTIVE_STRATEGIES branch below: the first draft did
  //    `return withIdempotency(...).then(() => undefined)` with no try/catch,
  //    and withIdempotency's own handler() invocation on the passthrough path
  //    has none either — confirmed by execution that a thrown error (e.g.
  //    executeRouteWithRetry exhausting retries) propagated as an unhandled
  //    rejection all the way to Fastify's default error handler, sending a
  //    plain `application/json` 500 instead of a well-formed SSE error event.
  //  - Last-turn-only, text-only, capped extraction — see
  //    extractLastUserTurnTextForMediaGate's doc comment.
  //  - Queueing (enqueueIfNeeded) is NOT replicated here: it's a load-shed
  //    decision that returns an async 202 with a poll-for-result contract
  //    that has no SSE equivalent. Deliberately out of scope — under load,
  //    a redirected request just runs inline like the queued===false path.
  const mediaGateText = extractLastUserTurnTextForMediaGate(chatRequest.messages);
  const mediaGateInference = inferCapabilities([{ role: 'user', content: mediaGateText }], {
    tools: chatRequest.tools,
    max_tokens: chatRequest.max_tokens,
  });
  if (detectMediaGenerationModality(mediaGateInference.requiredCapabilities) === 'file') {
    requestLog.info('File-generation intent detected on streaming request — redirecting to non-streaming artifact pipeline');
    try {
      await withIdempotency({
        request,
        reply,
        organizationId,
        requestBody: chatRequest,
        handler: async () => {
          const { response } = await executeRouteWithRetry(
            () =>
              processChatRequest({
                chatRequest: { ...chatRequest, stream: false },
                orchestrationEngine,
                organizationId,
                userId,
                requestId,
                log: requestLog,
                disableVideoEarlyPath: true,
              }),
            {
              operationName: 'POST /v1/chat/completions (streaming file-artifact redirect)',
              requestId,
              log: requestLog,
              isIdempotent: true,
              maxAttempts: 3,
              baseDelayMs: 200,
              maxDelayMs: 1200,
            }
          );
          if (tierCtx) {
            await debitTierRequest(
              organizationId,
              tierCtx,
              response?.usage?.prompt_tokens ?? 0,
              response?.usage?.completion_tokens ?? 0,
              requestId
            );
          }
          return { httpStatus: 200, body: response };
        },
        // 2026-07-17, second adversarial-review round: this closure must end
        // the raw stream itself (sendSSEDone + reply.raw.end()) BEFORE
        // returning — `FastifyReply` is a thenable (Fastify's own reply
        // lifecycle promise, resolved once `raw.writableEnded` is true), and
        // `withIdempotency` does `return sendResponse(...)` inside an async
        // function on every non-throwing branch (passthrough, isStreaming
        // bypass, replay, acquired-success, and every structured 400/401/
        // 409/503 early return). Returning `sseReply` there means JS's
        // async-function return semantics ADOPT that thenable instead of
        // resolving immediately — confirmed by execution (real Fastify +
        // fastify.inject, not the hand-rolled fake reply the unit tests use)
        // that `await withIdempotency(...)` hung forever for every one of
        // those branches, since this closure previously only did raw
        // WRITES (sendSSEChunk/sendSSEError), never raw.end() — the caller
        // called that afterward, a genuine circular wait. Node sets
        // `raw.writableEnded = true` SYNCHRONOUSLY when `.end()` returns, so
        // ending the stream here, before returning, resolves the thenable
        // right away instead of deadlocking.
        // setupSSEHeaders runs HERE, not before withIdempotency, and NOT in
        // the outer code — confirmed by execution (2026-07-17, third
        // adversarial-review round) that calling it up front made
        // `Idempotency-Replayed`/`Retry-After` silently vanish: those are
        // queued via `reply.header(...)` INSIDE withIdempotency (sendReplay,
        // the fail-closed 503 branch) before this closure ever runs, and
        // `setupSSEHeaders`'s `raw.writeHead()` now merges `reply.getHeaders()`
        // (see its doc comment) — but only if it hasn't already committed the
        // headers earlier. Calling it here, as the first thing in the ONE
        // closure that runs after every such reply.header() call, is what
        // lets that merge actually pick them up.
        sendResponse: (sseReply, httpStatus, body) => {
          setupSSEHeaders(sseReply);
          if (httpStatus >= 200 && httpStatus < 300) {
            sendSSEChunk(sseReply, body as ChatResponse);
          } else {
            const message =
              (body as { error?: { message?: string } } | undefined)?.error?.message ??
              'File-generation request failed';
            sendSSEError(sseReply, new Error(message));
          }
          sendSSEDone(sseReply);
          sseReply.raw.end();
          return sseReply;
        },
      });
    } catch (err) {
      // Reached either when the handler THROWS before withIdempotency ever
      // calls sendResponse (headers not sent yet — the common case), OR when
      // sendResponse itself started (already called setupSSEHeaders) and
      // THEN threw (e.g. a pathological body failing to serialize inside
      // sendSSEChunk). Guarding on `headersSent` matters for the second
      // case: calling setupSSEHeaders again would throw
      // ERR_HTTP_HEADERS_SENT, which — confirmed by execution, 4th
      // adversarial-review round — itself becomes an uncaught rejection
      // that hangs the client instead of delivering a clean SSE error.
      if (!reply.raw.headersSent) {
        setupSSEHeaders(reply);
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      requestLog.error({ error: errorMsg }, 'File-generation streaming redirect failed');
      sendSSEError(reply, err instanceof Error ? err : new Error(errorMsg));
      sendSSEDone(reply);
      reply.raw.end();
    }
    return;
  }

  // Track all attempts for comprehensive error logging
  const allAttempts: Array<{
    attempt: number;
    provider: string;
    model: string;
    success: boolean;
    error?: string;
    errorCode?: string;
    errorType?: string;
    latencyMs: number;
  }> = [];

  // Collective strategies (debate, consensus, quality-multipass) use hybrid streaming:
  // Phase 1: multi-model rounds yield SSE progress events
  // Phase 2: synthesis LLM call streams token-by-token
  const COLLECTIVE_STRATEGIES = new Set([
    'consensus',
    'debate',
    'quality-multipass',
    'quality_multipass',
    'parallel',
    'war-room',
    'blind-debate',
    'devil-advocate-consensus',
    'swarm-explore',
    'expert-panel',
    'stigmergic-refinement',
    'diversity-ensemble',
    'safety-quorum',
    'collaborative',
    'clarification-first',
    'research-synthesize',
    'critique-repair',
    'double-diamond',
    'multi-hop-qa',
    'persona-exploration',
    'agentic',
  ]);
  const requestedStrategy = typeof chatRequest.strategy === 'string' ? chatRequest.strategy : '';
  if (COLLECTIVE_STRATEGIES.has(requestedStrategy)) {
    setupSSEHeaders(reply);
    try {
      for await (const chunk of orchestrationEngine.executeStream(
        chatRequest,
        organizationId,
        userId
      )) {
        sendSSEChunk(reply, chunk);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      requestLog.error({ error: errorMsg }, 'Collective strategy stream failed');
      sendSSEError(reply, err instanceof Error ? err : new Error(errorMsg));
    }
    sendSSEDone(reply);
    // Close the HTTP response after [DONE]. The other streaming paths already
    // reply.raw.end() (see below); the collective path did not, so the socket
    // lingered open after the terminal [DONE] until the client/keep-alive
    // timeout — a connection leak under load (and why a naive client that does
    // not stop on [DONE] would block until its own timeout).
    reply.raw.end();
    return;
  }

  try {
    requestLog.info('Starting SSE streaming');
    setupSSEHeaders(reply);

    const plan = await orchestrationEngine.createStreamingPlan(
      chatRequest,
      organizationId,
      userId,
      requestId
    );

    // Extract required capabilities from request
    const requiredCapabilities: string[] = ['streaming'];
    if (chatRequest.tools && chatRequest.tools.length > 0) {
      requiredCapabilities.push('function_calling', 'tool_use');
    }

    // Select ALL capable fallback models (no artificial limit)
    const fallbackModels = await failoverService.selectFallbackOptions(
      plan.context.models,
      plan.model,
      plan.context.budget,
      plan.context.qualityTarget,
      {
        requireCapabilities: requiredCapabilities,
        // No maxFallbacks limit - try ALL capable models
      }
    );

    requestLog.info(
      {
        primaryModel: plan.model.id,
        primaryProvider: plan.model.provider,
        fallbackCount: fallbackModels.length,
        requiredCapabilities,
      },
      'Model selection complete - no artificial fallback limit'
    );

    const candidates: Array<{ model: Model; adapter: ProviderAdapter; request: ChatRequest }> = [];
    const seenModels = new Set<string>();

    const pushCandidate = (model: Model, adapter: ProviderAdapter, baseRequest: ChatRequest) => {
      if (seenModels.has(model.id)) {
        return;
      }
      seenModels.add(model.id);
      candidates.push({
        model,
        adapter,
        request: {
          ...baseRequest,
          model: model.id,
          stream: true,
        },
      });
    };

    pushCandidate(plan.model, plan.adapter, plan.request);

    // Bound how many fallback candidates we RESOLVE up front. selectFallbackOptions
    // returns EVERY capable model ("no artificial limit") — in prod that is ~5000+
    // — and resolving each via `await providerRegistry.findModel()` SERIALLY before
    // the first stream attempt blocked the whole request for ~100s (firstByte never
    // arrived → the client aborted at its timeout). A streaming fallback CHAIN only
    // ever needs a handful: if the primary + N fallbacks all fail, the request is
    // doomed regardless. Env-tunable; not a model pin (it caps the chain length,
    // selection order is unchanged and fully dynamic).
    const maxStreamFallbacks = Number(process.env.STREAMING_MAX_FALLBACKS ?? 8);
    for (const fallback of fallbackModels) {
      if (candidates.length > maxStreamFallbacks) break;
      const result = await providerRegistry.findModel(fallback.id);
      if (result) {
        pushCandidate(result.model, result.adapter, plan.request);
      }
    }

    if (candidates.length === 0) {
      throw new Error('No streaming-capable providers available');
    }

    // Hot-first reorder (residual-cascade fix, 2026-07-13): the hot-aware
    // ranking from e598553 (hub route states + isRouteHot) was only ever
    // applied to the buffered cross-provider retry in base-strategy.ts —
    // never to THIS chain, the most-used path. Consequence (measured): the
    // selector's #1 pick could be an unknown/cold route that accepts the
    // connection and stalls, burning the full 6s first-chunk deadline
    // before a route that is PROVEN SERVING RIGHT NOW (rank 3, e.g. kept
    // warm by the keep-warm cron) got its turn — the classic ~9s TTFT
    // spike (6s timeout + ~2s healthy TTFB). Rank convention matches
    // computeOperabilityRanks: 3=hot > 2=operable > 1=unknown >
    // 0=proven-bad. Sort is stable, so ties keep the selector's order —
    // within "all unknown" nothing changes. Rank by the EXECUTION provider
    // (adapter.getName()), not the catalog provider — same lesson as the
    // no-credits marking in base-strategy.
    // Kept outside the try so the streaming loop below can reuse the same
    // rank data to size the first-chunk timeout per candidate — a `null`
    // here (rank computation failed) makes every candidate fall back to the
    // static timeout, same as today.
    let candidateRanks: Map<(typeof candidates)[number], number> | null = null;
    try {
      const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
      const hub = getProviderOperabilityHub();
      const PROVEN_BAD = new Set(['auth_failed', 'no_credits', 'rate_limited', 'temporarily_unavailable']);
      const routeRank = (c: (typeof candidates)[number]): number => {
        const provider = (c.adapter.getName() || c.model.provider || '').toLowerCase();
        if (!provider) return 1;
        const st = hub.getRouteState(provider, c.model.id).operabilityState;
        if (PROVEN_BAD.has(st)) return 0;
        if (hub.isRouteHot(provider, c.model.id)) return 3;
        if (st === 'healthy' || st === 'recovering' || st === 'degraded') return 2;
        return 1;
      };
      const ranks = new Map(candidates.map((c) => [c, routeRank(c)] as const));
      candidates.sort((a, b) => (ranks.get(b) ?? 1) - (ranks.get(a) ?? 1));
      candidateRanks = ranks;
    } catch (rankError) {
      requestLog.warn(
        { error: rankError instanceof Error ? rankError.message : String(rankError) },
        'Hot-first candidate reorder failed — keeping selector order'
      );
    }

    requestLog.info(
      {
        totalCandidates: candidates.length,
        candidateList: candidates.map((c) => ({
          model: c.model.id,
          provider: c.model.provider,
        })),
      },
      'All capable models ready for fallback chain'
    );

    let lastError: unknown = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const attempt = index + 1;
      const attemptStart = Date.now();
      let chunkCount = 0;
      let totalTokens = 0;
      let lastChunk: ChatResponse | null = null;
      let firstChunkSent = false;

      try {
        requestLog.info(
          {
            attempt,
            totalCandidates: candidates.length,
            provider: candidate.adapter.getName(),
            model: candidate.model.name,
            modelId: candidate.model.id,
            capabilities: candidate.model.capabilities,
          },
          'Streaming attempt started'
        );

        reply.raw.write(
          `: streaming-provider attempt=${attempt}/${candidates.length} provider=${candidate.adapter.getName()} model=${candidate.model.name}\n\n`
        );

        const providerStream = streamHandler.handleProviderStream(
          candidate.adapter.chatCompletionStream(candidate.request),
          candidate.model.name
        );

        // Bound the provider stream so a STALLED provider (e.g. a HuggingFace
        // serverless cold-start that accepts the request then never emits a
        // token, or stops mid-answer without closing the SSE) cannot hang the
        // whole request with no error. A first-chunk timeout converts a pre-token
        // stall into a thrown error → the catch below falls through to the next
        // candidate (firstChunkSent is still false). An idle timeout closes a
        // mid-stream stall so the request finishes instead of hanging. Both are
        // TIMEOUTS, not model choices — env-tunable, selection stays dynamic.
        //
        // FAIL-FAST (2026-07-11): default lowered 20000ms -> 6000ms. Measured in
        // production (real benchmark, not simulated): a healthy provider's TTFB is
        // hundreds of ms to ~1-2s; the 20s default meant that whenever the
        // OPERABILITY-cache-selected primary candidate was degraded-but-not-yet-
        // marked-dead, the client sat for up to 20s before failover — this was the
        // dominant contributor to the measured p90 (~11.5s) for model=auto. 6s is
        // comfortably above any observed healthy TTFB (avoids false-positive aborts
        // on legitimately slower reasoning models) while cutting the worst-case tail
        // more than 3x.
        const iterator = providerStream[Symbol.asyncIterator]();
        const staticFirstChunkTimeoutMs = Number(process.env.STREAMING_FIRST_CHUNK_MS ?? 6000);
        // Dynamic first-chunk deadline (2026-07-14) — see
        // streaming-first-chunk-timeout.ts for the rationale.
        const firstChunkTimeoutMs = computeDynamicFirstChunkTimeoutMs(
          candidates,
          index,
          candidateRanks,
          staticFirstChunkTimeoutMs,
          Number(process.env.STREAMING_FIRST_CHUNK_FALLBACK_MS ?? 1800),
        );
        const idleTimeoutMs = Number(process.env.STREAMING_IDLE_MS ?? 15000);
        if (firstChunkTimeoutMs !== staticFirstChunkTimeoutMs) {
          requestLog.debug(
            { attempt, firstChunkTimeoutMs, staticFirstChunkTimeoutMs },
            'Dynamic first-chunk timeout shortened — hot fallback candidate waiting in queue'
          );
        }
        const closeIterator = (): void => {
          try {
            const ret = iterator.return?.(undefined);
            if (ret && typeof (ret as Promise<unknown>).then === 'function') {
              (ret as Promise<unknown>).catch(() => { /* ignore */ });
            }
          } catch { /* ignore */ }
        };

        // First chunk under a hard deadline (rethrow on timeout → next candidate).
        let firstTimer: ReturnType<typeof setTimeout> | undefined;
        const firstDeadline = new Promise<never>((_, reject) => {
          firstTimer = setTimeout(
            () => reject(new Error(`first-chunk timeout after ${firstChunkTimeoutMs}ms`)),
            firstChunkTimeoutMs,
          );
        });
        let result: IteratorResult<ChatResponse>;
        try {
          result = await Promise.race([iterator.next(), firstDeadline]);
        } catch (firstErr) {
          closeIterator();
          throw firstErr;
        } finally {
          if (firstTimer) clearTimeout(firstTimer);
        }

        while (!result.done) {
          const chunk = result.value;
          chunkCount += 1;
          if (chunk.usage?.total_tokens) {
            totalTokens = chunk.usage.total_tokens;
          }
          lastChunk = chunk;
          firstChunkSent = true;
          sendSSEChunk(reply, chunk);
          // Flush response if available
          if ('flush' in reply.raw && typeof reply.raw.flush === 'function') {
            reply.raw.flush();
          }
          // Subsequent chunks under an IDLE deadline.
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          let idledOut = false;
          const idleDeadline = new Promise<IteratorResult<ChatResponse, undefined>>((resolve) => {
            idleTimer = setTimeout(() => {
              idledOut = true;
              // done:true → the iterator "return" variant. Typing TReturn as
              // `undefined` makes `value` concretely undefined (not the default
              // `any` slot), so there is no double-cast AND no unsafe assignment.
              // The value is unused anyway (idledOut is checked before it is read).
              resolve({ done: true, value: undefined });
            }, idleTimeoutMs);
          });
          try {
            result = await Promise.race([iterator.next(), idleDeadline]);
          } finally {
            if (idleTimer) clearTimeout(idleTimer);
          }
          if (idledOut) {
            requestLog.warn(
              { provider: candidate.adapter.getName(), model: candidate.model.name, idleTimeoutMs },
              'Single-stream idle past deadline — closing straggling provider stream',
            );
            closeIterator();
            break;
          }
        }

        sendSSEDone(reply);
        const durationMs = Date.now() - startTime;

        await requestLogger.logRequest({
          organizationId,
          userId,
          requestId,
          endpoint: '/v1/chat/completions',
          method: 'POST',
          strategyName: 'single-streaming',
          modelsUsed: [candidate.model.id],
          modelCount: 1,
          primaryModelId: candidate.model.id,
          durationMs,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens,
          costUsd: 0,
          status: 'success',
          metadata: {
            streaming: true,
            chunks: chunkCount,
            provider: candidate.adapter.getName(),
            fallbackAttempts: attempt - 1,
          },
          request: {
            model: candidate.model.id,
            stream: true,
            strategy: chatRequest.strategy ?? 'auto',
          },
          response: {
            id: lastChunk?.id,
            model: candidate.model.id,
            finish_reason: lastChunk?.choices?.[0]?.finish_reason ?? undefined,
          },
        });

        await trackChatUsage({
          organizationId,
          userId,
          requestId,
          request: chatRequest,
          cacheHit: false,
          strategyOverride: 'single-streaming',
          totalTokensOverride: totalTokens,
          totalCostOverride: 0,
          modelsOverride: [
            {
              modelId: candidate.model.id,
              modelName: candidate.model.name,
              tokens: totalTokens,
            },
          ],
        });

        requestLog.info(
          {
            attempt,
            provider: candidate.adapter.getName(),
            model: candidate.model.name,
            chunks: chunkCount,
            tokens: totalTokens,
            duration: durationMs,
          },
          'Streaming completed'
        );

        // Hub feedback — SUCCESS (2026-07-13): this streaming path — the
        // most-used one — never wrote to the operability hub, so no route it
        // served ever became "hot" (isRouteHot needs lastSuccessAt), which
        // made the hot-first candidate reorder above a permanent no-op for
        // streaming-only traffic, and the learning loop only saw the
        // buffered execute() path. Record the success so the route this
        // request just proved alive rises to #1 for the next request.
        try {
          const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
          getProviderOperabilityHub().recordRouteExecution(
            candidate.adapter.getName(), candidate.model.id, true,
          );
        } catch { /* hub unavailable — non-fatal */ }

        reply.raw.end();
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const attemptLatency = Date.now() - attemptStart;

        // Parse provider-specific error details
        interface ProviderError {
          message?: string;
          error?: { code?: string; type?: string; param?: string; message?: string };
          code?: string;
          type?: string;
          status?: number;
          response?: { 
            data?: { error?: { code?: string; type?: string; param?: string } };
            status?: number;
          };
        }
        const errorObj: ProviderError | null = error && typeof error === 'object' && error !== null
          ? error as ProviderError
          : null;
        const errorDetails = {
          message: errorObj?.message || errorObj?.error?.message || String(error),
          code: errorObj?.error?.code || errorObj?.code || errorObj?.response?.data?.error?.code,
          type: errorObj?.error?.type || errorObj?.type || errorObj?.response?.data?.error?.type,
          param: errorObj?.error?.param || errorObj?.response?.data?.error?.param,
          status: errorObj?.status || errorObj?.response?.status,
        };

        // Record attempt for final summary
        allAttempts.push({
          attempt,
          provider: candidate.adapter.getName(),
          model: candidate.model.name,
          success: false,
          error: errorDetails.message,
          errorCode: errorDetails.code,
          errorType: errorDetails.type,
          latencyMs: attemptLatency,
        });

        requestLog.error(
          {
            attempt,
            totalCandidates: candidates.length,
            provider: candidate.adapter.getName(),
            model: candidate.model.name,
            modelId: candidate.model.id,
            latencyMs: attemptLatency,
            error: {
              message: errorDetails.message,
              code: errorDetails.code,
              type: errorDetails.type,
              param: errorDetails.param,
              status: errorDetails.status,
            },
            remainingCandidates: candidates.length - attempt,
          },
          `Streaming attempt ${attempt}/${candidates.length} failed - ${errorDetails.code || 'UNKNOWN'}: ${errorDetails.message}`
        );

        // Hub feedback — FAILURE (2026-07-13, mirror of the success write
        // above): a 402/404/timeout here previously taught the hub NOTHING,
        // so the same dead/stalling candidate stayed #1 for every subsequent
        // request and the cascade repeated forever (measured: 15-19s TTFT
        // with 3 consistent runs, first candidate timing out every time).
        // recordRouteExecution classifies the status/message internally
        // (402 -> no_credits, 404 -> dead route, generic failure kills
        // hotness), sinking the route in the hot-first reorder.
        try {
          const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
          getProviderOperabilityHub().recordRouteExecution(
            candidate.adapter.getName(), candidate.model.id, false,
            errorDetails.status, errorDetails.message,
          );
        } catch { /* hub unavailable — non-fatal */ }

        if (firstChunkSent) {
          throw error;
        }

        reply.raw.write(
          `: streaming-fallback attempt=${attempt}/${candidates.length} provider=${candidate.adapter.getName()} error_code=${errorDetails.code || 'UNKNOWN'} error_type=${errorDetails.type || 'unknown'} message=${errorDetails.message}\n\n`
        );
      }
    }

    // Log comprehensive failure summary
    requestLog.error(
      {
        totalAttempts: allAttempts.length,
        totalCandidates: candidates.length,
        allAttempts: allAttempts.map((a) => ({
          attempt: a.attempt,
          provider: a.provider,
          model: a.model,
          errorCode: a.errorCode,
          errorType: a.errorType,
          latencyMs: a.latencyMs,
        })),
        uniqueErrorCodes: [...new Set(allAttempts.map((a) => a.errorCode).filter(Boolean))],
        uniqueProviders: [...new Set(allAttempts.map((a) => a.provider))],
      },
      'ALL streaming providers failed - comprehensive failure summary'
    );

    throw lastError ?? new Error(`All ${candidates.length} streaming providers failed`);
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorObj = error instanceof Error ? error : new Error(String(error));
    requestLog.error({ error: errorMessage, duration: durationMs, allAttempts }, 'Streaming failed');

    sendSSEError(reply, errorObj);
    sendSSEDone(reply);

    requestLogger
      .logError(
        organizationId,
        userId,
        requestId,
        '/v1/chat/completions',
        'POST',
        error as Error,
        durationMs,
        chatRequest
      )
      .catch((logError: unknown) => {
        const logErrorMessage = logError instanceof Error ? logError.message : String(logError);
        requestLog.error({ error: logErrorMessage }, 'Failed to log streaming error');
      });

    reply.raw.end();
  }
}

/**
 * Register capability analysis and intelligent selection endpoints
 */
export async function registerCapabilityRoutes(
  fastify: FastifyInstance,
  _orchestrationEngine: OrchestrationEngine
): Promise<void> {
  const intelligentSelection = getIntelligentModelSelectionService();

  /**
   * POST /v1/analyze-requirements
   * Analyzes a request and returns recommended capabilities and models
   */
  fastify.post<{ Body: ChatRequest }>(
    '/v1/analyze-requirements',
    {
      schema: {
        description: 'Analyze request requirements and suggest optimal model selection',
        tags: ['capabilities'],
        body: {
          ...chatCompletionSchema.body,
          required: [],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              requirements: {
                type: 'object',
                properties: {
                  required: { type: 'array', items: { type: 'string' } },
                  preferred: { type: 'array', items: { type: 'string' } },
                  taskType: { type: 'string' },
                  complexity: { type: 'string' },
                  contextSize: { type: 'number' },
                  needsTools: { type: 'boolean' },
                  toolCount: { type: 'number' },
                },
              },
              triage: {
                type: 'object',
                nullable: true,
                properties: {
                  suggestedCapabilities: { type: 'array', items: { type: 'string' } },
                  suggestedTaskType: { type: 'string' },
                  complexity: { type: 'string' },
                  confidence: { type: 'number' },
                  triageModelsUsed: { type: 'array', items: { type: 'string' } },
                  crossValidated: { type: 'boolean' },
                },
              },
              selection: {
                type: 'object',
                properties: {
                  totalModelsEvaluated: { type: 'number' },
                  totalModelsMatched: { type: 'number' },
                  selectionTime: { type: 'number' },
                  primaryCandidate: {
                    type: 'object',
                    nullable: true,
                    properties: {
                      modelId: { type: 'string' },
                      provider: { type: 'string' },
                      score: { type: 'number' },
                      reason: { type: 'string' },
                      matchedCapabilities: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  topCandidates: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        modelId: { type: 'string' },
                        provider: { type: 'string' },
                        score: { type: 'number' },
                        reason: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [_authenticate],
    },
    async (request, reply) => {
      const chatRequest = normalizeChatRequest(request.body);
      const requestId = nanoid();

      const requestLog = logger.child({
        endpoint: '/v1/analyze-requirements',
        requestId,
      });

      requestLog.info('Analyzing request requirements');

      try {
        // Step 1: Analyze requirements
        const requirements = await intelligentSelection.analyzeRequirements(chatRequest);

        // Step 2: Perform triage if complex enough
        const triage = await intelligentSelection.performInputTriage(chatRequest, requirements);

        // Step 3: Select capable models
        const selection = await intelligentSelection.selectCapableModels(requirements, triage);

        const response = {
          requirements,
          triage: triage ? {
            suggestedCapabilities: triage.suggestedCapabilities,
            suggestedTaskType: triage.suggestedTaskType,
            complexity: triage.complexity,
            confidence: triage.confidence,
            triageModelsUsed: triage.triageModelsUsed,
            crossValidated: triage.crossValidated,
          } : null,
          selection: {
            totalModelsEvaluated: selection.totalModelsEvaluated,
            totalModelsMatched: selection.totalModelsMatched,
            selectionTime: selection.selectionTime,
            primaryCandidate: selection.primaryCandidate ? {
              modelId: selection.primaryCandidate.model.id,
              provider: selection.primaryCandidate.model.provider,
              score: selection.primaryCandidate.score,
              reason: selection.primaryCandidate.reason,
              matchedCapabilities: selection.primaryCandidate.matchedCapabilities,
            } : null,
            topCandidates: selection.candidates.slice(0, 10).map(c => ({
              modelId: c.model.id,
              provider: c.model.provider,
              score: c.score,
              reason: c.reason,
            })),
          },
        };

        requestLog.info({
          complexity: requirements.complexity,
          taskType: requirements.taskType,
          modelsMatched: selection.totalModelsMatched,
          primaryModel: selection.primaryCandidate?.model.id,
        }, 'Requirements analysis complete');

        return reply.send(response);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        requestLog.error({ error: errorMessage }, 'Failed to analyze requirements');
        return reply.status(500).send({
          error: {
            code: 'analysis_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  /**
   * GET /v1/provider-capabilities
   * Returns all available providers and their capabilities
   */
  fastify.get(
    '/v1/provider-capabilities',
    {
      schema: {
        description: 'Get all available providers and their model capabilities',
        tags: ['capabilities'],
        response: {
          200: {
            type: 'object',
            properties: {
              providers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    displayName: { type: 'string' },
                    status: { type: 'string' },
                    modelCount: { type: 'number' },
                    availability: {
                      type: 'object',
                      properties: {
                        status: { type: 'string' },
                        reason: { type: 'string' },
                        missingEnv: { type: 'array', items: { type: 'string' } },
                        lastUpdated: { type: 'string' },
                      },
                    },
                    models: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          capabilities: { type: 'array', items: { type: 'string' } },
                          contextWindow: { type: 'number' },
                          inputCostPer1k: { type: 'number' },
                          outputCostPer1k: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
              summary: {
                type: 'object',
                properties: {
                  totalProviders: { type: 'number' },
                  totalModels: { type: 'number' },
                  capabilityCounts: {
                    type: 'object',
                    additionalProperties: { type: 'number' },
                  },
                  availability: {
                    type: 'object',
                    additionalProperties: {
                      type: 'object',
                      properties: {
                        status: { type: 'string' },
                        reason: { type: 'string' },
                        missingEnv: {
                          type: 'array',
                          items: { type: 'string' },
                        },
                        lastUpdated: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          500: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
      preHandler: [_authenticate],
    },
    async (_request, reply) => {
      const requestLog = logger.child({
        endpoint: '/v1/provider-capabilities',
      });

      try {
        const registry = getProviderRegistry();
        const allAdapters = registry.getAll();
        type ProviderModelInfo = {
          id: string;
          name: string;
          capabilities: string[];
          contextWindow: number;
          inputCostPer1k: number;
          outputCostPer1k: number;
        };

        type ProviderCapabilitiesInfo = {
          name: string;
          displayName?: string;
          status: string;
          modelCount: number;
          availability: {
            status: string;
            reason?: string;
            missingEnv?: string[];
            lastUpdated?: string;
          };
          models: ProviderModelInfo[];
        };

        const providers: ProviderCapabilitiesInfo[] = [];
        const capabilityCounts: Record<string, number> = {};
        let totalModels = 0;
        const availabilitySnapshot = providerAvailabilityService.getSnapshot();

        for (const adapter of allAdapters) {
          try {
            const providerInfo = await adapter.getProvider();
            const models = await adapter.getModels();

            totalModels += models.length;

            // Count capabilities
            for (const model of models) {
              for (const cap of model.capabilities || []) {
                capabilityCounts[cap] = (capabilityCounts[cap] || 0) + 1;
              }
            }

            const availability = availabilitySnapshot[providerInfo.name];
            const availabilityPayload = availability
              ? {
                  status: availability.status,
                  reason: availability.reason,
                  missingEnv: availability.missingEnv,
                  lastUpdated: availability.lastUpdated.toISOString(),
                }
              : {
                  status: 'available',
                };

            const modelPayload: ProviderModelInfo[] = models.map((model) => ({
              id: model.id,
              name: model.name,
              capabilities: ensureStringArray(model.capabilities),
              contextWindow: model.contextWindow,
              inputCostPer1k: model.inputCostPer1k,
              outputCostPer1k: model.outputCostPer1k,
            }));

            providers.push({
              name: providerInfo.name,
              displayName: providerInfo.displayName,
              status: providerInfo.status,
              modelCount: models.length,
              availability: availabilityPayload,
              models: modelPayload,
            });
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            requestLog.warn({ provider: adapter.getName(), error: errorMessage }, 'Failed to get provider info');
          }
        }

        return reply.send({
          providers,
          summary: {
            totalProviders: providers.length,
            totalModels,
            capabilityCounts,
            availability: Object.fromEntries(
              Object.entries(availabilitySnapshot).map(([key, value]) => [
                key,
                {
                  status: value.status,
                  reason: value.reason,
                  missingEnv: value.missingEnv,
                  lastUpdated: value.lastUpdated.toISOString(),
                },
              ])
            ),
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        requestLog.error({ error: errorMessage }, 'Failed to get provider capabilities');
        return reply.status(500).send({
          error: {
            code: 'capabilities_fetch_failed',
            message: errorMessage,
          },
        });
      }
    }
  );

  /**
   * POST /v1/chat/completions/intelligent
   * Uses intelligent model selection with triage and dynamic fallback
   */
  fastify.post<{ Body: ChatRequest }>(
    '/v1/chat/completions/intelligent',
    {
      schema: {
        tags: ['Chat', 'Intelligent'],
        summary: 'Create chat completion with intelligent selection',
        description: 'Chat completion with intelligent model selection, triage, and unlimited fallback. Uses advanced AI to analyze requirements and automatically select the best model, with automatic failover to alternative models if needed.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          ...chatCompletionSchema.body,
          required: ['messages'],
          additionalProperties: true,
        },
        response: {
          200: {
            description: 'Chat completion completed successfully',
            ...chatCompletionResponseSchema,
          },
          202: {
            description: 'Request queued for asynchronous processing',
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['queued'] },
              message: { type: 'string' },
              queueId: { type: 'string' },
              position: { type: 'integer' },
              estimatedWaitTimeMs: { type: 'integer' },
              priority: { type: 'integer' },
              tier: { type: 'string', enum: ['enterprise', 'pro', 'free'] },
              systemLoad: { type: 'number' },
              reason: { type: 'string' },
              pollAfterMs: { type: 'integer' },
              statusUrl: { type: 'string' },
              expiresAt: { type: 'integer' },
            },
          },
          400: {
            description: 'Bad request (invalid input)',
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
          401: {
            description: 'Unauthorized',
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
          429: {
            description: 'Rate limit exceeded',
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
      preHandler: [_authenticate, _requireTenantContext()],
    },
    async (request, reply) => {
      const chatRequest = normalizeChatRequest(request.body);
      const userContext = createOrchestrationContext(request);
      const organizationId = userContext.organizationId;
      const userId = userContext.userId || '';
      const requestId = nanoid();
      const startTime = Date.now();

      const requestLog = logger.child({
        endpoint: '/v1/chat/completions/intelligent',
        organizationId,
        userId,
        requestId,
        requestedModel: chatRequest.model,
      });

      requestLog.info('Intelligent chat completion request received');

      try {
        // Step 1: Analyze requirements
        const requirements = await intelligentSelection.analyzeRequirements(chatRequest);

        requestLog.info({
          complexity: requirements.complexity,
          taskType: requirements.taskType,
          requiredCapabilities: requirements.required,
        }, 'Requirements analyzed');

        // Step 2: Perform triage for complex requests
        const triage = await intelligentSelection.performInputTriage(chatRequest, requirements);

        if (triage) {
          requestLog.info({
            triageModels: triage.triageModelsUsed,
            suggestedCapabilities: triage.suggestedCapabilities,
            confidence: triage.confidence,
          }, 'Input triage completed');
        }

        // Step 3: Select capable models (no limit)
        const selection = await intelligentSelection.selectCapableModels(requirements, triage);

        requestLog.info({
          totalCandidates: selection.totalModelsMatched,
          primaryModel: selection.primaryCandidate?.model.id,
          selectionTime: selection.selectionTime,
        }, 'Model selection completed');

        if (!selection.primaryCandidate) {
          return reply.status(400).send({
            error: {
              code: 'no_capable_models',
              message: 'No models found matching the required capabilities',
              requirements: requirements.required,
            },
          });
        }

        // Step 4: Execute with intelligent fallback
        if (chatRequest.stream) {
          // Streaming execution
          setupSSEHeaders(reply);

          const streamGenerator = intelligentSelection.executeStreamingWithFallback(
            chatRequest,
            selection
          );

          let result;
          for await (const chunk of streamGenerator) {
            if (chunk.choices) {
              sendSSEChunk(reply, chunk);
            }
            result = chunk;
          }

          // Final result contains execution metadata
          if (result && !result.choices) {
            const execResult = result as { success?: boolean; modelsAttempted?: number; finalProvider?: string; finalModel?: string };
            reply.raw.write(
              `: execution-summary success=${execResult.success} attempts=${execResult.modelsAttempted} provider=${execResult.finalProvider} model=${execResult.finalModel}\n\n`
            );
          }

          sendSSEDone(reply);
          reply.raw.end();
        } else {
          // Non-streaming execution
          const result = await executeRouteWithRetry(
            () => intelligentSelection.executeWithIntelligentFallback(chatRequest, selection, organizationId, userId, requirements.required),
            {
              operationName: 'POST /v1/chat/completions/intelligent',
              requestId,
              log: requestLog,
              isIdempotent: true,
              maxAttempts: 3,
              baseDelayMs: 200,
              maxDelayMs: 1200,
            }
          );

          const durationMs = Date.now() - startTime;

          if (!result.success) {
            requestLog.error({
              attempts: result.attempts,
              durationMs,
            }, 'All models failed');

            return reply.status(500).send({
              error: {
                code: 'all_models_failed',
                message: `All ${result.modelsAttempted} capable models failed`,
                attempts: result.attempts.map(a => ({
                  provider: a.provider,
                  model: a.model,
                  error: a.error,
                  errorCode: a.errorCode,
                })),
              },
            });
          }

          requestLog.info({
            finalProvider: result.finalProvider,
            finalModel: result.finalModel,
            attempts: result.modelsAttempted,
            durationMs,
          }, 'Intelligent completion successful');

          // Add execution metadata to response
          const response = {
            ...result.response,
            _execution: {
              provider: result.finalProvider,
              model: result.finalModel,
              attempts: result.modelsAttempted,
              totalCandidates: selection.totalModelsMatched,
              triageUsed: !!triage,
              durationMs,
              // Canonical-engine cost accounting (DUP #1 demotion, 2026-06-11):
              // triage + judge + synthesizer folded into the request total.
              costUsd: result.costUsd,
              modelsUsed: result.modelsUsed,
            },
          };

          return reply.send(response);
        }
      } catch (error: unknown) {
        const durationMs = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        requestLog.error({ error: errorMessage, durationMs }, 'Intelligent completion failed');

        return reply.status(500).send({
          error: {
            code: 'intelligent_completion_failed',
            message: errorMessage,
          },
        });
      }
    }
  );
}
