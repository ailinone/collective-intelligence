// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression test for a defect the hand-rolled fake-reply harness in
 * idempotency-middleware.test.ts CANNOT catch: a real `FastifyReply` is a
 * thenable (its own `.then()` resolves once `reply.raw.writableEnded` is
 * true). Every branch inside `withIdempotency` does `return sendResponse(...)`
 * inside an async function, so whatever a custom `sendResponse` returns gets
 * ADOPTED as the settlement of `withIdempotency`'s own promise. A
 * `sendResponse` override that only does raw WRITES (e.g. SSE `data:`
 * events) and defers `reply.raw.end()` to the caller deadlocks forever —
 * `await withIdempotency(...)` never resolves, because the thing it's
 * "waiting on" (the reply becoming sent) never happens until AFTER that
 * await returns. This can only be caught with a REAL Fastify instance,
 * since the fake reply in the sibling test file has no `.then()` at all.
 *
 * Found by adversarial review (2026-07-17) of the streaming file-generation
 * artifact redirect (chat-routes.ts) — its `sendResponse` originally did
 * only `reply.raw.write(...)` (via sendSSEChunk/sendSSEError) and called
 * `reply.raw.end()` in the CALLER, after `await withIdempotency(...)` — a
 * real request to that redirect hung forever on every non-throwing outcome
 * (success, replay, or a structured idempotency error).
 */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { withIdempotency, IDEMPOTENCY_REPLAYED_HEADER } from '../idempotency-middleware';
import { setupSSEHeaders, sendSSEChunk, sendSSEDone } from '@/utils/sse';
import type { IdempotencyStore } from '@/services/idempotency-service';

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

/** A minimal "raw write, then end" sendResponse — the CORRECT shape (mirrors
 * chat-routes.ts's fixed streaming redirect): must call `.raw.end()` itself
 * before returning, not leave it to the caller. */
function rawWriteAndEndSendResponse(reply: any, httpStatus: number, body: unknown) {
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
  reply.raw.write(`data: ${JSON.stringify({ httpStatus, body })}\n\n`);
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
  return reply;
}

/** The BROKEN shape the original defect had: raw write, but the caller (not
 * this closure) is responsible for `.raw.end()` — reproduced here only to
 * prove the harness itself can detect the hang; never shipped this way. */
function rawWriteNoEndSendResponse(reply: any, httpStatus: number, body: unknown) {
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
  reply.raw.write(`data: ${JSON.stringify({ httpStatus, body })}\n\n`);
  return reply;
}

async function buildApp(sendResponse: typeof rawWriteAndEndSendResponse, store: IdempotencyStore) {
  const app = Fastify();
  app.post('/test', async (request, reply) => {
    return withIdempotency({
      request,
      reply,
      organizationId: 'org-1',
      requestBody: { hello: 'world' },
      handler: async () => ({ httpStatus: 200, body: { ok: true } }),
      sendResponse,
      store,
    });
  });
  await app.ready();
  return app;
}

describe('withIdempotency + a real FastifyReply — sendResponse must end the stream itself', () => {
  it('a sendResponse that ends the raw stream itself completes promptly (the fixed shape)', async () => {
    const app = await buildApp(rawWriteAndEndSendResponse, new FakeStore());
    const response = await Promise.race([
      app.inject({ method: 'POST', url: '/test' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 4000)),
    ]);
    expect((response as { statusCode: number }).statusCode).toBe(200);
    await app.close();
  });

  it('a sendResponse that never ends the raw stream deadlocks — proves the harness would have caught the original defect', async () => {
    const app = await buildApp(rawWriteNoEndSendResponse, new FakeStore());
    await expect(
      Promise.race([
        app.inject({ method: 'POST', url: '/test' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 1500)),
      ]),
    ).rejects.toThrow('TIMEOUT');
    await app.close();
  });

  it('completes promptly on a REPLAYED response too (same key retried)', async () => {
    const store = new FakeStore();
    const app = await buildApp(rawWriteAndEndSendResponse, store);

    const first = await Promise.race([
      app.inject({ method: 'POST', url: '/test', headers: { 'idempotency-key': 'k1' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 4000)),
    ]);
    expect((first as { statusCode: number }).statusCode).toBe(200);

    const second = await Promise.race([
      app.inject({ method: 'POST', url: '/test', headers: { 'idempotency-key': 'k1' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 4000)),
    ]);
    expect((second as { statusCode: number }).statusCode).toBe(200);
    await app.close();
  });
});

// Regression for a SECOND real-Fastify-only defect found in the same
// re-verification round: setupSSEHeaders' `reply.raw.writeHead(...)` commits
// status+headers to the wire immediately. If it runs BEFORE withIdempotency,
// any `reply.header(...)` call withIdempotency makes internally (the
// Idempotency-Replayed marker on a replay; Retry-After on the fail-closed
// 503) only writes into Fastify's own header queue — which is flushed by
// Fastify's `reply.send()`, never called on this raw-write path — so it's
// silently dropped. Fixed two ways: (1) setupSSEHeaders now merges
// `reply.getHeaders()` so it picks up anything already queued, AND (2) the
// call moved from BEFORE withIdempotency to inside the `sendResponse`
// closure (which always runs AFTER any such reply.header() call).
describe('setupSSEHeaders + withIdempotency — queued Fastify headers must not be dropped', () => {
  it('Idempotency-Replayed survives when setupSSEHeaders runs inside sendResponse (the fixed call order)', async () => {
    const store = new FakeStore();
    const app = Fastify();
    app.post('/test', async (request, reply) => {
      return withIdempotency({
        request,
        reply,
        organizationId: 'org-1',
        requestBody: { hello: 'world' },
        handler: async () => ({ httpStatus: 200, body: { ok: true } }),
        store,
        sendResponse: (sseReply, httpStatus, body) => {
          setupSSEHeaders(sseReply); // called HERE, after any reply.header() withIdempotency already made
          sendSSEChunk(sseReply, body as never);
          sendSSEDone(sseReply);
          sseReply.raw.end();
          return sseReply;
        },
      });
    });
    await app.ready();

    await app.inject({ method: 'POST', url: '/test', headers: { 'idempotency-key': 'k-header-order' } });
    const replay = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'idempotency-key': 'k-header-order' },
    });

    expect(replay.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe('true');
    await app.close();
  });

  it('Idempotency-Replayed is dropped when setupSSEHeaders runs BEFORE withIdempotency (the original broken call order)', async () => {
    const store = new FakeStore();
    const app = Fastify();
    app.post('/test', async (request, reply) => {
      setupSSEHeaders(reply); // the ORIGINAL, broken order — headers committed too early
      return withIdempotency({
        request,
        reply,
        organizationId: 'org-1',
        requestBody: { hello: 'world' },
        handler: async () => ({ httpStatus: 200, body: { ok: true } }),
        store,
        sendResponse: (sseReply, httpStatus, body) => {
          sendSSEChunk(sseReply, body as never);
          sendSSEDone(sseReply);
          sseReply.raw.end();
          return sseReply;
        },
      });
    });
    await app.ready();

    await app.inject({ method: 'POST', url: '/test', headers: { 'idempotency-key': 'k-header-order-broken' } });
    const replay = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'idempotency-key': 'k-header-order-broken' },
    });

    // Proves the test harness genuinely detects the drop (not just the fix) —
    // this asserts the OLD, broken order really does lose the header.
    expect(replay.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    await app.close();
  });
});

// Regression for a THIRD real-Fastify-only defect, found re-verifying the
// header-merge fix above: moving setupSSEHeaders INSIDE sendResponse means
// headers can now be committed and THEN the closure can still throw (e.g. a
// pathological body failing JSON.stringify inside a chunk-send helper) —
// unlike before, when setupSSEHeaders ran exactly once, up front, so nothing
// could throw AFTER headers were sent. If the outer catch block
// unconditionally calls setupSSEHeaders again in that case, Node throws
// ERR_HTTP_HEADERS_SENT, which itself becomes an uncaught rejection that
// hangs the client instead of delivering a clean error. Fixed by guarding the
// catch block's setupSSEHeaders call on `!reply.raw.headersSent`.
describe('the outer catch must not re-commit headers sendResponse already sent', () => {
  function buildAppWithThrowingSend(guardHeadersSent: boolean) {
    const app = Fastify();
    // The unguarded (guardHeadersSent=false) shape deliberately re-throws
    // ERR_HTTP_HEADERS_SENT from inside its own catch block. Without this
    // handler, that rejection reaches Fastify's own default error handler,
    // which ALSO tries to write response headers and throws a SECOND
    // ERR_HTTP_HEADERS_SENT — one with no catcher anywhere, which surfaces
    // as an "Unhandled Rejection" that fails the whole test run regardless
    // of what this test itself asserts. This handler absorbs that second
    // throw without calling anything that could throw again; it must NOT
    // call reply.raw.end() itself, since the client-visible symptom this
    // test proves is that the response hangs once headers are double-sent.
    app.setErrorHandler((_err, _request, reply) => {
      if (reply.raw.headersSent) {
        return;
      }
      reply.raw.writeHead(500);
      reply.raw.end();
    });
    app.post('/test', async (request, reply) => {
      try {
        await withIdempotency({
          request,
          reply,
          organizationId: 'org-1',
          requestBody: { hello: 'world' },
          handler: async () => ({ httpStatus: 200, body: { ok: true } }),
          store: new FakeStore(),
          sendResponse: (sseReply: any) => {
            setupSSEHeaders(sseReply); // headers committed here...
            throw new Error('serialization boom'); // ...then this throws
          },
        });
      } catch {
        // Mirrors chat-routes.ts's fixed (guardHeadersSent=true) and
        // previously-broken (guardHeadersSent=false) catch block shape,
        // using the REAL setupSSEHeaders (not a manual writeHead) so this
        // matches the production code path exactly.
        if (!guardHeadersSent || !reply.raw.headersSent) {
          setupSSEHeaders(reply);
        }
        reply.raw.write('data: [ERROR]\n\n');
        reply.raw.end();
      }
    });
    return app;
  }

  it('completes promptly (no hang) when the catch block guards on headersSent (the fix)', async () => {
    const app = buildAppWithThrowingSend(true);
    await app.ready();
    const response = await Promise.race([
      app.inject({ method: 'POST', url: '/test' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 4000)),
    ]);
    expect((response as { statusCode: number }).statusCode).toBe(200);
    await app.close();
  });

  it('hangs when the catch block unconditionally re-commits headers (the pre-fix shape) — proves the harness catches it', async () => {
    const app = buildAppWithThrowingSend(false);
    await app.ready();
    await expect(
      Promise.race([
        app.inject({ method: 'POST', url: '/test' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 1500)),
      ]),
    ).rejects.toThrow();
    await app.close();
  });
});
