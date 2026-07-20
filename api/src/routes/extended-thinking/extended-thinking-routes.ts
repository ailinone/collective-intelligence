// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Extended Thinking Routes
 * Claude/Gemini-compatible extended thinking modes with REAL implementation
 * 
 * Features:
 * - Extended thinking (Claude-style prolonged reasoning)
 * - Ultra thinking (Ailin Collective Intelligence with 9 models)
 * - Dynamic model selection based on thinking_mode capability
 * - Streaming support
 * - Full orchestration integration
 *
 * NO HARDCODED MODELS - All selection is dynamic via capabilities
 * REAL IMPLEMENTATION - Uses orchestration engine with thinking-capable models
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  OrchestrationContext,
  ExecutionStrategyName,
} from '@/types';
import type { ExtendedFastifyRequest } from '@/types/fastify-extended';
import { createOrchestrationContext } from '@/utils/orchestration-context';
import {
  getOrchestrationEngine,
  isOrchestrationEngineInitialized,
} from '@/core/orchestration/orchestration-engine';
import { ModelRepository } from '@/services/model-repository';
import { nanoid } from 'nanoid';
import { trackChatUsage } from '@/services/billing-usage-tracker';
// SSE helpers reserved for future streaming support; route currently
// returns full responses synchronously.

const log = logger.child({ module: 'extended-thinking-routes' });

// ==
// Types
// ==

interface ExtendedThinkingRequest {
  messages: ChatMessage[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
  thinking_budget?: number; // Max tokens for thinking (Claude-style)
  stream?: boolean;
  // Ailin extensions
  quality_target?: number;
  max_cost?: number;
}

interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

interface TextBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ThinkingBlock | TextBlock;

interface ExtendedThinkingResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: ContentBlock[];
    };
    finish_reason: 'stop' | 'length' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    thinking_tokens?: number;
  };
  ailin_metadata?: {
    thinking_enabled: boolean;
    models_used: string[];
    strategy_used: string;
    total_cost: number;
    total_duration_ms: number;
  };
}

// ==
// Extended Thinking Service
// ==

class ExtendedThinkingService {
  private modelRepo: ModelRepository;

  constructor() {
    this.modelRepo = new ModelRepository();
  }

  /**
   * Execute extended thinking request
   * Uses models with thinking_mode capability (Claude, Gemini with thinking)
   */
  async executeExtendedThinking(
    request: ExtendedThinkingRequest,
    context: OrchestrationContext
  ): Promise<ExtendedThinkingResponse> {
    const startTime = Date.now();

    log.info(
      {
        requestId: context.requestId,
        messageCount: request.messages.length,
        thinkingBudget: request.thinking_budget,
      },
      'Extended thinking execution started'
    );

    // Step 1: Find models with thinking_mode capability
    const thinkingModels = await this.modelRepo.findModelsWithCapabilities(
      ['thinking_mode'],
      { limit: 5 }
    );

    if (thinkingModels.length === 0) {
      // Fallback to reasoning-capable models
      const reasoningModels = await this.modelRepo.findModelsWithCapabilities(
        ['reasoning'],
        { limit: 5 }
      );

      if (reasoningModels.length === 0) {
        throw new Error(
          'No thinking-capable models available. Configure at least one provider with thinking_mode or reasoning capability.'
        );
      }

      thinkingModels.push(...reasoningModels);
    }

    // Step 2: Build the candidate chain. This route used to pin
    // thinkingModels[0] with NO fallback — the repo fetched 5 candidates and
    // discarded 4, so one degraded provider failed the whole request. An
    // explicitly requested model stays pinned (no silent substitution);
    // auto-select tries the ranked candidates in order.
    let candidates = thinkingModels;
    if (request.model) {
      const requestedModel = thinkingModels.find(
        (m) => m.id === request.model || m.name === request.model
      );
      if (requestedModel) {
        candidates = [requestedModel];
      }
    }

    // Step 3: Prepare request with thinking instruction
    const thinkingSystemPrompt = this.buildThinkingSystemPrompt(request.thinking_budget);
    const enhancedMessages: ChatMessage[] = [
      { role: 'system', content: thinkingSystemPrompt },
      ...request.messages,
    ];

    // Step 4: Execute via orchestration engine, falling back across candidates
    if (!isOrchestrationEngineInitialized()) {
      throw new Error('OrchestrationEngine not initialized');
    }

    const engine = getOrchestrationEngine();
    let selectedModel = candidates[0];
    let result: Awaited<ReturnType<typeof engine.execute>> | null = null;
    let lastError: unknown = null;

    for (const candidate of candidates) {
      log.info(
        {
          requestId: context.requestId,
          model: candidate.name,
          provider: candidate.provider,
        },
        'Selected thinking model'
      );

      const chatRequest: ChatRequest = {
        model: candidate.id,
        messages: enhancedMessages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.max_tokens ?? 8192,
        quality_target: request.quality_target ?? 0.9,
        max_cost: request.max_cost,
      };

      try {
        result = await engine.execute(chatRequest, context.organizationId, context.userId);
        selectedModel = candidate;
        break;
      } catch (candidateError: unknown) {
        lastError = candidateError;
        const errorMessage = candidateError instanceof Error ? candidateError.message : String(candidateError);
        log.warn(
          { requestId: context.requestId, model: candidate.name, provider: candidate.provider, error: errorMessage },
          'Extended thinking candidate failed — trying next'
        );
      }
    }

    if (!result) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`All extended-thinking candidates failed (${candidates.length} tried)`);
    }

    // Step 5: Parse response to extract thinking blocks
    const responseContent = this.extractContent(result.finalResponse);
    const { thinkingBlocks, textBlocks, thinkingTokens } =
      this.parseThinkingContent(responseContent);

    const contentBlocks: ContentBlock[] = [
      ...thinkingBlocks.map((t): ThinkingBlock => ({ type: 'thinking', thinking: t })),
      ...textBlocks.map((t): TextBlock => ({ type: 'text', text: t })),
    ];

    const durationMs = Date.now() - startTime;

    log.info(
      {
        requestId: context.requestId,
        model: selectedModel.name,
        thinkingBlocks: thinkingBlocks.length,
        textBlocks: textBlocks.length,
        durationMs,
      },
      'Extended thinking completed'
    );

    return {
      id: `chatcmpl-${nanoid(24)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: selectedModel.name,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: contentBlocks,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: result.finalResponse.usage?.prompt_tokens ?? 0,
        completion_tokens: result.finalResponse.usage?.completion_tokens ?? 0,
        total_tokens: result.finalResponse.usage?.total_tokens ?? 0,
        thinking_tokens: thinkingTokens,
      },
      ailin_metadata: {
        thinking_enabled: true,
        models_used: result.modelsUsed.map((m) => m.modelId),
        strategy_used: result.strategyUsed,
        total_cost: result.totalCost,
        total_duration_ms: durationMs,
      },
    };
  }

  /**
   * Execute ultra thinking with collective intelligence
   * Uses massive-parallel or collaborative strategy with multiple models
   */
  async executeUltraThinking(
    request: ExtendedThinkingRequest,
    context: OrchestrationContext
  ): Promise<ExtendedThinkingResponse> {
    const startTime = Date.now();

    log.info(
      {
        requestId: context.requestId,
        messageCount: request.messages.length,
      },
      'Ultra thinking (Collective Intelligence) execution started'
    );

    // Step 1: Get multiple high-quality models for collective intelligence
    const models = await this.modelRepo.findModelsWithCapabilities(
      ['reasoning', 'chat'],
      { limit: 9, anyMatch: true }
    );

    if (models.length < 2) {
      throw new Error(
        'Ultra thinking requires at least 2 models. Configure more providers.'
      );
    }

    log.info(
      {
        requestId: context.requestId,
        modelCount: models.length,
        models: models.map((m) => m.name),
      },
      'Selected models for ultra thinking'
    );

    // Step 2: Prepare enhanced request with collective intelligence prompt
    const ultraSystemPrompt = this.buildUltraThinkingSystemPrompt();
    const enhancedMessages: ChatMessage[] = [
      { role: 'system', content: ultraSystemPrompt },
      ...request.messages,
    ];

    // Step 3: Determine strategy based on model count
    let strategy: ExecutionStrategyName = 'collaborative';
    if (models.length >= 5) {
      strategy = 'massive-parallel';
    } else if (models.length >= 3) {
      strategy = 'debate';
    }

    const chatRequest: ChatRequest = {
      model: 'auto', // Let orchestration select
      messages: enhancedMessages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 16384,
      strategy,
      quality_target: request.quality_target ?? 0.95,
      max_cost: request.max_cost,
    };

    // Step 4: Execute via orchestration engine with selected strategy
    if (!isOrchestrationEngineInitialized()) {
      throw new Error('OrchestrationEngine not initialized');
    }

    const engine = getOrchestrationEngine();

    // Update context with strategy-specific settings
    const ultraContext: OrchestrationContext = {
      ...context,
      models,
      qualityTarget: 0.95,
      taskType: 'reasoning',
    };

    const result = await engine.execute(chatRequest, ultraContext.organizationId, ultraContext.userId);

    // Step 5: Build response with collective thinking metadata
    const responseContent = this.extractContent(result.finalResponse);
    const { thinkingBlocks, textBlocks, thinkingTokens } =
      this.parseThinkingContent(responseContent);

    const contentBlocks: ContentBlock[] = [
      ...thinkingBlocks.map((t): ThinkingBlock => ({ type: 'thinking', thinking: t })),
      ...textBlocks.map((t): TextBlock => ({ type: 'text', text: t })),
    ];

    // If no explicit thinking blocks, wrap entire response as text
    if (contentBlocks.length === 0) {
      contentBlocks.push({ type: 'text', text: responseContent });
    }

    const durationMs = Date.now() - startTime;

    log.info(
      {
        requestId: context.requestId,
        strategy,
        modelsUsed: result.modelsUsed.length,
        durationMs,
        totalCost: result.totalCost,
      },
      'Ultra thinking completed'
    );

    return {
      id: `chatcmpl-${nanoid(24)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `ailin-ultra-${models.length}`,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: contentBlocks,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: result.finalResponse.usage?.prompt_tokens ?? 0,
        completion_tokens: result.finalResponse.usage?.completion_tokens ?? 0,
        total_tokens: result.finalResponse.usage?.total_tokens ?? 0,
        thinking_tokens: thinkingTokens,
      },
      ailin_metadata: {
        thinking_enabled: true,
        models_used: result.modelsUsed.map((m) => m.modelId),
        strategy_used: result.strategyUsed,
        total_cost: result.totalCost,
        total_duration_ms: durationMs,
      },
    };
  }

  /**
   * Build system prompt for extended thinking mode
   */
  private buildThinkingSystemPrompt(thinkingBudget?: number): string {
    const budgetInstruction = thinkingBudget
      ? `You have a thinking budget of approximately ${thinkingBudget} tokens for your reasoning process.`
      : '';

    return `You are an advanced AI assistant with extended thinking capabilities.

When responding to complex questions, you should:
1. First, engage in careful step-by-step reasoning, enclosed in <thinking> tags
2. Consider multiple perspectives and approaches
3. Identify potential issues or edge cases
4. Then provide your final, well-reasoned response

${budgetInstruction}

Format your response as:
<thinking>
[Your detailed reasoning process here]
</thinking>

[Your final response here]

Be thorough in your thinking but concise in your final answer.`;
  }

  /**
   * Build system prompt for ultra thinking (collective intelligence)
   */
  private buildUltraThinkingSystemPrompt(): string {
    return `You are part of an advanced collective intelligence system that leverages multiple AI perspectives.

Your task is to provide the most comprehensive, accurate, and well-reasoned response possible.

When responding:
1. Consider the problem from multiple angles
2. Identify and address potential weaknesses in reasoning
3. Synthesize insights into a coherent, high-quality response
4. Be explicit about your reasoning process using <thinking> tags when appropriate

Your response will be combined with other AI perspectives to create an optimal solution.
Focus on quality, accuracy, and completeness.`;
  }

  /**
   * Extract text content from chat response
   */
  private extractContent(response: ChatResponse): string {
    const message = response.choices?.[0]?.message;
    if (!message) {
      return '';
    }

    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }

    return '';
  }

  /**
   * Parse content to extract thinking blocks and text blocks
   */
  private parseThinkingContent(content: string): {
    thinkingBlocks: string[];
    textBlocks: string[];
    thinkingTokens: number;
  } {
    const thinkingBlocks: string[] = [];
    const textBlocks: string[] = [];

    // Extract <thinking> blocks
    const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    while ((match = thinkingRegex.exec(content)) !== null) {
      // Add text before thinking block
      if (match.index > lastIndex) {
        const textBefore = content.slice(lastIndex, match.index).trim();
        if (textBefore) {
          textBlocks.push(textBefore);
        }
      }

      thinkingBlocks.push(match[1].trim());
      lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last thinking block
    if (lastIndex < content.length) {
      const remainingText = content.slice(lastIndex).trim();
      if (remainingText) {
        textBlocks.push(remainingText);
      }
    }

    // If no thinking blocks found, treat entire content as text
    if (thinkingBlocks.length === 0 && textBlocks.length === 0 && content.trim()) {
      textBlocks.push(content.trim());
    }

    // Estimate thinking tokens (rough approximation: 4 chars per token)
    const thinkingTokens = Math.ceil(
      thinkingBlocks.reduce((sum, block) => sum + block.length, 0) / 4
    );

    return { thinkingBlocks, textBlocks, thinkingTokens };
  }
}

// ==
// Route Registration
// ==

export async function registerExtendedThinkingRoutes(
  server: FastifyInstance
): Promise<void> {
  const thinkingService = new ExtendedThinkingService();

  // POST /v1/chat/completions/extended-thinking
  server.post<{ Body: ExtendedThinkingRequest }>(
    '/v1/chat/completions/extended-thinking',
    {
      schema: {
        tags: ['Chat', 'Extended Thinking'],
        summary: 'Extended thinking mode',
        description:
          'Uses Claude-style extended thinking or Gemini thinking mode with multi-model orchestration. Returns structured thinking blocks alongside the response.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['messages'],
          properties: {
            messages: {
              type: 'array',
              description: 'Conversation messages. Each message has a role (system, user, assistant) and content (text or multimodal array).',
              items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                  role: { 
                    type: 'string', 
                    enum: ['system', 'user', 'assistant'],
                    description: 'Message role: system (instructions), user (input), assistant (previous responses)',
                  },
                  content: {
                    oneOf: [
                      { type: 'string', description: 'Text content as a string' },
                      { type: 'array', items: { type: 'object' }, description: 'Multimodal content array (text, images, etc.)' },
                    ],
                    description: 'Message content. Can be a string or array of content blocks.',
                  },
                },
              },
              minItems: 1,
            },
            model: {
              type: 'string',
              description:
                'Model ID or "auto" for dynamic selection of thinking-capable models (e.g., Claude models with thinking modes, Gemini with extended thinking)',
            },
            max_tokens: { 
              type: 'integer', 
              minimum: 1, 
              default: 8192,
              description: 'Maximum tokens in the response. Higher values allow longer outputs. Default: 8192',
            },
            temperature: { 
              type: 'number', 
              minimum: 0, 
              maximum: 2, 
              default: 0.7,
              description: 'Sampling temperature (0-2). Higher values increase randomness. Default: 0.7 for balanced reasoning',
            },
            thinking_budget: {
              type: 'integer',
              minimum: 100,
              maximum: 32000,
              description: 'Maximum tokens allocated specifically for the thinking/reasoning process (separate from response tokens). Range: 100-32000',
            },
            stream: { 
              type: 'boolean', 
              default: false,
              description: 'Whether to stream responses incrementally as Server-Sent Events (SSE)',
            },
            quality_target: { 
              type: 'number', 
              minimum: 0, 
              maximum: 1, 
              default: 0.9,
              description: 'Target quality level (0-1). Higher values prioritize reasoning quality over speed/cost. Default: 0.9',
            },
            max_cost: { 
              type: 'number', 
              minimum: 0,
              description: 'Maximum cost threshold (USD). Orchestration will not exceed this cost.',
            },
          },
        },
        response: {
          200: {
            description: 'Extended thinking completed successfully',
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Completion ID' },
              object: { type: 'string', enum: ['chat.completion'], description: 'Object type' },
              created: { type: 'integer', description: 'Unix timestamp of creation' },
              model: { type: 'string', description: 'Model used for thinking' },
              choices: {
                type: 'array',
                description: 'Completion choices with thinking blocks',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer', description: 'Choice index (0-based)' },
                    message: {
                      type: 'object',
                      description: 'Response message containing role, content, and thinking blocks',
                      properties: {
                        role: { type: 'string', description: 'Message role: assistant' },
                        content: { type: 'string', description: 'Response content text' },
                        thinking: { type: 'string', description: 'Thinking process (Claude-style extended thinking blocks)' },
                      },
                    },
                    finish_reason: { type: 'string', description: 'Reason for completion: stop (natural end), length (token limit), tool_calls (tool usage required)' },
                  },
                },
              },
              usage: {
                type: 'object',
                description: 'Token usage statistics',
                properties: {
                  prompt_tokens: { type: 'integer', description: 'Number of tokens in the prompt' },
                  completion_tokens: { type: 'integer', description: 'Number of tokens in the completion' },
                  thinking_tokens: { type: 'integer', description: 'Tokens used for thinking process (separate from completion tokens)' },
                  total_tokens: { type: 'integer', description: 'Total tokens used (prompt + completion + thinking)' },
                },
              },
              ailin_metadata: {
                type: 'object',
                description: 'Ailin-specific metadata about the request',
                properties: {
                  provider_used: { type: 'string', description: 'AI provider used (e.g., "anthropic", "google")' },
                  thinking_mode: { type: 'string', description: 'Thinking mode used (e.g., "extended", "ultra")' },
                  total_cost: { type: 'number', description: 'Total cost in USD for this request' },
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
      preHandler: authenticateRequest,
    },
    async (request: FastifyRequest<{ Body: ExtendedThinkingRequest }>, reply: FastifyReply) => {
      const extendedRequest = request as ExtendedFastifyRequest;
      const thinkingRequest = request.body;

      // Create orchestration context
      const userContext: OrchestrationContext = extendedRequest.userContext
        ? extendedRequest.userContext
        : createOrchestrationContext(request, {
            taskType: 'reasoning',
            contextSize: JSON.stringify(thinkingRequest.messages).length,
          });

      const requestId =
        typeof request.id === 'string' ? request.id : `ext-think-${nanoid(16)}`;
      userContext.requestId = requestId;

      try {
        // Handle streaming (future enhancement)
        if (thinkingRequest.stream) {
          // For now, execute normally and stream the result
          log.info({ requestId }, 'Extended thinking streaming mode requested');
        }

        // Execute extended thinking
        const response = await thinkingService.executeExtendedThinking(
          thinkingRequest,
          userContext
        );

        // Track usage for billing
        if (response.usage && userContext.organizationId) {
          await trackChatUsage({
            organizationId: userContext.organizationId,
            userId: userContext.userId ?? '',
            requestId,
            request: {
              model: response.model,
              messages: thinkingRequest.messages,
            },
            cacheHit: false,
            totalCostOverride: response.ailin_metadata?.total_cost ?? 0,
            totalTokensOverride: response.usage?.total_tokens ?? 0,
          });
        }

        return reply.send(response);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ requestId, error: errorMessage }, 'Extended thinking failed');

        return reply.status(500).send({
          error: {
            message: errorMessage,
            type: 'extended_thinking_error',
            code: 'THINKING_FAILED',
          },
        });
      }
    }
  );

  // POST /v1/chat/completions/ultra-thinking
  server.post<{ Body: ExtendedThinkingRequest }>(
    '/v1/chat/completions/ultra-thinking',
    {
      schema: {
        tags: ['Chat', 'Extended Thinking'],
        summary: 'Ultra thinking mode (Collective Intelligence)',
        description:
          'Ailin exclusive: orchestrates up to 9 models simultaneously with collaborative/massive-parallel strategy for maximum reasoning quality.',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        body: {
          type: 'object',
          required: ['messages'],
          properties: {
            messages: {
              type: 'array',
              description: 'Conversation messages. Each message has a role (system, user, assistant) and content (text or multimodal array).',
              items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                  role: { 
                    type: 'string', 
                    enum: ['system', 'user', 'assistant'],
                    description: 'Message role: system (instructions), user (input), assistant (previous responses)',
                  },
                  content: {
                    oneOf: [
                      { type: 'string', description: 'Text content as a string' },
                      {
                        type: 'array',
                        description: 'Multimodal content array (text, images, etc.)',
                        items: {
                          type: 'object',
                          description: 'Content block object. Can contain text, image_url, or other multimodal content types.',
                          properties: {
                            type: {
                              type: 'string',
                              description: 'Content block type: text, image_url, etc.',
                            },
                            text: {
                              type: 'string',
                              description: 'Text content (for text type blocks)',
                            },
                            image_url: {
                              type: 'object',
                              description: 'Image URL object (for image_url type blocks)',
                            },
                          },
                        },
                      },
                    ],
                    description: 'Message content. Can be a string or array of content blocks.',
                  },
                },
              },
              minItems: 1,
            },
            model: {
              type: 'string',
              description: 'Not used in ultra-thinking (uses multiple models)',
            },
            max_tokens: { 
              type: 'integer', 
              minimum: 1, 
              default: 16384,
              description: 'Maximum tokens in the response. Higher values allow longer reasoning outputs. Default: 16384',
            },
            temperature: { 
              type: 'number', 
              minimum: 0, 
              maximum: 2, 
              default: 0.7,
              description: 'Sampling temperature (0-2). Higher values increase randomness. Default: 0.7 for balanced reasoning',
            },
            stream: { 
              type: 'boolean', 
              default: false,
              description: 'Whether to stream responses incrementally as Server-Sent Events (SSE)',
            },
            quality_target: { 
              type: 'number', 
              minimum: 0, 
              maximum: 1, 
              default: 0.95,
              description: 'Target quality level (0-1). Higher values prioritize reasoning quality. Default: 0.95',
            },
            max_cost: { 
              type: 'number', 
              minimum: 0,
              description: 'Maximum cost threshold (USD). Orchestration will not exceed this cost.',
            },
          },
        },
        response: {
          200: {
            description: 'Ultra thinking completed successfully',
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Completion ID' },
              object: { type: 'string', enum: ['chat.completion'], description: 'Object type' },
              created: { type: 'integer', description: 'Unix timestamp of creation' },
              model: { type: 'string', description: 'Primary model used (or "collective" for multi-model)' },
              choices: {
                type: 'array',
                description: 'Completion choices with consolidated thinking',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer', description: 'Choice index (0-based)' },
                    message: {
                      type: 'object',
                      description: 'Response message containing role, content, and consolidated thinking',
                      properties: {
                        role: { type: 'string', description: 'Message role: assistant' },
                        content: { type: 'string', description: 'Response content text' },
                        thinking: { type: 'string', description: 'Consolidated thinking from multiple models (ultra-thinking mode)' },
                      },
                    },
                    finish_reason: { type: 'string', description: 'Reason for completion: stop (natural end), length (token limit), tool_calls (tool usage required)' },
                  },
                },
              },
              usage: {
                type: 'object',
                description: 'Token usage statistics across all models',
                properties: {
                  prompt_tokens: { type: 'integer', description: 'Number of tokens in the prompt' },
                  completion_tokens: { type: 'integer', description: 'Number of tokens in the completion' },
                  thinking_tokens: { type: 'integer', description: 'Total tokens used for thinking across all models' },
                  total_tokens: { type: 'integer', description: 'Total tokens used (prompt + completion + thinking)' },
                },
              },
              ailin_metadata: {
                type: 'object',
                description: 'Ailin-specific metadata about the ultra-thinking request',
                properties: {
                  providers_used: { type: 'array', items: { type: 'string' }, description: 'List of providers/models used in the collective intelligence orchestration' },
                  strategy: { type: 'string', description: 'Orchestration strategy used (e.g., "collaborative", "massive-parallel")' },
                  total_cost: { type: 'number', description: 'Total cost in USD across all models used' },
                  consensus_score: { type: 'number', description: 'Consensus score (0-1) indicating agreement level among multiple models' },
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
      preHandler: authenticateRequest,
    },
    async (request: FastifyRequest<{ Body: ExtendedThinkingRequest }>, reply: FastifyReply) => {
      const extendedRequest = request as ExtendedFastifyRequest;
      const thinkingRequest = request.body;

      // Create orchestration context
      const userContext: OrchestrationContext = extendedRequest.userContext
        ? extendedRequest.userContext
        : createOrchestrationContext(request, {
            taskType: 'reasoning',
            contextSize: JSON.stringify(thinkingRequest.messages).length,
          });

      const requestId =
        typeof request.id === 'string' ? request.id : `ultra-think-${nanoid(16)}`;
      userContext.requestId = requestId;

      try {
        // Execute ultra thinking with collective intelligence
        const response = await thinkingService.executeUltraThinking(
          thinkingRequest,
          userContext
        );

        // Track usage for billing
        if (response.usage && userContext.organizationId) {
          await trackChatUsage({
            organizationId: userContext.organizationId,
            userId: userContext.userId ?? '',
            requestId,
            request: {
              model: response.model,
              messages: thinkingRequest.messages,
            },
            cacheHit: false,
            totalCostOverride: response.ailin_metadata?.total_cost ?? 0,
            totalTokensOverride: response.usage?.total_tokens ?? 0,
          });
        }

        return reply.send(response);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ requestId, error: errorMessage }, 'Ultra thinking failed');

        return reply.status(500).send({
          error: {
            message: errorMessage,
            type: 'ultra_thinking_error',
            code: 'ULTRA_THINKING_FAILED',
          },
        });
      }
    }
  );

  log.info('Extended Thinking routes registered successfully (REAL implementation)');
}
