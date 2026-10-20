// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#751 — client-disconnect guard on the collective SSE path (functional).
 *
 * The bug: the collective branch of `POST /v1/chat/completions` consumed
 * `orchestrationEngine.executeStream()` with NO listener on `request.raw`
 * close/aborted, so a user closing the tab mid-consensus let the full ~150s
 * fan-out run into a dead socket AND still got debited.
 *
 * attachClientDisconnectGuard is the detection half of the fix: it converts a
 * mid-response client disconnect into an AbortSignal the engine's own
 * cancellation channel understands.
 *
 * Note on event sources (why the guard listens on `res`, not `req`): since
 * Node 16, IncomingMessage 'close' fires when the request MESSAGE completes —
 * as soon as the body is consumed, before the SSE stream starts — so a
 * client vanishing mid-response emits NO request event at all (this exact
 * blindness shipped to prod; §24 evidence requestId Da7JX49FSsUUkrcz7eEnU).
 * The guard therefore detects via ServerResponse 'close', which fires
 * prematurely on a real disconnect (writableEnded === false) and after
 * res.end() on normal completion (writableEnded === true — discriminated).
 * These tests simulate request.raw with a real EventEmitter and reply.raw
 * with an EventEmitter carrying a writableEnded flag, the same shape the
 * real fastify objects present to the guard. The real-socket proof lives in
 * client-disconnect-guard.functional.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { attachClientDisconnectGuard } from '../client-disconnect-guard';
import type { IncomingMessage, ServerResponse } from 'node:http';

function makeRawPair(writableEnded = false): {
  req: IncomingMessage;
  res: ServerResponse;
} {
  const req = new EventEmitter() as IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    writableEnded,
  }) as ServerResponse;
  return { req, res };
}

describe('attachClientDisconnectGuard', () => {
  it('aborts the signal when the response closes mid-stream (the ci#751 bug scenario)', () => {
    const { req, res } = makeRawPair(false);
    const guard = attachClientDisconnectGuard(req, res);

    expect(guard.fired).toBe(false);
    expect(guard.signal.aborted).toBe(false);

    res.emit('close');

    expect(guard.fired).toBe(true);
    expect(guard.signal.aborted).toBe(true);
  });

  it('aborts on the legacy `aborted` request event too (belt-and-suspenders)', () => {
    const { req, res } = makeRawPair(false);
    const guard = attachClientDisconnectGuard(req, res);

    req.emit('aborted');

    expect(guard.fired).toBe(true);
    expect(guard.signal.aborted).toBe(true);
  });

  it('does NOT abort on response close after a normal completion (writableEnded) — no false positive', () => {
    const { req, res } = makeRawPair(true);
    const guard = attachClientDisconnectGuard(req, res);

    res.emit('close');

    expect(guard.fired).toBe(false);
    expect(guard.signal.aborted).toBe(false);
  });

  it('is idempotent: res close + req aborted double-fire aborts once', () => {
    const { req, res } = makeRawPair(false);
    const guard = attachClientDisconnectGuard(req, res);
    const spy = vi.fn();
    guard.signal.addEventListener('abort', spy);

    res.emit('close');
    req.emit('aborted');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('dispose() detaches the listeners — no abort after stream settled', () => {
    const { req, res } = makeRawPair(false);
    const guard = attachClientDisconnectGuard(req, res);
    guard.dispose();

    res.emit('close');
    req.emit('aborted');

    expect(guard.fired).toBe(false);
    expect(guard.signal.aborted).toBe(false);
    expect(res.listenerCount('close')).toBe(0);
    expect(req.listenerCount('aborted')).toBe(0);
  });

  it('the abort signal is the same object across calls (single cancellation channel)', () => {
    const { req, res } = makeRawPair(false);
    const guard = attachClientDisconnectGuard(req, res);
    const first = guard.signal;
    res.emit('close');
    expect(guard.signal).toBe(first);
  });

  it('ignores a request-message `close` — that event fires at body-consumption on modern Node, not on client death', () => {
    // Regression lock for the §24 prod blindness: emitting `close` on the
    // request (message-complete) must NOT abort a still-streaming response.
    const { req, res } = makeRawPair(false);
    const guard = attachClientDisconnectGuard(req, res);

    req.emit('close');

    expect(guard.fired).toBe(false);
    expect(guard.signal.aborted).toBe(false);
  });
});
