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
import type { ChatResponse, AilinMetadata, AilinErrorMetadata } from '@/types';
import { logger } from './logger';
import { applyBranding } from './branding';

/**
 * Maximum safe size (bytes) for a single SSE `data: ...\n\n` line.
 *
 * SSE is a line-oriented protocol — a `data:` frame is read by consumers as
 * ONE line before it is parsed. Real-world SSE/HTTP clients enforce a hard
 * per-line buffer limit; e.g. Python's `aiohttp.StreamReader` (used by
 * ailin-chat's backend proxy — `routers/openai.py` — to relay this exact
 * stream when CI is registered as its OpenAI-compatible provider) iterates a
 * raw stream via `readline()`, which raises `LineTooLong` ("Got more than
 * 131072 bytes when reading: ...") once a line exceeds its default
 * `_high_water` mark (2x its 65536-byte default `limit`). That is the
 * verbatim production incident (2026-09-08): a real image-generation
 * response, redirected through the streaming media-generation gate
 * (chat-routes.ts), embedded a full base64 image inline in
 * `ailin_metadata.artifacts[].b64_json` inside a single JSON-stringified SSE
 * line — hundreds of KB, unbroken by any newline — and the browser surfaced
 * aiohttp's read failure as a hard 400 to the end user.
 *
 * Kept well under the smallest widely-observed real-world limit (131072) for
 * margin against other line-based consumers with smaller ones. Overridable
 * for environments with different constraints, same convention as
 * `ARTIFACT_MAX_B64_CHARS` (orchestration-engine.ts).
 */
const SSE_LINE_SAFE_MAX_BYTES = Number(process.env.SSE_LINE_SAFE_MAX_BYTES) || 60_000;

/**
 * Type guard: `ailin_metadata` is a discriminated union (see `ChatResponse`)
 * — only the final-completion `AilinMetadata` shape (no `type` field) ever
 * carries `.artifacts`; the SSE-only progress/observer/clarification variants
 * always carry one.
 */
function hasInlineArtifacts(
  metadata: ChatResponse['ailin_metadata']
): metadata is AilinMetadata & { artifacts: NonNullable<AilinMetadata['artifacts']> } {
  return (
    !!metadata &&
    !('type' in metadata) &&
    Array.isArray((metadata as AilinMetadata).artifacts) &&
    (metadata as AilinMetadata).artifacts!.length > 0
  );
}

/**
 * Strip any inline base64 artifact payload that would make this chunk unsafe
 * to ship as a single SSE line. Never mutates the input; returns the same
 * reference when there is nothing to strip (the overwhelmingly common case —
 * most chunks carry no artifacts at all).
 *
 * Deliberately NOT a "raise the buffer" fix: a line-based SSE reader (the
 * normal, idiomatic way to consume Server-Sent Events) cannot safely receive
 * an arbitrarily large single line no matter how generous any one buffer is
 * set to — a big enough generated image/video/audio/file will always
 * eventually exceed a fixed limit. The only correct fix is to never inline
 * such payloads into one transport line. When the artifact already carries a
 * `url` (the established pattern elsewhere in this codebase — see
 * `ArtifactRef`, which has no b64 field at all), the inline copy is pure
 * redundant weight and is always dropped, not just when oversized.
 */
function stripUnsafeInlineArtifacts(chunk: ChatResponse): ChatResponse {
  const metadata = chunk.ailin_metadata;
  if (!hasInlineArtifacts(metadata)) return chunk;

  let mutated = false;
  const safeArtifacts = metadata.artifacts.map((artifact) => {
    if (!artifact.b64_json) return artifact;
    const oversized = artifact.b64_json.length > SSE_LINE_SAFE_MAX_BYTES;
    if (!artifact.url && !oversized) return artifact;
    mutated = true;
    return {
      ...artifact,
      b64_json: undefined,
      ...(artifact.url
        ? {}
        : {
            error:
              artifact.error ??
              'Generated payload omitted from this streaming response (too large to inline safely) — retry with stream:false to receive it.',
          }),
    };
  });

  if (!mutated) return chunk;
  return { ...chunk, ailin_metadata: { ...metadata, artifacts: safeArtifacts } };
}

/**
 * Last-resort guard for any OTHER unbounded field (present or future) that
 * could still push a line over budget after artifact-stripping. Replaces the
 * chunk with a small, honest, safely-sized placeholder rather than ever
 * emitting a line long enough to break a downstream line-based reader.
 */
function buildOversizedFallback(chunk: ChatResponse): ChatResponse {
  const [firstChoice, ...restChoices] = chunk.choices;
  return {
    ...chunk,
    ailin_metadata: undefined,
    choices: firstChoice
      ? [
          {
            ...firstChoice,
            message: {
              role: 'assistant',
              content:
                'Response too large to deliver over a streaming connection. Retry with stream:false.',
            },
            delta: undefined,
          },
          ...restChoices,
        ]
      : chunk.choices,
  };
}

/**
 * Format SSE data
 */
export function formatSSE(data: ChatResponse): string {
  const safeData = stripUnsafeInlineArtifacts(data);
  const line = `data: ${JSON.stringify(safeData)}\n\n`;
  if (Buffer.byteLength(line, 'utf8') <= SSE_LINE_SAFE_MAX_BYTES) {
    return line;
  }
  logger.warn(
    { id: safeData.id, bytes: Buffer.byteLength(line, 'utf8') },
    'SSE chunk exceeded the safe line-length budget even after stripping inline artifacts — replacing with a degraded placeholder instead of emitting an oversized line'
  );
  return `data: ${JSON.stringify(buildOversizedFallback(safeData))}\n\n`;
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
 *
 * Applies `applyBranding()` here — the single choke point every streaming
 * caller in the codebase already goes through — rather than at each call
 * site. Confirmed live: a self-hosted response's `message.content` correctly
 * refused to name the underlying model while the SAME JSON payload's
 * `model`/`system_fingerprint` fields carried it verbatim, because the
 * non-streaming path (`chat-request-processor.ts`) already calls
 * `applyBranding()` before responding, but nothing on the streaming path
 * did. A per-call-site fix would need to be re-applied at every future SSE
 * emitter; this one covers all of them, including ones not yet written.
 */
export function sendSSEChunk(reply: FastifyReply, chunk: ChatResponse): void {
  reply.raw.write(formatSSE(applyBranding(chunk)));
}

/**
 * Send SSE done signal
 */
export function sendSSEDone(reply: FastifyReply): void {
  reply.raw.write(`data: ${SSE_EVENTS.DONE}\n\n`);
}

/**
 * Send SSE error
 *
 * Context-window preflight audit (2026-09): `error.code`, when present
 * (e.g. `ContextWindowExceededError`'s `code: 'context_exceeded'`), is now
 * additionally surfaced as `ailin_metadata: { type: 'error', code }` — a
 * machine-readable companion to the human-readable text already placed in
 * `choices[0].message.content` below, so an agentic client can react
 * programmatically instead of only pattern-matching prose. Absent for any
 * plain `Error` with no `.code` (every existing call site), so this is
 * purely additive.
 */
export function sendSSEError(reply: FastifyReply, error: Error): void {
  const errorWithCode = error as ErrorWithCode;
  // ChatResponse doesn't have error property, create a minimal response with error in choices
  const errorData: ChatResponse = {
    id: `error-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'error',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: error.message,
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
    ...(errorWithCode.code
      ? {
          ailin_metadata: {
            type: 'error',
            code: errorWithCode.code,
          } satisfies AilinErrorMetadata,
        }
      : {}),
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
