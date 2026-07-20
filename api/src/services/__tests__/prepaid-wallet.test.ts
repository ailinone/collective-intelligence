// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import {
  estimateMaxChargeUsd,
  evaluateSpendGate,
  InMemoryBalanceStore,
  PrepaidWallet,
  type BalanceStore,
  type CreditMemo,
  type DebitResult,
  type FailedDebitRecord,
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
      Array.from({ length: 8 }, () => wallet.debit('org', 1, 'req_dup')),
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
      Array.from({ length: 5 }, (_, i) => wallet.reserve('org', `hold_${i}`, 0.4)),
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
  async applyDebit(
    _o: string,
    _a: number,
    _k: string,
    _m: CreditMemo,
  ): Promise<DebitResult> {
    throw new Error('db down');
  }
  async reserveHold(
    _o: string,
    _h: string,
    _a: number,
    _opts?: ReserveOptions,
  ): Promise<ReserveResult> {
    throw new Error('db down');
  }
  async settleHold(): Promise<DebitResult> {
    throw new Error('db down');
  }
  async releaseHold(): Promise<void> {
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
