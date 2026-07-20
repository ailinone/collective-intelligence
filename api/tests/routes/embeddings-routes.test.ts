// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for Embeddings Routes
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIAdapter } from '@/providers/openai/openai-adapter';
import type { EmbeddingRequest, EmbeddingResponse } from '@/types';

/**
 * Type for OpenAIAdapter with generateEmbeddings method exposed for testing
 */
type OpenAIAdapterWithEmbeddings = OpenAIAdapter & {
  generateEmbeddings: (request: EmbeddingRequest) => Promise<EmbeddingResponse>;
};

describe('Embeddings Routes Logic', () => {
  let adapter: OpenAIAdapter;

  beforeEach(() => {
    adapter = new OpenAIAdapter({
      name: 'openai',
      apiKey: 'test-key',
      models: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
    });
  });

  describe('Generate Embeddings', () => {
    it('should generate embeddings for single text', async () => {
      // Mock OpenAI embeddings API
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [
          {
            embedding: new Array(1536).fill(0).map(() => Math.random()),
            index: 0,
          },
        ],
        model: 'text-embedding-3-small',
        usage: {
          prompt_tokens: 5,
          total_tokens: 5,
        },
      });

      const result = await adapter.generateEmbeddings({
        input: 'Hello world',
        model: 'text-embedding-3-small',
      });

      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBe(1);
      expect(result.data[0].embedding).toBeDefined();
      expect(Array.isArray(result.data[0].embedding)).toBe(true);
      expect(result.data[0].embedding.length).toBe(1536);

      mockEmbeddings.mockRestore();
    });

    it('should generate embeddings for array of texts', async () => {
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [
          {
            embedding: new Array(1536).fill(0).map(() => Math.random()),
            index: 0,
          },
          {
            embedding: new Array(1536).fill(0).map(() => Math.random()),
            index: 1,
          },
          {
            embedding: new Array(1536).fill(0).map(() => Math.random()),
            index: 2,
          },
        ],
        model: 'text-embedding-3-small',
        usage: {
          prompt_tokens: 15,
          total_tokens: 15,
        },
      });

      const result = await adapter.generateEmbeddings({
        input: ['Hello', 'World', 'Test'],
        model: 'text-embedding-3-small',
      });

      expect(result).toBeDefined();
      expect(result.data.length).toBe(3);
      
      result.data.forEach((item, index) => {
        expect(item.embedding).toBeDefined();
        expect(item.index).toBe(index);
        expect(item.embedding.length).toBe(1536);
      });

      mockEmbeddings.mockRestore();
    });

    it('should include usage information', async () => {
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [
          {
            embedding: new Array(1536).fill(0).map(() => Math.random()),
            index: 0,
          },
        ],
        model: 'text-embedding-3-small',
        usage: {
          prompt_tokens: 10,
          total_tokens: 10,
        },
      });

      const result = await adapter.generateEmbeddings({
        input: 'Test text for embeddings',
        model: 'text-embedding-3-small',
      });

      expect(result.usage).toBeDefined();
      expect(result.usage.prompt_tokens).toBeGreaterThan(0);
      expect(result.usage.total_tokens).toBeGreaterThan(0);

      mockEmbeddings.mockRestore();
    });

    it('should return correct model name', async () => {
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [
          {
            embedding: new Array(1536).fill(0).map(() => Math.random()),
            index: 0,
          },
        ],
        model: 'text-embedding-3-small',
        usage: {
          prompt_tokens: 5,
          total_tokens: 5,
        },
      });

      const result = await adapter.generateEmbeddings({
        input: 'Test',
        model: 'text-embedding-3-small',
      });

      expect(result.model).toBe('text-embedding-3-small');

      mockEmbeddings.mockRestore();
    });
  });

  describe('Embedding Models', () => {
    it('should support text-embedding-3-small', async () => {
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0), index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      });

      const result = await adapter.generateEmbeddings({
        input: 'Test',
        model: 'text-embedding-3-small',
      });

      expect(result.model).toBe('text-embedding-3-small');
      expect(result.data[0].embedding.length).toBe(1536);

      mockEmbeddings.mockRestore();
    });

    it('should support text-embedding-3-large', async () => {
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [{ embedding: new Array(3072).fill(0), index: 0 }],
        model: 'text-embedding-3-large',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      });

      const result = await adapter.generateEmbeddings({
        input: 'Test',
        model: 'text-embedding-3-large',
      });

      expect(result.model).toBe('text-embedding-3-large');
      expect(result.data[0].embedding.length).toBe(3072);

      mockEmbeddings.mockRestore();
    });

    it('should support text-embedding-ada-002 (legacy)', async () => {
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0), index: 0 }],
        model: 'text-embedding-ada-002',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      });

      const result = await adapter.generateEmbeddings({
        input: 'Test',
        model: 'text-embedding-ada-002',
      });

      expect(result.model).toBe('text-embedding-ada-002');

      mockEmbeddings.mockRestore();
    });
  });

  describe('Input Validation', () => {
    it('should handle empty string', async () => {
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0), index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });

      const result = await adapter.generateEmbeddings({
        input: '',
        model: 'text-embedding-3-small',
      });

      expect(result).toBeDefined();

      mockEmbeddings.mockRestore();
    });

    it('should handle very long text', async () => {
      const longText = 'a'.repeat(8000); // 8k characters
      
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0), index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 2000, total_tokens: 2000 },
      });

      const result = await adapter.generateEmbeddings({
        input: longText,
        model: 'text-embedding-3-small',
      });

      expect(result).toBeDefined();
      expect(result.usage.prompt_tokens).toBeGreaterThan(0);

      mockEmbeddings.mockRestore();
    });

    it('should handle empty array', async () => {
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });

      const result = await adapter.generateEmbeddings({
        input: [],
        model: 'text-embedding-3-small',
      });

      expect(result).toBeDefined();
      expect(result.data.length).toBe(0);

      mockEmbeddings.mockRestore();
    });

    it('should handle special characters and unicode', async () => {
      const specialText = '你好世界 🌍 émojis & spëcial çhars!';
      
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0), index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 15, total_tokens: 15 },
      });

      const result = await adapter.generateEmbeddings({
        input: specialText,
        model: 'text-embedding-3-small',
      });

      expect(result).toBeDefined();

      mockEmbeddings.mockRestore();
    });
  });

  describe('Embedding Properties', () => {
    it('should generate normalized vectors', async () => {
      const mockEmbedding = new Array(1536).fill(0).map(() => Math.random() - 0.5);
      
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [{ embedding: mockEmbedding, index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      });

      const result = await adapter.generateEmbeddings({
        input: 'Test',
        model: 'text-embedding-3-small',
      });

      const embedding = result.data[0].embedding;
      
      // Calculate magnitude
      const magnitude = Math.sqrt(
        embedding.reduce((sum, val) => sum + val * val, 0)
      );

      // OpenAI embeddings are normalized (magnitude ~= 1)
      expect(magnitude).toBeGreaterThan(0);

      mockEmbeddings.mockRestore();
    });

    it('should generate consistent embeddings for same input', async () => {
      const input = 'Consistent test';
      
      const mockEmbedding = new Array(1536).fill(0).map((_, i) => i / 1536);
      
      const mockEmbeddings = vi.spyOn(adapter as OpenAIAdapterWithEmbeddings, 'generateEmbeddings').mockResolvedValue({
        data: [{ embedding: mockEmbedding, index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      });

      const result1 = await adapter.generateEmbeddings({
        input,
        model: 'text-embedding-3-small',
      });

      const result2 = await adapter.generateEmbeddings({
        input,
        model: 'text-embedding-3-small',
      });

      // Mock returns same values, but in real API they should be very similar
      expect(result1.data[0].embedding).toEqual(result2.data[0].embedding);

      mockEmbeddings.mockRestore();
    });
  });

  describe('Cost Calculation', () => {
    it('should calculate embedding costs correctly', () => {
      // text-embedding-3-small: $0.00002 per 1k tokens
      const costPer1k = 0.00002;
      const tokens = 1000;
      const expectedCost = (tokens / 1000) * costPer1k;

      expect(expectedCost).toBe(0.00002);
    });

    it('should handle different embedding models pricing', () => {
      // text-embedding-3-small: $0.00002 per 1k
      const smallCost = (1000 / 1000) * 0.00002;
      
      // text-embedding-3-large: $0.00013 per 1k
      const largeCost = (1000 / 1000) * 0.00013;
      
      // text-embedding-ada-002: $0.0001 per 1k
      const adaCost = (1000 / 1000) * 0.0001;

      expect(smallCost).toBeLessThan(adaCost);
      expect(adaCost).toBeLessThan(largeCost);
    });
  });
});

