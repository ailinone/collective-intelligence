// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * client-disconnect-guard.ts — detects a client disconnect on the collective
 * SSE streaming path (ci#751) and turns it into an AbortSignal the
 * orchestration engine already understands.
 *
 * The bug: `POST /v1/chat/completions`'s collective branch (chat-routes.ts)
 * consumed `orchestrationEngine.executeStream()` with no listener on
 * `request.raw` close/aborted. A user closing the tab in the middle of a
 * ~150s consensus/expert-panel run let the FULL multi-model fan-out execute,
 * then wrote the stream into a dead socket — and `debitChatRequest` still
 * billed the user for usage of a response they never saw.
 *
 * Product decision (2026-10-04, fail-safe, revertible): on client disconnect,
 * ABORT the orchestration (pending fan-outs cancelled; in-flight provider
 * calls absorbed by the platform) and DO NOT debit the user — no complete
 * execution, no usage, no debit. The pre-execution wallet hold is RELEASED
 * (releaseChatHold) instead of being left reserved until its TTL.
 *
 * Event-source semantics (ci#751 follow-up, §24 prod evidence requestId
 * Da7JX49FSsUUkrcz7eEnU): the FIRST version of this guard listened on
 * `request.raw` 'close'/'aborted'. On modern Node (v24 in prod) the
 * IncomingMessage 'close' event fires when the request MESSAGE completes —
 * i.e. as soon as the body is consumed, before the SSE stream even starts,
 * and frequently BEFORE this guard attaches — and 'aborted' is deprecated
 * and never fires for a client that vanishes mid-response. Result: a client
 * killed mid-consensus produced NO event at all, the guard never fired, and
 * the full fan-out + debit ran anyway.
 *
 * The detection therefore hangs on `res` ('close' on the ServerResponse):
 * the response stream closes either after `res.end()` (normal completion —
 * `res.writableEnded` is true, discriminated below) or when the underlying
 * connection tears down prematurely (`res.writableEnded` is false — a real
 * client disconnect). `req.once('aborted')` is kept as belt-and-suspenders
 * (it only fires on genuine premature termination, so it cannot false-fire).
 * `req` 'close' is deliberately NOT listened to: since Node 16 it fires on
 * message completion, which is both too early (pre-attach) and a
 * false-positive risk mid-stream (the message is already complete while the
 * response is still being written).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ClientDisconnectGuard {
  /** Aborts exactly when a mid-response client disconnect is detected. */
  readonly signal: AbortSignal;
  /** True once a disconnect fired (checked by the caller to skip debit/error writes). */
  readonly fired: boolean;
  /** Detach the raw listeners — call when the stream settles. */
  dispose(): void;
}

export function attachClientDisconnectGuard(
  req: IncomingMessage,
  res: ServerResponse
): ClientDisconnectGuard {
  const controller = new AbortController();
  let fired = false;

  const onDisconnect = () => {
    // Normal completion path: the response already finished writing, so this
    // `close` is the ordinary end-of-response event, NOT a client disconnect.
    if (res.writableEnded || fired) return;
    fired = true;
    controller.abort();
  };

  // Primary detection: premature close of the response stream.
  res.once('close', onDisconnect);
  // Legacy premature-termination event; `once` + the `fired` flag make the
  // double registration idempotent.
  req.once('aborted', onDisconnect);

  return {
    signal: controller.signal,
    get fired() {
      return fired;
    },
    dispose() {
      res.removeListener('close', onDisconnect);
      req.removeListener('aborted', onDisconnect);
    },
  };
}
