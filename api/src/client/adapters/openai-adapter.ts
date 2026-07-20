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
  StreamChunk,
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
} from '@/types/model-client';
import type {
  ChatCompletionRequestBody,
  ChatCompletionResponse,
  EmbeddingsResponse as ProviderEmbeddingsResponse,
  ImageGenerationRequestBody,
  ImageGenerationResponse,
  AudioTTSRequestBody,
  ProviderRawResponse,
  RawInvokePayload,
  RawInvokeResponse,
} from '@/types/provider-request-types';
import { logger } from '@/utils/logger';

const _log = logger.child({ component: 'OpenAIAdapter' });

function getOpenAIBaseUrl(model: ModelRecord): string {
  return model.config.baseUrl || 'https://api.openai.com/v1';
}

function getApiKey(_model: ModelRecord): string {
  // Buscar secret real via config.apiKeyRef, env, vault, etc.
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured');
  return key;
}

export const OpenAIProviderAdapter: ProviderAdapter = {
  async text(model: ModelRecord, req: TextRequest): Promise<TextResponse> {
    const baseUrl = getOpenAIBaseUrl(model);
    const apiKey = getApiKey(model);

    // Escolhe entre /chat/completions e /completions baseado no tipo
    const url = `${baseUrl}/chat/completions`;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
      req.messages ??
      [
        req.system ? { role: 'system' as const, content: req.system } : null,
        { role: 'user' as const, content: req.prompt },
      ].filter((msg): msg is { role: 'system' | 'user'; content: string } => msg !== null);

    const body: ChatCompletionRequestBody = {
      model: model.providerModelId,
      messages,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 512,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI text error: ${response.status} - ${text}`);
    }

    const json = (await response.json()) as ChatCompletionResponse;
    const content = json.choices[0]?.message?.content ?? '';

    return { content, raw: json };
  },

  async *streamText(model: ModelRecord, req: TextRequest): AsyncIterable<StreamChunk> {
    const baseUrl = getOpenAIBaseUrl(model);
    const apiKey = getApiKey(model);

    const url = `${baseUrl}/chat/completions`;
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
      req.messages ??
      [
        req.system ? { role: 'system' as const, content: req.system } : null,
        { role: 'user' as const, content: req.prompt },
      ].filter((msg): msg is { role: 'system' | 'user'; content: string } => msg !== null);

    const body = {
      model: model.providerModelId,
      messages,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 512,
      stream: true,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(`OpenAI stream error: ${response.status} - ${text}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    let streamDone = false;
    while (!streamDone) {
      const result = await reader.read();
      streamDone = result.done;
      if (streamDone) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) continue;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.replace(/^data:\s*/, '');
        if (data === '[DONE]') continue;
        try {
          const json: unknown = JSON.parse(data);
          // SSE chunk shape: { choices: [{ delta: { content?: string } }] }.
          // Narrow each level structurally so `.delta.content` is type-safe.
          if (typeof json !== 'object' || json === null) continue;
          const choices = (json as { choices?: unknown }).choices;
          if (!Array.isArray(choices) || choices.length === 0) continue;
          // `Array.isArray` on `unknown` narrows to `any[]` (TS quirk);
          // re-annotate the indexed element as `unknown` to keep the chain honest.
          const firstChoice: unknown = choices[0];
          if (typeof firstChoice !== 'object' || firstChoice === null) continue;
          const deltaObj = (firstChoice as { delta?: unknown }).delta;
          if (typeof deltaObj !== 'object' || deltaObj === null) continue;
          const delta = (deltaObj as { content?: unknown }).content;
          if (typeof delta === 'string' && delta.length > 0) {
            yield { content: delta, raw: json };
          }
        } catch {
          // ignora parse error em linha quebrada
        }
      }
    }
  },

  async toolChat(model: ModelRecord, req: ToolChatRequest): Promise<ToolChatResponse> {
    const baseUrl = getOpenAIBaseUrl(model);
    const apiKey = getApiKey(model);

    const url = `${baseUrl}/chat/completions`;

    const tools: Array<{
      type: 'function';
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      };
    }> = req.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters,
      },
    }));

    // Convert toolChoice to OpenAI format
    let toolChoice: ChatCompletionRequestBody['tool_choice'] = 'auto';
    if (req.toolChoice) {
      if (req.toolChoice === 'auto' || req.toolChoice === 'required') {
        toolChoice = 'auto';
      } else if (typeof req.toolChoice === 'object' && 'name' in req.toolChoice) {
        toolChoice = {
          type: 'function',
          function: { name: req.toolChoice.name },
        };
      }
    }

    const body: ChatCompletionRequestBody = {
      model: model.providerModelId,
      messages: req.messages,
      tools,
      tool_choice: toolChoice,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI toolChat error: ${response.status} - ${text}`);
    }

    const json = await response.json() as ChatCompletionResponse;

    const toolCalls = (
      json.choices[0]?.message?.tool_calls?.map((tc) => ({
        toolName: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
      })) ?? []
    );

    return { toolCalls, raw: json };
  },

  async structuredJson<T = unknown>(model: ModelRecord, req: TextRequest & { schema?: Record<string, unknown> }): Promise<{ json: T; raw: ProviderRawResponse }> {
    const baseUrl = getOpenAIBaseUrl(model);
    const apiKey = getApiKey(model);

    const url = `${baseUrl}/chat/completions`;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = req.messages ?? [
      { role: 'system' as const, content: 'Você responde SEMPRE com JSON válido.' },
      { role: 'user' as const, content: req.prompt },
    ];

    const body: ChatCompletionRequestBody = {
      model: model.providerModelId,
      messages,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 512,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = await response.json() as ChatCompletionResponse;
    const content = json.choices[0]?.message?.content ?? '{}';

    let parsed: T;
    try {
      parsed = JSON.parse(content) as T;
    } catch (err) {
      throw new Error(`Invalid JSON from OpenAI: ${content}`);
    }

    return { json: parsed, raw: json as ProviderRawResponse };
  },

  async embeddings(model: ModelRecord, req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    const baseUrl = getOpenAIBaseUrl(model);
    const apiKey = getApiKey(model);
    const url = `${baseUrl}/embeddings`;

    const body = {
      model: model.providerModelId,
      input: req.inputs,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI embeddings error: ${response.status} - ${text}`);
    }

    const json = await response.json() as ProviderEmbeddingsResponse;
    const vectors = json.data.map((item) => item.embedding);

    return { vectors, raw: json };
  },

  async vision(model: ModelRecord, req: VisionRequest): Promise<VisionResponse> {
    const baseUrl = getOpenAIBaseUrl(model);
    const apiKey = getApiKey(model);
    const url = `${baseUrl}/chat/completions`;

    const imageUrlOrBase64 =
      typeof req.image === 'string'
        ? req.image
        : `data:image/png;base64,${req.image.toString('base64')}`;

    const body = {
      model: model.providerModelId,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: req.prompt },
            {
              type: 'image_url',
              image_url: { url: imageUrlOrBase64 },
            },
          ],
        },
      ],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = (await response.json()) as ChatCompletionResponse;
    const content = json.choices[0]?.message?.content ?? '';

    return { content, raw: json };
  },

  async imageGenerate(model: ModelRecord, req: ImageGenRequest): Promise<ImageGenResponse> {
    const baseUrl = getOpenAIBaseUrl(model);
    const apiKey = getApiKey(model);
    const url = `${baseUrl}/images/generations`;

    const body: ImageGenerationRequestBody = {
      model: model.providerModelId,
      prompt: req.prompt,
      size: req.size ?? '512x512',
      ...(req.options as Record<string, unknown>),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI image error: ${response.status} - ${text}`);
    }

    const json = (await response.json()) as ImageGenerationResponse;
    const b64 = json.data[0]?.b64_json;
    if (!b64) {
      throw new Error('OpenAI image generation returned no image data');
    }
    const buf = Buffer.from(b64, 'base64');

    return {
      image: buf,
      format: 'png',
      raw: json,
    };
  },

  async textToSpeech(model: ModelRecord, req: AudioTTSRequest): Promise<AudioTTSResponse> {
    const baseUrl = getOpenAIBaseUrl(model);
    const apiKey = getApiKey(model);
    const url = `${baseUrl}/audio/speech`;

    const body: AudioTTSRequestBody = {
      model: model.providerModelId,
      input: req.text,
      voice: req.voice ?? 'alloy',
      format: req.format ?? 'mp3',
      ...(req.options as Record<string, unknown>),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI tts error: ${response.status} - ${text}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    return {
      audio: buffer,
      format: req.format ?? 'mp3',
      raw: null, // se precisar, chame endpoint que retorne metadata
    };
  },

  async speechToText(model: ModelRecord, req: AudioSTTRequest): Promise<AudioSTTResponse> {
    const baseUrl = getOpenAIBaseUrl(model);
    const apiKey = getApiKey(model);
    const url = `${baseUrl}/audio/transcriptions`;

    const form = new FormData();
    // Usar Uint8Array para compatibilidade
    const uint8Array = new Uint8Array(req.audio);
    form.append('file', new File([uint8Array], 'audio.wav', { type: 'audio/wav' }));
    form.append('model', model.providerModelId);
    if (req.language) form.append('language', req.language);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI stt error: ${response.status} - ${text}`);
    }

    const json = (await response.json()) as { text: string; [key: string]: unknown };
    return {
      text: json.text,
      raw: json,
    };
  },

  async rawInvoke(_model: ModelRecord, op: string, _payload: RawInvokePayload): Promise<RawInvokeResponse> {
    // fallback genérico, se precisar
    throw new Error(`rawInvoke not implemented for OpenAI: ${op}`);
  },
};
