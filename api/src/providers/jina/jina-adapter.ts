// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { logger } from '@/utils/logger';
import {
  ProviderAdapter,
  type HealthCheckResult,
  type ProviderConfig as BaseProviderConfig,
} from '../base/provider-adapter';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  Model,
  Provider,
} from '@/types';
import type {
  ImageEditRequest,
  ImageEditResponse,
  ImageVariationRequest,
  ImageVariationResponse,
  ModerationRequest,
  ModerationResponse,
} from '@/types/model-client';
import { getModelsByProvider } from '@/services/model-catalog-service';

export interface JinaAdapterConfig extends BaseProviderConfig {
  apiBaseUrl?: string;
  deepSearchBaseUrl?: string;
  readerBaseUrl?: string;
  searchBaseUrl?: string;
}

interface JinaRequestOptions {
  baseUrl: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  includeAuth?: boolean;
  stream?: boolean;
}

export class JinaAdapter extends ProviderAdapter {
  private readonly apiKey: string;
  private readonly apiBaseUrl: string;
  private readonly deepSearchBaseUrl: string;
  private readonly readerBaseUrl: string;
  private readonly searchBaseUrl: string;
  private readonly log = logger.child({ provider: 'jina' });

  constructor(config: JinaAdapterConfig) {
    super('jina', 'Jina AI', config);
    this.apiKey = config.apiKey;
    this.apiBaseUrl = config.apiBaseUrl || 'https://api.jina.ai/v1';
    this.deepSearchBaseUrl = config.deepSearchBaseUrl || 'https://deepsearch.jina.ai/v1';
    this.readerBaseUrl = config.readerBaseUrl || 'https://r.jina.ai';
    this.searchBaseUrl = config.searchBaseUrl || 'https://s.jina.ai';
  }

  async getProvider(): Promise<Provider> {
    const health = await this.healthCheck();
    const models = await this.getModels();

    return {
      id: 'jina',
      name: 'jina',
      displayName: this.displayName,
      status: health.healthy ? 'active' : 'disabled',
      models,
      health: {
        status: health.healthy ? 'healthy' : 'degraded',
        lastCheck: health.checkedAt,
        latency: health.latency,
        errorRate: health.healthy ? 0 : 1,
      },
    };
  }

  async getModels(): Promise<Model[]> {
    const models = await getModelsByProvider('jina');
    return models.map((model) => ({
      ...model,
      id: model.name,
    }));
  }

  async chatCompletion(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.requestJson({
      baseUrl: this.deepSearchBaseUrl,
      path: '/chat/completions',
      method: 'POST',
      includeAuth: true,
      body: {
        model: request.model || 'jina-deepsearch-v1',
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        top_p: request.top_p,
        frequency_penalty: request.frequency_penalty,
        presence_penalty: request.presence_penalty,
        stop: request.stop,
        stream: false,
        tools: request.tools,
        tool_choice: request.tool_choice,
        response_format: request.response_format,
      },
    });

    return response as ChatResponse;
  }

  async *chatCompletionStream(request: ChatRequest): AsyncGenerator<ChatResponse, void, unknown> {
    const response = await this.requestRaw({
      baseUrl: this.deepSearchBaseUrl,
      path: '/chat/completions',
      method: 'POST',
      includeAuth: true,
      stream: true,
      body: {
        model: request.model || 'jina-deepsearch-v1',
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        top_p: request.top_p,
        frequency_penalty: request.frequency_penalty,
        presence_penalty: request.presence_penalty,
        stop: request.stop,
        stream: true,
        tools: request.tools,
        tool_choice: request.tool_choice,
        response_format: request.response_format,
      },
    });

    if (!response.body) {
      throw new Error('jina streaming response body is empty');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        // ReadableStream<Uint8Array>.read() — `value` is `unknown` by the
        // lib types here; we narrow with `instanceof Uint8Array`.
        const { done, value } = (await reader.read()) as {
          done: boolean;
          value: Uint8Array | undefined;
        };
        if (done) break;
        if (!(value instanceof Uint8Array)) continue;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as ChatResponse;
            yield parsed;
          } catch {
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const response = await this.requestJson({
      baseUrl: this.apiBaseUrl,
      path: '/embeddings',
      method: 'POST',
      includeAuth: true,
      body: {
        input: request.input,
        model: request.model,
        encoding_format: request.encoding_format,
      },
    });

    return response as EmbeddingResponse;
  }

  async webSearch(
    _model: Model,
    request: { query: string; maxResults?: number; options?: Record<string, unknown> }
  ): Promise<{ text: string; raw: unknown }> {
    const query = (request.query || '').trim();
    if (!query) {
      throw new Error('jina webSearch requires a non-empty query');
    }

    const url = `${this.searchBaseUrl}?q=${encodeURIComponent(query)}`;
    const response = await this.requestRaw({
      baseUrl: '',
      path: url,
      method: 'GET',
      includeAuth: true,
    });
    const text = await response.text();
    return { text, raw: text };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();

    if (!this.apiKey) {
      return {
        healthy: false,
        checkedAt: new Date(),
        error: 'JINA_API_KEY is not configured',
        latency: Date.now() - start,
      };
    }

    try {
      const response = await this.requestRaw({
        baseUrl: this.readerBaseUrl,
        path: '/https://example.com',
        method: 'GET',
        includeAuth: false,
      });

      return {
        healthy: response.ok,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        healthy: false,
        checkedAt: new Date(),
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  calculateCost(_model: Model, _inputTokens: number, _outputTokens: number): number {
    return 0;
  }

  normalizeModelName(modelName: string): string {
    return modelName?.trim() || 'jina-deepsearch-v1';
  }

  async imageEdit(_model: Model, _request: ImageEditRequest): Promise<ImageEditResponse> {
    throw new Error('jina: imageEdit not supported');
  }

  async imageVariation(
    _model: Model,
    _request: ImageVariationRequest
  ): Promise<ImageVariationResponse> {
    throw new Error('jina: imageVariation not supported');
  }

  async moderate(_model: Model, _request: ModerationRequest): Promise<ModerationResponse> {
    throw new Error('jina: moderation not supported');
  }

  private async requestJson(options: JinaRequestOptions): Promise<unknown> {
    const response = await this.requestRaw(options);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      const rawText = await response.text();
      return { text: rawText };
    }
    return (await response.json()) as unknown;
  }

  private async requestRaw(options: JinaRequestOptions): Promise<Response> {
    // Single choke-point for all Jina API calls — route the whole retry loop
    // through the resilience stack (bulkhead → breaker → timeout). Wrapping the
    // entire loop (not each attempt) makes an OPEN breaker fast-fail without
    // running backoff. Returns the (possibly streaming) Response; the body is
    // read by callers outside the slot, so streaming semantics are preserved.
    return this.executeThroughBulkhead(
      () => this.requestRawInner(options),
      `${options.method || 'POST'} ${options.path}`
    );
  }

  private async requestRawInner(options: JinaRequestOptions): Promise<Response> {
    const retries = Math.max(0, this.config.maxRetries ?? 2);
    const retryDelayMs = Math.max(50, this.config.retryDelay ?? 500);
    const timeoutMs = Math.max(1000, this.config.timeout ?? 30000);
    const method = options.method || 'POST';
    const url = this.buildUrl(options.baseUrl, options.path);
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= retries) {
      attempt += 1;
      try {
        const headers = this.buildHeaders(options.includeAuth ?? true, options.stream === true);
        const response = await fetch(url, {
          method,
          headers,
          body: method === 'GET' || options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.status === 429 && attempt <= retries) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
          const waitMs =
            Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
              ? retryAfterSeconds * 1000
              : retryDelayMs * attempt;
          await this.sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Jina HTTP ${response.status}: ${errorText.slice(0, 500)}`);
        }

        return response;
      } catch (error) {
        lastError = error;
        if (attempt > retries) break;
        const backoffMs = retryDelayMs * attempt;
        await this.sleep(backoffMs);
      }
    }

    this.log.error(
      { url, retries, error: lastError instanceof Error ? lastError.message : String(lastError) },
      'Jina request failed'
    );
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private buildHeaders(includeAuth: boolean, stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: stream ? 'text/event-stream' : 'application/json',
      'Content-Type': 'application/json',
    };

    if (includeAuth && this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private buildUrl(baseUrl: string, path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }

    const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }
}
