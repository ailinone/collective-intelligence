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
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ExecutionStrategyName,
  MessageContent,
  Model,
} from '@/types';
import type { Logger } from 'pino';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { TierContext } from '@/services/pricing-tier-billing';
import {
  OrchestrationEngine,
  detectMediaGenerationModality,
  detectMediaGenerationModalities,
} from '@/core/orchestration/orchestration-engine';
import { inferCapabilities } from '@/core/orchestration/capability-inference';
import {
  requestRequiresFunctionCalling,
  explicitlyLacksFunctionCalling,
} from '@/core/orchestration/function-calling-guard';
import { isDeadCandidateProvider } from '@/core/orchestration/dead-candidate-skip';
import {
  NoFallbackCandidateError,
  FallbackExhaustedError,
} from '@/core/orchestration/execute-with-fallback';
import { authenticate as _authenticate } from '@/middleware/auth-middleware';
import {
  requireTenantContext as _requireTenantContext,
  getTenantContext as _getTenantContext,
} from '@/api/middleware/tenant-isolation-middleware';
import { logger } from '@/utils/logger';
import { nanoid } from 'nanoid';
import { processChatRequest } from '@/services/chat-request-processor';
import { enqueueIfNeeded, queueManagerMiddleware } from '@/api/middleware/queue-manager';
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
import { sanitizeToolSchemas } from '@/utils/tool-schema-sanitizer';
import { checkQuota } from '@/services/quota-service';
import { evaluateGovernance } from '@/services/org-governance-service';
import { gateChatRequest } from '@/services/prepaid-wallet-gate';
import { recordSecurityEvent } from '@/services/security-audit-service';
import { trackChatUsage } from '@/services/billing-usage-tracker';
import { providerAvailabilityService } from '@/services/provider-availability-service';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import { ensureStringArray, getHeaderString } from '@/utils/type-guards';
import { ContextWindowExceededError } from '@/utils/custom-errors';
import { isDevelopment } from '@/config';
import { resolveAilinVirtualModelAlias } from '@/services/ailin-virtual-model-service';
import {
  HIGH_EFFORT_QUALITY_TARGET_FLOOR,
  isReasoningEffort,
} from '@/utils/reasoning-effort';
import { checkExplicitModelExists, unknownModelErrorBody } from '@/services/explicit-model-guard';
import {
  debitTierRequest,
  estimatePromptTokens,
  extractTierContext,
  gateTierRequest,
  isTierBillingEnabled,
} from '@/services/pricing-tier-billing';
import { executeRouteWithRetry } from '@/utils/route-retry';
import { streamingTimeToFirstByte } from '@/observability/ci-metrics';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { withIdempotency } from '@/middleware/idempotency-middleware';
import {
  STRATEGY_INPUT_VALUES,
  canonicalizeStrategyInput,
  resolveExecutionStrategy,
} from '@/core/orchestration/strategy-contract';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import {
  anonymousGuestApiKeyId,
  anonymousQuotaExceededBody,
  checkAndConsumeAnonymousQuota,
  inAnonymousQuotaScope,
} from '@/services/anonymous-quota-gate';
import { recordAnonymousChat } from '@/services/anonymous-chat-audit';
import {
  anonymousOutputViolation,
  ANONYMOUS_TRIPWIRE_REFUSAL,
  ANONYMOUS_TRIPWIRE_OVERLAP_CHARS,
} from '@/services/anonymous-output-tripwire';
import {
  chatFreeTierApiKeyId,
  checkAndConsumeFreeTierAutoQuota,
  freeTierQuotaExceededBody,
  isFreeTierAutoQuotaEnabled,
  isInChatFreeTierScope,
} from '@/services/free-tier-quota-gate';
import {
  FREE_TIER_ALLOWED_STRATEGIES,
  FREE_TIER_FALLBACK_STRATEGY,
} from '@/core/orchestration/triage-service';

/**
 * Per-request cost ceiling applied when `ailin_free_tier_scope` is set (see
 * that field's doc in types/index.ts). Matches `ailin-economy`'s own
 * cost-cascade cap (ailin-virtual-model-service.ts's DEFAULT_PROFILES) — the
 * platform's existing notion of what a free-tier request is allowed to cost,
 * applied here to `ailin-auto`'s per-model-call ceiling too.
 */
const FREE_TIER_MAX_COST_USD = 0.003;

/**
 * Apply the free-tier cost/strategy ceiling to a request already confirmed to
 * be in free-tier scope (anonymous or the dedicated chat-free-tier key).
 * Mutates and returns `chatRequest`.
 *
 * Both halves close a real bypass, found in security review: the earlier
 * version only DEFAULTED `max_cost` (`?? FREE_TIER_MAX_COST_USD`), so a
 * client that supplied its own — higher, or absent-cap-meaning — value kept
 * it verbatim. And `applyFreeTierStrategyCap` (triage-service.ts) only runs
 * inside orchestration-engine.ts's triage-gated branches, which are skipped
 * entirely whenever `request.strategy` is explicitly set — so a request with
 * `model:"ailin-auto", strategy:"consensus"` reached dispatch with the
 * client's explicit strategy untouched, never seeing the cap at all. Clearing
 * an out-of-allowlist explicit `strategy` here, before the request ever
 * reaches orchestration, closes that gap without touching the shared
 * dispatch code every other request (paid, authenticated, or otherwise) also
 * runs through.
 */
export function applyFreeTierCeiling(chatRequest: ChatRequest): void {
  chatRequest.max_cost = Math.min(
    chatRequest.max_cost ?? FREE_TIER_MAX_COST_USD,
    FREE_TIER_MAX_COST_USD
  );
  if (
    chatRequest.strategy &&
    !FREE_TIER_ALLOWED_STRATEGIES.has(chatRequest.strategy as ExecutionStrategyName)
  ) {
    chatRequest.strategy = FREE_TIER_FALLBACK_STRATEGY;
  }
  chatRequest.ailin_free_tier_scope = true;
}

/**
 * Did a completed single-model streaming attempt actually deliver something
 * a caller could use — real assistant content, or a tool call?
 *
 * EMPTY-STREAM GUARD (2026-09-06 incident, ci-api production): a provider
 * stream that never throws but also never yields content or a tool call was
 * being recorded as a hub SUCCESS in the streaming loop below. Because
 * `isRouteHot()` only compares `lastSuccessAt` to `lastFailureAt`, that false
 * success kept a degenerate route "hot", so the hot-first candidate reorder
 * put the SAME broken route back at the front of the chain for every
 * subsequent `model=auto` request — reproduced live across four consecutive
 * user messages (a retry of a plain question, then unrelated image- and
 * video-generation prompts) that all surfaced the same empty/garbled output
 * from the same provider+model. Extracted as a pure predicate so the guard
 * can be unit-tested directly instead of only through a source-grep.
 */
export function hasMeaningfulStreamedOutput(
  totalContentLength: number,
  sawToolCalls: boolean
): boolean {
  return totalContentLength > 0 || sawToolCalls;
}

/**
 * Classifies WHY the tools-required streaming fallback chain emptied
 * (`candidates.length === 0` after the primary was demoted and every
 * resolved fallback was rejected), so the caller can fail closed with a
 * correctly-classified error instead of silently re-executing the
 * already-rejected primary.
 *
 * FAIL-CLOSED FIX (2026-09-08, mirrors acc0efee's hard-capability
 * fail-closed pattern): the escape hatch this replaces silently re-pushed
 * `plan.model` — the SAME primary this code had just proven, moments
 * earlier, to explicitly lack `function_calling` — with only a `warn` log.
 * A tools-bearing request would then be served by a model that can only
 * emit prose, and the calling IDE/agent either hangs waiting for a
 * `tool_call` that never arrives or mis-parses the response — exactly the
 * "registry resolution divergence" failure class (2026-08-20 incident) the
 * surrounding re-validation exists to prevent, reintroduced by its own
 * designed-in escape hatch.
 *
 * Two distinct outcomes (mirrors the `NoFallbackCandidateError` /
 * `FallbackExhaustedError` split already used by `executeWithFallback` for
 * embeddings/audio/images/rerank):
 *   - 'unsatisfiable': at least one candidate was rejected because the
 *     REGISTRY-resolved model explicitly lacks `function_calling` (or there
 *     were no fallback candidates to examine at all) — the capability
 *     genuinely cannot be satisfied for this request right now, independent
 *     of provider health.
 *   - 'exhausted': every rejection was instead "provider currently dead"
 *     (open circuit / no credits) — function-calling-capable candidates
 *     exist, they are just all transiently unreachable, which is a
 *     retryable outage rather than an unsatisfiable requirement.
 *
 * Extracted as a pure function so the classification can be unit-tested
 * directly instead of only through a source-grep (same rationale as
 * `hasMeaningfulStreamedOutput` above).
 */
export function classifyEmptyToolsFallbackChain(
  skippedNoFunctionCalling: number,
  fallbackModelCount: number
): 'unsatisfiable' | 'exhausted' {
  return skippedNoFunctionCalling > 0 || fallbackModelCount === 0
    ? 'unsatisfiable'
    : 'exhausted';
}

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
              description:
                'Message role: system (instructions), user (user input), assistant (model response), function/tool (tool results)',
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
                        description:
                          'Content part type: text (plain text) or image_url (image reference)',
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
                            description:
                              'Image URL (must be publicly accessible or use data URI format)',
                          },
                          detail: {
                            type: 'string',
                            enum: ['low', 'high', 'auto'],
                            description:
                              'Image detail level: low (cost-effective, 512x512), high (full resolution), auto (adaptive based on image size)',
                          },
                        },
                      },
                    },
                  },
                  description:
                    'Array of content parts (text and/or images) for multimodal messages',
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
                  description:
                    'Content object format (alternative to array format for multimodal content)',
                },
              ],
              description: 'Message content (string, array of parts, or object)',
            },
            name: {
              type: 'string',
              description: 'Optional name for the message (for function/tool messages)',
            },
            tool_calls: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: 'Tool calls made by the assistant',
            },
            tool_call_id: {
              type: 'string',
              description: 'ID of the tool call this message responds to',
            },
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
        description:
          'Sampling temperature (0-2). Higher values make output more random. Lower values make it more focused and deterministic.',
      },
      max_tokens: {
        type: 'integer',
        minimum: 1,
        description:
          'Maximum number of tokens to generate in the completion. Model-dependent limits apply.',
      },
      top_p: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Nucleus sampling parameter. Consider tokens with top_p probability mass. Alternative to temperature.',
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
          {
            type: 'array',
            items: { type: 'string' },
            maxItems: 4,
            description: 'Up to 4 stop sequences',
          },
        ],
        description: 'Stop sequences. Generation stops when any sequence is encountered.',
      },
      stream: {
        type: 'boolean',
        default: false,
        description:
          'Enable streaming mode. Returns Server-Sent Events (SSE) stream of completion chunks.',
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
                  description:
                    'Function name (must be unique, lowercase/underscore, a-z, 0-9, _). Used by the model to identify which function to call.',
                },
                description: {
                  type: 'string',
                  description:
                    'Function description explaining what the function does. The model uses this to decide when to call the function.',
                },
                parameters: {
                  type: 'object',
                  additionalProperties: true,
                  description:
                    'JSON Schema object defining function parameters. Must be valid JSON Schema describing the expected input structure.',
                },
              },
            },
          },
        },
        description:
          'List of tools (functions) available to the model. Model may choose to call these tools.',
      },
      tool_choice: {
        oneOf: [
          {
            type: 'string',
            enum: ['none', 'auto'],
            description: 'Tool choice mode: none (no tools) or auto (model decides)',
          },
          { type: 'object', additionalProperties: true, description: 'Force specific tool call' },
        ],
        description:
          'Controls which tool (if any) the model calls. "none" disables tools, "auto" lets model decide.',
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
        description:
          'Ailin-specific: Maximum cost in USD for this request. Orchestration will select models within budget.',
      },
      quality_target: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Ailin-specific: Quality target (0-1). Higher values prioritize quality over cost/speed.',
      },
      reasoning_effort: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description:
          'Canonical reasoning-effort hint (matches the OpenAI o-series convention). Controls how much a model should "think" before answering: low/medium/high map to increasing internal reasoning-token budgets on models with native extended thinking, and bias model/quality selection at high effort. Reconciled with the lower-level `thinking_budget` field by resolveReasoningEffort() — an explicit `thinking_budget` always takes precedence over this enum.',
      },
      thinking_budget: {
        type: 'integer',
        minimum: 1,
        description:
          'Ailin-specific: explicit native-thinking token budget for models with extended-thinking support (e.g. DeepSeek-R1, QwQ). A more specific override of `reasoning_effort` — when both are set, this numeric value wins verbatim.',
      },
      task_type: {
        type: 'string',
        description:
          'Ailin-specific: Task type hint (e.g., "code-generation", "analysis", "creative") for better model selection',
      },
      no_cache: {
        type: 'boolean',
        description:
          'Ailin-specific: Skip semantic cache lookup. Used for experiment validation to force real LLM calls.',
      },
      freeze_learning: {
        type: 'boolean',
        description:
          'Ailin-specific: Do not feed learning/bandit updates from this request. Used by the experiment harness during the frozen measurement phase to keep the system fixed.',
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
            description:
              'Vector store IDs to search. Only stores owned by your organization are queried.',
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

export const chatCompletionResponseSchema = {
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
          finish_reason: {
            anyOf: [
              { type: 'null', description: 'Completion reason not reported by the provider' },
              {
                type: 'string',
                description:
                  'Reason for completion: stop (natural end), length (token limit), tool_calls (tool usage required), content_filter (content filtered), or function_call (deprecated)',
              },
            ],
            description: 'Reason the model stopped generating',
          },
          logprobs: {
            anyOf: [
              { type: 'null', description: 'No logprobs returned' },
              {
                type: 'object',
                additionalProperties: true,
                description: 'Log probability information for tokens',
              },
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
                  {
                    type: 'null',
                    description:
                      'No text content — an assistant message that only carries tool_calls has a null content per the OpenAI wire format',
                  },
                  { type: 'string', description: 'Text content as a string' },
                  {
                    type: 'array',
                    description: 'Array of content parts (for multimodal responses)',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                      description: 'Content part object (text, image_url, etc.)',
                    },
                  },
                ],
                description: 'Message content (string or array of parts)',
              },
              refusal: {
                anyOf: [
                  { type: 'null', description: 'No refusal reason' },
                  {
                    type: 'string',
                    description: 'Reason why the model refused to respond (safety/content policy)',
                  },
                ],
                description: 'Refusal reason if the model declined to respond',
              },
              tool_calls: {
                anyOf: [
                  { type: 'null', description: 'No tool calls made' },
                  {
                    type: 'array',
                    description: 'Array of tool calls made by the model',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                      description: 'Tool call object containing function name and arguments',
                    },
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
      description:
        'Ailin-specific metadata about the completion (model used, provider, cost, etc.)',
    },
  },
};

export function normalizeChatRequest(chatRequest: ChatRequest): ChatRequest {
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
    !chatRequest.strategy && aliasResolution?.strategy ? aliasResolution.strategy : undefined;

  // FIX (2026-08-22, request Td9Rzv...): tools with absent/`{}`/non-object
  // `function.parameters` (or `type: ['object']`) poison the WHOLE request at
  // strict providers (OpenAI 400 invalid_function_parameters). The sanitizer
  // rewrites them; log once per request so a misbehaving chat client is
  // visible without spamming per-tool lines.
  const normalizedToolNames: string[] = [];
  const normalizedRequest: ChatRequest = {
    ...chatRequest,
    model: aliasResolution ? aliasResolution.model : chatRequest.model,
    strategy:
      resolvedStrategy ?? (normalizedStrategyInput === 'dynamic' ? 'auto' : chatRequest.strategy),
    messages: normalizedMessages,
    tools: sanitizeToolSchemas(chatRequest.tools, {
      onNormalization: (event) => normalizedToolNames.push(event.name),
    }),
  };
  if (normalizedToolNames.length > 0) {
    logger.warn(
      { normalizedTools: normalizedToolNames },
      'Normalized invalid tool parameter schemas (absent/empty/non-object parameters or invalid root type)'
    );
  }

  if (strategyFromAlias) {
    normalizedRequest.strategy = strategyFromAlias;
  }
  if (
    aliasResolution?.qualityTarget !== undefined &&
    normalizedRequest.quality_target === undefined
  ) {
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

  // LOTE AZ (2026-09) — reasoning_effort foundation.
  //
  // 1) Defensive validation: the JSON schema enforces the closed enum for
  //    real HTTP callers, but `normalizeChatRequest` also runs for
  //    internally-constructed requests (tests, the experiment harness) that
  //    bypass Fastify validation. Drop a garbage value rather than let it
  //    silently reach `resolveReasoningEffort()` — the object spread above
  //    (`...chatRequest`) already carried whatever was on the incoming
  //    request forward unchanged, so this only needs to correct it, not add
  //    it (propagation-without-loss is the point: a VALID value survives the
  //    whole alias-resolution pass untouched).
  if (
    normalizedRequest.reasoning_effort !== undefined &&
    !isReasoningEffort(normalizedRequest.reasoning_effort)
  ) {
    delete normalizedRequest.reasoning_effort;
  }

  // 2) Selection-bias stretch goal: 'high' effort biases toward the SAME
  //    quality-selection hook the alias system and the triage layer already
  //    use for "the caller wants high quality" — `quality_target >= 0.9`
  //    (see orchestration-engine.ts `applyTriageRoute`'s
  //    `clientWantsHighQuality` check and the `preferQuality` alias check).
  //    Reusing that exact, already-wired threshold instead of inventing a
  //    new heuristic. Never overrides an explicit client-set or
  //    alias-resolved `quality_target` — this only fills the gap when
  //    nothing else expressed a quality preference.
  if (
    normalizedRequest.reasoning_effort === 'high' &&
    normalizedRequest.quality_target === undefined
  ) {
    normalizedRequest.quality_target = HIGH_EFFORT_QUALITY_TARGET_FLOOR;
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

function normalizeContentItem(
  item: MessageContent | string | Record<string, unknown>
): MessageContent {
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
        description:
          'Create a chat completion with intelligent multi-model orchestration. Supports streaming and non-streaming modes. Automatically selects the best model based on requirements, cost, and quality targets.',
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
              estimatedWaitTimeMs: {
                type: 'integer',
                description: 'Estimated wait time in milliseconds',
              },
              priority: { type: 'integer', description: 'Request priority' },
              tier: {
                type: 'string',
                enum: ['enterprise', 'pro', 'free'],
                description: 'User tier',
              },
              systemLoad: { type: 'number', description: 'Current system load' },
              reason: { type: 'string', description: 'Reason for queueing' },
              pollAfterMs: {
                type: 'integer',
                description: 'Recommended polling interval in milliseconds',
              },
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
          404: {
            description:
              'The explicitly requested `model` does not exist in any provider. Returned only for a client-pinned id; `auto`, `ailin-*` aliases and an absent model never reach this path.',
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  type: { type: 'string' },
                  code: { type: 'string', description: 'model_not_found' },
                  param: { type: 'string' },
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
      // queueManagerMiddleware populates `request.queueContext` from the
      // current system load (see request-queue-service.ts's `shouldQueue`,
      // >80% capacity or an existing waiting job) — it requires tenantContext
      // to already be set, which `_authenticate`/the global apiKeyAuthMiddleware
      // hook guarantee by this point. `enqueueIfNeeded` below reads that
      // context to decide whether to return a 202 async-acknowledgment instead
      // of processing inline; it is only ever CONSULTED on the non-streaming
      // branch (streaming has no 202/poll equivalent — see the "Queueing is
      // NOT replicated here" comment further down for the deliberate
      // streaming exclusion). Previously this hook was imported under an
      // underscore-prefixed unused-var alias but never registered, so
      // `queueContext` was always undefined and `enqueueIfNeeded` always took
      // the `queued: false` branch — the load-shed protection this route's
      // schema already documents (see the 202 response above) never actually
      // engaged, regardless of real system load.
      preHandler: [_authenticate, queueManagerMiddleware],
    },
    async (request, reply) => {
      // Read the RAW, client-submitted model BEFORE normalizeChatRequest
      // rewrites it to 'auto' for every ailin-* alias (see
      // anonymous-quota-gate.ts header) — the anonymous-visitor scope check
      // below depends on seeing exactly what the client sent.
      const rawModel = typeof request.body?.model === 'string' ? request.body.model : undefined;

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

      // ── Anonymous-visitor daily free quota (ailin-economy) ─────────────
      // In scope ONLY for the one designated M2M guest key + literal
      // model:"ailin-economy" (checked on the RAW body, not the
      // post-normalization value). Every other request is untouched — this
      // never runs, and never consults the wallet, for normal traffic.
      const requestApiKeyId = (request as ExtendedFastifyRequest).apiKey?.id;
      const anonHeaders = request.headers as Record<string, string | string[] | undefined>;

      // Session affinity (LOTE AW, 2026-09): carry the resolved API-key id
      // and, when present, the client's conversation id down through
      // orchestrationEngine.{execute,createStreamingPlan,executeStream}'s
      // buildContext() — see `ailin_session_scope`'s doc comment
      // (types/index.ts). Set unconditionally, for EVERY request (not just
      // the anonymous-quota scope above), and always overwrites whatever a
      // client sent, mirroring `ailin_anonymous_context`'s established
      // server-set-only pattern.
      chatRequest.ailin_session_scope = {
        apiKeyId: requestApiKeyId,
        conversationId: getHeaderString(anonHeaders, 'x-ailin-conversation-id'),
      };

      const anonScope = inAnonymousQuotaScope({
        apiKeyId: requestApiKeyId,
        rawModel,
        visitorIdHeader: getHeaderString(anonHeaders, 'x-anonymous-visitor-id'),
        // Chat-backend forwards the ORIGINAL browser's IP/UA/Accept-Language
        // as data (custom headers), not via the connection itself — every
        // anonymous request reaches ci from chat-backend's own (whitelisted)
        // egress IP regardless of which visitor is asking, so the connection
        // -level signal can't distinguish visitors from each other.
        visitorIpHeader: getHeaderString(anonHeaders, 'x-anonymous-visitor-ip'),
        visitorUserAgentHeader: getHeaderString(anonHeaders, 'x-anonymous-visitor-user-agent'),
        visitorAcceptLanguageHeader: getHeaderString(
          anonHeaders,
          'x-anonymous-visitor-accept-language'
        ),
      });
      if (anonScope.inScope && anonScope.visitorIdHash && requestApiKeyId) {
        const anonVisitorIp = getHeaderString(anonHeaders, 'x-anonymous-visitor-ip');
        const anonResult = await checkAndConsumeAnonymousQuota(
          requestApiKeyId,
          anonScope.visitorIdHash,
          anonVisitorIp || undefined
        );
        if (!anonResult.allowed) {
          return reply.status(429).send(anonymousQuotaExceededBody(anonResult.resetAt));
        }
        // Cost/strategy ceiling, not just a request counter (see
        // applyFreeTierCeiling's doc above): a daily count bounds how many
        // free calls a visitor gets, not what any single one can cost or
        // which strategy it runs. `ailin-economy` already had its own
        // maxCost via ailin-virtual-model-service.ts's DEFAULT_PROFILES; this
        // is the equivalent for the anonymous path generally, applied
        // uniformly here rather than per-alias.
        applyFreeTierCeiling(chatRequest);
        // Audit context for anonymous-chat-audit.ts — one investigable row per
        // anonymous completion (visitor fingerprint/IP/UA + messages + response
        // + models served). Server-set from trusted headers; overwrite any
        // client-supplied value unconditionally.
        chatRequest.ailin_anonymous_context = {
          apiKeyId: requestApiKeyId,
          visitorFingerprint: anonScope.visitorIdHash,
          visitorIp: anonVisitorIp || undefined,
          userAgent: getHeaderString(anonHeaders, 'x-anonymous-visitor-user-agent') || undefined,
          acceptLanguage:
            getHeaderString(anonHeaders, 'x-anonymous-visitor-accept-language') || undefined,
        };
      } else if (requestApiKeyId && requestApiKeyId === anonymousGuestApiKeyId()) {
        // Defense in depth: the dedicated anonymous-guest M2M key exists for
        // exactly one purpose (ailin-economy chat completions carrying the
        // visitor header). Nothing else stops this key from being used for
        // any other model or endpoint today — without this check, a leaked
        // key (or a chat-backend bug) would get free, uncounted access to
        // the whole model catalog through this identity. Reject anything
        // that doesn't match the expected shape instead of silently
        // processing it unmetered and uncounted.
        return reply.status(403).send({
          error: {
            code: 'anonymous_key_scope_violation',
            message:
              'This API key is restricted to POST /v1/chat/completions with model "ailin-economy" and the X-Anonymous-Visitor-Id header set.',
          },
        });
      } else if (
        rawModel === 'ailin-economy' &&
        getHeaderString(anonHeaders, 'x-anonymous-visitor-id')
      ) {
        // Diagnostic for the quota-gate blind spot: the request LOOKS like an
        // anonymous-visitor call (guest model + visitor header present) but
        // the gate did not fire and the defense-in-depth branch above did not
        // match either. The only way both skip silently is `request.apiKey?.id`
        // differing from the configured ANONYMOUS_GUEST_API_KEY_ID — e.g. the
        // key VALUE chat-backend sends resolves to a different api_keys row
        // than the row ID configured here (duplicate/rotated key), or the
        // global apiKeyAuthMiddleware did not attach the key at all. Log the
        // two IDs (plus the authenticated key's name to spot duplicate
        // 'chat-anonymous-guest' rows instantly) so ONE probe pinpoints the
        // mismatch. Never logs header values or the key itself.
        request.log.warn(
          {
            apiKeyId: requestApiKeyId ?? null,
            apiKeyName: (request as ExtendedFastifyRequest).apiKey?.name ?? null,
            configuredGuestKeyId: anonymousGuestApiKeyId() ?? null,
            hasVisitorIdHeader: true,
          },
          'Anonymous-looking request skipped quota gate: authenticated API key id does not match ANONYMOUS_GUEST_API_KEY_ID'
        );
      }

      // ── Authenticated daily free quota (ailin-auto) ─────────────────────
      // In scope ONLY for the one designated chat-free-tier API key id +
      // literal model:"ailin-auto" (checked on the RAW body) + a real userId —
      // see `isInChatFreeTierScope` / free-tier-quota-gate.ts's file header
      // for why this is keyed on a dedicated key id rather than
      // organizationId (an org-scoped counter over `ailin-auto` would also
      // cap financial's and guide's unrelated usage of the same org).
      // Any request authenticated normally (not through the dedicated key)
      // is untouched — this never runs, and never consults the wallet, for
      // normal traffic. Within the allowance this is a no-op (request
      // proceeds as today, still exempt from the wallet gate below). Once
      // exceeded, the ailin-auto request is rejected outright — never
      // silently swapped to a billed model.
      const chatFreeTierScope = isInChatFreeTierScope({
        apiKeyId: requestApiKeyId,
        rawModel,
        userId,
      });
      if (isFreeTierAutoQuotaEnabled() && chatFreeTierScope) {
        const freeTierResult = await checkAndConsumeFreeTierAutoQuota(
          requestApiKeyId as string,
          userId
        );
        if (!freeTierResult.allowed) {
          return reply.status(429).send(freeTierQuotaExceededBody(freeTierResult.resetAt));
        }
        // Cost/strategy ceiling, same reasoning as the anonymous path above.
        applyFreeTierCeiling(chatRequest);
      } else if (
        requestApiKeyId &&
        requestApiKeyId === chatFreeTierApiKeyId() &&
        !chatFreeTierScope
      ) {
        // Defense in depth, same reasoning as the anonymous-guest-key check
        // above: chat's backend is expected to only ever send model:"ailin-auto"
        // over this dedicated key. Independent of `isFreeTierAutoQuotaEnabled()`
        // on purpose — this rejects misuse of the credential itself (leaked key,
        // chat-backend bug sending the wrong model) regardless of whether the
        // quota-counting feature happens to be toggled on right now.
        return reply.status(403).send({
          error: {
            code: 'chat_free_tier_key_scope_violation',
            message:
              'This API key is restricted to POST /v1/chat/completions with model "ailin-auto".',
          },
        });
      }

      // ── Explicit model must exist ──────────────────────────────────────
      // A model id the client wrote that exists in NO provider is a client
      // bug, and answering it with a silently substituted model is worse than
      // an error: the caller never learns the id was wrong and is billed for a
      // model it did not ask for. Measured: `"model":
      // "definitely-not-a-real-model-xyz"` returned 200.
      //
      // This is NOT the same as "pinned model is currently unusable" (filtered
      // by a health/balance/capability gate) — that case still degrades to
      // automatic selection on purpose, downstream. See explicit-model-guard.ts.
      // The check fails OPEN: an unreachable catalog admits the request.
      const explicitModelCheck = await checkExplicitModelExists(chatRequest);
      if (!explicitModelCheck.exists && explicitModelCheck.requestedModel) {
        request.log.info(
          { requestedModel: explicitModelCheck.requestedModel },
          'Rejecting chat completion: pinned model does not exist in any provider'
        );
        return reply.status(404).send(unknownModelErrorBody(explicitModelCheck.requestedModel));
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
        ? extractTierContext({
            tier: chatRequest.ailin_tier,
            tierRate: chatRequest.ailin_tier_rate,
          })
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

            // Anonymous audit row (non-streaming path). Fire-and-forget —
            // audit failure never breaks the response.
            const anonCtxNs = chatRequest.ailin_anonymous_context;
            // Anonymous output tripwire (non-streaming): narrow deny-list
            // backstop for the exact incident class (2026-08-20 "vadia").
            // The full ORIGINAL text is still persisted below for
            // investigation — only the DELIVERED payload is sanitized.
            let anonNsTripped: string | undefined;
            let anonNsOriginalText: string | undefined;
            if (anonCtxNs && typeof response?.choices?.[0]?.message?.content === 'string') {
              const nsViolation = anonymousOutputViolation(response.choices[0].message.content);
              if (nsViolation) {
                anonNsTripped = nsViolation.category;
                anonNsOriginalText = response.choices[0].message.content;
                requestLog.warn(
                  { category: nsViolation.category, model: response.model },
                  'anonymous-output tripwire: replaced violating non-streaming response'
                );
                response.choices[0].message.content = ANONYMOUS_TRIPWIRE_REFUSAL;
              }
            }
            if (anonCtxNs) {
              recordAnonymousChat({
                requestId,
                apiKeyId: anonCtxNs.apiKeyId,
                visitorFingerprint: anonCtxNs.visitorFingerprint,
                visitorIp: anonCtxNs.visitorIp,
                userAgent: anonCtxNs.userAgent,
                acceptLanguage: anonCtxNs.acceptLanguage,
                modelRequested: chatRequest.model,
                modelsServed:
                  (response as { ailin_metadata?: { models_used?: string[] } } | undefined)
                    ?.ailin_metadata?.models_used ??
                  (typeof response?.model === 'string' ? [response.model] : []),
                messages: chatRequest.messages,
                responseText:
                  anonNsOriginalText ??
                  (response?.choices?.[0]?.message?.content as string | undefined) ??
                  undefined,
                inputTokens: response?.usage?.prompt_tokens ?? 0,
                outputTokens: response?.usage?.completion_tokens ?? 0,
                status: 'success',
                metadata: { streaming: false, outputTripwire: anonNsTripped },
              });
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

        const errorMessage =
          error instanceof Error
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
          return reply
            .code(429)
            .type('application/json')
            .send({
              error: {
                code: 'rate_limit_exceeded',
                message: 'Rate limit exceeded. Please try again later.',
              },
            });
        }

        if (statusCode === 401) {
          return reply
            .code(401)
            .type('application/json')
            .send({
              error: {
                code: 'unauthorized',
                message: 'Invalid or missing authentication.',
              },
            });
        }

        if (statusCode && statusCode >= 400 && statusCode < 500) {
          const { extractErrorCodeFromObject } = await import('@/utils/type-guards');
          const clientErrorCode = extractErrorCodeFromObject(error) || 'bad_request';
          return reply
            .code(statusCode)
            .type('application/json')
            .send({
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
          return reply
            .code(409)
            .type('application/json')
            .send({
              error: {
                code: 'duplicate_entry',
                message: 'A record with this value already exists',
              },
            });
        }
        if (prismaCode === 'P2003' || prismaCode === 'P2014') {
          return reply
            .code(400)
            .type('application/json')
            .send({
              error: {
                code: 'foreign_key_constraint',
                message: 'Invalid reference to related record',
              },
            });
        }
        if (prismaCode === 'P2025') {
          return reply
            .code(404)
            .type('application/json')
            .send({
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

/**
 * Full decision behind the streaming media-generation redirect gate below:
 * extract the last user turn's text (see extractLastUserTurnTextForMediaGate's
 * doc comment for why it's last-turn-only and text-only/capped), run it
 * through the SAME capability inference the non-streaming heuristic fallback
 * uses, then classify the result via detectMediaGenerationModality — the same
 * function orchestration-engine.ts uses to route a triage-produced stage to
 * executeMediaGenerationStage. Exported so the gate's redirect DECISION (not
 * just the text-extraction step) has direct unit-test coverage without
 * booting a full Fastify + Prisma + provider-registry stack.
 *
 * 2026-09-07 fix: this used to be inlined at the call site with the caller
 * checking `=== 'file'` only — image/video/audio requests fell through this
 * gate entirely (see the doc comment on the call site for the history of
 * that gap). Centralizing the decision here means the call site's condition
 * is now the only thing that needs to widen to cover all four modalities.
 */
export function detectStreamingMediaGateModality(
  chatRequest: Pick<ChatRequest, 'messages' | 'tools' | 'max_tokens'>
): ReturnType<typeof detectMediaGenerationModality> {
  const mediaGateText = extractLastUserTurnTextForMediaGate(chatRequest.messages);
  const mediaGateInference = inferCapabilities([{ role: 'user', content: mediaGateText }], {
    tools: chatRequest.tools,
    max_tokens: chatRequest.max_tokens,
  });
  return detectMediaGenerationModality(mediaGateInference.requiredCapabilities);
}

/**
 * Observability-only sibling of {@link detectStreamingMediaGateModality}
 * (LOTE AT PR4, 2026-09-07): reports EVERY modality the same gate text/
 * inference detects, not just the first. Does NOT change the redirect
 * gate's CONDITION below — `detectStreamingMediaGateModality(...) !== null`
 * already redirects correctly for a composite (2+ modality) request exactly
 * as it does for a single one (both are non-null), since the redirect only
 * needs to know "does this need the non-streaming generation pipeline at
 * all", not which/how-many modalities. This exists purely so the log line
 * at the call site — and anyone debugging a composite request from logs —
 * can see the real composite modality set instead of only the first match,
 * matching `OrchestrationEngine.detectMediaGenerationModalities()`'s plural
 * detection the non-streaming composite pipeline actually acts on.
 */
export function detectStreamingMediaGateModalities(
  chatRequest: Pick<ChatRequest, 'messages' | 'tools' | 'max_tokens'>
): ReturnType<typeof detectMediaGenerationModalities> {
  const mediaGateText = extractLastUserTurnTextForMediaGate(chatRequest.messages);
  const mediaGateInference = inferCapabilities([{ role: 'user', content: mediaGateText }], {
    tools: chatRequest.tools,
    max_tokens: chatRequest.max_tokens,
  });
  return detectMediaGenerationModalities(mediaGateInference.requiredCapabilities);
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

  // Media-generation artifact coverage on streaming (2026-07-16/17
  // architecture audit, v2 after an earlier all-modality design was
  // rejected by adversarial review, and this v2 itself fixed 3 further
  // confirmed defects from a SECOND adversarial review — see the three
  // points below marked "v2 fix"; widened to all four modalities 2026-09-07,
  // see "2026-09-07 fix" below).
  //  - Covers all four modalities detectMediaGenerationModality recognizes:
  //    image/video/audio generation AND file generation (docx/csv/json/
  //    pdf/.../code_file_generation).
  //  - (2026-09-07 fix) Originally FILE modality only. The image/video/audio
  //    media regexes (IMAGE_GEN_KEYWORDS etc. in capability-inference.ts) do
  //    NOT need the tool-noun guard the file-format regexes needed (that
  //    guard exists because bare format nouns like "csv"/"pdf" collide with
  //    unrelated tool-building requests — "create a csv parser" — the
  //    image/video/audio keyword sets already require a generation-verb +
  //    media-noun pair with no such collision class). Confirmed by execution
  //    that a streaming request with clear image/video/audio generation
  //    intent (e.g. "generate an image of a red bicycle") fell all the way
  //    through to the ordinary single-model chat fast path
  //    (createStreamingPlan, requiredCapabilities: ['streaming'] only) and
  //    produced a short hallucinated non-answer instead of ever attempting
  //    real generation — the root cause of "Ball"/"B"-style garbage
  //    responses to media-generation requests via the default streaming
  //    chat UI. Fixed by widening the gate condition from `=== 'file'` to
  //    `!== null` (see detectStreamingMediaGateModality above) — every other
  //    mechanic on this path (forced stream:false, disableVideoEarlyPath,
  //    withIdempotency wiring, SSE re-framing below) is untouched and now
  //    shared by all four modalities.
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
  const mediaGateModality = detectStreamingMediaGateModality(chatRequest);
  if (mediaGateModality !== null) {
    // LOTE AT PR4 (2026-09-07): observability only — see
    // detectStreamingMediaGateModalities's doc comment. The redirect
    // condition above is unchanged (still `!== null` on the singular
    // detector); this just lets the log line show the full composite
    // modality set when there is one, instead of only the first match.
    const mediaGateModalities = detectStreamingMediaGateModalities(chatRequest);
    requestLog.info(
      {
        modality: mediaGateModality,
        modalities: Array.from(mediaGateModalities),
        composite: mediaGateModalities.size >= 2,
      },
      'Media-generation intent detected on streaming request — redirecting to non-streaming generation pipeline'
    );
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
              operationName: 'POST /v1/chat/completions (streaming media-generation redirect)',
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
              'Media-generation request failed';
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
      requestLog.error(
        { error: errorMsg, modality: mediaGateModality },
        'Media-generation streaming redirect failed'
      );
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
  //
  // FIX (2026-08-03): this used to be a hand-maintained Set that had drifted
  // out of sync with the 32 strategies orchestration-engine.ts actually
  // registers — 11 of them (hybrid, cost-cascade, adaptive, contextual,
  // hierarchical, massive-parallel, reinforcement, sensitivity-consensus,
  // sequential, tri-role-collective, competitive) were requestable via
  // `strategy` but NOT in this Set, so `strategy:"hybrid", stream:true`
  // silently fell through to the single-model fast path below instead of
  // the strategy the caller actually asked for — the client had no way to
  // tell it happened. Deriving from resolveExecutionStrategy() (the same
  // canonical registry backing the request-body schema validation, see
  // strategy-contract.ts) means any strategy actually registered on the
  // engine is routed correctly here by construction, with no second list to
  // keep in sync. executeStream() (orchestration-engine.ts:2865
  // selectStrategy, :2982) already resolves ANY registered strategy
  // correctly — streaming-capable or not, both branches are handled — so
  // 'single' and unspecified/'auto' are the only two cases left on the
  // dedicated fast path below, unchanged from prior behavior.
  const requestedStrategy = typeof chatRequest.strategy === 'string' ? chatRequest.strategy : '';
  const resolvedExecutionStrategy = resolveExecutionStrategy(requestedStrategy);
  const isCollectiveStrategyRequest =
    !!resolvedExecutionStrategy &&
    resolvedExecutionStrategy !== 'single' &&
    resolvedExecutionStrategy !== 'auto';
  // Anonymous-audit + output-tripwire state for the SINGLE/fast streaming
  // path — the path anonymous chat requests actually take (no strategy ⇒
  // resolved 'auto'/'single' lands here, NOT in the collective branch).
  // Until now this path neither persisted an anonymous_chat_logs row nor
  // had any output-side guard: both lived only in the collective/
  // non-streaming branches. Declared BEFORE the outer try so the terminal
  // catch (all-providers-failed) can persist the failed-run audit row too.
  const anonFastCtx = chatRequest.ailin_anonymous_context;
  let anonFastText = '';
  let anonFastTrippedCategory: string | undefined;
  const anonFastModels = new Set<string>();
  if (isCollectiveStrategyRequest) {
    setupSSEHeaders(reply);
    let firstChunkAt = false;
    // Anonymous-audit accumulators: full streamed response text + every model
    // that yielded a chunk, persisted once the stream settles (success OR
    // error — a failed anonymous run is just as investigable as a good one).
    const anonCtx = chatRequest.ailin_anonymous_context;
    let anonResponseText = '';
    const anonModelsServed = new Set<string>();
    let anonErrorCode: string | undefined;
    // OTel coverage gap fix (2026-08-03): orchestrationEngine.executeStream()
    // itself is an async generator (too large/complex to safely wrap
    // internally in this pass — see orchestration-engine.ts:2737), so the
    // span is created here at the consumption site instead, around the
    // exact boundary chat-routes.ts already controls. This was previously
    // completely untraced: OTel only covered the non-streaming execute()
    // path (orchestration-engine.ts:715), never this one, despite it being
    // the collective-strategy SSE path used in production.
    const tracer = trace.getTracer('ci-orchestration');
    await tracer.startActiveSpan(
      'orchestration.executeStream',
      {
        attributes: {
          'request.id': requestId,
          'org.id': organizationId,
          'request.strategy': requestedStrategy,
        },
      },
      async (span) => {
        try {
          for await (const chunk of orchestrationEngine.executeStream(
            chatRequest,
            organizationId,
            userId
          )) {
            if (!firstChunkAt) {
              firstChunkAt = true;
              streamingTimeToFirstByte.observe(
                { strategy: requestedStrategy, result: 'success' },
                Date.now() - startTime
              );
            }
            sendSSEChunk(reply, chunk);
            if (anonCtx) {
              const delta = chunk.choices?.[0]?.delta?.content;
              if (typeof delta === 'string') anonResponseText += delta;
              if (typeof chunk.model === 'string' && chunk.model) anonModelsServed.add(chunk.model);
            }
          }
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          if (!firstChunkAt) {
            streamingTimeToFirstByte.observe(
              { strategy: requestedStrategy, result: 'error' },
              Date.now() - startTime
            );
          }
          const errorMsg = err instanceof Error ? err.message : String(err);
          anonErrorCode = err instanceof Error ? err.name : 'stream_error';
          span.recordException(err instanceof Error ? err : new Error(errorMsg));
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
          requestLog.error({ error: errorMsg }, 'Collective strategy stream failed');
          sendSSEError(reply, err instanceof Error ? err : new Error(errorMsg));
        } finally {
          span.end();
        }
        if (anonCtx) {
          recordAnonymousChat({
            requestId,
            apiKeyId: anonCtx.apiKeyId,
            visitorFingerprint: anonCtx.visitorFingerprint,
            visitorIp: anonCtx.visitorIp,
            userAgent: anonCtx.userAgent,
            acceptLanguage: anonCtx.acceptLanguage,
            modelRequested: chatRequest.model,
            modelsServed: [...anonModelsServed],
            messages: chatRequest.messages,
            responseText: anonResponseText || undefined,
            status: anonErrorCode ? 'error' : 'success',
            errorCode: anonErrorCode,
            metadata: { streaming: true, strategy: requestedStrategy },
          });
        }
      }
    );
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
    const toolsRequired = requestRequiresFunctionCalling(chatRequest.tools);
    if (toolsRequired) {
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

    // FUNCTION-CALLING RE-VALIDATION (2026-08-20 incident, request
    // 91YJ-kZPPLHjodsSSKLkz): the capability filter above runs on CATALOG/DB
    // rows, but the model actually executed is the one RESOLVED from the
    // provider registry — and the two can diverge (stale vendor listing,
    // different provider variant). The incident had 4 consecutive attempts
    // on registry models whose capabilities were
    // ["chat","text_generation","streaming"] (no function_calling) for a
    // tools request. So for tools requests we re-validate the RESOLVED model,
    // both for the PRIMARY and for fallback candidates. Conservative
    // semantics: reject only when capabilities are explicitly declared AND
    // lack function_calling (unknown metadata passes — see
    // function-calling-guard.ts). Never empties the chain: if every
    // candidate is rejected we fall back to today's behavior (primary as
    // last resort).
    let primaryPushed = false;
    if (!toolsRequired) {
      pushCandidate(plan.model, plan.adapter, plan.request);
      primaryPushed = true;
    } else {
      const resolvedPrimary = await providerRegistry.findModel(plan.model.id);
      const primaryModel = resolvedPrimary?.model ?? plan.model;
      if (explicitlyLacksFunctionCalling(primaryModel)) {
        requestLog.warn(
          {
            primaryModel: plan.model.id,
            resolvedProvider: primaryModel.provider,
            resolvedCapabilities: primaryModel.capabilities,
          },
          'Primary streaming model resolved WITHOUT function_calling for tools request — demoted from chain head'
        );
      } else {
        pushCandidate(primaryModel, resolvedPrimary?.adapter ?? plan.adapter, plan.request);
        primaryPushed = true;
      }
    }

    // Bound how many fallback candidates we RESOLVE up front. selectFallbackOptions
    // returns EVERY capable model ("no artificial limit") — in prod that is ~5000+
    // — and resolving each via `await providerRegistry.findModel()` SERIALLY before
    // the first stream attempt blocked the whole request for ~100s (firstByte never
    // arrived → the client aborted at its timeout). A streaming fallback CHAIN only
    // ever needs a handful: if the primary + N fallbacks all fail, the request is
    // doomed regardless. Env-tunable; not a model pin (it caps the chain length,
    // selection order is unchanged and fully dynamic).
    //
    // DEAD-CANDIDATE SKIP (2026-08-19): selectFallbackOptions ranks purely by
    // quality/cost/context — dead providers (open circuit breaker, exhausted
    // balance, invalid credentials) are usually the CHEAPEST, so they dominated
    // the top of the list and the whole capped chain could be dead providers,
    // failing the request without ever reaching a healthy one (live incident:
    // 9/9 attempts = alibaba access-denied / nanogpt+gmi no-balance / phala 401 /
    // openrouter model-404 → "Upstream provider error while streaming"). Skipped
    // candidates do NOT count toward the cap: we keep walking the ranked list
    // until maxStreamFallbacks LIVE candidates are resolved. Providers whose
    // circuit is HALF_OPEN are also skipped — a permanently-dead provider
    // oscillates OPEN→HALF_OPEN→OPEN forever (RC-3 lesson).
    // TOOLS-REQUIRED HEADROOM (2026-09-07 incident, requests i7fTRLVuNSY0ezeixeM3A
    // / 5zMk-k8bZ5hBCSwVwUAwG / edAGdf-ei9h1pYFvzyqE_): a request that carries
    // `tools` draws from a MUCH thinner, more provider-correlated eligible pool
    // than the flat cap was sized for — both real incident requests needed to
    // examine 324 ranked fallback candidates (237-238 rejected for lacking
    // function_calling, 33-78 already dead) just to fill a 9-slot chain, out of
    // 1479 total fallback options returned by selectFallbackOptions. With a flat
    // cap of 9, a coincident multi-provider outage window (billing exhaustion on
    // 3+ hubs, one bad API key, one Cloudflare IP-ban, one buggy tool-call JSON
    // encoder) exhausted every slot even though ~1150 further, likely-healthy
    // candidates sat unexamined below the cap. Give tools-required requests a
    // deeper cap — safe now that resolution below is parallelized instead of
    // serial (see FALLBACK_RESOLVE_CONCURRENCY). Env-tunable, not a model pin:
    // still the same dynamic ranked list, just walked deeper.
    const maxStreamFallbacks = toolsRequired
      ? Number(process.env.STREAMING_MAX_FALLBACKS_TOOLS ?? 20)
      : Number(process.env.STREAMING_MAX_FALLBACKS ?? 8);
    // PROVIDER DIVERSITY CAP (2026-08-21, request k0QPvOU6tetSXz9gOJU-k): the
    // ranked list clustered 5 of 9 chain slots on ONE provider (alibaba ×5);
    // when that provider died on attempt 1 (HTTP 400 billing), attempts 2-5
    // were guaranteed circuit-OPEN failures — 4 wasted slots while live
    // providers sat below the cap. Cap candidates per provider (selection
    // order is unchanged; excess models of a saturated provider simply yield
    // their slot to the next provider's model). Env-tunable, not a model pin.
    const maxPerProvider = Number(process.env.STREAMING_MAX_CANDIDATES_PER_PROVIDER ?? 2);
    const perProviderCount = new Map<string, number>();
    let skippedDeadCandidates = 0;
    let skippedNoFunctionCalling = 0;
    const isDeadCandidate = (adapterProvider: string, model: Model): boolean => {
      // Shared selection-time gate (dead-candidate-skip.ts) — same
      // PROVEN_BAD_STATES + OPEN/HALF_OPEN circuit semantics, now also applied
      // to the collective-strategy eligible pool in base-strategy.
      if (isDeadCandidateProvider(adapterProvider, model.id)) return true;
      if ((model as Model & { balanceStatus?: string }).balanceStatus === 'no-credits') return true;
      return false;
    };
    // PARALLEL RESOLUTION (2026-09-07 incident, same requests as above):
    // `providerRegistry.findModel()` is NOT free — it does real I/O (catalog +
    // operability lookups) averaging ~60ms/call in production. Resolving the
    // ranked list SERIALLY (one `await` per candidate, as this loop used to)
    // meant that whenever a request needed to walk deep into the list to find
    // enough live/qualifying candidates, the WHOLE cost landed on the request
    // before even the first streaming attempt started: the 5zM request above
    // spent ~19.9s of its 26.5s total duration just resolving 324 candidates
    // BEFORE the first byte was ever attempted. Resolving in bounded-concurrency
    // batches (order-preserving — results are still applied in ranked-list
    // order, so selection semantics are unchanged) cuts that wall-clock cost by
    // roughly the concurrency factor, which is what makes raising the
    // tools-required cap above safe rather than a straight latency trade.
    const FALLBACK_RESOLVE_CONCURRENCY = Number(
      process.env.STREAMING_FALLBACK_RESOLVE_CONCURRENCY ?? 10
    );
    for (
      let batchStart = 0;
      batchStart < fallbackModels.length && candidates.length <= maxStreamFallbacks;
      batchStart += FALLBACK_RESOLVE_CONCURRENCY
    ) {
      const batch = fallbackModels.slice(batchStart, batchStart + FALLBACK_RESOLVE_CONCURRENCY);
      const resolvedBatch = await Promise.all(
        batch.map((fallback) => providerRegistry.findModel(fallback.id))
      );
      for (const result of resolvedBatch) {
        if (candidates.length > maxStreamFallbacks) break;
        if (!result) continue;
        const adapterProvider = result.adapter.getName() || result.model.provider;
        // Tools requests: re-validate the RESOLVED registry model (see
        // FUNCTION-CALLING RE-VALIDATION note above). Skipped candidates do
        // not count toward the cap — we keep walking the ranked list.
        if (toolsRequired && explicitlyLacksFunctionCalling(result.model)) {
          skippedNoFunctionCalling += 1;
          continue;
        }
        // Keep the primary (already pushed) — only gate FALLBACK candidates, and
        // never let the skip empty the chain entirely.
        if (
          (primaryPushed || candidates.length > 0) &&
          isDeadCandidate(adapterProvider, result.model)
        ) {
          skippedDeadCandidates += 1;
          continue;
        }
        const providerCount = perProviderCount.get(adapterProvider) ?? 0;
        if (providerCount >= maxPerProvider) {
          continue;
        }
        perProviderCount.set(adapterProvider, providerCount + 1);
        pushCandidate(result.model, result.adapter, plan.request);
      }
    }
    if (skippedNoFunctionCalling > 0) {
      requestLog.warn(
        { skippedNoFunctionCalling, liveCandidates: candidates.length },
        'Skipped fallback candidates that explicitly lack function_calling for tools request'
      );
    }
    if (skippedDeadCandidates > 0) {
      requestLog.info(
        { skippedDeadCandidates, liveCandidates: candidates.length },
        'Skipped dead fallback candidates (open circuit / no credits / proven bad)'
      );
    }

    if (candidates.length === 0) {
      if (toolsRequired) {
        // FAIL CLOSED (2026-09-08 fix, mirrors acc0efee's hard-capability
        // fail-closed pattern): this branch is only reachable when
        // toolsRequired is true — the non-tools path already pushed the
        // primary unconditionally above, so candidates.length can never be
        // 0 there. Reaching here means the primary was demoted for
        // explicitly lacking function_calling AND every resolved fallback
        // was rejected too. See classifyEmptyToolsFallbackChain's doc
        // comment for why this fails closed instead of silently re-pushing
        // the already-demoted primary, and for the unsatisfiable/exhausted
        // distinction below.
        const classification = classifyEmptyToolsFallbackChain(
          skippedNoFunctionCalling,
          fallbackModels.length
        );
        requestLog.error(
          {
            primaryModel: plan.model.id,
            skippedNoFunctionCalling,
            skippedDeadCandidates,
            fallbackModelCount: fallbackModels.length,
            classification,
          },
          'No function-calling-capable live streaming candidates for tools request — failing closed instead of demoting to the already-rejected primary'
        );
        if (classification === 'unsatisfiable') {
          throw new NoFallbackCandidateError('function_calling');
        }
        throw new FallbackExhaustedError('function_calling', [
          {
            model: `${skippedDeadCandidates} function-calling-capable candidate(s)`,
            modelId: 'n/a',
            provider: 'multiple',
            status: 'failed',
            errorClass: 'provider_unavailable',
            errorMessage: 'dead (open circuit breaker / no credits) at chain-build time',
            durationMs: 0,
          },
        ]);
      }
      pushCandidate(plan.model, plan.adapter, plan.request);
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
      const PROVEN_BAD = new Set([
        'auth_failed',
        'no_credits',
        'rate_limited',
        'temporarily_unavailable',
      ]);
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

      // INTER-ATTEMPT DEAD RE-CHECK (2026-08-21, request k0QPvOU6tetSXz9gOJU-k):
      // candidates are resolved UP FRONT, so a provider that dies mid-chain
      // (attempt 1 gets HTTP 402/401/400-billing → circuit opens) keeps its
      // remaining pre-resolved slots in the list and attempts 2..N fail with
      // "Circuit breaker X is OPEN" — wasted wall-clock on providers already
      // known dead, while live candidates wait below. Re-evaluate liveness
      // right before each attempt; skip (do not burn the attempt) when the
      // provider turned dead since the chain was built. Never empties the
      // chain alone: index 0 is never skipped (a chain of one dead candidate
      // still gets its attempt — same never-empty semantics as the build-time
      // skip above).
      if (
        index > 0 &&
        isDeadCandidate(candidate.adapter.getName() || candidate.model.provider, candidate.model)
      ) {
        requestLog.info(
          {
            attempt,
            provider: candidate.adapter.getName(),
            modelId: candidate.model.id,
          },
          'Candidate provider died mid-chain (circuit opened / proven bad since build) — skipping attempt'
        );
        continue;
      }
      let chunkCount = 0;
      let totalTokens = 0;
      let lastChunk: ChatResponse | null = null;
      let firstChunkSent = false;
      // EMPTY-STREAM GUARD (2026-09-06 incident): a provider stream that
      // completes without throwing but never delivers real content or a
      // tool call must not be recorded as a hub SUCCESS below — see the
      // usage site for the full incident writeup. Tracked per-candidate,
      // across every choice (not just choices[0]) so a provider that puts
      // its answer on a non-zero choice index is not misclassified.
      let totalContentLength = 0;
      let sawToolCalls = false;

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
        //
        // RELAXED (2026-08-22, request Td9Rzv...): 6s proved too tight for mid/large
        // open-weight models (arcee deepseek-v4-pro, empiriolabs mistral-small —
        // both aborted by "first-chunk timeout after 6000ms" while queueing).
        // Default raised 6000ms -> 10000ms. Env-tunable via STREAMING_FIRST_CHUNK_MS;
        // the dynamic shortening below (hot fallback waiting) still applies.
        const iterator = providerStream[Symbol.asyncIterator]();
        const staticFirstChunkTimeoutMs = Number(process.env.STREAMING_FIRST_CHUNK_MS ?? 10000);
        // Dynamic first-chunk deadline (2026-07-14) — see
        // streaming-first-chunk-timeout.ts for the rationale.
        const firstChunkTimeoutMs = computeDynamicFirstChunkTimeoutMs(
          candidates,
          index,
          candidateRanks,
          staticFirstChunkTimeoutMs,
          Number(process.env.STREAMING_FIRST_CHUNK_FALLBACK_MS ?? 1800)
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
              (ret as Promise<unknown>).catch(() => {
                /* ignore */
              });
            }
          } catch {
            /* ignore */
          }
        };

        // First chunk under a hard deadline (rethrow on timeout → next candidate).
        let firstTimer: ReturnType<typeof setTimeout> | undefined;
        const firstDeadline = new Promise<never>((_, reject) => {
          firstTimer = setTimeout(
            () => reject(new Error(`first-chunk timeout after ${firstChunkTimeoutMs}ms`)),
            firstChunkTimeoutMs
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
          if (!firstChunkSent) {
            streamingTimeToFirstByte.observe(
              { strategy: requestedStrategy || 'auto', result: 'success' },
              Date.now() - startTime
            );
          }
          firstChunkSent = true;
          for (const streamedChoice of chunk.choices ?? []) {
            const streamedContent = streamedChoice.delta?.content;
            if (typeof streamedContent === 'string') {
              totalContentLength += streamedContent.length;
            }
            if (Array.isArray(streamedChoice.delta?.tool_calls) && streamedChoice.delta.tool_calls.length > 0) {
              sawToolCalls = true;
            }
          }
          // Anonymous streaming: audit-accumulate, and tripwire-check BEFORE
          // the chunk goes on the wire. The overlap window re-includes the
          // tail of already-checked text so a slur split across a chunk
          // boundary ("va"|"dia") is still caught. On violation the offending
          // chunk is replaced by the safe refusal, the stream is terminated
          // (iterator closed, loop broken — the sendSSEDone right after the
          // loop still runs exactly once) and the category is logged +
          // persisted on the audit row. Text streamed BEFORE the match may
          // already have reached the client — accepted limitation of a
          // streaming output filter; the full original text is kept in
          // anonFastText for the audit row.
          const anonDelta = chunk.choices?.[0]?.delta?.content;
          if (anonFastCtx && typeof chunk.model === 'string' && chunk.model) {
            anonFastModels.add(chunk.model);
          }
          if (
            anonFastCtx &&
            !anonFastTrippedCategory &&
            typeof anonDelta === 'string' &&
            anonDelta.length > 0
          ) {
            anonFastText += anonDelta;
            const fastViolation = anonymousOutputViolation(
              anonFastText.slice(-ANONYMOUS_TRIPWIRE_OVERLAP_CHARS * 2)
            );
            if (fastViolation) {
              anonFastTrippedCategory = fastViolation.category;
              requestLog.warn(
                { category: fastViolation.category, model: chunk.model },
                'anonymous-output tripwire: terminating violating anonymous stream'
              );
              chunk.choices = [
                {
                  index: 0,
                  delta: { content: ANONYMOUS_TRIPWIRE_REFUSAL },
                  finish_reason: 'stop',
                },
              ];
              sendSSEChunk(reply, chunk);
              closeIterator();
              break;
            }
          }
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
              'Single-stream idle past deadline — closing straggling provider stream'
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

        // Anonymous audit row (single/fast streaming path — previously
        // missing entirely; only the collective and non-streaming branches
        // persisted one). Fire-and-forget. Note anonFastText keeps the FULL
        // original text even when the tripwire replaced what was streamed.
        if (anonFastCtx) {
          recordAnonymousChat({
            requestId,
            apiKeyId: anonFastCtx.apiKeyId,
            visitorFingerprint: anonFastCtx.visitorFingerprint,
            visitorIp: anonFastCtx.visitorIp,
            userAgent: anonFastCtx.userAgent,
            acceptLanguage: anonFastCtx.acceptLanguage,
            modelRequested: chatRequest.model,
            modelsServed: [...anonFastModels],
            messages: chatRequest.messages,
            responseText: anonFastText || undefined,
            inputTokens: 0,
            outputTokens: 0,
            status: 'success',
            metadata: {
              streaming: true,
              strategy: 'single-streaming',
              outputTripwire: anonFastTrippedCategory,
            },
          });
        }

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
        //
        // EMPTY-STREAM GUARD (2026-09-06 incident, requests -kXgoqJ1wMeguw0,
        // wvLk_r6pxWu-, aFyPSyapYs6, U5C1zB-Fcvcx — all served by the same
        // route): a stream that never throws but also never delivers real
        // content or a tool call was still being recorded as a hub SUCCESS
        // here. Because isRouteHot() only looks at lastSuccessAt vs.
        // lastFailureAt, that false success kept a degenerate route "hot",
        // so the hot-first reorder above put it BACK at the front of the
        // candidate chain for every subsequent model=auto request — the
        // same broken route then won attempt #1 again and again, and every
        // one of four consecutive user messages (a retry, then unrelated
        // image/video-generation prompts) surfaced the same empty/garbled
        // output. Recording this as a failure (not success) demotes the
        // route out of "hot" so the next request's reorder gives a
        // healthier candidate a turn — classifyError() defaults an
        // unrecognized message like this one to 'unknown', not one of the
        // auth/credit/rate-limit states, so a single fluke does not get
        // quarantined as hard-dead the way a real 401/402 would.
        const hadMeaningfulOutput = hasMeaningfulStreamedOutput(totalContentLength, sawToolCalls);
        if (!hadMeaningfulOutput) {
          requestLog.warn(
            {
              attempt,
              provider: candidate.adapter.getName(),
              model: candidate.model.name,
              modelId: candidate.model.id,
              chunks: chunkCount,
            },
            'Streaming completed with no content and no tool calls — recording as a hub failure to prevent hot-route reinforcement'
          );
        }
        try {
          const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
          getProviderOperabilityHub().recordRouteExecution(
            candidate.adapter.getName(),
            candidate.model.id,
            hadMeaningfulOutput,
            undefined,
            hadMeaningfulOutput
              ? undefined
              : 'empty streaming output (no content, no tool calls)'
          );
        } catch {
          /* hub unavailable — non-fatal */
        }

        // Session affinity write (LOTE AW, 2026-09): this streaming fast
        // path is the dominant real-world path (stream:true, no explicit
        // collective strategy) and never went through the
        // strategy.recordExecution() sibling calls in
        // orchestration-engine.ts — record the model that actually served
        // this turn directly. Fire-and-forget; a missing
        // `sessionAffinityKey` (buildContext() didn't run, or ran on a
        // synthetic context) is a silent no-op.
        if (plan.context.sessionAffinityKey) {
          const { getSessionAffinityService } = await import(
            '@/services/session-affinity-service'
          );
          getSessionAffinityService()
            .recordOutcome({
              organizationId: plan.context.organizationId,
              identifier: plan.context.sessionAffinityKey.identifier,
              sessionKey: plan.context.sessionAffinityKey.sessionKey,
              modelId: candidate.model.id,
              provider: candidate.model.provider || candidate.adapter.getName(),
              triage: plan.context.triage,
            })
            .catch(() => {});
        }

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
        const errorObj: ProviderError | null =
          error && typeof error === 'object' && error !== null ? (error as ProviderError) : null;
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
            candidate.adapter.getName(),
            candidate.model.id,
            false,
            errorDetails.status,
            errorDetails.message
          );
        } catch {
          /* hub unavailable — non-fatal */
        }

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
    requestLog.error(
      { error: errorMessage, duration: durationMs, allAttempts },
      'Streaming failed'
    );

    // Client only ever sees a generic, request-ID-correlated message here —
    // errorObj/errorMessage (already logged above in full, including raw
    // upstream provider text) can contain vendor account/billing details
    // (e.g. "account balance is insufficient", internal transaction ids)
    // that must not be relayed to the API caller. Two deliberate exceptions,
    // both entirely our own message text (never vendor-derived, so relaying
    // verbatim is safe) and far more actionable for an agentic caller than a
    // generic "provider error" that invites a blind retry:
    //  - function-calling fail-closed errors (NoFallbackCandidateError /
    //    FallbackExhaustedError);
    //  - context-window-exceeded (2026-09 audit): detected either via our
    //    own pre-flight check (single-model-strategy.ts) throwing
    //    ContextWindowExceededError directly, or a real provider rejection
    //    whose message matches error-classification.ts's
    //    CONTEXT_EXCEEDED_KEYWORDS (this streaming path calls provider
    //    adapters directly, bypassing the strategy classes' own classified
    //    throws, so this is the only place to catch a raw provider-side
    //    rejection here) — CONTEXT_EXCEEDED_KEYWORDS never matches
    //    vendor-account/billing text, so this carve-out doesn't weaken that
    //    guarantee either.
    const isClassifiedCapabilityError =
      error instanceof NoFallbackCandidateError || error instanceof FallbackExhaustedError;
    const { classifyProviderError } = await import('@/core/operability');
    const isContextExceeded =
      error instanceof ContextWindowExceededError ||
      classifyProviderError(error).errorClass === 'context_exceeded';
    sendSSEError(
      reply,
      isClassifiedCapabilityError
        ? (error as Error)
        : isContextExceeded
          ? new ContextWindowExceededError(
              `Request context size exceeds the model's context window (request ${requestId}). Reduce the request (shorter history, fewer/smaller tool results) or choose a model with a larger context window.`
            )
          : new Error(`Upstream provider error while streaming (request ${requestId}).`)
    );
    sendSSEDone(reply);

    // Anonymous audit row (failed fast-path stream) — a failed anonymous run
    // is just as investigable as a successful one, mirroring the collective
    // branch's finally-block behavior.
    if (anonFastCtx) {
      recordAnonymousChat({
        requestId,
        apiKeyId: anonFastCtx.apiKeyId,
        visitorFingerprint: anonFastCtx.visitorFingerprint,
        visitorIp: anonFastCtx.visitorIp,
        userAgent: anonFastCtx.userAgent,
        acceptLanguage: anonFastCtx.acceptLanguage,
        modelRequested: chatRequest.model,
        modelsServed: [...anonFastModels],
        messages: chatRequest.messages,
        responseText: anonFastText || undefined,
        status: 'error',
        errorCode: error instanceof Error ? error.name : 'stream_error',
        metadata: {
          streaming: true,
          strategy: 'single-streaming',
          outputTripwire: anonFastTrippedCategory,
        },
      });
    }

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
 * Register provider-capability discovery endpoints.
 *
 * Registers exactly one route: `GET /v1/provider-capabilities`. It reads the
 * provider registry directly and needs no orchestration engine, which is why
 * this function takes none.
 *
 * `POST /v1/chat/completions/intelligent` and `POST /v1/analyze-requirements`
 * used to be registered here; both were removed on 2026-08-03. The retraction
 * is recorded in `docs/guides/migration-guide.md` ("Removed Endpoints") in this
 * repo, and in the public changelog (`reference/changelog.mdx`) in the separate
 * `guide` repo — this repo has no CHANGELOG file. Use `POST /v1/chat/completions`
 * with `model: "auto"`, which runs the same selection through the canonical
 * orchestration engine (with cost accounting and billing the removed routes
 * never had).
 */
export async function registerCapabilityRoutes(fastify: FastifyInstance): Promise<void> {
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
            requestLog.warn(
              { provider: adapter.getName(), error: errorMessage },
              'Failed to get provider info'
            );
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
}
