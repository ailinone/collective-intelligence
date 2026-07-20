// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Mock do OpenAI Adapter para testes
 * 
 * NOTA: Este arquivo é mantido apenas para compatibilidade com testes legados.
 * NOVOS TESTES DEVEM USAR DESCOBERTA DINÂMICA DE MODELOS - NENHUM MODELO HARDCODED!
 * 
 * Use este mock para evitar chamadas reais à API do OpenAI durante testes.
 * 
 * Exemplo de uso:
 * ```typescript
 * import { vi } from 'vitest';
 * import { mockOpenAIAdapter } from '@mocks/providers/openai';
 * 
 * vi.mock('@/providers/openai/openai-adapter', () => ({
 *   OpenAIAdapter: vi.fn().mockImplementation(() => mockOpenAIAdapter),
 * }));
 * ```
 * 
 * IMPORTANTE: Para novos testes, use getTestModelId() e getTestModel() de test-model-helper.ts
 * em vez de modelos hardcoded como 'gpt-4' ou 'text-embedding-ada-002'.
 */

import type { ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse } from '@/types';

// NOTE: Model names are placeholders - real tests should use dynamic discovery
// These are kept for backward compatibility only
export const mockChatResponse: ChatResponse = {
  id: 'mock-chat-completion-id',
  object: 'chat.completion',
  created: Date.now(),
  model: 'mock-model-placeholder', // Placeholder - use dynamic discovery in real tests
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'This is a mock response from OpenAI.',
      },
      finishReason: 'stop',
    },
  ],
  usage: {
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
  },
};

export const mockEmbeddingResponse: EmbeddingResponse = {
  object: 'list',
  data: [
    {
      object: 'embedding',
      index: 0,
      embedding: Array(1536).fill(0).map(() => Math.random()),
    },
  ],
  model: 'mock-embedding-model', // Placeholder - use dynamic discovery in real tests
  usage: {
    promptTokens: 5,
    totalTokens: 5,
  },
};

export const mockOpenAIAdapter = {
  name: 'openai',
  
  chatCompletion: async (_request: ChatRequest): Promise<ChatResponse> => {
    return mockChatResponse;
  },
  
  chatCompletionStream: async function* (_request: ChatRequest): AsyncGenerator<ChatResponse> {
    yield mockChatResponse;
  },
  
  generateEmbeddings: async (_request: EmbeddingRequest): Promise<EmbeddingResponse> => {
    return mockEmbeddingResponse;
  },
  
  healthCheck: async () => ({
    healthy: true,
    latencyMs: 50,
    details: { mock: true },
  }),
  
  // NOTE: getModels returns empty array - real tests should use dynamic discovery
  // This is kept for backward compatibility only
  getModels: async () => [], // Use dynamic discovery instead of hardcoded models
};

/**
 * Cria um mock configurável do OpenAI Adapter
 */
export function createMockOpenAIAdapter(overrides?: Partial<typeof mockOpenAIAdapter>) {
  return {
    ...mockOpenAIAdapter,
    ...overrides,
  };
}

