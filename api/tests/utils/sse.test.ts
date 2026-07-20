// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for SSE utilities
 * Uses REAL models from dynamic discovery - NO hardcoded models
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { formatSSE, sendSSEChunk, sendSSEDone, sendSSEError, setupSSEHeaders, StreamHandler } from '@/utils/sse';
import type { ChatResponse } from '@/types';
import { startTestEnvironment, stopTestEnvironment } from './test-environment';
import { getTestModel, ensureModelsDiscovered } from './dynamic-model-discovery';

describe('SSE Utilities - Real Tests (NO Hardcoded Models)', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  describe('formatSSE', () => {
    it('should format data correctly with real models', async () => {
      // Get a real model from dynamic discovery - NO hardcoded models
      const realModel = await getTestModel();
      if (!realModel) {
        return; // Skip if no models available
      }

      const chunk: ChatResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion.chunk',
        created: 1234567890,
        model: realModel.id, // Use dynamically discovered model
        choices: [
          {
            index: 0,
            delta: {
              content: 'Hello',
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      };

      const formatted = formatSSE(chunk);

      expect(formatted).toContain('data: ');
      expect(formatted).toContain('"id":"chatcmpl-123"');
      expect(formatted).toContain('"content":"Hello"');
      expect(formatted.endsWith('\n\n')).toBe(true);
    }, 60000);
  });

  describe('sendSSEChunk', () => {
    it('should write formatted chunk to response', async () => {
      // Get a real model from dynamic discovery - NO hardcoded models
      const realModel = await getTestModel();
      if (!realModel) {
        return; // Skip if no models available
      }

      const mockWrite = vi.fn();
      const mockReply = {
        raw: { write: mockWrite },
      };

      const chunk: ChatResponse = {
        id: 'test',
        object: 'chat.completion.chunk',
        created: 123,
        model: realModel.id, // Use dynamically discovered model
        choices: [{
          index: 0,
          delta: { content: 'test' },
          finish_reason: null,
          logprobs: null,
        }],
      };

      sendSSEChunk(mockReply as never, chunk);

      expect(mockWrite).toHaveBeenCalled();
      const written = mockWrite.mock.calls[0][0] as string;
      expect(written).toContain('data: ');
      expect(written).toContain('"id":"test"');
    }, 60000);
  });

  describe('sendSSEDone', () => {
    it('should send done event', () => {
      const mockWrite = vi.fn();
      const mockReply = {
        raw: { write: mockWrite },
      };

      sendSSEDone(mockReply as never);

      expect(mockWrite).toHaveBeenCalled();
      const written = mockWrite.mock.calls[0][0] as string;
      expect(written).toBe('data: [DONE]\n\n');
    });
  });

  describe('sendSSEError', () => {
    it('should send error event', () => {
      const mockWrite = vi.fn();
      const mockReply = {
        raw: { write: mockWrite },
      };

      sendSSEError(mockReply as never, new Error('Test error'));

      expect(mockWrite).toHaveBeenCalled();
      const written = mockWrite.mock.calls[0][0] as string;
      expect(written).toContain('data: ');
      expect(written).toContain('"content":"Test error"');
    });
  });

  describe('setupSSEHeaders', () => {
    it('should set correct SSE headers', () => {
      const mockWriteHead = vi.fn();
      const mockReply = {
        raw: { writeHead: mockWriteHead },
      };

      setupSSEHeaders(mockReply as never);

      expect(mockWriteHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
      );
    });
  });

  describe('StreamHandler', () => {
    it('should handle stream chunks with real models', async () => {
      // Get a real model from dynamic discovery - NO hardcoded models
      const realModel = await getTestModel();
      if (!realModel) {
        return; // Skip if no models available
      }

      const handler = new StreamHandler();

      const chunk: ChatResponse = {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 123,
        model: realModel.id, // Use dynamically discovered model
        choices: [{
          index: 0,
          delta: { content: 'chunk' },
          finish_reason: null,
          logprobs: null,
        }],
      };

      async function* providerStream(): AsyncGenerator<ChatResponse, void, unknown> {
        yield chunk;
      }

      const received: ChatResponse[] = [];
      for await (const event of handler.handleProviderStream(providerStream(), realModel.id)) {
        received.push(event);
      }

      expect(received.length).toBe(1);
      expect(received[0].id).toBe('chunk-1');
    }, 60000);
  });
});
