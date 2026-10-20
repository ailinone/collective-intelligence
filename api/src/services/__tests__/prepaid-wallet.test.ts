// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it, vi } from 'vitest';
import {
  estimateMaxChargeUsd,
  evaluateSpendGate,
  InMemoryBalanceStore,
  PrepaidWallet,
  type BalanceStore,
  type CreditMemo,
  type DebitResult,
  type ExpirySweepResult,
  type FailedDebitRecord,
  type GrantResult,
  type ReserveOptions,
  type ReserveResult,
} from '@/services/prepaid-wallet';

describe('prepaid-wallet', () => {
  it('rejects when the worst-case charge would breach the floor', () => {
    const d = evaluateSpendGate(0.5, 0.8);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('insufficient_funds');
  });

  it('allows when the balance covers the worst-case charge', () => {
    expect(evaluateSpendGate(1.0, 0.8).allowed).toBe(true);
  });

  it('honours a non-zero minimum-balance floor', () => {
    expect(evaluateSpendGate(1.0, 0.8, { minBalanceUsd: 0.5 }).allowed).toBe(false);
    expect(evaluateSpendGate(2.0, 0.8, { minBalanceUsd: 0.5 }).allowed).toBe(true);
  });

  it('estimates the hold from prompt + max output at the tier rate', () => {
    // large tier $5/$21 · 100k prompt + 50k max output = 0.5 + 1.05 = $1.55.
    expect(estimateMaxChargeUsd(5, 21, 100_000, 50_000)).toBeCloseTo(1.55, 6);
  });

  it('gate → debit actual leaves margin: hold ≥ real charge', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org_1: 2.0 }));
    const hold = estimateMaxChargeUsd(5, 21, 100_000, 50_000); // $1.55 worst case.
    const gate = await wallet.checkGate('org_1', hold);
    expect(gate.allowed).toBe(true);

    // The model actually emitted only 20k tokens → real charge $0.5 + $0.42 = $0.92.
    const real = estimateMaxChargeUsd(5, 21, 100_000, 20_000);
    const after = await wallet.debit('org_1', real, 'req_abc');
    expect(after).toBeCloseTo(2.0 - 0.92, 6);
    expect(real).toBeLessThan(hold); // never charged more than was held.
  });

  it('top-up credits and rejects non-positive amounts', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore());
    expect(await wallet.topUp('org_2', 10)).toBe(10);
    expect(await wallet.topUp('org_2', 5.25)).toBeCloseTo(15.25, 6);
    await expect(wallet.topUp('org_2', 0)).rejects.toThrow();
    await expect(wallet.topUp('org_2', -1)).rejects.toThrow();
  });

  it('a zero-cost debit is a no-op (does not write)', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org_3: 3 }));
    expect(await wallet.debit('org_3', 0)).toBe(3);
  });
});

// ── DI-01: idempotent debit (a retried debit double-charges without this) ────────────
describe('prepaid-wallet · idempotent debit (DI-01)', () => {
  it('applying the same idempotency key twice charges exactly once', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 10 }));

    const first = await wallet.debit('org', 2.5, 'req_1');
    expect(first).toBeCloseTo(7.5, 6);

    // Retry with the SAME request id: no additional money moves.
    const replay = await wallet.debit('org', 2.5, 'req_1');
    expect(replay).toBeCloseTo(7.5, 6);
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(7.5, 6);

    // A different key on the same org still charges.
    const second = await wallet.debit('org', 1, 'req_2');
    expect(second).toBeCloseTo(6.5, 6);
  });

  it('races on the same key resolve to a single charge', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 5 }));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => wallet.debit('org', 1, 'req_dup'))
    );
    // Every caller sees the post-charge balance; the balance dropped by exactly $1.
    for (const r of results) expect(r).toBeCloseTo(4, 6);
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(4, 6);
  });

  it('an explicit idempotencyKey overrides the requestId', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 5 }));
    await wallet.debit('org', 1, 'req_a', 'idem_shared');
    await wallet.debit('org', 1, 'req_b', 'idem_shared'); // same idem key → no re-charge
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(4, 6);
  });
});

// ── Idempotent top-up: a retried top-up double-credits without this ──────────────────
describe('prepaid-wallet · idempotent top-up', () => {
  it('applying the same reference twice credits exactly once', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore());

    const first = await wallet.topUp('org', 10, 'ref_1');
    expect(first).toBeCloseTo(10, 6);

    // Retry with the SAME reference: no additional money moves; the replay
    // returns the balance current at the original apply (applyDebit semantics).
    const replay = await wallet.topUp('org', 10, 'ref_1');
    expect(replay).toBeCloseTo(10, 6);
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(10, 6);

    // A different reference still credits.
    const second = await wallet.topUp('org', 5.25, 'ref_2');
    expect(second).toBeCloseTo(15.25, 6);
  });

  it('races on the same reference resolve to a single credit', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore());
    const results = await Promise.all(
      Array.from({ length: 8 }, () => wallet.topUp('org', 0.01, 'ref_dup'))
    );
    for (const r of results) expect(r).toBeCloseTo(0.01, 6);
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(0.01, 6);
  });

  it('a top-up without a reference stays non-idempotent (legacy adjust)', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore());
    expect(await wallet.topUp('org', 10)).toBeCloseTo(10, 6);
    expect(await wallet.topUp('org', 10)).toBeCloseTo(20, 6); // no reference → credits again
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(20, 6);
  });

  it('a debit and a top-up sharing the raw key do not collide', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 10 }));

    // Top-up keys are namespaced (`topup:<ref>`), so a debit on the same raw
    // key is a DIFFERENT ledger key: both money movements apply.
    await wallet.topUp('org', 4, 'shared_key');
    await wallet.debit('org', 1, 'shared_key');
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(13, 6);

    // And neither replays: the top-up does not re-credit, the debit not re-charge.
    await wallet.topUp('org', 4, 'shared_key');
    await wallet.debit('org', 1, 'shared_key');
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(13, 6);
  });
});

// ── DI-02: persisted holds prevent concurrent oversell ───────────────────────────────
describe('prepaid-wallet · persisted holds (DI-02)', () => {
  it('an active hold reduces the spendable (available) balance', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 2 }));
    expect(await wallet.getAvailableUsd('org')).toBeCloseTo(2, 6);

    const r = await wallet.reserve('org', 'hold_1', 1.55);
    expect(r.allowed).toBe(true);
    expect(await wallet.getAvailableUsd('org')).toBeCloseTo(0.45, 6);
    // Raw ledger balance is untouched until the debit/settle.
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(2, 6);

    // A second gate now sees the reservation and cannot reserve another $1.55.
    const gate2 = await wallet.checkGate('org', 1.55);
    expect(gate2.allowed).toBe(false);
  });

  it('concurrent reservations cannot oversell the last dollar', async () => {
    const store = new InMemoryBalanceStore({ org: 1.0 });
    const wallet = new PrepaidWallet(store);

    // Five requests race to reserve $0.40 each against a $1.00 balance.
    const decisions = await Promise.all(
      Array.from({ length: 5 }, (_, i) => wallet.reserve('org', `hold_${i}`, 0.4))
    );

    const allowed = decisions.filter((d) => d.allowed).length;
    expect(allowed).toBe(2); // 2 × $0.40 = $0.80 ≤ $1.00; a 3rd would be $1.20.
    // Spendable balance never went negative.
    const available = await wallet.getAvailableUsd('org');
    expect(available).toBeGreaterThanOrEqual(0);
    expect(available).toBeCloseTo(0.2, 6);
  });

  it('settle applies the actual charge and releases the remainder', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 2.0 }));
    const hold = estimateMaxChargeUsd(5, 21, 100_000, 50_000); // $1.55
    const gate = await wallet.reserve('org', 'hold_x', hold);
    expect(gate.allowed).toBe(true);
    expect(await wallet.getAvailableUsd('org')).toBeCloseTo(0.45, 6);

    // Real charge $0.92 → settle: ledger drops to 1.08 and the $1.55 hold is freed.
    const balance = await wallet.settle('org', 'hold_x', 0.92, 'req_x');
    expect(balance).toBeCloseTo(1.08, 6);
    expect(await wallet.getAvailableUsd('org')).toBeCloseTo(1.08, 6);
  });

  it('re-settling the same hold does not double-charge', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 2.0 }));
    await wallet.reserve('org', 'hold_y', 1.55);
    const first = await wallet.settle('org', 'hold_y', 0.92, 'req_y');
    const replay = await wallet.settle('org', 'hold_y', 0.92, 'req_y');
    expect(first).toBeCloseTo(1.08, 6);
    expect(replay).toBeCloseTo(1.08, 6);
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(1.08, 6);
  });

  it('releasing a hold frees the reservation with no charge', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 2.0 }));
    await wallet.reserve('org', 'hold_z', 1.55);
    expect(await wallet.getAvailableUsd('org')).toBeCloseTo(0.45, 6);
    await wallet.release('org', 'hold_z');
    expect(await wallet.getAvailableUsd('org')).toBeCloseTo(2.0, 6);
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(2.0, 6); // never charged
  });

  it('reserve is idempotent on the hold id', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 2.0 }));
    const a = await wallet.reserve('org', 'hold_same', 1.0);
    const b = await wallet.reserve('org', 'hold_same', 1.0);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    // Only ONE $1.00 reservation is held, not two.
    expect(await wallet.getAvailableUsd('org')).toBeCloseTo(1.0, 6);
  });

  it('an expired hold no longer reserves balance', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 2.0 }));
    await wallet.reserve('org', 'hold_ttl', 1.5, { ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await wallet.getAvailableUsd('org')).toBeCloseTo(2.0, 6);
  });
});

/** A store that fails every money-moving op — used to prove failures are not swallowed. */
class FailingDebitStore implements BalanceStore {
  readonly recorded: FailedDebitRecord[] = [];
  async getBalanceUsd(): Promise<number> {
    return 10;
  }
  async getAvailableUsd(): Promise<number> {
    return 10;
  }
  async adjustBalanceUsd(): Promise<number> {
    throw new Error('db down');
  }
  async applyTopup(_o: string, _a: number, _k: string, _m: CreditMemo): Promise<DebitResult> {
    throw new Error('db down');
  }
  async applyDebit(_o: string, _a: number, _k: string, _m: CreditMemo): Promise<DebitResult> {
    throw new Error('db down');
  }
  async reserveHold(
    _o: string,
    _h: string,
    _a: number,
    _opts?: ReserveOptions
  ): Promise<ReserveResult> {
    throw new Error('db down');
  }
  async settleHold(): Promise<DebitResult> {
    throw new Error('db down');
  }
  async releaseHold(): Promise<void> {
    throw new Error('db down');
  }
  async applyGrant(): Promise<GrantResult> {
    throw new Error('db down');
  }
  async expireGrants(): Promise<ExpirySweepResult> {
    throw new Error('db down');
  }
  async reverseGrant(): Promise<import('@/services/prepaid-wallet').GrantReversalResult> {
    throw new Error('db down');
  }
  async recordFailedDebit(record: FailedDebitRecord): Promise<void> {
    this.recorded.push(record);
  }
}

// ── DI-08: debit failure is surfaced + recorded, never silently swallowed ────────────
describe('prepaid-wallet · debit failures are not swallowed (DI-08)', () => {
  it('a failing debit propagates (does not resolve silently)', async () => {
    const wallet = new PrepaidWallet(new FailingDebitStore());
    await expect(wallet.debit('org', 1, 'req_fail')).rejects.toThrow('db down');
  });

  it('a failed debit can be durably recorded for retry', async () => {
    const store = new FailingDebitStore();
    const wallet = new PrepaidWallet(store);

    // Mirror the gate helper's DI-08 handler: catch, log, and enqueue for retry.
    try {
      await wallet.debit('org', 1.23, 'req_fail', 'req_fail');
      throw new Error('expected debit to reject');
    } catch (error) {
      await wallet.recordFailedDebit({
        organizationId: 'org',
        amountUsd: 1.23,
        requestId: 'req_fail',
        idempotencyKey: 'req_fail',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]).toMatchObject({
      organizationId: 'org',
      amountUsd: 1.23,
      idempotencyKey: 'req_fail',
      error: 'db down',
    });
  });

  it('the in-memory store captures failed-debit records', async () => {
    const store = new InMemoryBalanceStore({ org: 5 });
    const wallet = new PrepaidWallet(store);
    await wallet.recordFailedDebit({
      organizationId: 'org',
      amountUsd: 0.5,
      requestId: 'req_z',
      idempotencyKey: 'req_z',
      error: 'boom',
    });
    expect(store.failedDebits).toHaveLength(1);
    expect(store.failedDebits[0].error).toBe('boom');
  });
});

// ── Promotional grants: expiry-bucketed credit allocated at debit time ──────────────
describe('prepaid-wallet · grants', () => {
  const futureMs = (days: number) => Date.now() + days * 24 * 60 * 60 * 1000;

  it('a grant credits the balance and is idempotent per grant id', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 1 }));
    const res = await wallet.grant('org', 'campaign:r1', 5, futureMs(30));
    expect(res.balanceUsd).toBeCloseTo(6, 6);
    expect(res.applied).toBe(true);

    const replay = await wallet.grant('org', 'campaign:r1', 5, futureMs(30));
    expect(replay.applied).toBe(false);
    expect(await wallet.getBalanceUsd('org')).toBeCloseTo(6, 6);
  });

  it('rejects non-positive amounts and past expiries', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore());
    await expect(wallet.grant('org', 'campaign:r2', 0, futureMs(1))).rejects.toThrow();
    await expect(wallet.grant('org', 'campaign:r2', -1, futureMs(1))).rejects.toThrow();
    await expect(wallet.grant('org', 'campaign:r2', 5, Date.now() - 1000)).rejects.toThrow();
  });

  it('a debit consumes the promotional grant before purchased balance', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 2 }));
    await wallet.grant('org', 'campaign:r3', 3, futureMs(30));

    // $4 debit: $3 from the grant, $1 from purchased balance → $1 left.
    expect(await wallet.debit('org', 4, 'req_1')).toBeCloseTo(1, 6);
  });

  it('allocation drains soonest-expiring grants first', async () => {
    const store = new InMemoryBalanceStore();
    const w2 = new PrepaidWallet(store);
    await w2.grant('org', 'campaign:late', 2, futureMs(60));
    await w2.grant('org', 'campaign:soon', 2, futureMs(10));
    await w2.debit('org', 1.5, 'req_2');
    // Balance is pooled, so the observable invariant is the sweep result once
    // both expire: `soon` still had 0.50 → reclaims 0.50; `late` reclaims 2.
    // (The debit demonstrably came out of `soon`: otherwise `soon` reclaims 0.)
    const sweep = await store.expireGrants(futureMs(70));
    expect(sweep.grantsExpired).toBe(2);
    expect(sweep.reclaimedUsd).toBeCloseTo(2.5, 6);
  });

  it('settle consumes grants like a plain debit', async () => {
    const wallet = new PrepaidWallet(new InMemoryBalanceStore({ org: 1 }));
    await wallet.grant('org', 'campaign:r4', 2, futureMs(30));

    const gate = await wallet.reserve('org', 'hold_g1', 1.5);
    expect(gate.allowed).toBe(true);
    expect(await wallet.settle('org', 'hold_g1', 1.2)).toBeCloseTo(1.8, 6);
  });

  it('the expiry sweep reclaims the unspent remainder and is idempotent', async () => {
    const store = new InMemoryBalanceStore({ org: 3 });
    const w = new PrepaidWallet(store);
    await w.grant('org', 'campaign:r5', 2, Date.now() + 60_000);
    await w.debit('org', 0.5, 'req_3'); // spends part of the grant

    // Simulate the sweep running after expiry (expireGrants takes "now").
    const sweep1 = await store.expireGrants(Date.now() + 120_000);
    expect(sweep1.grantsExpired).toBe(1);
    expect(sweep1.reclaimedUsd).toBeCloseTo(1.5, 6);
    // The debit came out of the grant, so purchased 3 is intact and the
    // grant's unspent 1.5 was reclaimed: 5 − 0.5 spent − 1.5 reclaimed = 3.
    expect(await store.getBalanceUsd('org')).toBeCloseTo(3, 6);

    // Idempotent: a second sweep reclaims nothing.
    const sweep2 = await store.expireGrants(Date.now() + 130_000);
    expect(sweep2.grantsExpired).toBe(0);
    expect(sweep2.reclaimedUsd).toBeCloseTo(0, 6);
  });

  it('a grant expiry reclaim never double-counts against a debit', async () => {
    const store = new InMemoryBalanceStore({ org: 0 });
    const w = new PrepaidWallet(store);
    await w.grant('org', 'campaign:r7', 5, Date.now() + 60_000);
    await w.debit('org', 2, 'req_4'); // all from grant → grant remaining 3
    expect(await store.getBalanceUsd('org')).toBeCloseTo(3, 6);

    await w.grant('org', 'campaign:r8', 1, Date.now() + 30_000);
    await store.expireGrants(Date.now() + 60_000); // both past expiry now
    expect(await store.getBalanceUsd('org')).toBeCloseTo(0, 6);
  });

  it('a debit in the expiry→sweep window reduces the grant (no double reclaim)', async () => {
    // P1 regression: between a grant's expiry moment and the 60s sweep pass,
    // the expired-but-unreclaimed promotional money is still pooled balance.
    // A debit there MUST consume from the grant — otherwise the sweep later
    // reclaims the FULL remaining and the org is charged twice for the spend.
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0);
      const store = new InMemoryBalanceStore({ org: 0 });
      const w = new PrepaidWallet(store);
      await w.grant('org', 'campaign:window', 5, t0 + 60_000); // valid future expiry

      // Jump PAST the grant's expiry, BEFORE the sweep pass would run.
      vi.setSystemTime(t0 + 90_000);
      await w.debit('org', 3, 'req_window'); // debit inside the window

      const sweep = await store.expireGrants(Date.now());
      // With the expiry-filter bug the debit skipped the grant and this
      // reclaims the full $5 (balance −3 = double charge). With the fix only
      // the unspent $2 is reclaimed: 5 − 3 − 2 = 0.
      expect(sweep.grantsExpired).toBe(1);
      expect(sweep.reclaimedUsd).toBeCloseTo(2, 6);
      expect(await store.getBalanceUsd('org')).toBeCloseTo(0, 6);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Grant reversal (campaign clawback) ─────────────────────────────────────────
describe('prepaid-wallet · grant reversal', () => {
  const futureMs = (days: number) => Date.now() + days * 24 * 60 * 60 * 1000;

  it('reverses an active grant by reclaiming only the unspent remainder', async () => {
    const store = new InMemoryBalanceStore({ org: 0 });
    const w = new PrepaidWallet(store);
    await w.grant('org', 'campaign:rev1', 5, futureMs(30));
    await w.debit('org', 2, 'req_r1'); // spent part of the grant

    const res = await w.reverseGrant('campaign:rev1');
    expect(res.status).toBe('reversed');
    expect(res.reversedUsd).toBeCloseTo(3, 6);
    // 5 granted − 2 spent − 3 reclaimed = 0; the SPENT part is not clawed
    // back from anywhere — only the unspent remainder leaves the balance.
    expect(await store.getBalanceUsd('org')).toBeCloseTo(0, 6);
  });

  it('a reversed grant reversal is an idempotent no-op', async () => {
    const store = new InMemoryBalanceStore();
    const w = new PrepaidWallet(store);
    await w.grant('org', 'campaign:rev2', 5, futureMs(30));

    expect((await w.reverseGrant('campaign:rev2')).reversedUsd).toBeCloseTo(5, 6);
    const replay = await w.reverseGrant('campaign:rev2');
    expect(replay.status).toBe('reversed');
    expect(replay.reversedUsd).toBeCloseTo(0, 6);
    expect(await store.getBalanceUsd('org')).toBeCloseTo(0, 6);
  });

  it('exhausted and expired grants reverse as no-ops; missing ids are reported', async () => {
    const store = new InMemoryBalanceStore();
    const w = new PrepaidWallet(store);
    await w.grant('org', 'campaign:ex1', 2, futureMs(30));
    await w.debit('org', 2, 'req_r2'); // grant fully consumed → exhausted
    expect((await w.reverseGrant('campaign:ex1')).status).toBe('exhausted');

    await store.applyGrant('org', 'campaign:exp1', 1, Date.now() + 30_000, { kind: 'grant' });
    await store.expireGrants(Date.now() + 60_000);
    expect((await w.reverseGrant('campaign:exp1')).status).toBe('expired');

    expect((await w.reverseGrant('campaign:nope')).status).toBe('missing');
  });
});
