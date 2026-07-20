// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Own-Model Provider Adapter
 *
 * Connects the ci/api orchestration gateway to the model-stack serving
 * endpoint. The serving endpoint (vLLM) exposes an OpenAI-compatible API,
 * so this adapter translates between the gateway's internal model format
 * and the own-model endpoint.
 *
 * Configuration:
 *   OWN_MODEL_ENDPOINT - Base URL of the serving endpoint (e.g. http://localhost:8081)
 *   OWN_MODEL_API_KEY  - Optional API key for the serving endpoint
 *   OWN_MODEL_TIMEOUT  - Request timeout in ms (default 120000)
 *   OWN_MODEL_ENABLED  - Set to "true" to enable (default "false")
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'own-model-adapter' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OwnModelConfig {
  endpoint: string;
  apiKey?: string;
  timeoutMs: number;
  enabled: boolean;
}

export interface OwnModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  capabilities: {
    chat: boolean;
    completion: boolean;
    embedding: boolean;
    tool_use: boolean;
  };
  context_window: number;
  version: string;
  status: 'ready' | 'loading' | 'unavailable';
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  stop?: string | string[];
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig(): OwnModelConfig {
  return {
    endpoint: process.env.OWN_MODEL_ENDPOINT || 'http://localhost:8081',
    apiKey: process.env.OWN_MODEL_API_KEY,
    timeoutMs: parseInt(process.env.OWN_MODEL_TIMEOUT || '120000', 10),
    enabled: process.env.OWN_MODEL_ENABLED === 'true',
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OwnModelAdapter {
  private config: OwnModelConfig;
  private healthy = false;
  private lastHealthCheck = 0;
  private healthCheckIntervalMs = 30_000;
  private cachedModels: OwnModelInfo[] = [];

  constructor(config?: Partial<OwnModelConfig>) {
    const base = loadConfig();
    this.config = { ...base, ...config };
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  normalizeModelName(modelId: string): string {
    return modelId?.trim().replace(/^own\//, '') || '';
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  async checkHealth(): Promise<boolean> {
    if (!this.config.enabled) return false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(`${this.config.endpoint}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      this.healthy = res.ok;
      this.lastHealthCheck = Date.now();

      if (!res.ok) {
        log.warn({ status: res.status }, 'Own-model health check failed');
      }
      return this.healthy;
    } catch (err) {
      log.warn({ err }, 'Own-model health check error');
      this.healthy = false;
      this.lastHealthCheck = Date.now();
      return false;
    }
  }

  async isReady(): Promise<boolean> {
    if (!this.config.enabled) return false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(`${this.config.endpoint}/ready`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  async isHealthy(): Promise<boolean> {
    if (Date.now() - this.lastHealthCheck < this.healthCheckIntervalMs) {
      return this.healthy;
    }
    return this.checkHealth();
  }

  // -------------------------------------------------------------------------
  // Model listing
  // -------------------------------------------------------------------------

  async listModels(): Promise<OwnModelInfo[]> {
    if (!this.config.enabled) return [];

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;

      const res = await fetch(`${this.config.endpoint}/v1/models`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        log.warn({ status: res.status }, 'Failed to list own models');
        return [];
      }

      const body = (await res.json()) as { data: Array<{ id: string; created?: number }> };

      this.cachedModels = (body.data || []).map((m) => ({
        id: `own/${m.id}`,
        object: 'model' as const,
        created: m.created || Math.floor(Date.now() / 1000),
        owned_by: 'ailin-model-stack',
        capabilities: {
          chat: true,
          completion: true,
          embedding: false,
          tool_use: true,
        },
        context_window: 4096,
        version: 'latest',
        status: 'ready' as const,
      }));

      return this.cachedModels;
    } catch (err) {
      log.warn({ err }, 'Error listing own models');
      return this.cachedModels; // return cached on error
    }
  }

  // -------------------------------------------------------------------------
  // Chat completion
  // -------------------------------------------------------------------------

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (!this.config.enabled) {
      throw new Error('Own-model provider is not enabled');
    }

    const healthy = await this.isHealthy();
    if (!healthy) {
      throw new Error('Own-model provider is unhealthy');
    }

    // Strip own/ prefix if present
    const modelId = this.normalizeModelName(request.model);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const res = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, model: modelId, stream: false }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errorBody = await res.text().catch(() => 'unknown');
        throw new Error(`Own-model request failed: HTTP ${res.status} — ${errorBody}`);
      }

      const body = (await res.json()) as ChatCompletionResponse;

      // Prefix model ID in response
      body.model = `own/${body.model}`;

      log.info(
        {
          model: body.model,
          promptTokens: body.usage?.prompt_tokens,
          completionTokens: body.usage?.completion_tokens,
        },
        'Own-model completion succeeded'
      );

      return body;
    } catch (err) {
      clearTimeout(timer);
      log.error({ err, model: modelId }, 'Own-model completion failed');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Streaming chat completion
  // -------------------------------------------------------------------------

  async *chatCompletionStream(
    request: ChatCompletionRequest
  ): AsyncGenerator<string, void, undefined> {
    if (!this.config.enabled) {
      throw new Error('Own-model provider is not enabled');
    }

    const modelId = this.normalizeModelName(request.model);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const res = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, model: modelId, stream: true }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok || !res.body) {
        throw new Error(`Own-model stream failed: HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = (await reader.read()) as {
          done: boolean;
          value: Uint8Array | undefined;
        };
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          yield data;
        }
      }
    } catch (err) {
      clearTimeout(timer);
      log.error({ err, model: modelId }, 'Own-model stream failed');
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: OwnModelAdapter | null = null;

export function getOwnModelAdapter(): OwnModelAdapter {
  if (!_instance) {
    _instance = new OwnModelAdapter();
  }
  return _instance;
}

export function resetOwnModelAdapter(): void {
  _instance = null;
}
