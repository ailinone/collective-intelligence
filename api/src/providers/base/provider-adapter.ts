// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Base Provider Adapter Interface
 * All provider adapters must implement this interface
 */

import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
} from '@/types';
import type {
  AudioTTSRequest,
  AudioTTSResponse,
  AudioSTTRequest,
  AudioSTTResponse,
  ImageGenRequest,
  ImageGenResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  VideoGenRequest,
  VideoGenResponse,
  VisionRequest,
  VisionResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';
import { logger } from '@/utils/logger';
import { getErrorMessage } from '@/utils/type-guards';
import { distributedBulkheadManager, type BulkheadLike } from '@/core/resilience/distributed-bulkhead';
import { distributedCircuitBreakerManager } from '@/core/resilience/distributed-circuit-breaker';
import { tokenBucketManager } from '@/core/resilience/token-bucket-limiter';
import { providerTpmRejectedTotal } from '@/observability/ci-metrics';

/**
 * Health check result
 */
export interface HealthCheckResult {
  healthy: boolean;
  latency?: number;
  error?: string;
  checkedAt: Date;
}

/**
 * Provider balance/credit check result
 */
export interface BalanceCheckResult {
  hasCredits: boolean;
  balance?: number;
  currency?: string;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  /** Scale-to-100k Phase 2: optional additional keys, rotated alongside apiKey. See @/types ProviderConfig. */
  apiKeyPool?: string[];
}

/**
 * Abstract base class for all provider adapters
 */
export abstract class ProviderAdapter {
  protected config: ProviderConfig;
  protected name: string;
  protected displayName: string;
  protected bulkhead!: BulkheadLike; // Bulkhead instance for resource isolation — distributed (fleet-wide), scale-to-100k Phase 2
  protected circuitBreaker!: ReturnType<typeof distributedCircuitBreakerManager.getBreaker>; // Circuit breaker for failure protection (v5.0)
  protected adaptiveTimeout: { currentTimeout: number; lastUpdate: number; recordLatency?: (latency: number) => Promise<void> } | null = null; // Adaptive timeout tracker (v5.0)

  constructor(name: string, displayName: string, config: ProviderConfig) {
    this.name = name;
    this.displayName = displayName;
    this.config = {
      timeout: 60000, // 60s default
      maxRetries: 3,
      retryDelay: 1000, // 1s
      ...config,
    };

    // Initialize bulkhead for this provider (v5.0 - INTEGRATED)
    this.initializeBulkhead();
  }

  /**
   * Get API key (for adapters that need to expose it, e.g., realtime clients)
   */
  getApiKey(): string {
    return this.config.apiKey;
  }

  private poolRotationIndex = 0;

  /**
   * All configured keys for this provider — apiKey plus any apiKeyPool
   * entries, deduplicated. Adapters that support multi-account rotation
   * (see the OpenAI adapter for the reference implementation) use this list
   * to build multiple upstream clients/credentials instead of just one.
   */
  protected getAllApiKeys(): string[] {
    const keys = [this.config.apiKey, ...(this.config.apiKeyPool ?? [])].filter(
      (k): k is string => typeof k === 'string' && k.length > 0
    );
    return Array.from(new Set(keys));
  }

  /**
   * Round-robin the next key/index across getAllApiKeys(). Stateful per
   * adapter instance — fine for spreading load across accounts, NOT a
   * fleet-wide-fair mechanism (each replica rotates independently). That's
   * an acceptable tradeoff here: the goal is to avoid pinning 100% of a
   * provider's traffic to a single account, not to perfectly balance load
   * across accounts fleet-wide.
   */
  protected nextPoolIndex(poolSize: number): number {
    const index = this.poolRotationIndex % Math.max(1, poolSize);
    this.poolRotationIndex++;
    return index;
  }

  /**
   * Initialize bulkhead pattern and circuit breaker for this provider
   * Provides resource isolation and failure protection
   */
  private initializeBulkhead(): void {
    try {
      // Configure bulkhead based on provider tier
      const config = this.getBulkheadConfig();
      this.bulkhead = distributedBulkheadManager.getBulkhead(this.name, config);

      // Configure circuit breaker for this provider
      this.circuitBreaker = distributedCircuitBreakerManager.getBreaker(
        `${this.name}-api`,
        'llm-provider'
      );

      logger.info(
        { provider: this.name, bulkhead: config },
        '✅ Bulkhead + Circuit Breaker enabled'
      );
    } catch (error) {
      logger.warn(
        { provider: this.name, error },
        '⚠️ Resilience patterns initialization failed, continuing without'
      );
    }
  }

  /**
   * Get bulkhead configuration for this provider
   */
  protected getBulkheadConfig(): {
    maxConcurrent: number;
    maxQueueSize: number;
    queueTimeout: number;
  } {
    // Tier-based configuration
    const tierConfigs: Record<string, { maxConcurrent: number; maxQueueSize: number; queueTimeout: number }> = {
      openai: { maxConcurrent: 20, maxQueueSize: 100, queueTimeout: 60000 },
      anthropic: { maxConcurrent: 20, maxQueueSize: 100, queueTimeout: 60000 },
      google: { maxConcurrent: 20, maxQueueSize: 100, queueTimeout: 60000 },
      deepseek: { maxConcurrent: 10, maxQueueSize: 50, queueTimeout: 45000 },
      mistral: { maxConcurrent: 15, maxQueueSize: 75, queueTimeout: 50000 },
      xai: { maxConcurrent: 10, maxQueueSize: 50, queueTimeout: 45000 },
      cohere: { maxConcurrent: 10, maxQueueSize: 50, queueTimeout: 45000 },
      nvidia: { maxConcurrent: 15, maxQueueSize: 75, queueTimeout: 55000 },
      'nvidia-hub': { maxConcurrent: 15, maxQueueSize: 75, queueTimeout: 55000 },
      aihubmix: { maxConcurrent: 12, maxQueueSize: 60, queueTimeout: 50000 },
      novita: { maxConcurrent: 12, maxQueueSize: 60, queueTimeout: 50000 },
      moonshot: { maxConcurrent: 15, maxQueueSize: 75, queueTimeout: 55000 },
      minimax: { maxConcurrent: 12, maxQueueSize: 60, queueTimeout: 50000 },
      jina: { maxConcurrent: 12, maxQueueSize: 60, queueTimeout: 50000 },
      friendli: { maxConcurrent: 12, maxQueueSize: 60, queueTimeout: 50000 },
      aiml: { maxConcurrent: 12, maxQueueSize: 60, queueTimeout: 50000 },
      imagerouter: { maxConcurrent: 8, maxQueueSize: 40, queueTimeout: 45000 },
      openrouter: { maxConcurrent: 20, maxQueueSize: 100, queueTimeout: 60000 },
      orqai: { maxConcurrent: 18, maxQueueSize: 90, queueTimeout: 60000 },
      edenai: { maxConcurrent: 12, maxQueueSize: 60, queueTimeout: 50000 },
      heliconeai: { maxConcurrent: 15, maxQueueSize: 75, queueTimeout: 55000 },
    };

    const base = tierConfigs[this.name] || {
      maxConcurrent: 10,
      maxQueueSize: 50,
      queueTimeout: 30000,
    };

    // Scale-to-100k Phase 2: per-provider ceiling should be a config value,
    // not a hardcoded constant that only a code change can adjust. Optional
    // JSON override, e.g.:
    //   PROVIDER_BULKHEAD_LIMITS={"openai":{"maxConcurrent":80}}
    // Merges over (not replaces) the built-in defaults above, so operators
    // can tune a single provider without restating every field/provider.
    const override = this.getBulkheadOverride();
    return override ? { ...base, ...override } : base;
  }

  private getBulkheadOverride(): Partial<{
    maxConcurrent: number;
    maxQueueSize: number;
    queueTimeout: number;
  }> | null {
    const raw = process.env.PROVIDER_BULKHEAD_LIMITS;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<{
        maxConcurrent: number;
        maxQueueSize: number;
        queueTimeout: number;
      }>>;
      return parsed[this.name] ?? null;
    } catch (error) {
      logger.warn(
        { provider: this.name, error },
        'PROVIDER_BULKHEAD_LIMITS is not valid JSON — ignoring override'
      );
      return null;
    }
  }

  /**
   * TPM (tokens-per-minute) budget for this provider — scale-to-100k Phase 2
   * follow-up (issue #152). Distinct from the bulkhead's concurrency cap:
   * this bounds total token throughput over time, not simultaneous calls.
   * Sized conservatively by default; override per-provider via
   * PROVIDER_TPM_LIMITS (JSON env, same merge pattern as
   * PROVIDER_BULKHEAD_LIMITS).
   */
  protected getTpmConfig(): { capacity: number; refillRatePerSecond: number } {
    const tierConfigs: Record<string, { capacity: number; refillRatePerSecond: number }> = {
      openai: { capacity: 450_000, refillRatePerSecond: 7_500 }, // 450k burst, ~450k/min sustained
      anthropic: { capacity: 400_000, refillRatePerSecond: 6_667 },
      google: { capacity: 400_000, refillRatePerSecond: 6_667 },
    };

    const base = tierConfigs[this.name] || { capacity: 150_000, refillRatePerSecond: 2_500 };
    const override = this.getTpmOverride();
    return override ? { ...base, ...override } : base;
  }

  private getTpmOverride(): Partial<{ capacity: number; refillRatePerSecond: number }> | null {
    const raw = process.env.PROVIDER_TPM_LIMITS;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<
        string,
        Partial<{ capacity: number; refillRatePerSecond: number }>
      >;
      return parsed[this.name] ?? null;
    } catch (error) {
      logger.warn({ provider: this.name, error }, 'PROVIDER_TPM_LIMITS is not valid JSON — ignoring override');
      return null;
    }
  }

  /**
   * Consume `estimatedTokens` from this provider's fleet-wide TPM budget.
   * Throws if the budget is exhausted. Called from executeThroughBulkhead
   * BEFORE acquiring a bulkhead lease — a TPM-limited request shouldn't hold
   * a concurrency slot while doing nothing.
   */
  private async consumeTpmBudget(estimatedTokens: number): Promise<void> {
    const { capacity, refillRatePerSecond } = this.getTpmConfig();
    const bucket = tokenBucketManager.getBucket('provider-tpm', this.name, {
      capacity,
      refillRate: refillRatePerSecond,
    });
    const allowed = await bucket.consume(estimatedTokens);
    if (!allowed) {
      providerTpmRejectedTotal.inc({ provider: this.name });
      throw new Error(
        `Provider ${this.name} TPM budget exhausted (requested ${estimatedTokens} tokens, capacity ${capacity}/${refillRatePerSecond}/s). Try again later.`
      );
    }
  }

  /**
   * Get provider name
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get provider display name
   */
  getDisplayName(): string {
    return this.displayName;
  }

  /**
   * Get provider information
   */
  abstract getProvider(): Promise<Provider>;

  /**
   * Get available models
   */
  abstract getModels(): Promise<Model[]>;

  /**
   * Chat completion (non-streaming)
   * Note: Actual implementations should call this.executeThroughBulkhead()
   */
  abstract chatCompletion(request: ChatRequest): Promise<ChatResponse>;

  /**
   * Execute operation through full resilience stack (v5.0 - INTEGRATED)
   * TPM budget (if estimatedTokens given) → Bulkhead → Circuit Breaker → Operation
   *
   * @param estimatedTokens Optional token-cost estimate for this call. When
   * provided, consumes from the provider's fleet-wide TPM budget before
   * attempting to acquire a bulkhead lease (scale-to-100k Phase 2 follow-up,
   * issue #152). Omit to keep the prior concurrency-only behavior — existing
   * call sites that don't estimate token cost are unaffected.
   */
  protected async executeThroughBulkhead<T>(
    operation: () => Promise<T>,
    operationName: string = 'operation',
    estimatedTokens?: number
  ): Promise<T> {
    const startTime = Date.now();

    if (typeof estimatedTokens === 'number' && estimatedTokens > 0) {
      await this.consumeTpmBudget(estimatedTokens);
    }

    try {
      // Layer 1: Bulkhead (resource isolation)
      const bulkheadOperation = async () => {
        // Layer 2: Circuit Breaker (failure protection)
        if (this.circuitBreaker) {
          return await this.circuitBreaker.execute(operation);
        }
        return await operation();
      };

      let result: T;
      if (this.bulkhead) {
        result = await this.bulkhead.execute(bulkheadOperation);
      } else {
        result = await bulkheadOperation();
      }

      // Record latency for adaptive timeouts
      const latency = Date.now() - startTime;
      if (this.adaptiveTimeout && this.adaptiveTimeout.recordLatency) {
        await this.adaptiveTimeout.recordLatency(latency).catch(() => {});
      }

      return result;
    } catch (error) {
      const latency = Date.now() - startTime;

      // Record latency even on failure
      if (this.adaptiveTimeout && this.adaptiveTimeout.recordLatency) {
        await this.adaptiveTimeout.recordLatency(latency).catch(() => {});
      }

      logger.warn(
        {
          provider: this.name,
          operation: operationName,
          latency,
          error: getErrorMessage(error),
        },
        'Resilience stack rejected operation'
      );
      throw error;
    }
  }

  /**
   * Chat completion (streaming)
   */
  abstract chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown>;

  /**
   * Generate embeddings
   */
  abstract generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse>;

  /**
   * Health check
   */
  abstract healthCheck(): Promise<HealthCheckResult>;

  /**
   * Check provider balance/credits.
   * Optional — providers without a balance API should leave the default (returns null).
   * Returning null means "unable to check"; returning { hasCredits: false } means "confirmed no credits".
   */
  async checkBalance(): Promise<BalanceCheckResult | null> {
    return null;
  }

  /**
   * Calculate cost for a request/response
   */
  abstract calculateCost(model: Model, inputTokens: number, outputTokens: number): number;

  /**
   * Normalize model name (convert provider-specific to standard)
   * Can be async for adapters that need to fetch model info
   */
  abstract normalizeModelName(modelName: string): string | Promise<string>;

  /**
   * Text-to-Speech (TTS)
   * Converts text to audio
   * 
   * @returns AudioTTSResponse with audio buffer
   * @throws Error if provider doesn't support TTS or if request fails
   */
  // Base-class default implementations throw because the capability is not
  // supported by every provider. Parameters are intentionally unused at this
  // layer (subclasses that override use them with non-prefixed names —
  // TypeScript permits parameter renaming in overrides).
  async textToSpeech(_model: Model, _request: AudioTTSRequest): Promise<AudioTTSResponse> {
    throw new Error(`${this.name}: textToSpeech not implemented. Provider does not support TTS capability.`);
  }

  /**
   * Speech-to-Text (STT)
   * Transcribes audio to text
   *
   * @returns AudioSTTResponse with transcribed text
   * @throws Error if provider doesn't support STT or if request fails
   */
  async speechToText(_model: Model, _request: AudioSTTRequest): Promise<AudioSTTResponse> {
    throw new Error(`${this.name}: speechToText not implemented. Provider does not support STT capability.`);
  }

  /**
   * Image Generation
   * Generates images from text prompts
   *
   * @returns ImageGenResponse with image buffer or URL
   * @throws Error if provider doesn't support image generation or if request fails
   */
  async imageGenerate(_model: Model, _request: ImageGenRequest): Promise<ImageGenResponse> {
    throw new Error(`${this.name}: imageGenerate not implemented. Provider does not support image generation capability.`);
  }

  /**
   * Image Edit
   * Edits images based on prompt and optional mask
   * 
   * @param model Model to use
   * @param request Request with image, mask, and prompt
   * @returns ImageEditResponse with edited image
   * @throws Error if provider doesn't support image editing
   */
  abstract imageEdit(model: Model, request: ImageEditRequest): Promise<ImageEditResponse>;

  /**
   * Image Variations
   * Creates variations of an existing image
   * 
   * @param model Model to use
   * @param request Request with source image
   * @returns ImageVariationResponse with variation images
   * @throws Error if provider doesn't support image variations
   */
  abstract imageVariation(model: Model, request: ImageVariationRequest): Promise<ImageVariationResponse>;

  /**
   * Video Generation
   * Generates videos from prompt and optional conditioning media
   */
  async videoGenerate(_model: Model, _request: VideoGenRequest): Promise<VideoGenResponse> {
    throw new Error(`${this.name}: videoGenerate not implemented. Provider does not support video generation capability.`);
  }

  /**
   * Web Search
   * Performs web search for grounding
   * 
   * @param model Model with web_search capability
   * @param request Search request
   * @returns Search results
   * @throws Error if provider doesn't support web search
   */
  async webSearch(_model: Model, _request: { query: string; maxResults?: number; options?: Record<string, unknown> }): Promise<{ text: string; raw: unknown }> {
    throw new Error(`${this.name}: webSearch not implemented. Provider does not support web search capability.`);
  }

  /**
   * Content Moderation
   * Classifies content for policy violations
   * 
   * @param model Model with moderation capability
   * @param request Moderation request
   * @returns Moderation result
   * @throws Error if provider doesn't support moderation
   */
  abstract moderate(model: Model, request: ModerationRequest): Promise<ModerationResponse>;

  /**
   * Vision (Image Understanding)
   * Analyzes images and answers questions
   * 
   * @param model Model with vision capability
   * @param request Vision request with image and prompt
   * @returns VisionResponse with analysis
   * @throws Error if provider doesn't support vision
   */
  async vision(model: Model, request: VisionRequest): Promise<VisionResponse> {
    const toImageUrl = (image: Buffer | string): string => {
      if (Buffer.isBuffer(image)) {
        return `data:image/png;base64,${image.toString('base64')}`;
      }

      const trimmed = image.trim();
      if (!trimmed) {
        throw new Error(`${this.name}: vision request image is empty`);
      }

      if (
        trimmed.startsWith('http://') ||
        trimmed.startsWith('https://') ||
        trimmed.startsWith('data:')
      ) {
        return trimmed;
      }

      // Best-effort fallback for base64-only payloads.
      if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length > 32) {
        return `data:image/png;base64,${trimmed.replace(/\s+/g, '')}`;
      }

      return trimmed;
    };

    const imageUrl = toImageUrl(request.image);
    const response = await this.chatCompletion({
      model: model.name || model.id,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: request.prompt },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
                detail:
                  typeof request.options?.detail === 'string' &&
                  (request.options.detail === 'low' ||
                    request.options.detail === 'high' ||
                    request.options.detail === 'auto')
                    ? request.options.detail
                    : 'auto',
              },
            },
          ],
        },
      ],
      temperature:
        typeof request.options?.temperature === 'number' ? request.options.temperature : 0.2,
      max_tokens:
        typeof request.options?.max_tokens === 'number' ? request.options.max_tokens : 1024,
    });

    const firstChoice = response.choices?.[0];
    const messageContent = firstChoice?.message?.content;
    const content = this.extractTextFromChatContent(messageContent);

    return {
      content,
      raw: response,
    };
  }

  /**
   * Extract text from assistant message content that may be string or multimodal array.
   */
  protected extractTextFromChatContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (!part || typeof part !== 'object') return '';
          const textDescriptor = Object.getOwnPropertyDescriptor(part, 'text');
          return typeof textDescriptor?.value === 'string' ? textDescriptor.value : '';
        })
        .filter((segment) => segment.length > 0)
        .join('\n')
        .trim();
    }

    return '';
  }

  /**
   * Validate configuration
   */
  protected validateConfig(): void {
    if (!this.config.apiKey) {
      throw new Error(`${this.name}: API key is required`);
    }
  }

  /**
   * Retry logic with exponential backoff.
   *
   * The entire retry sequence is routed through the resilience stack
   * (bulkhead → circuit breaker → adaptive timeout) via
   * {@link executeThroughBulkhead}. Wrapping the whole loop — rather than
   * each individual attempt — is deliberate and required for correct
   * fast-fail behavior: when the circuit breaker is OPEN,
   * `executeThroughBulkhead` rejects immediately, so the retry loop never
   * runs and never sleeps through its exponential backoff. Per-attempt
   * wrapping would instead let the loop catch the open-circuit error and
   * back off, defeating the fast-fail. On the happy path the supplied
   * `operation` still runs exactly once and returns identically.
   */
  protected async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    estimatedTokens?: number
  ): Promise<T> {
    return this.executeThroughBulkhead(async () => {
      const maxRetries = this.config.maxRetries || 3;
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await operation();
        } catch (error) {
          lastError = error as Error;

          // Don't retry on client errors (4xx)
          if (this.isClientError(error)) {
            throw error;
          }

          // Don't retry if we've exhausted attempts
          if (attempt === maxRetries) {
            break;
          }

          // Exponential backoff
          const delay = this.config.retryDelay! * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }

      throw new Error(
        `${this.name}: ${operationName} failed after ${maxRetries + 1} attempts: ${lastError?.message}`
      );
    }, operationName, estimatedTokens);
  }

  /**
   * Check if error is a client error (4xx) that shouldn't be retried
   */
  protected isClientError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
      // Safely extract status/statusCode without type assertions
      let statusCode: number | null = null;
      
      const statusDescriptor = Object.getOwnPropertyDescriptor(error, 'status');
      if (statusDescriptor && typeof statusDescriptor.value === 'number') {
        statusCode = statusDescriptor.value;
      }
      
      if (statusCode === null) {
        const statusCodeDescriptor = Object.getOwnPropertyDescriptor(error, 'statusCode');
        if (statusCodeDescriptor && typeof statusCodeDescriptor.value === 'number') {
          statusCode = statusCodeDescriptor.value;
        }
      }
      
      return statusCode !== null && statusCode >= 400 && statusCode < 500;
    }
    return false;
  }

  /**
   * Sleep for a specified duration
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Sanitize error message (remove sensitive data)
   */
  protected sanitizeError(error: unknown): string {
    if (error instanceof Error) {
      // Remove API keys from error messages
      return error.message.replace(/sk-[a-zA-Z0-9-_]+/g, 'sk-***');
    }
    return String(error);
  }
}
