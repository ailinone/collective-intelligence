// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-hold-ttl.test.ts — ENT-002 Phase 1 subset (D4).
 *
 * Two guarantees, per phase-1-plan.md Track D:
 *  (a) a hold sized for the worst-case intent-family horizon does not expire
 *      mid-generation — the per-family TTL map is complete over the families,
 *      every value >= the 5-minute DEFAULT, and the wallet gate passes the
 *      family's TTL into the store's reserve;
 *  (b) restart fault injection: reserve → process restart (a FRESH
 *      PrepaidWallet instance over the SAME persisted store — what a deploy
 *      churn actually is, since the store lives in Postgres while the wallet
 *      is per-process) → TTL expiry → the release/settle path applies the
 *      charge EXACTLY ONCE, no double-charge (the settleHold no-op-settle
 *      invariant at prepaid-wallet.ts's settle semantics).
 *
 * Store note: the money-correctness under test lives in the BalanceStore PORT
 * (the documented atomicity contract), exercised here on InMemoryBalanceStore
 * — the same store the prepaid-wallet.test.ts suite uses. The Prisma store's
 * DB-level atomicity is covered by its own db-backed suite (Testcontainers;
 * not runnable in this environment — Docker unavailable — see the report).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest } from '@/types';

import {
  HOLD_TTL_MS_BY_FAMILY,
  holdTtlForRequest,
} from '@/services/strategy-hold-ttl';
import {
  DEFAULT_HOLD_TTL_MS,
  InMemoryBalanceStore,
  PrepaidWallet,
  type BalanceStore,
} from '@/services/prepaid-wallet';
import type { StrategyFamily } from '@/services/strategy-family';

const ORG = 'org-hold-ttl';

/** Holder the mocked Prisma store hands back — swapped per test (house pattern). */
const hoisted = vi.hoisted(() => ({ store: null as BalanceStore | null }));

vi.mock('@/services/prepaid-wallet-prisma-store', () => ({
  // A constructor that returns our in-memory store instead of touching Postgres.
  PrismaBalanceStore: class {
    constructor() {
      return hoisted.store as never;
    }
  },
}));

afterEach(() => {
  hoisted.store = null;
});

beforeEach(() => {
  delete process.env.PREPAID_WALLET_GATE_ENABLED;
});

// ── (a) TTL sizing ──────────────────────────────────────────────────────────
describe('(a) per-family hold TTL sizing', () => {
  it('covers ALL 8 strategy families', () => {
    const families: StrategyFamily[] = [
      'auto',
      'best',
      'fast',
      'economy',
      'single',
      'parallel',
      'consensus',
      'expert-panel',
    ];
    for (const family of families) {
      expect(HOLD_TTL_MS_BY_FAMILY[family], family).toBeGreaterThan(0);
    }
  });

  it('never SHORTENS the default: every family TTL >= DEFAULT_HOLD_TTL_MS', () => {
    for (const [, ttlMs] of Object.entries(HOLD_TTL_MS_BY_FAMILY)) {
      expect(ttlMs).toBeGreaterThanOrEqual(DEFAULT_HOLD_TTL_MS);
    }
  });

  it('sizes the deliberation-heavy families above the solo ones', () => {
    expect(HOLD_TTL_MS_BY_FAMILY.best).toBeGreaterThan(HOLD_TTL_MS_BY_FAMILY.fast);
    expect(HOLD_TTL_MS_BY_FAMILY.auto).toBeGreaterThanOrEqual(HOLD_TTL_MS_BY_FAMILY.single);
  });

  it('composite requests get their family horizon; non-family requests keep the DEFAULT', () => {
    const composite = { ailin_tier: 'medium', ailin_alias: 'best:medium' };
    expect(holdTtlForRequest(composite)).toBe(HOLD_TTL_MS_BY_FAMILY.best);

    // Everything the policy gate passes through also skips TTL sizing:
    expect(holdTtlForRequest({ ailin_alias: 'ailin-best' })).toBeUndefined();
    expect(holdTtlForRequest({ model: 'gpt-4o-mini' })).toBeUndefined();
    expect(holdTtlForRequest({})).toBeUndefined();
  });

  it('a hold sized for the family horizon outlives the worst-case generation window', async () => {
    // The guarantee that matters: a `best` (quality-multipass) execution that
    // legitimately runs for MINUTES must not have its hold expire underneath
    // it. Simulate the worst documented single-generation wall clock
    // (~50s for one media generation, multi-pass text above that) against a
    // real hold: reserve with the family TTL, advance past the whole window,
    // and verify the reservation is STILL subtracted from available.
    vi.useFakeTimers();
    try {
      const store = new InMemoryBalanceStore({ [ORG]: 100 });
      const wallet = new PrepaidWallet(store);
      const ttlMs = HOLD_TTL_MS_BY_FAMILY.best;

      const gate = await wallet.reserve(ORG, 'hold_best', 1, { ttlMs });
      expect(gate.allowed).toBe(true);

      vi.advanceTimersByTime(DEFAULT_HOLD_TTL_MS + 60_000); // default expired LONG ago
      // Still within the family horizon → the hold is still active.
      const availableMidGeneration = await wallet.getAvailableUsd(ORG);
      expect(availableMidGeneration).toBe(99); // 100 − 1 hold still reserved

      // Settle at the end of a generation that outlived the DEFAULT TTL:
      // applied exactly once, on the still-live hold.
      const balance = await wallet.settle(ORG, 'hold_best', 0.4);
      expect(balance).toBe(99.6);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── (a-wiring) the wallet gate passes the family TTL into the reserve ───────
describe('(a-wiring) gateChatRequest reserves with the family TTL', () => {
  it('reserves a composite request with its family TTL and a non-tiered request with none', async () => {
    // A REAL store, with reserveHold wrapped in a capture spy — full
    // BalanceStore compliance without hand-rolling the interface.
    const inner = new InMemoryBalanceStore({ [ORG]: 100 });
    const captured: Array<{ holdId: string; amountUsd: number; ttlMs?: number }> = [];
    const spyStore: BalanceStore = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
      reserveHold: async (
        org: string,
        holdId: string,
        amountUsd: number,
        opts?: { ttlMs?: number }
      ) => {
        captured.push({ holdId, amountUsd, ttlMs: opts?.ttlMs });
        return inner.reserveHold(org, holdId, amountUsd, opts);
      },
    });
    hoisted.store = spyStore;

    vi.resetModules();
    vi.stubEnv('PREPAID_WALLET_GATE_ENABLED', 'true');
    try {
      const gate = await import('@/services/prepaid-wallet-gate');

      const composite: ChatRequest = {
        messages: [{ role: 'user', content: 'hello world '.repeat(20) }],
        max_tokens: 256,
        model: 'auto',
        ailin_alias: 'best:medium',
        ailin_tier: 'medium',
        ailin_tier_rate: { inputPer1MUsd: 2, outputPer1MUsd: 8 },
      } as ChatRequest;

      const result = await gate.gateChatRequest(ORG, composite);
      expect(result.allowed).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0].ttlMs).toBe(HOLD_TTL_MS_BY_FAMILY.best);

      // Non-composite request: no reserve at all (the gate is a no-op).
      captured.length = 0;
      const plain: ChatRequest = {
        messages: [{ role: 'user', content: 'hi' }],
        model: 'auto',
        ailin_alias: 'ailin-best',
      } as ChatRequest;
      const plainResult = await gate.gateChatRequest(ORG, plain);
      expect(plainResult.allowed).toBe(true);
      expect(captured).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

// ── (b) restart fault injection: reserve → restart → TTL expiry → settle ────
describe('(b) CI-restart-mid-stream fault injection (no double-charge)', () => {
  it('TTL-expired hold: settle applies the charge EXACTLY ONCE; replay is a no-op', async () => {
    // One PERSISTED store (models the Postgres state that survives deploys).
    const persistedStore = new InMemoryBalanceStore({ [ORG]: 10 });
    const walletBeforeRestart = new PrepaidWallet(persistedStore);

    // 1. RESERVE the worst case with a SHORT ttl so expiry is reachable in
    //    test time (production ttlMs comes from strategy-hold-ttl; the
    //    expiry mechanics are identical).
    const gate = await walletBeforeRestart.reserve(ORG, 'hold_restart', 5, { ttlMs: 5 });
    expect(gate.allowed).toBe(true);
    expect(await walletBeforeRestart.getAvailableUsd(ORG)).toBe(5); // 10 − 5 held

    // 2. PROCESS RESTART: the in-flight request dies mid-generation; a fresh
    //    wallet instance mounts over the SAME persisted store.
    const walletAfterRestart = new PrepaidWallet(persistedStore);

    // 3. TTL EXPIRY: the hold self-expires (lazy, on read) — reserved spend
    //    is freed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await walletAfterRestart.getAvailableUsd(ORG)).toBe(10);

    // 4. The orphaned request's settle path still runs (retry/outbox): the
    //    ACTUAL charge (0.5, less than the 5 held) must apply EXACTLY ONCE.
    const balanceAfterFirstSettle = await walletAfterRestart.settle(ORG, 'hold_restart', 0.5, 'req-1');
    expect(balanceAfterFirstSettle).toBe(9.5); // 10 − 0.5, charged once

    // 5. NO DOUBLE-CHARGE: a retried settle (crash between settle and ack,
    //    or the outbox redelivering) is the documented no-op — same balance.
    const balanceAfterReplay = await walletAfterRestart.settle(ORG, 'hold_restart', 0.5, 'req-1');
    expect(balanceAfterReplay).toBe(9.5);
    expect(await persistedStore.getBalanceUsd(ORG)).toBe(9.5);
  });

  it('TTL-expired hold: the release path is safe and charges nothing', async () => {
    const persistedStore = new InMemoryBalanceStore({ [ORG]: 10 });
    const before = new PrepaidWallet(persistedStore);
    const gate = await before.reserve(ORG, 'hold_release', 4, { ttlMs: 5 });
    expect(gate.allowed).toBe(true);

    const after = new PrepaidWallet(persistedStore); // restart
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The failure path (request failed before spending) releases — a no-op
    // against an expired hold, and the balance never moves.
    await after.release(ORG, 'hold_release');
    expect(await persistedStore.getBalanceUsd(ORG)).toBe(10);
    expect(await after.getAvailableUsd(ORG)).toBe(10);
  });

  it('restart WITHOUT TTL expiry: the fresh wallet still sees and settles the live hold', async () => {
    const persistedStore = new InMemoryBalanceStore({ [ORG]: 10 });
    const before = new PrepaidWallet(persistedStore);
    const ttlMs = HOLD_TTL_MS_BY_FAMILY.single; // the family-sized horizon
    const gate = await before.reserve(ORG, 'hold_live', 4, { ttlMs });
    expect(gate.allowed).toBe(true);

    // Deploy churn: fresh wallet, hold still live (well inside its TTL).
    const after = new PrepaidWallet(persistedStore);
    expect(await after.getAvailableUsd(ORG)).toBe(6); // 10 − 4 still held

    // Settlement on the new instance charges exactly once.
    const balance = await after.settle(ORG, 'hold_live', 1.25, 'req-2');
    expect(balance).toBe(8.75);
    const replay = await after.settle(ORG, 'hold_live', 1.25, 'req-2');
    expect(replay).toBe(8.75);
  });
});
