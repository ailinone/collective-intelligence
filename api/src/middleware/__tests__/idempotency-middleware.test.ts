// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for the idempotency route helper (`withIdempotency`) — the
 * Fastify-facing wrapper used by `POST /v1/chat/completions` and
 * `POST /v1/responses`.
 *
 * Verifies the end-to-end route behavior against a fake reply + fake store:
 *   - passthrough (no header) runs the handler unchanged;
 *   - streaming bypass runs the handler and never touches the store;
 *   - first call runs the handler; identical retry REPLAYS with
 *     `Idempotency-Replayed: true` and the handler is NOT re-invoked;
 *   - same key + different body → 409 idempotency_key_reuse;
 *   - concurrent in-flight → 409 idempotency_in_progress;
 *   - a 5xx response is NOT cached (retry re-runs the handler);
 *   - over-long key → 400 idempotency_key_invalid;
 *   - store failure fails CLOSED (503, handler NOT run) so a billable request is
 *     never executed without idempotency protection during a Redis outage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  withIdempotency,
  IDEMPOTENCY_REPLAYED_HEADER,
  IDEMPOTENCY_STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from '../idempotency-middleware';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type IdempotencyStore,
} from '@/services/idempotency-service';

class FakeStore implements IdempotencyStore {
  public data = new Map<string, string>();

  async setNx(key: string, value: string): Promise<boolean> {
    if (this.data.has(key)) return false;
    this.data.set(key, value);
    return true;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
}

interface CapturedReply {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

function makeReply(): { reply: FastifyReply; captured: CapturedReply } {
  const captured: CapturedReply = { headers: {} };
  const reply = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    header(name: string, value: string) {
      captured.headers[name] = value;
      return this;
    },
    send(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, captured };
}

function makeRequest(headers: Record<string, string | string[]> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

const ORG = 'org-1';
const BODY = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };

describe('withIdempotency — passthrough', () => {
  it('runs the handler unchanged when no Idempotency-Key is present', async () => {
    const { reply, captured } = makeReply();
    const handler = vi.fn().mockResolvedValue({ httpStatus: 200, body: { ok: true } });
    const store = new FakeStore();

    await withIdempotency({
      request: makeRequest(),
      reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler,
      store,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ ok: true });
    expect(store.data.size).toBe(0); // store untouched on passthrough
  });

  it('treats a blank Idempotency-Key as passthrough', async () => {
    const { captured } = makeReply();
    const handler = vi.fn().mockResolvedValue({ httpStatus: 200, body: { ok: true } });
    const store = new FakeStore();
    const { reply } = makeReply();

    await withIdempotency({
      request: makeRequest({ 'idempotency-key': '   ' }),
      reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler,
      store,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.data.size).toBe(0);
  });
});

describe('withIdempotency — streaming bypass', () => {
  it('runs the handler and never touches the store for streaming requests', async () => {
    const { reply, captured } = makeReply();
    const handler = vi.fn().mockResolvedValue({ httpStatus: 200, body: { stream: true } });
    const store = new FakeStore();

    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k1' }),
      reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: true,
      handler,
      store,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(captured.status).toBe(200);
    expect(store.data.size).toBe(0);
  });
});

// Added 2026-07-17 for the streaming file-generation artifact redirect: a
// caller whose client is an SSE connection must NOT get a plain JSON
// `reply.send()` — every existing caller keeps that behavior via the
// default, but a caller can override how the final `{httpStatus, body}` is
// delivered.
describe('withIdempotency — sendResponse override', () => {
  it('uses the custom sendResponse instead of a plain reply.send() on the passthrough path', async () => {
    const { reply, captured } = makeReply();
    const handler = vi.fn().mockResolvedValue({ httpStatus: 200, body: { ok: true } });
    const sendResponse = vi.fn((r: FastifyReply, status: number, body: unknown) => {
      captured.status = status;
      captured.body = { sse: true, wrapped: body };
      return r;
    });

    await withIdempotency({
      request: makeRequest(),
      reply,
      organizationId: ORG,
      requestBody: BODY,
      handler,
      sendResponse,
    });

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(reply, 200, { ok: true });
    expect(captured.body).toEqual({ sse: true, wrapped: { ok: true } });
  });

  it('uses the custom sendResponse on the isStreaming-bypass path (the actual redirect use case)', async () => {
    const { reply, captured } = makeReply();
    const handler = vi.fn().mockResolvedValue({ httpStatus: 200, body: { artifact: 'pdf' } });
    const sendResponse = vi.fn((r: FastifyReply, status: number, body: unknown) => {
      captured.status = status;
      captured.body = { sse: true, wrapped: body };
      return r;
    });

    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-stream' }),
      reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: true,
      handler,
      sendResponse,
    });

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(reply, 200, { artifact: 'pdf' });
  });

  it('defaults to a plain reply.status().send() when sendResponse is omitted (every pre-existing caller)', async () => {
    const { reply, captured } = makeReply();
    const handler = vi.fn().mockResolvedValue({ httpStatus: 200, body: { ok: true } });

    await withIdempotency({
      request: makeRequest(),
      reply,
      organizationId: ORG,
      requestBody: BODY,
      handler,
    });

    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ ok: true });
  });
});

describe('withIdempotency — replay', () => {
  it('replays the cached response with Idempotency-Replayed and skips re-execution', async () => {
    const store = new FakeStore();
    const responseBody = { id: 'cmpl-1', text: 'hello' };

    const first = makeReply();
    const handler1 = vi.fn().mockResolvedValue({ httpStatus: 200, body: responseBody });
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-replay' }),
      reply: first.reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler: handler1,
      store,
    });
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(first.captured.body).toEqual(responseBody);
    expect(first.captured.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();

    // Identical retry → replay, handler NOT called.
    const second = makeReply();
    const handler2 = vi.fn().mockResolvedValue({ httpStatus: 200, body: { should: 'not-run' } });
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-replay' }),
      reply: second.reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler: handler2,
      store,
    });

    expect(handler2).not.toHaveBeenCalled();
    expect(second.captured.status).toBe(200);
    expect(second.captured.body).toEqual(responseBody);
    expect(second.captured.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
  });

  // Added 2026-07-17 for the streaming file-generation artifact redirect: it
  // does NOT pass isStreaming (its response is one complete ChatResponse,
  // exactly as cacheable/replayable as any non-streaming response), relying
  // on a REPLAYED result also being routed through a custom sendResponse so
  // it can be re-framed as SSE — not just the fresh-execution path.
  it('routes a REPLAYED response through a custom sendResponse too, not just the fresh-execution path', async () => {
    const store = new FakeStore();
    const responseBody = { id: 'cmpl-1', artifact: 'pdf' };
    const sends: Array<{ status: number; body: unknown }> = [];
    const sendResponse = (r: FastifyReply, status: number, body: unknown) => {
      sends.push({ status, body });
      return r;
    };

    const first = makeReply();
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-replay-sse' }),
      reply: first.reply,
      organizationId: ORG,
      requestBody: BODY,
      handler: vi.fn().mockResolvedValue({ httpStatus: 200, body: responseBody }),
      sendResponse,
      store,
    });

    const second = makeReply();
    const handler2 = vi.fn().mockResolvedValue({ httpStatus: 200, body: { should: 'not-run' } });
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-replay-sse' }),
      reply: second.reply,
      organizationId: ORG,
      requestBody: BODY,
      handler: handler2,
      sendResponse,
      store,
    });

    expect(handler2).not.toHaveBeenCalled();
    expect(sends).toHaveLength(2);
    expect(sends[0]).toEqual({ status: 200, body: responseBody });
    expect(sends[1]).toEqual({ status: 200, body: responseBody });
  });

  // Added 2026-07-17: confirms the streaming redirect's actual configuration
  // (no isStreaming flag) genuinely gets full dedup — a same-key retry must
  // NOT re-invoke a billable handler, closing the double-billing gap an
  // earlier draft (isStreaming: true) had.
  it('a request WITHOUT isStreaming set gets full dedup protection (the fix for the streaming redirect double-billing gap)', async () => {
    const store = new FakeStore();
    const billingSpy = vi.fn();
    const handler = vi.fn(async () => {
      billingSpy();
      return { httpStatus: 200, body: { artifact: 'pdf' } };
    });

    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-dedup' }),
      reply: makeReply().reply,
      organizationId: ORG,
      requestBody: BODY,
      handler,
      store,
    });
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-dedup' }),
      reply: makeReply().reply,
      organizationId: ORG,
      requestBody: BODY,
      handler,
      store,
    });

    expect(billingSpy).toHaveBeenCalledTimes(1);
  });
});

describe('withIdempotency — 409 conflicts', () => {
  it('returns 409 idempotency_key_reuse for the same key with a different body', async () => {
    const store = new FakeStore();
    const first = makeReply();
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-reuse' }),
      reply: first.reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler: vi.fn().mockResolvedValue({ httpStatus: 200, body: { ok: true } }),
      store,
    });

    const second = makeReply();
    const handler2 = vi.fn();
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-reuse' }),
      reply: second.reply,
      organizationId: ORG,
      requestBody: { ...BODY, model: 'gpt-4o' },
      isStreaming: false,
      handler: handler2,
      store,
    });

    expect(handler2).not.toHaveBeenCalled();
    expect(second.captured.status).toBe(409);
    expect((second.captured.body as { error: { code: string } }).error.code).toBe(
      'idempotency_key_reuse'
    );
  });

  it('returns 409 idempotency_in_progress for a concurrent in-flight request', async () => {
    const store = new FakeStore();

    // First request blocks: handler never resolves (simulates in-flight).
    let resolveFirst!: () => void;
    const firstHandler = vi.fn().mockReturnValue(
      new Promise<{ httpStatus: number; body: unknown }>((resolve) => {
        resolveFirst = () => resolve({ httpStatus: 200, body: { ok: true } });
      })
    );
    const first = makeReply();
    const firstPromise = withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-inflight' }),
      reply: first.reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler: firstHandler,
      store,
    });

    // Second concurrent request with the same key → in_progress.
    const second = makeReply();
    const handler2 = vi.fn();
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-inflight' }),
      reply: second.reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler: handler2,
      store,
    });

    expect(handler2).not.toHaveBeenCalled();
    expect(second.captured.status).toBe(409);
    expect((second.captured.body as { error: { code: string } }).error.code).toBe(
      'idempotency_in_progress'
    );

    // Let the first finish so no dangling promise.
    resolveFirst();
    await firstPromise;
  });
});

describe('withIdempotency — non-2xx is not cached', () => {
  it('does NOT cache a 5xx; a retry re-runs the handler', async () => {
    const store = new FakeStore();

    const first = makeReply();
    const handler1 = vi
      .fn()
      .mockResolvedValue({ httpStatus: 500, body: { error: { code: 'internal_error' } } });
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-5xx' }),
      reply: first.reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler: handler1,
      store,
    });
    expect(first.captured.status).toBe(500);
    expect(store.data.size).toBe(0); // lock released, nothing cached

    // Retry succeeds and IS cached.
    const second = makeReply();
    const handler2 = vi.fn().mockResolvedValue({ httpStatus: 200, body: { ok: true } });
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-5xx' }),
      reply: second.reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler: handler2,
      store,
    });
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(second.captured.status).toBe(200);
  });

  it('releases the lock and re-throws when the handler throws', async () => {
    const store = new FakeStore();
    const { reply } = makeReply();
    const boom = new Error('boom');

    await expect(
      withIdempotency({
        request: makeRequest({ 'idempotency-key': 'k-throw' }),
        reply,
        organizationId: ORG,
        requestBody: BODY,
        isStreaming: false,
        handler: vi.fn().mockRejectedValue(boom),
        store,
      })
    ).rejects.toThrow('boom');

    expect(store.data.size).toBe(0); // lock released after throw
  });
});

describe('withIdempotency — validation & resilience', () => {
  it('returns 400 idempotency_key_invalid for an over-long key', async () => {
    const { reply, captured } = makeReply();
    const handler = vi.fn();
    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1) }),
      reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler,
      store: new FakeStore(),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(captured.status).toBe(400);
    expect((captured.body as { error: { code: string } }).error.code).toBe(
      'idempotency_key_invalid'
    );
  });

  it('fails CLOSED (503, handler NOT run) when the store SET NX throws', async () => {
    const { reply, captured } = makeReply();
    const handler = vi.fn().mockResolvedValue({ httpStatus: 200, body: { ok: true } });
    const brokenStore: IdempotencyStore = {
      setNx: vi.fn().mockRejectedValue(new Error('redis down')),
      set: vi.fn(),
      get: vi.fn(),
      del: vi.fn(),
    };

    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-broken' }),
      reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler,
      store: brokenStore,
    });

    // Money-path safety: the billable handler must NOT run when we cannot
    // de-duplicate — otherwise a retry during the outage could double-charge.
    expect(handler).not.toHaveBeenCalled();
    expect(captured.status).toBe(503);
    expect((captured.body as { error: { code: string } }).error.code).toBe(
      'idempotency_store_unavailable'
    );
    expect(captured.headers['Retry-After']).toBe(
      String(IDEMPOTENCY_STORE_UNAVAILABLE_RETRY_AFTER_SECONDS)
    );
  });

  it('fails CLOSED when the store GET throws after a lost SET NX race', async () => {
    const { reply, captured } = makeReply();
    const handler = vi.fn().mockResolvedValue({ httpStatus: 200, body: { ok: true } });
    // SET NX reports "not acquired" (someone else holds it) then the follow-up
    // GET blows up — the store is still unreachable, so we must fail closed.
    const brokenStore: IdempotencyStore = {
      setNx: vi.fn().mockResolvedValue(false),
      set: vi.fn(),
      get: vi.fn().mockRejectedValue(new Error('redis down')),
      del: vi.fn(),
    };

    await withIdempotency({
      request: makeRequest({ 'idempotency-key': 'k-broken-get' }),
      reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler,
      store: brokenStore,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(captured.status).toBe(503);
    expect((captured.body as { error: { code: string } }).error.code).toBe(
      'idempotency_store_unavailable'
    );
  });

  it('honors the x-idempotency-key alias header', async () => {
    const store = new FakeStore();
    const first = makeReply();
    await withIdempotency({
      request: makeRequest({ 'x-idempotency-key': 'k-alias' }),
      reply: first.reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler: vi.fn().mockResolvedValue({ httpStatus: 200, body: { v: 1 } }),
      store,
    });

    const second = makeReply();
    const handler2 = vi.fn();
    await withIdempotency({
      request: makeRequest({ 'x-idempotency-key': 'k-alias' }),
      reply: second.reply,
      organizationId: ORG,
      requestBody: BODY,
      isStreaming: false,
      handler: handler2,
      store,
    });
    expect(handler2).not.toHaveBeenCalled();
    expect(second.captured.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
  });
});
