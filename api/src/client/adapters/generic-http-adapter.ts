// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { ProviderAdapter } from '../provider-adapter';
import type { ModelRecord } from '@/types/model-client';
import {
  TextRequest,
  TextResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
  ImageGenRequest,
  ImageGenResponse,
  AudioTTSRequest,
  AudioTTSResponse,
  AudioSTTRequest,
  AudioSTTResponse,
  VisionRequest,
  VisionResponse,
  ToolChatRequest,
  ToolChatResponse,
  StreamChunk,
} from '@/types/model-client';
import type {
  ChatCompletionRequestBody,
  EmbeddingsRequestBody,
  ImageGenerationRequestBody,
  ProviderRawResponse,
  ProviderEmbeddingsResponse,
  RawInvokePayload,
  RawInvokeResponse,
} from '@/types/provider-request-types';
import { logger } from '@/utils/logger';

const _log = logger.child({ component: 'GenericHTTPAdapter' });

function getBaseUrl(model: ModelRecord): string {
  if (!model.config.baseUrl) {
    throw new Error(`baseUrl missing for model ${model.id}`);
  }
  return model.config.baseUrl;
}

function getApiKey(model: ModelRecord): string | undefined {
  // você pode buscar por model.config.apiKeyRef
  return process.env[model.config.apiKeyRef || ''] || undefined;
}

// Type-safe helper to get string from extra config
function getExtraString(extra: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = extra?.[key];
  return typeof value === 'string' ? value : undefined;
}

// helpers para montar headers/body baseados em config
function buildHeaders(model: ModelRecord): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const apiKey = getApiKey(model);
  const authHeader = getExtraString(model.config.extra, 'authHeader');
  const authBearerPrefix = getExtraString(model.config.extra, 'authBearerPrefix');

  if (apiKey && authHeader) {
    headers[authHeader] = apiKey;
  } else if (apiKey && authBearerPrefix) {
    headers['Authorization'] = `${authBearerPrefix} ${apiKey}`;
  }

  return headers;
}

export const GenericHTTPProviderAdapter: ProviderAdapter = {
  async text(model: ModelRecord, req: TextRequest): Promise<TextResponse> {
    const baseUrl = getBaseUrl(model);
    const headers = buildHeaders(model);

    const endpoint = model.config.endpointOverrides?.text || '/v1/chat/completions';

    const url = `${baseUrl}${endpoint}`;

    // O discovery/config define o formato esperado desse hub:
    // Exemplo de formato "OpenAI-like" como default
    const body: ChatCompletionRequestBody = {
      model: model.providerModelId,
      messages:
        req.messages ??
        [
          req.system ? { role: 'system', content: req.system } : null,
          { role: 'user', content: req.prompt },
        ].filter((msg): msg is { role: 'system' | 'user'; content: string } => msg !== null),
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 512,
    };

    // você pode permitir templates mais customizáveis via config.extra

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GenericHTTP text error: ${response.status} - ${text}`);
    }

    const jsonData = await response.json();

    // Validate jsonData is an object to use as ProviderRawResponse
    const rawResponse: ProviderRawResponse = jsonData && typeof jsonData === 'object' && jsonData !== null
      ? jsonData as ProviderRawResponse
      : {};

    // Ponto crucial: como extrair o texto?
    // Você pode ter no model.config.extra algo como:
    // textPath: 'choices.0.message.content'
    const textPath = getExtraString(model.config.extra, 'textPath') ?? 'choices.0.message.content';

    const content = getByPath(jsonData, textPath);
    const contentStr = typeof content === 'string' ? content : '';

    return { content: contentStr, raw: rawResponse };
  },

  async *streamText(_model: ModelRecord, _req: TextRequest): AsyncIterable<StreamChunk> {
    // Streaming não é suportado pelo adaptador HTTP genérico sem configuração específica de SSE/chunked JSON.
    const errorResponse: ProviderRawResponse = { error: true, message: 'streamText not implemented for GenericHTTP' };
    yield { content: '[ERROR] streamText not implemented for GenericHTTP', raw: errorResponse };
    throw new Error('streamText not implemented for GenericHTTP (precisa de config específica)');
  },

  async toolChat(_model: ModelRecord, _req: ToolChatRequest): Promise<ToolChatResponse> {
    // Depende muito se o hub suporta tool calling nativo
    // Caso não suporte, você pode emular via prompt
    throw new Error('toolChat not implemented for GenericHTTP');
  },

  async structuredJson<T = unknown>(model: ModelRecord, req: TextRequest & { schema?: Record<string, unknown> }): Promise<{ json: T; raw: ProviderRawResponse }> {
    // Pode mandar prompt instruindo JSON puro
    const response = await this.text(model, req);
    const content = response.content;
    
    // Parse JSON safely
    let parsedJson: T;
    try {
      parsedJson = JSON.parse(content) as T;
    } catch (parseError) {
      throw new Error(`Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
    }
    
    // Validate raw response is ProviderRawResponse (already validated in text method)
    const rawResponse: ProviderRawResponse = response.raw && typeof response.raw === 'object' && response.raw !== null
      ? response.raw as ProviderRawResponse
      : {};
    
    return { json: parsedJson, raw: rawResponse };
  },

  async embeddings(model: ModelRecord, req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    const baseUrl = getBaseUrl(model);
    const headers = buildHeaders(model);
    const endpoint = model.config.endpointOverrides?.embeddings || '/v1/embeddings';
    const url = `${baseUrl}${endpoint}`;

    const body: EmbeddingsRequestBody = {
      model: model.providerModelId,
      input: req.inputs,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GenericHTTP embeddings error: ${response.status} - ${text}`);
    }

    const jsonData = await response.json();
    
    // Validate response structure matches ProviderEmbeddingsResponse
    const embeddingsResponse: ProviderEmbeddingsResponse = 
      jsonData && typeof jsonData === 'object' && jsonData !== null
        ? jsonData as ProviderEmbeddingsResponse
        : { data: [], object: 'list' };

    const vectorPath = getExtraString(model.config.extra, 'embeddingPath') ?? 'data.*.embedding';
    const extractedVectors = mapByWildcardPath(embeddingsResponse, vectorPath);
    
    // Validate vectors is array of number arrays
    const vectors: number[][] = Array.isArray(extractedVectors) 
      ? extractedVectors.filter((vec): vec is number[] => 
          Array.isArray(vec) && vec.every(v => typeof v === 'number')
        )
      : [];

    return { vectors, raw: embeddingsResponse };
  },

  async vision(_model: ModelRecord, _req: VisionRequest): Promise<VisionResponse> {
    // Se o hub aceitar multimodal no mesmo endpoint de chat,
    // você adapta aqui conforme config.extra.
    throw new Error('vision not implemented for GenericHTTP');
  },

  async imageGenerate(model: ModelRecord, req: ImageGenRequest): Promise<ImageGenResponse> {
    const baseUrl = getBaseUrl(model);
    const headers = buildHeaders(model);
    const endpoint = model.config.endpointOverrides?.image || '/v1/images';
    const url = `${baseUrl}${endpoint}`;

    // Safely merge options
    const options: Record<string, unknown> = req.options && typeof req.options === 'object' && req.options !== null
      ? req.options as Record<string, unknown>
      : {};
    
    const body: ImageGenerationRequestBody = {
      model: model.providerModelId,
      prompt: req.prompt,
      size: req.size ?? '512x512',
      ...options,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GenericHTTP image error: ${response.status} - ${text}`);
    }

    // pode ser binário direto ou JSON com base64
    const imageBinaryResponse = model.config.extra?.imageBinaryResponse === true;
    if (imageBinaryResponse) {
      const buf = Buffer.from(await response.arrayBuffer());
      return { image: buf, format: 'png', raw: null };
    } else {
      const json = await response.json();
      const imagePath = getExtraString(model.config.extra, 'imageB64Path') ?? 'data.0.b64_json';
      const b64 = getByPath(json, imagePath);
      if (typeof b64 !== 'string') {
        throw new Error(`Invalid base64 string at path ${imagePath}`);
      }
      const buf = Buffer.from(b64, 'base64');
      return { image: buf, format: 'png', raw: json };
    }
  },

  async textToSpeech(_model: ModelRecord, _req: AudioTTSRequest): Promise<AudioTTSResponse> {
    // similar ao imageGenerate: config define endpoint, body e formato
    throw new Error('textToSpeech not implemented for GenericHTTP');
  },

  async speechToText(_model: ModelRecord, _req: AudioSTTRequest): Promise<AudioSTTResponse> {
    // idem, mas com multipart/form-data se precisar
    throw new Error('speechToText not implemented for GenericHTTP');
  },

  async rawInvoke(model: ModelRecord, op: string, payload: RawInvokePayload): Promise<RawInvokeResponse> {
    const baseUrl = getBaseUrl(model);
    const headers = buildHeaders(model);
    const endpoint = model.config.endpointOverrides?.[op];
    if (!endpoint) throw new Error(`No endpoint override for op '${op}'`);

    const url = `${baseUrl}${endpoint}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GenericHTTP rawInvoke error: ${response.status} - ${text}`);
    }

    const jsonData = await response.json();
    // RawInvokeResponse is type unknown, so we return it directly
    return jsonData as RawInvokeResponse;
  },
};

// helpers genéricos
function getByPath(obj: unknown, path: string): unknown {
  // ex: 'choices.0.message.content'
  return path.split('.').reduce((acc: unknown, key: string) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    const indexMatch = key.match(/^(\d+)$/);
    if (indexMatch) {
      const idx = Number(indexMatch[1]);
      if (Array.isArray(acc)) {
        return acc[idx];
      }
      return undefined;
    }
    if (acc && typeof acc === 'object' && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function mapByWildcardPath(obj: unknown, pattern: string): unknown[] {
  // ex: 'data.*.embedding'
  const parts = pattern.split('.');
  const result: unknown[] = [];

  function recurse(current: unknown, idx: number): void {
    if (idx === parts.length) {
      result.push(current);
      return;
    }
    const part = parts[idx];
    if (part === '*') {
      if (Array.isArray(current)) {
        current.forEach((item) => recurse(item, idx + 1));
      }
    } else {
      if (current && typeof current === 'object' && !Array.isArray(current) && part in current) {
        const record = current as Record<string, unknown>;
        recurse(record[part], idx + 1);
      }
    }
  }

  recurse(obj, 0);
  return result;
}
