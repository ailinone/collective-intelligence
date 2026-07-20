// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Vertex AI Provider Adapter
 * Implements ProviderAdapter for Google Cloud Vertex AI Model Garden
 * Supports models from Vertex AI including Google models and third-party models
 */

import { ProviderAdapter, type HealthCheckResult } from '../base/provider-adapter';
import { MODERATION_ANALYZER_SYSTEM_PROMPT } from '../base/moderation-prompt';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ProviderConfig,
  Provider,
  Model,
  EmbeddingRequest,
  EmbeddingResponse,
} from '@/types';
import type {
  ModerationRequest,
  ModerationResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
} from '@/types/model-client';
import { logger } from '@/utils/logger';
import { getModelsByProvider } from '@/services/model-catalog-service';
import { spawn } from 'child_process';

/**
 * Vertex AI Adapter
 * Supports Google models through Vertex AI and Model Garden providers
 */
export class VertexAIAdapter extends ProviderAdapter {
  protected config: ProviderConfig & {
    projectId: string;
    location?: string;
    useExpressMode?: boolean;
  };

  private providerLog = logger.child({ provider: 'vertex-ai' });

  constructor(
    config: ProviderConfig & { projectId: string; location?: string; useExpressMode?: boolean }
  ) {
    super('vertex-ai', 'Google Cloud Vertex AI', config);
    this.config = config;

    // Validate configuration
    if (!config.projectId) {
      throw new Error('VertexAIAdapter requires projectId in configuration');
    }

    if (config.useExpressMode && !config.apiKey) {
      throw new Error('Express mode requires apiKey in configuration');
    }

    if (!config.useExpressMode && !config.apiKey) {
      // For standard mode, we'll use gcloud auth
      this.providerLog.info('Using standard Vertex AI authentication (gcloud)');
    }

    this.providerLog.info(
      {
        projectId: config.projectId,
        location: config.location || 'global',
        useExpressMode: config.useExpressMode,
      },
      'VertexAIAdapter initialized'
    );
  }

  /**
   * Get provider name
   */
  getName(): string {
    return 'vertex-ai';
  }

  /**
   * Get provider information
   */
  async getProvider(): Promise<Provider> {
    const models = await this.getModels();

    // For development/testing, always return active status
    // In production, you might want to use health check
    const status = models.length > 0 ? 'active' : 'disabled';

    return {
      id: 'vertex-ai',
      name: 'vertex-ai',
      displayName: 'Google Cloud Vertex AI',
      status,
      health: { status: 'healthy' as const, lastCheck: new Date(), latency: 0 },
      models,
      metadata: {
        projectId: this.config.projectId,
        location: this.config.location || 'global',
        useExpressMode: this.config.useExpressMode,
        modelGarden: true,
      },
    };
  }

  /**
   * Get available models
   */
  async getModels(): Promise<Model[]> {
    return getModelsByProvider('vertex-ai');
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // Test connectivity by attempting to get access token or API key validation
      if (this.config.useExpressMode) {
        // Express mode - just validate API key format
        if (!this.config.apiKey?.startsWith('AIza')) {
          throw new Error('Invalid API key format for express mode');
        }
      } else {
        // Standard mode - test gcloud auth
        await this.executeGcloudCommand(['auth', 'application-default', 'print-access-token']);
      }

      const latency = Date.now() - startTime;
      return {
        healthy: true,
        latency,
        checkedAt: new Date(),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.providerLog.error({ error: errorMessage }, 'Vertex AI health check failed');

      return {
        healthy: false,
        error: errorMessage,
        checkedAt: new Date(),
      };
    }
  }

  /**
   * Execute gcloud command
   */
  private async executeGcloudCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use PowerShell to execute gcloud on Windows to avoid spawn issues
      const gcloud = spawn(
        process.platform === 'win32' ? 'powershell' : 'gcloud',
        process.platform === 'win32' ? ['-Command', `& { gcloud ${args.join(' ')} }`] : args,
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, GOOGLE_CLOUD_PROJECT: this.config.projectId },
        }
      );

      let stdout = '';
      let stderr = '';

      // `data` is `Buffer | string` from child_process; type explicitly so
      // `.toString()` is safe rather than going through `any`.
      gcloud.stdout.on('data', (data: Buffer | string) => {
        stdout += typeof data === 'string' ? data : data.toString();
      });

      gcloud.stderr.on('data', (data: Buffer | string) => {
        stderr += typeof data === 'string' ? data : data.toString();
      });

      gcloud.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`gcloud command failed: ${stderr}`));
        }
      });

      gcloud.on('error', (error) => {
        reject(new Error(`Failed to execute gcloud: ${error.message}`));
      });
    });
  }

  /**
   * Chat completion
   */
  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    try {
      const modelId = request.model;
      this.providerLog.debug(
        { modelId, messageCount: request.messages.length },
        'Processing chat completion'
      );

      // Model validation is delegated to upstream (ProviderRegistry + DB catalog) and
      // to Vertex AI itself (404 for unknown publisher models). We do NOT maintain a
      // hardcoded allowlist here — that would drift from the DB-backed catalog and
      // silently reject valid models added via discovery.
      if (!modelId) {
        throw new Error('Model is required for Vertex AI chat completion');
      }

      // Build Vertex AI request payload
      const payload = this.buildVertexAIPayload(request);

      // Execute request
      const response = await this.makeVertexAIRequest(modelId, payload);

      // Parse and return response
      return this.parseVertexAIResponse(response, request);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.providerLog.error(
        { error: errorMessage, model: request.model },
        'Chat completion failed'
      );
      throw error;
    }
  }

  /**
   * Build Vertex AI request payload
   */
  private buildVertexAIPayload(request: ChatRequest): Record<string, unknown> {
    const contents = request.messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: this.convertMessageParts(message),
    }));

    const payload: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: request.temperature || 0.7,
        maxOutputTokens: request.max_tokens || 2048,
        topP: request.top_p || 1.0,
        topK: 32, // Default topK for Vertex AI
      },
    };

    // Add safety settings for Gemini models
    if (request.model && request.model.includes('gemini')) {
      payload.safetySettings = [
        {
          category: 'HARM_CATEGORY_HARASSMENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE',
        },
        {
          category: 'HARM_CATEGORY_HATE_SPEECH',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE',
        },
        {
          category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE',
        },
        {
          category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE',
        },
      ];
    }

    // Add tools if present
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((tool) => ({
        function_declarations: [tool.function],
      }));
    }

    return payload;
  }

  /**
   * Convert message parts for Vertex AI format
   */
  private convertMessageParts(message: ChatMessage): Array<{ text?: string; inlineData?: { mimeType: string; data: string }; fileData?: { fileUri: string; mimeType: string } }> {
    if (typeof message.content === 'string') {
      return [{ text: message.content }];
    }

    if (Array.isArray(message.content)) {
      return message.content.map((part) => {
        if (part.type === 'text') {
          return { text: part.text };
        } else if (part.type === 'image_url') {
          return {
            fileData: {
              mimeType: this.getMimeType(part.image_url.url),
              fileUri: part.image_url.url,
            },
          };
        }
        return { text: JSON.stringify(part) };
      });
    }

    return [{ text: String(message.content) }];
  }

  /**
   * Get MIME type from URL
   */
  private getMimeType(url: string): string {
    if (url.includes('.png')) return 'image/png';
    if (url.includes('.jpg') || url.includes('.jpeg')) return 'image/jpeg';
    if (url.includes('.gif')) return 'image/gif';
    if (url.includes('.webp')) return 'image/webp';
    return 'image/jpeg'; // Default
  }

  /**
   * Make Vertex AI API request
   */
  private async makeVertexAIRequest(modelId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const location = this.config.location || 'global';
    const publisher = 'google';
    const model = this.mapModelId(modelId);

    let url: string;
    let headers: Record<string, string>;

    if (this.config.useExpressMode) {
      // Express mode
      url = `https://aiplatform.googleapis.com/v1/publishers/${publisher}/models/${model}:streamGenerateContent?key=${this.config.apiKey}`;
      headers = {
        'Content-Type': 'application/json',
      };
    } else {
      // Standard mode with gcloud auth
      const accessToken = await this.executeGcloudCommand([
        'auth',
        'application-default',
        'print-access-token',
      ]);
      url = `https://aiplatform.googleapis.com/v1/projects/${this.config.projectId}/locations/${location}/publishers/${publisher}/models/${model}:streamGenerateContent`;
      headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      };
    }

    // Route the provider API call through the resilience stack (bulkhead →
    // breaker → timeout) so a Vertex AI outage fast-fails and is isolated
    // per-provider. The gcloud access-token retrieval above is auth (not the
    // LLM call), so it deliberately stays outside the bulkhead slot.
    return this.executeThroughBulkhead(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Vertex AI API error ${response.status}: ${errorText}`);
      }

      // For streaming, we'll handle the first chunk for now
      // In production, you'd want to implement proper streaming
      const responseText = await response.text();
      const parsed: unknown = JSON.parse(responseText);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
      throw new Error('Invalid response format from Vertex AI');
    }, 'chat completion');
  }

  /**
   * Map model ID to Vertex AI format
   */
  private mapModelId(modelId: string): string {
    // Remove provider prefix if present
    const cleanId = modelId.replace('vertex-ai/', '').replace('google/', '');

    // Map to Vertex AI model names
    const modelMap: Record<string, string> = {
      'gemini-2.5-pro': 'gemini-2.5-pro',
      'gemini-2.0-flash': 'gemini-2.0-flash-001',
      'gemini-1.5-pro': 'gemini-1.5-pro',
      'gemini-1.5-flash': 'gemini-1.5-flash',
      'gemini-1.0-pro': 'gemini-1.0-pro',
    };

    return modelMap[cleanId] || cleanId;
  }

  /**
   * Parse Vertex AI response
   */
  private parseVertexAIResponse(response: Record<string, unknown>, request: ChatRequest): ChatResponse {
    // Handle streaming response (simplified for now)
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    const candidate = candidates[0] as Record<string, unknown> | undefined;

    if (!candidate) {
      throw new Error('No response candidates from Vertex AI');
    }

    const content = candidate.content as Record<string, unknown> | undefined;
    let responseText = '';

    if (content && Array.isArray(content.parts)) {
      const parts = content.parts as Array<Record<string, unknown>>;
      responseText = parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
    }

    // Type guard for finishReason
    const finishReasonValue = candidate.finishReason;
    const validFinishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = 
      finishReasonValue === 'STOP' || finishReasonValue === 'stop' ? 'stop' :
      finishReasonValue === 'MAX_TOKENS' || finishReasonValue === 'length' ? 'length' :
      finishReasonValue === 'SAFETY' || finishReasonValue === 'content_filter' ? 'content_filter' :
      finishReasonValue === 'RECITATION' || finishReasonValue === 'tool_calls' ? 'tool_calls' :
      'stop';

    // Type guard for usageMetadata
    const usageMetadata = response.usageMetadata;
    const promptTokens = (usageMetadata && typeof usageMetadata === 'object' && 'promptTokenCount' in usageMetadata && typeof usageMetadata.promptTokenCount === 'number') 
      ? usageMetadata.promptTokenCount 
      : 0;
    const completionTokens = (usageMetadata && typeof usageMetadata === 'object' && 'candidatesTokenCount' in usageMetadata && typeof usageMetadata.candidatesTokenCount === 'number') 
      ? usageMetadata.candidatesTokenCount 
      : 0;
    const totalTokens = (usageMetadata && typeof usageMetadata === 'object' && 'totalTokenCount' in usageMetadata && typeof usageMetadata.totalTokenCount === 'number') 
      ? usageMetadata.totalTokenCount 
      : 0;

    return {
      id: `vertex-ai-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model!,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: responseText,
          },
          finish_reason: validFinishReason,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    };
  }

  /**
   * Calculate cost for Vertex AI
   * Uses pricing from model catalog (database-backed)
   */
  calculateCost(model: Model, promptTokens: number, completionTokens: number): number {
    // Validate that pricing is available
    if (!model.inputCostPer1k || !model.outputCostPer1k) {
      this.providerLog.warn(
        { modelId: model.id },
        'Model pricing not available in catalog, using fallback pricing'
      );
      // Fallback pricing for Vertex AI models (conservative estimates)
      const inputCostPer1K = 0.001;
      const outputCostPer1K = 0.004;
      
      const inputCost = (promptTokens / 1000) * inputCostPer1K;
      const outputCost = (completionTokens / 1000) * outputCostPer1K;
      
      return inputCost + outputCost;
    }

    // Use pricing from model catalog
    const inputCostPer1K = Math.max(0, Number(model.inputCostPer1k) || 0);
    const outputCostPer1K = Math.max(0, Number(model.outputCostPer1k) || 0);

    const cost = (promptTokens / 1000) * inputCostPer1K
               + (completionTokens / 1000) * outputCostPer1K;

    return Math.max(0, cost);
  }

  /**
   * Chat completion streaming for Vertex AI
   * REAL IMPLEMENTATION - Uses Server-Sent Events (SSE) streaming from Vertex AI API
   */
  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    const startTime = Date.now();

    try {
      const modelId = request.model;
      if (!modelId) {
        throw new Error('Model is required for Vertex AI streaming');
      }

      // Build Vertex AI request payload
      const payload = this.buildVertexAIPayload(request);
      const model = this.mapModelId(modelId);

      // Make streaming request to Vertex AI
      const location = this.config.location || 'global';
      const publisher = 'google';

      let url: string;
      let headers: Record<string, string>;

      if (this.config.useExpressMode) {
        // Express mode - use non-streaming endpoint for regular requests
        url = `https://aiplatform.googleapis.com/v1/publishers/${publisher}/models/${model}:generateContent?key=${this.config.apiKey}`;
        headers = {
          'Content-Type': 'application/json',
        };
      } else {
        // Standard mode with gcloud auth - use non-streaming endpoint for regular requests
        const accessToken = await this.executeGcloudCommand([
          'auth',
          'application-default',
          'print-access-token',
        ]);
        url = `https://aiplatform.googleapis.com/v1/projects/${this.config.projectId}/locations/${location}/publishers/${publisher}/models/${model}:generateContent`;
        headers = {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        };
      }

      // Make streaming request
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Vertex AI API error ${response.status}: ${errorText}`);
      }
      
      // `isStreaming` previously declared and unused — content-type detection
      // is now logged once below for diagnostics, then drained via the SSE
      // reader regardless of declared content-type (Vertex AI sometimes
      // mislabels chunked JSON; the reader handles both cases uniformly).
      const contentType = response.headers.get('content-type') || '';
      this.providerLog.debug({ contentType }, 'Vertex AI chat: parsing response stream');

      if (!response.body) {
        throw new Error('Response body is null');
      }

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let firstChunk = true;
      let chunkId = `chatcmpl-${Date.now()}`;
      let accumulatedContent = '';
      let finishReason: 'stop' | 'length' | null = null;
      let totalTokens = 0;

      try {
        let streamDone = false;
        while (!streamDone) {
          const result = await reader.read();
          streamDone = result.done;
          if (streamDone) break;
          const value: unknown = result.value;
          if (!(value instanceof Uint8Array)) continue;

          // Decode chunk
          buffer += decoder.decode(value, { stream: true });
          
          // Process complete SSE messages (lines ending with \n\n)
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;

            // Parse SSE format: "data: {...}"
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              
              if (dataStr === '[DONE]') {
                // End of stream
                finishReason = 'stop';
                continue;
              }

              try {
                const data = JSON.parse(dataStr) as Record<string, unknown>;
                
                // Extract candidate from Vertex AI response
                const candidates = Array.isArray(data.candidates) ? data.candidates : [];
                const candidate = candidates[0] as Record<string, unknown> | undefined;

                if (candidate) {
                  const content = candidate.content as Record<string, unknown> | undefined;
                  const parts = Array.isArray(content?.parts) ? content.parts : [];
                  
                  for (const part of parts) {
                    const text = (part as Record<string, unknown>).text;
                    if (typeof text === 'string' && text) {
                      accumulatedContent += text;
                      
                      if (firstChunk) {
                        const duration = Date.now() - startTime;
                        this.providerLog.debug({ duration }, 'First chunk received');
                        firstChunk = false;
                      }

                      // Yield chunk
        yield {
                        id: chunkId,
          object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: modelId,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                              content: text,
              },
                            finish_reason: null,
              logprobs: null,
            },
          ],
                        usage: undefined,
                      };
                    }
                  }

                  // Check for finish reason
                  const finishReasonStr = candidate.finishReason;
                  if (typeof finishReasonStr === 'string') {
                    if (finishReasonStr === 'STOP') {
                      finishReason = 'stop';
                    } else if (finishReasonStr === 'MAX_TOKENS') {
                      finishReason = 'length';
                    }
                  }

                  // Extract usage if available
                  const usageMetadata = data.usageMetadata as Record<string, unknown> | undefined;
                  if (usageMetadata) {
                    const promptTokens = typeof usageMetadata.promptTokenCount === 'number' ? usageMetadata.promptTokenCount : 0;
                    const completionTokens = typeof usageMetadata.candidatesTokenCount === 'number' ? usageMetadata.candidatesTokenCount : 0;
                    totalTokens = promptTokens + completionTokens;
                  }
                }
              } catch (parseError) {
                // Skip invalid JSON chunks
                this.providerLog.warn({ error: parseError instanceof Error ? parseError.message : String(parseError), line }, 'Failed to parse SSE data chunk');
              }
            }
          }
        }

        // Yield final chunk with finish reason if we have accumulated content
        if (accumulatedContent && finishReason) {
          yield {
            id: chunkId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: finishReason,
                logprobs: null,
              },
            ],
            usage: totalTokens > 0 ? {
              prompt_tokens: 0, // Will be calculated from request
              completion_tokens: Math.floor(totalTokens * 0.8), // Estimate
              total_tokens: totalTokens,
            } : undefined,
          };
      }
      
      const totalDuration = Date.now() - startTime;
        this.providerLog.debug({ duration: totalDuration, contentLength: accumulatedContent.length }, 'Streaming completed');
      } finally {
        reader.releaseLock();
      }
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      this.providerLog.error(
        {
          error: error instanceof Error ? error.message : String(error),
          duration,
          model: request.model,
        },
        'Streaming chat completion failed'
      );
      throw error;
    }
  }

  /**
   * Generate embeddings (not supported by Vertex AI)
   */
  async generateEmbeddings(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error('Embeddings not supported by Vertex AI');
  }

  /**
   * Normalize model name for Vertex AI
   */
  normalizeModelName(modelName: string): string {
    return modelName; // Vertex AI model names are already normalized
  }

  /**
   * Content Moderation
   * Vertex AI uses Google's safety settings, not a separate moderation API
   * Uses chat completion to analyze content for policy violations
   */
  async moderate(model: Model, request: ModerationRequest): Promise<ModerationResponse> {
    try {
      // Use chat completion to analyze content
      const moderationPrompt = `Analyze the following text for content policy violations. Respond with a JSON object indicating if the content is flagged and category scores (0.0-1.0) for: sexual, hate, harassment, self-harm, sexual/minors, hate/threatening, violence/graphic, self-harm/intent, self-harm/instructions, harassment/threatening, violence.
      
      Text to analyze: "${request.text}"
      
      Respond with JSON only: {"flagged": boolean, "categories": {...}, "category_scores": {...}}`;

      const chatResponse = await this.chatCompletion({
        model: model.id,
        messages: [
          { role: 'system', content: MODERATION_ANALYZER_SYSTEM_PROMPT },
          { role: 'user', content: moderationPrompt },
        ],
        temperature: 0.1,
        max_tokens: 500,
      });

      // Parse the response
      const messageContent = chatResponse.choices[0]?.message?.content;
      const contentStr = typeof messageContent === 'string' ? messageContent : JSON.stringify(messageContent ?? {});
      const moderationResult = JSON.parse(contentStr || '{}') as {
        flagged?: boolean;
        categories?: Record<string, boolean>;
        category_scores?: Record<string, number>;
      };

      return {
        flagged: moderationResult.flagged || false,
        categories: {
          sexual: moderationResult.categories?.sexual || false,
          hate: moderationResult.categories?.hate || false,
          harassment: moderationResult.categories?.harassment || false,
          'self-harm': moderationResult.categories?.['self-harm'] || false,
          'sexual/minors': moderationResult.categories?.['sexual/minors'] || false,
          'hate/threatening': moderationResult.categories?.['hate/threatening'] || false,
          'violence/graphic': moderationResult.categories?.['violence/graphic'] || false,
          'self-harm/intent': moderationResult.categories?.['self-harm/intent'] || false,
          'self-harm/instructions': moderationResult.categories?.['self-harm/instructions'] || false,
          'harassment/threatening': moderationResult.categories?.['harassment/threatening'] || false,
          violence: moderationResult.categories?.violence || false,
        },
        category_scores: {
          sexual: moderationResult.category_scores?.sexual || 0,
          hate: moderationResult.category_scores?.hate || 0,
          harassment: moderationResult.category_scores?.harassment || 0,
          'self-harm': moderationResult.category_scores?.['self-harm'] || 0,
          'sexual/minors': moderationResult.category_scores?.['sexual/minors'] || 0,
          'hate/threatening': moderationResult.category_scores?.['hate/threatening'] || 0,
          'violence/graphic': moderationResult.category_scores?.['violence/graphic'] || 0,
          'self-harm/intent': moderationResult.category_scores?.['self-harm/intent'] || 0,
          'self-harm/instructions': moderationResult.category_scores?.['self-harm/instructions'] || 0,
          'harassment/threatening': moderationResult.category_scores?.['harassment/threatening'] || 0,
          violence: moderationResult.category_scores?.violence || 0,
        },
        raw: moderationResult,
      };
    } catch (error) {
      // Fallback: return safe defaults if moderation fails
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.providerLog.warn({ error: errorMessage }, 'Moderation analysis failed, returning safe defaults');
      
      return {
        flagged: false,
        categories: {
          sexual: false,
          hate: false,
          harassment: false,
          'self-harm': false,
          'sexual/minors': false,
          'hate/threatening': false,
          'violence/graphic': false,
          'self-harm/intent': false,
          'self-harm/instructions': false,
          'harassment/threatening': false,
          violence: false,
        },
        category_scores: {
          sexual: 0,
          hate: 0,
          harassment: 0,
          'self-harm': 0,
          'sexual/minors': 0,
          'hate/threatening': 0,
          'violence/graphic': 0,
          'self-harm/intent': 0,
          'self-harm/instructions': 0,
          'harassment/threatening': 0,
          violence: 0,
        },
        raw: { error: errorMessage, provider: 'vertex-ai', note: 'Fallback moderation response' },
      };
    }
  }

  /**
   * Image Edit
   * Vertex AI/Imagen does not have image editing via API
   */
  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('Vertex AI image editing is not yet implemented. Vertex AI/Imagen does not provide image editing via API. Use OpenAI DALL-E for image editing.');
  }

  /**
   * Image Variation
   * Vertex AI/Imagen does not have image variation via API
   */
  async imageVariation(_model: Model, _request: ImageVariationRequest): Promise<ImageVariationResponse> {
    throw new Error('Vertex AI image variation is not yet implemented. Vertex AI/Imagen does not provide image variation via API. Use OpenAI DALL-E for image variations.');
  }
}
