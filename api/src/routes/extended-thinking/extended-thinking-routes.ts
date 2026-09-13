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
 * Claude/Gemini-compatible extended thinking modes
 *
 * Features:
 * - Extended thinking (Claude-style prolonged reasoning)
 * - Ultra thinking (Ailin Collective Intelligence with 9 models)
 * - Dynamic model selection based on thinking_mode capability
 * - Streaming support
 * - Full orchestration integration
 *
 * NO HARDCODED MODELS - All selection is dynamic via capabilities
 *
 * NATIVE-WHEN-AVAILABLE, PROMPT-ENGINEERED FALLBACK OTHERWISE (LOTE AZ
 * follow-up, 2026-09). Both routes below resolve the caller's intent through
 * the canonical `resolveReasoningEffort()` (`@/utils/reasoning-effort`) and,
 * for a candidate/model that carries the `thinking_mode` capability (or the
 * defensive name heuristic in `modelHasNativeThinking()`), attach
 * `reasoning_effort`/`thinking_budget` directly onto the `ChatRequest`
 * forwarded to the orchestration engine — the SAME request shape
 * `resolveReasoningEffort()` callers everywhere else in the codebase consume
 * (base-strategy.ts's native-thinking budget, and the per-provider
 * Anthropic/Google/OpenAI/xAI native mappings), so a model with real native
 * extended-thinking support gets the ACTUAL provider mechanism (thinking
 * budget / reasoning-effort tier), not just a text instruction. The
 * prompt-injection ("wrap your reasoning in <thinking> tags") plus
 * regex-parsing approach that used to run unconditionally for EVERY model is
 * now used ONLY as the graceful fallback for models with no native thinking
 * support at all — see `executeExtendedThinking`/`executeUltraThinking`
 * below for the per-branch detail.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { rejectAnonymousGuestKeyPreHandler } from '@/services/anonymous-quota-gate';
import { rejectChatFreeTierKeyPreHandler } from '@/services/free-tier-quota-gate';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  OrchestrationContext,
  OrchestrationResult,
  ExecutionStrategyName,
  ReasoningEffort,
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
import { evaluateOrchestrationGate } from '@/services/orchestration-gate';
import {
  EFFORT_THINKING_BUDGETS,
  modelHasNativeThinking,
  resolveReasoningEffort,
} from '@/utils/reasoning-effort';
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
  thinking_budget?: number; // Max tokens for thinking (Claude-style). Wins verbatim over reasoning_effort — see resolveReasoningEffort().
  /** Canonical graded effort dial (LOTE AZ). Resolved together with
   *  `thinking_budget` via `resolveReasoningEffort()` — see module doc. */
  reasoning_effort?: ReasoningEffort;
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

export class ExtendedThinkingService {
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
    const thinkingModels = await this.modelRepo.findModelsWithCapabilities(['thinking_mode'], {
      limit: 5,
    });

    if (thinkingModels.length === 0) {
      // Fallback to reasoning-capable models
      const reasoningModels = await this.modelRepo.findModelsWithCapabilities(['reasoning'], {
        limit: 5,
      });

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

    // Step 3: Resolve the caller's reasoning-effort intent ONCE via the
    // canonical resolver (LOTE AZ). Hitting this endpoint at all is an
    // explicit ask for extended thinking, so — unlike the generic
    // `/v1/chat/completions` resolution — a caller who supplied neither
    // `reasoning_effort` nor `thinking_budget` still gets a concrete budget
    // here (`EFFORT_THINKING_BUDGETS.medium`) rather than "no signal at all".
    const resolvedEffort = resolveReasoningEffort({
      reasoning_effort: request.reasoning_effort,
      thinking_budget: request.thinking_budget,
    });
    const effectiveEffort: ReasoningEffort = resolvedEffort.effort ?? 'medium';
    const effectiveThinkingBudget = resolvedEffort.thinkingBudget ?? EFFORT_THINKING_BUDGETS.medium;

    // Prompt-injection fallback messages — built once, used ONLY for
    // candidates that fail the native-thinking check below (`buildThinkingSystemPrompt`
    // asks the model to narrate its reasoning as text; this is the fallback,
    // not the primary mechanism, see module doc).
    const thinkingSystemPrompt = this.buildThinkingSystemPrompt(request.thinking_budget);
    const fallbackMessages: ChatMessage[] = [
      { role: 'system', content: thinkingSystemPrompt },
      ...request.messages,
    ];

    // Step 4: Execute via orchestration engine, falling back across candidates
    if (!isOrchestrationEngineInitialized()) {
      throw new Error('OrchestrationEngine not initialized');
    }

    const engine = getOrchestrationEngine();
    let selectedModel = candidates[0];
    let selectedModelIsNative = modelHasNativeThinking(selectedModel);
    let result: Awaited<ReturnType<typeof engine.execute>> | null = null;
    let lastError: unknown = null;

    for (const candidate of candidates) {
      // Per-candidate, NOT assumed from the `thinking_mode` capability filter
      // above: `thinkingModels` should already all be native, but the
      // zero-results fallback pushes in `reasoning`-capability models too
      // (line ~164), which are not necessarily native. Checking per-candidate
      // means a mixed candidate chain still gets the right treatment for
      // EACH model it actually tries, not just the first one.
      const isNative = modelHasNativeThinking(candidate);

      log.info(
        {
          requestId: context.requestId,
          model: candidate.name,
          provider: candidate.provider,
          nativeThinking: isNative,
        },
        'Selected thinking model'
      );

      const chatRequest: ChatRequest = {
        model: candidate.id,
        // Native models: send the caller's own messages untouched — no
        // <thinking>-tag prompt engineering, the provider's real
        // extended-thinking mechanism (activated below) produces genuine
        // internal reasoning without being asked to narrate it as text.
        // Non-native models: keep today's prompt-injection fallback exactly
        // as before.
        messages: isNative ? request.messages : fallbackMessages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.max_tokens ?? 8192,
        quality_target: request.quality_target ?? 0.9,
        max_cost: request.max_cost,
        ...(isNative
          ? {
              // THE actual fix: attach the canonical fields to the ChatRequest
              // forwarded to the orchestration engine, in the exact shape
              // `resolveReasoningEffort()` callers everywhere else consume
              // (base-strategy.ts's native-thinking budget today; the
              // per-provider Anthropic/Google/OpenAI/xAI native mappings once
              // those land). `thinking_budget` is ALSO read directly by
              // adapters that don't go through executeModelWithReasoning
              // (byteplus-adapter.ts, groq-adapter.ts,
              // openai-compatible-hub-adapter.ts), so this activates real
              // native thinking regardless of which internal strategy path
              // the orchestration engine picks for this request.
              reasoning_effort: effectiveEffort,
              thinking_budget: effectiveThinkingBudget,
              // Also enables base-strategy's own reasoning_traces capture
              // (executeModelWithReasoning -> extractReasoning) for
              // strategies that gate on it — a no-op prompt-wise for native
              // models specifically, since withReasoningPrompt() already
              // skips injection when hasNativeThinking(model) is true.
              ailin_constraints: { enable_reasoning: true },
            }
          : {}),
      };

      try {
        result = await engine.execute(chatRequest, context.organizationId, context.userId);
        selectedModel = candidate;
        selectedModelIsNative = isNative;
        break;
      } catch (candidateError: unknown) {
        lastError = candidateError;
        const errorMessage =
          candidateError instanceof Error ? candidateError.message : String(candidateError);
        log.warn(
          {
            requestId: context.requestId,
            model: candidate.name,
            provider: candidate.provider,
            error: errorMessage,
          },
          'Extended thinking candidate failed — trying next'
        );
      }
    }

    if (!result) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`All extended-thinking candidates failed (${candidates.length} tried)`);
    }

    // Step 5: Extract the thinking content. For a native model, prefer the
    // orchestration engine's own `reasoning_traces` (populated by
    // executeModelWithReasoning -> extractReasoning when the strategy path
    // honors `ailin_constraints.enable_reasoning`) — that is genuine
    // provider-native reasoning, not text we asked the model to produce.
    // Falls back to the <thinking>/<think>-tag regex parse (today's only
    // mechanism) whenever native traces aren't available: a non-native
    // candidate, or a native one whose selected strategy path didn't run
    // through executeModelWithReasoning but may still have emitted its raw
    // native <think> tags straight into the content untouched.
    const responseContent = this.extractContent(result.finalResponse);
    const nativeReasoning = selectedModelIsNative ? this.extractNativeReasoningTraces(result) : [];

    let thinkingBlocks: string[];
    let textBlocks: string[];
    let thinkingTokens: number;
    if (nativeReasoning.length > 0) {
      thinkingBlocks = nativeReasoning;
      textBlocks = responseContent.trim() ? [responseContent.trim()] : [];
      thinkingTokens = Math.ceil(nativeReasoning.reduce((sum, t) => sum + t.length, 0) / 4);
    } else {
      ({ thinkingBlocks, textBlocks, thinkingTokens } = this.parseThinkingContent(responseContent));
    }

    const contentBlocks: ContentBlock[] = [
      ...thinkingBlocks.map((t): ThinkingBlock => ({ type: 'thinking', thinking: t })),
      ...textBlocks.map((t): TextBlock => ({ type: 'text', text: t })),
    ];

    const durationMs = Date.now() - startTime;

    log.info(
      {
        requestId: context.requestId,
        model: selectedModel.name,
        nativeThinking: selectedModelIsNative,
        usedNativeReasoningTraces: nativeReasoning.length > 0,
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
    const models = await this.modelRepo.findModelsWithCapabilities(['reasoning', 'chat'], {
      limit: 9,
      anyMatch: true,
    });

    if (models.length < 2) {
      throw new Error('Ultra thinking requires at least 2 models. Configure more providers.');
    }

    log.info(
      {
        requestId: context.requestId,
        modelCount: models.length,
        models: models.map((m) => m.name),
      },
      'Selected models for ultra thinking'
    );

    // Step 2: Prepare enhanced request with collective intelligence prompt.
    // Kept UNCONDITIONALLY here (unlike executeExtendedThinking's single-model
    // pin) because ultra-thinking fans one ChatRequest out across up to 9
    // heterogeneous models at once — some may have native thinking, some may
    // not, and there is no per-model message customization hook at this
    // level. The prompt stays a harmless, low-cost nudge for whichever
    // participants lack native support; models that DO have it still get the
    // real mechanism via `reasoning_effort`/`thinking_budget` below (and
    // `withReasoningPrompt()` in base-strategy.ts already skips its OWN
    // reasoning-tag injection for a model where `hasNativeThinking()` is
    // true, so native participants don't see duplicated instructions).
    const ultraSystemPrompt = this.buildUltraThinkingSystemPrompt();
    const enhancedMessages: ChatMessage[] = [
      { role: 'system', content: ultraSystemPrompt },
      ...request.messages,
    ];

    // Step 2.5: Resolve the caller's reasoning-effort intent (LOTE AZ). Ultra
    // thinking's whole point is maximum reasoning depth, so — same rationale
    // as executeExtendedThinking — an unset caller value here defaults to
    // 'high' rather than 'medium' or "no signal".
    const resolvedEffort = resolveReasoningEffort({
      reasoning_effort: request.reasoning_effort,
      thinking_budget: request.thinking_budget,
    });
    const effectiveEffort: ReasoningEffort = resolvedEffort.effort ?? 'high';
    const effectiveThinkingBudget = resolvedEffort.thinkingBudget ?? EFFORT_THINKING_BUDGETS.high;

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
      // THE actual fix (see module doc): attach the canonical fields so any
      // participant with real native thinking support (`thinking_mode`
      // capability) activates the actual provider mechanism instead of only
      // ever getting the prompt-engineered narration above.
      reasoning_effort: effectiveEffort,
      thinking_budget: effectiveThinkingBudget,
      ailin_constraints: { enable_reasoning: true },
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

    const result = await engine.execute(
      chatRequest,
      ultraContext.organizationId,
      ultraContext.userId
    );

    // Step 5: Build response with collective thinking metadata. Prefer real
    // native reasoning traces (see executeExtendedThinking's Step 5 doc for
    // why) over the prompt-injection regex parse whenever the collective
    // strategy actually populated them.
    const responseContent = this.extractContent(result.finalResponse);
    const nativeReasoning = this.extractNativeReasoningTraces(result);

    let thinkingBlocks: string[];
    let textBlocks: string[];
    let thinkingTokens: number;
    if (nativeReasoning.length > 0) {
      thinkingBlocks = nativeReasoning;
      textBlocks = responseContent.trim() ? [responseContent.trim()] : [];
      thinkingTokens = Math.ceil(nativeReasoning.reduce((sum, t) => sum + t.length, 0) / 4);
    } else {
      ({ thinkingBlocks, textBlocks, thinkingTokens } = this.parseThinkingContent(responseContent));
    }

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
   * Real native-thinking traces from the orchestration engine, if the
   * selected strategy path actually populated them. `metadata.reasoning_traces`
   * is the established, codebase-wide convention every strategy uses to
   * surface `ModelExecution.reasoning` (populated by
   * `executeModelWithReasoning` -> `extractReasoning`) — see
   * `single-model-strategy.ts`, `consensus-strategy.ts`, and the ~25 other
   * strategies that build this same shape. Reading it here (rather than only
   * ever regexing the final response text) is what lets a genuinely native
   * model's real internal reasoning surface as a `thinking` block even after
   * it has already been stripped out of the visible response content.
   */
  private extractNativeReasoningTraces(result: Pick<OrchestrationResult, 'metadata'>): string[] {
    const traces = result.metadata?.reasoning_traces;
    if (!Array.isArray(traces)) return [];
    return (traces as Array<{ reasoning?: unknown }>)
      .map((t) => t.reasoning)
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .map((r) => r.trim());
  }

  /**
   * Parse content to extract thinking blocks and text blocks.
   * Matches BOTH `<thinking>...</thinking>` (the prompt-injection fallback's
   * own convention, asked for by `buildThinkingSystemPrompt`/
   * `buildUltraThinkingSystemPrompt`) and `<think>...</think>` (the raw
   * native format some models — DeepSeek-R1, QwQ — emit directly into their
   * completion text when nothing upstream already stripped it out via
   * `extractNativeReasoningTraces`).
   */
  private parseThinkingContent(content: string): {
    thinkingBlocks: string[];
    textBlocks: string[];
    thinkingTokens: number;
  } {
    const thinkingBlocks: string[] = [];
    const textBlocks: string[] = [];

    // Extract <thinking>...</thinking> or <think>...</think> blocks (tag
    // name captured and back-referenced so open/close always match).
    const thinkingRegex = /<(thinking|think)>([\s\S]*?)<\/\1>/gi;
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

      thinkingBlocks.push(match[2].trim());
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

export async function registerExtendedThinkingRoutes(server: FastifyInstance): Promise<void> {
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
              description:
                'Conversation messages. Each message has a role (system, user, assistant) and content (text or multimodal array).',
              items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                  role: {
                    type: 'string',
                    enum: ['system', 'user', 'assistant'],
                    description:
                      'Message role: system (instructions), user (input), assistant (previous responses)',
                  },
                  content: {
                    oneOf: [
                      { type: 'string', description: 'Text content as a string' },
                      {
                        type: 'array',
                        items: { type: 'object' },
                        description: 'Multimodal content array (text, images, etc.)',
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
              description:
                'Model ID or "auto" for dynamic selection of thinking-capable models (e.g., Claude models with thinking modes, Gemini with extended thinking)',
            },
            max_tokens: {
              type: 'integer',
              minimum: 1,
              default: 8192,
              description:
                'Maximum tokens in the response. Higher values allow longer outputs. Default: 8192',
            },
            temperature: {
              type: 'number',
              minimum: 0,
              maximum: 2,
              default: 0.7,
              description:
                'Sampling temperature (0-2). Higher values increase randomness. Default: 0.7 for balanced reasoning',
            },
            thinking_budget: {
              type: 'integer',
              minimum: 100,
              maximum: 32000,
              description:
                'Maximum tokens allocated specifically for the thinking/reasoning process (separate from response tokens). Range: 100-32000. Wins verbatim over reasoning_effort when both are set.',
            },
            reasoning_effort: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description:
                'Canonical graded reasoning-effort dial. For a model with real native extended-thinking support, maps to a documented thinking_budget tier (low=1024, medium=4096, high=16384 tokens) and activates the actual native mechanism. Defaults to "medium" when neither this nor thinking_budget is set.',
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
              description:
                'Target quality level (0-1). Higher values prioritize reasoning quality over speed/cost. Default: 0.9',
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
                        thinking: {
                          type: 'string',
                          description: 'Thinking process (Claude-style extended thinking blocks)',
                        },
                      },
                    },
                    finish_reason: {
                      type: 'string',
                      description:
                        'Reason for completion: stop (natural end), length (token limit), tool_calls (tool usage required)',
                    },
                  },
                },
              },
              usage: {
                type: 'object',
                description: 'Token usage statistics',
                properties: {
                  prompt_tokens: { type: 'integer', description: 'Number of tokens in the prompt' },
                  completion_tokens: {
                    type: 'integer',
                    description: 'Number of tokens in the completion',
                  },
                  thinking_tokens: {
                    type: 'integer',
                    description:
                      'Tokens used for thinking process (separate from completion tokens)',
                  },
                  total_tokens: {
                    type: 'integer',
                    description: 'Total tokens used (prompt + completion + thinking)',
                  },
                },
              },
              ailin_metadata: {
                type: 'object',
                description: 'Ailin-specific metadata about the request',
                properties: {
                  provider_used: {
                    type: 'string',
                    description: 'AI provider used (e.g., "anthropic", "google")',
                  },
                  thinking_mode: {
                    type: 'string',
                    description: 'Thinking mode used (e.g., "extended", "ultra")',
                  },
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
      preHandler: [
        authenticateRequest,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
      ],
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

      const requestId = typeof request.id === 'string' ? request.id : `ext-think-${nanoid(16)}`;
      userContext.requestId = requestId;

      try {
        // Admission gate. Class B: this route is already metered (trackChatUsage
        // below), so adding the check is purely additive with no accounting
        // change. Check-only helper — it records nothing. Defaults to shadow
        // mode: evaluates and logs, denies nothing.
        //
        // `strategy` is deliberately OMITTED. 'extended-thinking' is a route
        // name, not a member of `ExecutionStrategyName | StrategyInputName`
        // (`types/index.ts:834`), and `evaluatePolicy` does an exact-string
        // membership test against the org's `allowedStrategies`
        // (`org-governance-service.ts:377`). Passing a non-canonical token would
        // produce a `policy_violation` on EVERY request for any org that has
        // configured an allowed-strategy list out of the canonical names — which
        // under shadow mode systematically inflates the very
        // `orchestration_gate.shadow_denial` rate this workstream uses as its
        // enforcement-readiness signal, and would 403 blameless users the moment
        // this endpoint was allowlisted. The real strategy is not knowable here
        // anyway: `executeExtendedThinking` picks it from model-repository
        // candidates resolved inside the service. `evaluatePolicy` short-circuits
        // on an empty strategy (`:377`), so model allow/block lists and the
        // budget cap still apply.
        const gate = await evaluateOrchestrationGate({
          organizationId: userContext.organizationId,
          userId: userContext.userId ?? '',
          endpoint: '/v1/chat/completions/extended-thinking',
          requestId,
          model: thinkingRequest.model,
        });
        if (!gate.allowed) {
          return reply.status(gate.status).send(gate.body);
        }

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
              description:
                'Conversation messages. Each message has a role (system, user, assistant) and content (text or multimodal array).',
              items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                  role: {
                    type: 'string',
                    enum: ['system', 'user', 'assistant'],
                    description:
                      'Message role: system (instructions), user (input), assistant (previous responses)',
                  },
                  content: {
                    oneOf: [
                      { type: 'string', description: 'Text content as a string' },
                      {
                        type: 'array',
                        description: 'Multimodal content array (text, images, etc.)',
                        items: {
                          type: 'object',
                          description:
                            'Content block object. Can contain text, image_url, or other multimodal content types.',
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
              description:
                'Maximum tokens in the response. Higher values allow longer reasoning outputs. Default: 16384',
            },
            temperature: {
              type: 'number',
              minimum: 0,
              maximum: 2,
              default: 0.7,
              description:
                'Sampling temperature (0-2). Higher values increase randomness. Default: 0.7 for balanced reasoning',
            },
            thinking_budget: {
              type: 'integer',
              minimum: 100,
              maximum: 32000,
              description:
                'Maximum tokens allocated for native extended-thinking, for any collective participant with real native support. Wins verbatim over reasoning_effort when both are set.',
            },
            reasoning_effort: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description:
                'Canonical graded reasoning-effort dial, applied to every native-thinking-capable participant in the collective. Defaults to "high" when neither this nor thinking_budget is set.',
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
              description:
                'Target quality level (0-1). Higher values prioritize reasoning quality. Default: 0.95',
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
              model: {
                type: 'string',
                description: 'Primary model used (or "collective" for multi-model)',
              },
              choices: {
                type: 'array',
                description: 'Completion choices with consolidated thinking',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer', description: 'Choice index (0-based)' },
                    message: {
                      type: 'object',
                      description:
                        'Response message containing role, content, and consolidated thinking',
                      properties: {
                        role: { type: 'string', description: 'Message role: assistant' },
                        content: { type: 'string', description: 'Response content text' },
                        thinking: {
                          type: 'string',
                          description:
                            'Consolidated thinking from multiple models (ultra-thinking mode)',
                        },
                      },
                    },
                    finish_reason: {
                      type: 'string',
                      description:
                        'Reason for completion: stop (natural end), length (token limit), tool_calls (tool usage required)',
                    },
                  },
                },
              },
              usage: {
                type: 'object',
                description: 'Token usage statistics across all models',
                properties: {
                  prompt_tokens: { type: 'integer', description: 'Number of tokens in the prompt' },
                  completion_tokens: {
                    type: 'integer',
                    description: 'Number of tokens in the completion',
                  },
                  thinking_tokens: {
                    type: 'integer',
                    description: 'Total tokens used for thinking across all models',
                  },
                  total_tokens: {
                    type: 'integer',
                    description: 'Total tokens used (prompt + completion + thinking)',
                  },
                },
              },
              ailin_metadata: {
                type: 'object',
                description: 'Ailin-specific metadata about the ultra-thinking request',
                properties: {
                  providers_used: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'List of providers/models used in the collective intelligence orchestration',
                  },
                  strategy: {
                    type: 'string',
                    description:
                      'Orchestration strategy used (e.g., "collaborative", "massive-parallel")',
                  },
                  total_cost: {
                    type: 'number',
                    description: 'Total cost in USD across all models used',
                  },
                  consensus_score: {
                    type: 'number',
                    description:
                      'Consensus score (0-1) indicating agreement level among multiple models',
                  },
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
      preHandler: [
        authenticateRequest,
        rejectAnonymousGuestKeyPreHandler,
        rejectChatFreeTierKeyPreHandler,
      ],
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

      const requestId = typeof request.id === 'string' ? request.id : `ultra-think-${nanoid(16)}`;
      userContext.requestId = requestId;

      try {
        // Admission gate. Ultra-thinking is collective intelligence — many
        // models per single request — so it is one of the highest-amplification
        // doors in the API and belongs in the first enforcement wave. Already
        // metered below, so the check is purely additive. Defaults to shadow.
        //
        // `strategy` is OMITTED for the same reason as the extended-thinking
        // route above, and here it is not merely non-canonical but genuinely
        // unknowable at gate time: `executeUltraThinking` selects between
        // 'collaborative', 'debate' and 'massive-parallel' from the number of
        // models it resolves (`:322-328`), which happens after this point.
        const gate = await evaluateOrchestrationGate({
          organizationId: userContext.organizationId,
          userId: userContext.userId ?? '',
          endpoint: '/v1/chat/completions/ultra-thinking',
          requestId,
          model: thinkingRequest.model,
        });
        if (!gate.allowed) {
          return reply.status(gate.status).send(gate.body);
        }

        // Execute ultra thinking with collective intelligence
        const response = await thinkingService.executeUltraThinking(thinkingRequest, userContext);

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
