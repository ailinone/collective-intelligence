// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Idempotency middleware / route helper
 * ──────────────────────────────────────────────────────────────────────────
 * Thin Fastify-facing wrapper around `idempotency-service.ts`. Route handlers
 * for the billable endpoints (`POST /v1/chat/completions`, `POST /v1/responses`)
 * call {@link withIdempotency} to wrap their core execution so that:
 *
 *   - a retry with the same `Idempotency-Key` + same body replays the original
 *     response (adding `Idempotency-Replayed: true`) instead of re-billing;
 *   - the same key with a DIFFERENT body returns 409 `idempotency_key_reuse`;
 *   - a concurrent in-flight request returns 409 `idempotency_in_progress`;
 *   - requests WITHOUT the header pass through completely unchanged;
 *   - streaming (`stream:true`) requests bypass idempotency (SSE is not
 *     buffered/replayable in this first version — documented limitation);
 *   - if the idempotency store (Redis) is UNREACHABLE for a keyed request we
 *     FAIL CLOSED with a retryable 503 `idempotency_store_unavailable` rather
 *     than run the billable handler unprotected — a silent execution during an
 *     outage could double-charge a retrying client. Safety over availability on
 *     the money path.
 *
 * The error responses are sent as `{ error: { code, message } }`; the global
 * `request-context` `preSerialization` hook enriches every >=400 payload into
 * the canonical `{ error, requestId, correlationId, timestamp }` envelope, so
 * we deliberately do NOT duplicate that envelope here.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  beginIdempotentRequest,
  finalizeIdempotentRequest,
  releaseIdempotentRequest,
  normalizeIdempotencyKey,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type IdempotencyStore,
  type IdempotencyRecord,
} from '@/services/idempotency-service';
import { logger } from '@/utils/logger';

const log = logger.child({ middleware: 'idempotency' });

/** Header clients send the idempotency key in (canonical + `x-` alias). */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_HEADER_ALIAS = 'x-idempotency-key';
/** Response header flagged on a replayed (cached) response. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/**
 * `Retry-After` hint (seconds) sent with the fail-closed 503 when the
 * idempotency store is unreachable. Short so a well-behaved client retries
 * promptly once the store (Redis) recovers, without hammering during the
 * outage. Overridable via `IDEMPOTENCY_STORE_UNAVAILABLE_RETRY_AFTER_SECONDS`.
 */
export const IDEMPOTENCY_STORE_UNAVAILABLE_RETRY_AFTER_SECONDS = (() => {
  const parsed = Number.parseInt(
    process.env.IDEMPOTENCY_STORE_UNAVAILABLE_RETRY_AFTER_SECONDS ?? '',
    10
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
})();

/**
 * Extract a single string header value (string or first array element).
 */
function getHeaderValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    if (typeof first === 'string') return first;
  }
  return undefined;
}

/**
 * Read the raw Idempotency-Key header (canonical, then alias) off a request.
 */
export function readIdempotencyHeader(request: FastifyRequest): string | undefined {
  return (
    getHeaderValue(request.headers[IDEMPOTENCY_HEADER]) ??
    getHeaderValue(request.headers[IDEMPOTENCY_HEADER_ALIAS])
  );
}

export interface WithIdempotencyOptions<T> {
  request: FastifyRequest;
  reply: FastifyReply;
  /** Tenant scope — the authenticated organization id. */
  organizationId: string;
  /** The normalized request body that gets hashed for the dedup fingerprint. */
  requestBody: unknown;
  /** Whether this request is streaming (idempotency is skipped if so). */
  isStreaming?: boolean;
  /**
   * The core handler. MUST return `{ httpStatus, body }`. A 2xx result is
   * cached + replayable; any non-2xx result is NOT cached (retry stays open).
   * If it throws, the lock is released and the error re-thrown to the caller.
   */
  handler: () => Promise<{ httpStatus: number; body: T }>;
  /** Injectable store for tests. Defaults to the Redis-backed store. */
  store?: IdempotencyStore;
  /**
   * How to finalize the reply once a `{ httpStatus, body }` result is ready
   * (from the handler, a replay record, or an early-return error). Defaults
   * to a plain `reply.status(httpStatus).send(body)` — every existing caller
   * gets EXACTLY that behavior unchanged. Override this for an `isStreaming`
   * caller whose client expects SSE framing instead of a JSON body (added
   * 2026-07-17 for the chat streaming media/file-artifact redirect — without
   * this hook, `isStreaming: true` still did a plain JSON send, which is
   * wrong for a client that opened the connection expecting
   * `text/event-stream`).
   *
   * ⚠️ `FastifyReply` is a thenable (its own `.then()` resolves once
   * `reply.raw.writableEnded` is true), and every branch below does
   * `return sendResponse(...)` inside an async function — so whatever this
   * returns gets ADOPTED as the settlement of `withIdempotency`'s own
   * promise, not treated as a plain value. A custom implementation that does
   * only raw WRITES (e.g. SSE `data:` events) and defers `reply.raw.end()`
   * to the caller, AFTER awaiting `withIdempotency(...)`, deadlocks forever
   * — confirmed by execution (real Fastify + `fastify.inject`, 2026-07-17).
   * Any override MUST call `reply.raw.end()` (directly, or via something
   * that does, like Fastify's own `reply.send()`) BEFORE returning.
   */
  sendResponse?: (reply: FastifyReply, httpStatus: number, body: unknown) => FastifyReply;
}

/**
 * Send a replayed (cached) response: original status + body, with the
 * `Idempotency-Replayed: true` marker so clients can tell it was a replay.
 */
function sendReplay(
  reply: FastifyReply,
  record: IdempotencyRecord,
  sendResponse: (reply: FastifyReply, httpStatus: number, body: unknown) => FastifyReply
): FastifyReply {
  reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  return sendResponse(reply, record.httpStatus ?? 200, record.body);
}

function defaultSendResponse(reply: FastifyReply, httpStatus: number, body: unknown): FastifyReply {
  return reply.status(httpStatus).send(body);
}

/**
 * Wrap a route's core execution with idempotency semantics.
 *
 * Returns the `FastifyReply` (already sent) in every branch so callers can
 * `return withIdempotency(...)` directly.
 */
export async function withIdempotency<T>(
  options: WithIdempotencyOptions<T>
): Promise<FastifyReply> {
  const { request, reply, organizationId, requestBody, isStreaming, handler, store } = options;
  const sendResponse = options.sendResponse ?? defaultSendResponse;

  const rawKey = readIdempotencyHeader(request);

  // ── Passthrough: no header → behavior unchanged ──────────────────────────
  if (rawKey === undefined) {
    const { httpStatus, body } = await handler();
    return sendResponse(reply, httpStatus, body);
  }

  // ── Streaming bypass: SSE responses are not replayable in v1 ─────────────
  if (isStreaming) {
    log.debug(
      { organizationId },
      'Idempotency-Key present on a streaming request; idempotency skipped (streaming not replayable)'
    );
    const { httpStatus, body } = await handler();
    return sendResponse(reply, httpStatus, body);
  }

  const key = normalizeIdempotencyKey(rawKey);

  // Empty-after-trim → treat as passthrough (a blank header is not a key).
  if (key === undefined) {
    const { httpStatus, body } = await handler();
    return sendResponse(reply, httpStatus, body);
  }

  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return sendResponse(reply, 400, {
      error: {
        code: 'idempotency_key_invalid',
        message: `Idempotency-Key must not exceed ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      },
    });
  }

  // Tenant scope is mandatory — without it we cannot isolate keys.
  if (!organizationId) {
    return sendResponse(reply, 401, {
      error: {
        code: 'unauthorized',
        message: 'Tenant context required for idempotent requests.',
      },
    });
  }

  let begin;
  try {
    begin = await beginIdempotentRequest({ organizationId, key, requestBody, store });
  } catch (error) {
    // ── FAIL CLOSED (money-path safety) ──────────────────────────────────────
    // The idempotency store (Redis) is unreachable, so we CANNOT guarantee
    // at-most-once execution for this billable request. Running the handler
    // anyway — the previous fail-OPEN behavior — means a client retry during the
    // outage would re-execute the inference and DOUBLE-CHARGE. The client
    // explicitly opted into de-duplication by sending an Idempotency-Key, so we
    // refuse with a retryable 503 (safety over availability) rather than bill
    // twice. The client keeps the same key and retries once the store recovers.
    log.error(
      { organizationId, error: error instanceof Error ? error.message : String(error) },
      'idempotency store unavailable; refusing billable request (fail-closed) to avoid double-charge'
    );
    reply.header('Retry-After', String(IDEMPOTENCY_STORE_UNAVAILABLE_RETRY_AFTER_SECONDS));
    return sendResponse(reply, 503, {
      error: {
        code: 'idempotency_store_unavailable',
        message:
          'The idempotency store is temporarily unavailable, so this request cannot be safely de-duplicated. Retry shortly with the same Idempotency-Key.',
      },
    });
  }

  if (begin.outcome === 'replay') {
    log.info({ organizationId }, 'idempotency replay: returning cached response');
    return sendReplay(reply, begin.record, sendResponse);
  }

  if (begin.outcome === 'key_reuse') {
    return sendResponse(reply, 409, {
      error: {
        code: 'idempotency_key_reuse',
        message:
          'This Idempotency-Key was already used with a different request body. Reuse a key only for identical retried requests.',
      },
    });
  }

  if (begin.outcome === 'in_progress') {
    return sendResponse(reply, 409, {
      error: {
        code: 'idempotency_in_progress',
        message:
          'A request with this Idempotency-Key is already in progress. Retry after it completes.',
      },
    });
  }

  // ── outcome === 'acquired': we own execution ─────────────────────────────
  const { redisKey, requestHash } = begin;
  try {
    const { httpStatus, body } = await handler();

    if (httpStatus >= 200 && httpStatus < 300) {
      // Cache successful responses so retries replay them.
      await finalizeIdempotentRequest({ redisKey, requestHash, httpStatus, body, store });
    } else {
      // Never cache non-2xx (4xx/5xx) — release the lock so retries can run.
      await releaseIdempotentRequest({ redisKey, store });
    }

    return sendResponse(reply, httpStatus, body);
  } catch (error) {
    // Thrown error → release the lock (do not cache failures) and re-throw so
    // the route's existing error handling produces the response.
    await releaseIdempotentRequest({ redisKey, store });
    throw error;
  }
}
