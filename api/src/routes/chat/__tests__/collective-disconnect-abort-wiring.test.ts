// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ci#751 — wiring contract for the client-disconnect abort on the collective
 * SSE path (chat-routes.ts) and the engine-side signal forwarding
 * (orchestration-engine.ts).
 *
 * Why string-grep wiring tests (established repo pattern — see
 * quality-multipass-stream-resilience-wiring.test.ts): the collective branch
 * of `POST /v1/chat/completions` sits behind the full auth/governance/wallet
 * preHandler chain of a 3.5k-line route module, so a functional route test
 * would need the whole app fixture; the regression mode here is silent
 * refactoring of the wiring (the exact failure mode that caused the bug —
 * the loop simply never had any disconnect handling at all). The functional
 * halves live in client-disconnect-guard.test.ts (detection) and
 * release-chat-hold.test.ts (hold release).
 *
 * The wiring being locked:
 *  1. chat-routes attaches attachClientDisconnectGuard on the collective branch
 *     and threads its signal as executeStream's 4th argument.
 *  2. The debit is SKIPPED when the guard fired (no execution, no usage, no
 *     debit — 2026-10-04 product decision) and releaseChatHold runs instead.
 *  3. The guard is disposed when the stream settles (no listener leak).
 *  4. The engine forwards the external signal into the SAME requestController
 *     the deadline drives (one cancellation channel), and removes the listener
 *     in the generator's finally.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const routesSrc = readFileSync(join(__dirname, '..', 'chat-routes.ts'), 'utf8');
const engineSrc = readFileSync(
  join(__dirname, '..', '..', '..', 'core', 'orchestration', 'orchestration-engine.ts'),
  'utf8'
);

describe('chat-routes: collective branch disconnect wiring (ci#751)', () => {
  it('attaches the disconnect guard on the collective branch before consuming the stream', () => {
    expect(routesSrc).toMatch(/attachClientDisconnectGuard\(request\.raw,\s*reply\.raw\)/);
    // The attach must live INSIDE the collective branch (after the
    // isCollectiveStrategyRequest gate), not on the shared handler path.
    const collectiveIdx = routesSrc.indexOf('if (isCollectiveStrategyRequest) {');
    const attachIdx = routesSrc.indexOf('attachClientDisconnectGuard(request.raw');
    expect(collectiveIdx).toBeGreaterThan(-1);
    expect(attachIdx).toBeGreaterThan(collectiveIdx);
  });

  it('threads the guard signal as executeStream’s external cancellation signal', () => {
    expect(routesSrc).toMatch(
      /orchestrationEngine\.executeStream\(\s*chatRequest,\s*organizationId,\s*userId,\s*disconnectGuard\.signal/
    );
  });

  it('skips the per-user debit when the client disconnected (no execution, no debit)', () => {
    // The abort branch must short-circuit BEFORE debitChatRequest and release
    // the pre-execution hold instead of letting it ride until its TTL.
    const abortIdx = routesSrc.indexOf("if (disconnectGuard.fired) {");
    const debitIdx = routesSrc.indexOf('await debitChatRequest({', abortIdx);
    const abortReturn = routesSrc.indexOf('await releaseChatHold({', abortIdx);
    expect(abortIdx).toBeGreaterThan(-1);
    expect(abortReturn).toBeGreaterThan(abortIdx);
    expect(debitIdx).toBeGreaterThan(abortReturn);
    expect(routesSrc).toMatch(/await releaseChatHold\(\{/);
    expect(routesSrc).toMatch(/holdId:\s*walletHoldId/);
    // The gate's hold id must be threaded from the POST handler into
    // handleStreamingRequest (it is not otherwise in scope on the streaming
    // path) — this exact threading is what makes the release possible.
    expect(routesSrc).toMatch(
      /billingOrganizationId,\s*\/\/ ci#751[\s\S]*?walletGate\.holdId\s*\n\s*\);/
    );
    expect(routesSrc).toMatch(/walletHoldId\?: string/);
  });

  it('disposes the guard when the stream settles (no raw-listener leak)', () => {
    expect(routesSrc).toMatch(/disconnectGuard\.dispose\(\)/);
  });

  it('does not write an SSE error frame into a dead socket after abort', () => {
    // Inside the catch: sendSSEError only when the guard has NOT fired.
    expect(routesSrc).toMatch(
      /if \(disconnectGuard\.fired\) \{[\s\S]*?Collective strategy stream aborted[\s\S]*?\} else \{[\s\S]*?sendSSEError\(reply/
    );
  });

  it('emits the structured abort event for observability (OPS-001 input)', () => {
    expect(routesSrc).toMatch(/collective_stream_client_abort/);
    expect(routesSrc).toMatch(/phase:\s*firstChunkAt \? 'mid_stream' : 'before_first_chunk'/);
    expect(routesSrc).toMatch(/durationMs:/);
  });
});

describe('orchestration-engine: externalSignal forwarding (ci#751)', () => {
  it('executeStream accepts an optional external cancellation signal', () => {
    expect(engineSrc).toMatch(/externalSignal\?: AbortSignal/);
  });

  it('feeds the external signal into the SAME requestController the deadline drives', () => {
    expect(engineSrc).toMatch(/externalAbortListener = \(\) => requestController\.abort\(\)/);
    expect(engineSrc).toMatch(
      /externalSignal\.addEventListener\('abort',\s*externalAbortListener, \{ once: true \}\)/
    );
    // An already-aborted external signal must abort immediately (race guard).
    expect(engineSrc).toMatch(/if \(externalSignal\.aborted\) \{\s*requestController\.abort\(\)/);
  });

  it('removes the abort listener in the generator’s finally (no cross-request leak)', () => {
    expect(engineSrc).toMatch(
      /externalSignal\.removeEventListener\('abort',\s*externalAbortListener\)/
    );
  });
});
