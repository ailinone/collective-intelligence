// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Server-Sent Events (SSE) utilities
 * For streaming chat completions to ailin-cli
 */

import type { FastifyReply } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';
import type { ChatResponse, AilinMetadata } from '@/types';
import { logger } from './logger';

/**
 * Format SSE data
 */
export function formatSSE(data: ChatResponse): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * SSE event types
 */
export const SSE_EVENTS = {
  MESSAGE: 'message',
  DONE: '[DONE]',
  ERROR: 'error',
} as const;

/**
 * Extended error with optional code property
 */
interface ErrorWithCode extends Error {
  code?: string;
}

/**
 * Send SSE chunk
 */
export function sendSSEChunk(reply: FastifyReply, chunk: ChatResponse): void {
  reply.raw.write(formatSSE(chunk));
}

/**
 * Send SSE done signal
 */
export function sendSSEDone(reply: FastifyReply): void {
  reply.raw.write(`data: ${SSE_EVENTS.DONE}\n\n`);
}

/**
 * Send SSE error
 */
export function sendSSEError(reply: FastifyReply, error: Error): void {
  const _errorWithCode = error as ErrorWithCode;
  // ChatResponse doesn't have error property, create a minimal response with error in choices
  const errorData: ChatResponse = {
    id: `error-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'error',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: error.message,
      },
      finish_reason: null,
      logprobs: null,
    }],
  };
  reply.raw.write(formatSSE(errorData));
}

/**
 * Setup SSE response headers.
 *
 * Merges in whatever Fastify headers were already QUEUED via `reply.header()`
 * before this runs (e.g. `Idempotency-Replayed`/`Retry-After` set inside
 * `withIdempotency`) — `reply.header()` only writes into Fastify's internal
 * header map, flushed to the wire by Fastify's own `reply.send()` path. A
 * caller that ends the raw stream itself (bypassing `.send()`, as every SSE
 * response here does) never triggers that flush, so any header queued before
 * this call would otherwise be silently dropped. Confirmed by execution
 * (2026-07-17, real fastify.inject()): the streaming file-generation
 * redirect's Idempotency-Replayed header on a replay, and its Retry-After
 * header on the idempotency-store-unavailable 503, both vanished before this
 * fix, because `setupSSEHeaders` ran (and committed `raw.writeHead`) BEFORE
 * `withIdempotency` ever called `reply.header(...)`.
 */
export function setupSSEHeaders(reply: FastifyReply): void {
  const headers: OutgoingHttpHeaders = {
    ...(reply.getHeaders() as OutgoingHttpHeaders),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  };
  reply.raw.writeHead(200, headers);
}

/**
 * Stream handler for orchestration results
 */
export class StreamHandler {
  private log = logger.child({ component: 'stream-handler' });
  private chunkCount = 0;

  /**
   * Handle streaming from a provider adapter
   */
  async *handleProviderStream(
    providerStream: AsyncGenerator<ChatResponse, void, unknown>,
    _requestedModel: string // Prefixed with _ to indicate intentionally unused
  ): AsyncGenerator<ChatResponse, void, unknown> {
    try {
      for await (const chunk of providerStream) {
        this.chunkCount++;

        // Add ailin metadata to first chunk
        if (this.chunkCount === 1) {
          this.log.debug('First chunk received, starting stream');
        }

        yield chunk;
      }

      this.log.debug({ totalChunks: this.chunkCount }, 'Stream completed');
    } catch (error) {
      this.log.error({ error, chunkCount: this.chunkCount }, 'Stream error');
      throw error;
    }
  }

  /**
   * Merge metadata into final chunk
   */
  createFinalChunk(baseChunk: ChatResponse, metadata: AilinMetadata): ChatResponse {
    return {
      ...baseChunk,
      ailin_metadata: metadata,
    };
  }
}
