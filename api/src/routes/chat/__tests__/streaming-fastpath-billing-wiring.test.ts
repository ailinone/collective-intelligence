// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Source-level pins for the streaming fast-path wallet billing wiring.
 *
 * Why this exists
 * ───────────────
 * The single-model streaming fast-path of POST /v1/chat/completions is the
 * MOST COMMON billed surface of ailin-auto, yet it historically called
 * trackChatUsage with a modelsOverride that had no prompt/completion split
 * — aggregateTokenUsage produced 0/0, debitChatRequest charged $0 and the
 * wallet hold was released unbilled ("infinite balance" in streaming).
 *
 * Functional coverage of the tracker itself lives in
 * billing-usage-tracker-accounting.test.ts; these pins guard the ROUTE-side
 * wiring (string-grep style, mirroring auto-preset-billing.test.ts pins).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const code = readFileSync(fileURLToPath(new URL('../chat-routes.ts', import.meta.url)), 'utf8');

describe('streaming fast-path wallet billing wiring (source-level pins)', () => {
  it('captures the prompt/completion split from the streamed usage object', () => {
    expect(code).toContain('chunk.usage?.total_tokens');
    expect(code).toContain('chunk.usage?.prompt_tokens');
    expect(code).toContain('chunk.usage?.completion_tokens');
  });

  it('threads tokenUsageOverride (never an always-undefined literal) into the fast-path debit', () => {
    const callAt = code.indexOf("strategyOverride: 'single-streaming',");
    expect(callAt).toBeGreaterThan(-1);
    const block = code.slice(callAt, callAt + 900);
    expect(block).toContain('tokenUsageOverride:');
    expect(block).toContain('{ promptTokens, completionTokens }');
    // The call site must not short-circuit the split when totals exist:
    // the guard only skips the override when BOTH directions are zero.
    expect(block).toContain('promptTokens > 0 || completionTokens > 0');
  });

  it('every wallet debit surface settles the gate hold (holdId threading)', () => {
    // A hold left to TTL-expire eats available balance for minutes after
    // every billed request. Every debit surface must carry the reservation
    // forward: the fast-path trackChatUsage, the collective surgical debit
    // (via the threaded walletHoldId parameter — same one the ci#751 abort
    // release uses) and both processChatRequest call sites.
    const fastPath = code.slice(
      code.indexOf("strategyOverride: 'single-streaming',"),
      code.indexOf("strategyOverride: 'single-streaming',") + 900
    );
    expect(fastPath).toContain('holdId: walletHoldId,');
    // Collective surgical debit settles the SAME hold the abort path releases.
    const debitAt = code.indexOf('await debitChatRequest({');
    expect(debitAt).toBeGreaterThan(-1);
    const debitBlock = code.slice(debitAt, debitAt + 400);
    expect(debitBlock).toContain('holdId: walletHoldId,');
    // The POST handler threads the gate's hold into handleStreamingRequest
    // (ci#751 anchor) AND into the non-streaming processChatRequest.
    const threadAt = code.indexOf('walletGate.holdId');
    expect(threadAt).toBeGreaterThan(-1);
    expect(code.match(/walletHoldId: walletGate\.holdId,/g)?.length).toBe(1);
  });
});
