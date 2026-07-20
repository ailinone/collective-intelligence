// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * prepaid-wallet.ts — prepaid credit balance: the worst-case spend HOLD (the 402
 * gate), the post-execution debit, and top-up credits.
 *
 * The flow per request:
 *   1. RESERVE the WORST-CASE charge (prompt tokens + the request's max output, at
 *      the tier rate) against the balance — reject with 402 if it can't be covered.
 *      The reservation is PERSISTED (a hold), so concurrent requests see each
 *      other's holds and cannot both spend the last dollar (no oversell — DI-02);
 *   2. run the request (the COGS guard keeps the internal fan-out within margin);
 *   3. SETTLE the hold with the ACTUAL charge (user's real tokens at the tier rate)
 *      and release the unused remainder. Settlement is IDEMPOTENT (keyed by the
 *      hold / request id), so a retried debit charges exactly once (no double-charge
 *      — DI-01). A debit that can't be applied is recorded durably for retry rather
 *      than silently swallowed (DI-08).
 *
 * All money math is pure and behind a `BalanceStore` port; the Prisma-backed store
 * lives in `prepaid-wallet-prisma-store.ts` (operator-gated on its migration). The
 * store is responsible for DB-level atomicity — the ports below are documented with
 * the atomicity contract each implementation MUST honour.
 */

/** Default lifetime of a spend hold before it self-expires (safety net for crashed requests). */
export const DEFAULT_HOLD_TTL_MS = 5 * 60 * 1000;

export interface CreditMemo {
  kind: 'topup' | 'debit' | 'adjustment' | 'refund';
  requestId?: string;
  description?: string;
  /**
   * Unique key that makes a money-moving debit idempotent: applying the same key
   * twice moves money once. Required by `applyDebit`; for `settleHold` it defaults
   * to the hold id.
   */
  idempotencyKey?: string;
}

/** Result of an idempotent money-moving debit (a plain debit or a hold settlement). */
export interface DebitResult {
  /** Ledger balance after the debit (or the prior balance-after, on an idempotent replay). */
  balanceUsd: number;
  /** false when the idempotency key had already been applied — no money moved on this call. */
  applied: boolean;
}

/** Result of an atomic hold reservation at the spend gate. */
export interface ReserveResult {
  ok: boolean;
  /** Spendable balance (ledger balance − active holds) AFTER this reservation. */
  availableUsd: number;
  /** Raw ledger balance (holds not subtracted). */
  balanceUsd: number;
}

export interface ReserveOptions {
  /** Balance floor a request must stay at/above to reserve (default 0 — no overdraft). */
  minBalanceUsd?: number;
  /** Hold lifetime before self-expiry (default DEFAULT_HOLD_TTL_MS). */
  ttlMs?: number;
}

/** A debit that could not be applied — captured durably for observability + retry (DI-08). */
export interface FailedDebitRecord {
  organizationId: string;
  amountUsd: number;
  requestId?: string;
  idempotencyKey?: string;
  error: string;
}

/**
 * Persistence port. Implementations MUST provide the documented atomicity — the
 * money-correctness of the wallet depends on the DB, not on app-level check-then-act.
 */
export interface BalanceStore {
  /** Raw ledger balance (holds NOT subtracted). */
  getBalanceUsd(organizationId: string): Promise<number>;
  /** Spendable balance = ledger balance − Σ active (non-expired) holds. */
  getAvailableUsd(organizationId: string): Promise<number>;
  /**
   * Atomically add `deltaUsd` (negative = debit) and return the new balance.
   * NOT idempotent — use for top-ups/adjustments only. Money-moving debits go
   * through `applyDebit`/`settleHold`, which are idempotent.
   */
  adjustBalanceUsd(organizationId: string, deltaUsd: number, memo: CreditMemo): Promise<number>;
  /**
   * Atomically apply a debit EXACTLY ONCE per `idempotencyKey`. Concurrent or
   * retried calls with the same key move money once; later calls return the prior
   * result with `applied: false`. Enforced by a DB unique constraint on the key.
   */
  applyDebit(
    organizationId: string,
    amountUsd: number,
    idempotencyKey: string,
    memo: CreditMemo,
  ): Promise<DebitResult>;
  /**
   * Atomically reserve `amountUsd` against the SPENDABLE balance and persist a hold.
   * The check-and-reserve MUST be atomic (row lock / single conditional write) so two
   * concurrent reservations cannot both take the last dollar. Idempotent per `holdId`.
   */
  reserveHold(
    organizationId: string,
    holdId: string,
    amountUsd: number,
    opts?: ReserveOptions,
  ): Promise<ReserveResult>;
  /**
   * Settle a hold: apply `actualChargeUsd` to the balance (idempotent — keyed by the
   * hold id) and release the reservation, freeing the unused remainder. A settle of an
   * already-settled or expired hold is a safe no-op that still applies the charge once.
   */
  settleHold(
    organizationId: string,
    holdId: string,
    actualChargeUsd: number,
    memo: CreditMemo,
  ): Promise<DebitResult>;
  /** Release a hold with NO charge (e.g. the request failed before spending). Idempotent. */
  releaseHold(organizationId: string, holdId: string): Promise<void>;
  /** Best-effort durable record of a debit that could not be applied (DI-08). MUST NOT throw. */
  recordFailedDebit(record: FailedDebitRecord): Promise<void>;
}

/** Round to micro-USD so repeated token math doesn't accrue float dust. */
export function roundUsd(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export interface SpendGateOptions {
  /** Balance floor a request must stay at/above to START (default 0 — no overdraft). */
  minBalanceUsd?: number;
}

export type SpendGateDecision =
  | { allowed: true; balanceUsd: number; estimatedMaxChargeUsd: number }
  | { allowed: false; reason: 'insufficient_funds'; balanceUsd: number; estimatedMaxChargeUsd: number };

/** Decide whether a request may start, given the (spendable) balance and the worst-case charge. */
export function evaluateSpendGate(
  balanceUsd: number,
  estimatedMaxChargeUsd: number,
  opts: SpendGateOptions = {},
): SpendGateDecision {
  const floor = opts.minBalanceUsd ?? 0;
  if (balanceUsd - estimatedMaxChargeUsd < floor) {
    return { allowed: false, reason: 'insufficient_funds', balanceUsd, estimatedMaxChargeUsd };
  }
  return { allowed: true, balanceUsd, estimatedMaxChargeUsd };
}

/**
 * Worst-case charge to HOLD at the gate: the user's prompt tokens plus the request's
 * declared `max_tokens` output, priced at the tier rate. The actual debit (on real
 * output) is ≤ this, so a passing gate guarantees the request is affordable.
 */
export function estimateMaxChargeUsd(
  tierInputPer1MUsd: number,
  tierOutputPer1MUsd: number,
  promptTokens: number,
  maxCompletionTokens: number,
): number {
  return roundUsd(
    (Math.max(0, promptTokens) / 1_000_000) * tierInputPer1MUsd +
      (Math.max(0, maxCompletionTokens) / 1_000_000) * tierOutputPer1MUsd,
  );
}

/** Thin orchestration over a `BalanceStore`: gate/reserve, top-up, settle/debit. */
export class PrepaidWallet {
  constructor(private readonly store: BalanceStore) {}

  async getBalanceUsd(organizationId: string): Promise<number> {
    return this.store.getBalanceUsd(organizationId);
  }

  /** Spendable balance (ledger balance − active holds). */
  async getAvailableUsd(organizationId: string): Promise<number> {
    return this.store.getAvailableUsd(organizationId);
  }

  /**
   * Read-only gate check against the SPENDABLE balance (does NOT persist a hold).
   * Prefer `reserve` on the request path — a bare check is racy under concurrency.
   */
  async checkGate(
    organizationId: string,
    estimatedMaxChargeUsd: number,
    opts?: SpendGateOptions,
  ): Promise<SpendGateDecision> {
    const available = await this.store.getAvailableUsd(organizationId);
    return evaluateSpendGate(available, estimatedMaxChargeUsd, opts);
  }

  /**
   * Atomically reserve the worst-case charge and persist a hold (DI-02). Concurrent
   * reservations see each other's holds and cannot both drive the balance negative.
   * Returns a `SpendGateDecision` so call sites mirror `checkGate`.
   */
  async reserve(
    organizationId: string,
    holdId: string,
    estimatedMaxChargeUsd: number,
    opts?: SpendGateOptions & { ttlMs?: number },
  ): Promise<SpendGateDecision> {
    const hold = roundUsd(Math.max(0, estimatedMaxChargeUsd));
    const res = await this.store.reserveHold(organizationId, holdId, hold, {
      minBalanceUsd: opts?.minBalanceUsd,
      ttlMs: opts?.ttlMs,
    });
    if (res.ok) {
      return { allowed: true, balanceUsd: res.availableUsd, estimatedMaxChargeUsd: hold };
    }
    return {
      allowed: false,
      reason: 'insufficient_funds',
      balanceUsd: res.availableUsd,
      estimatedMaxChargeUsd: hold,
    };
  }

  /**
   * Settle a reservation with the ACTUAL charge and release the remainder (DI-01/DI-02).
   * Idempotent: a retried settle of the same `holdId` charges once. Returns the new
   * ledger balance (backward-compatible with the old `debit` return shape).
   */
  async settle(
    organizationId: string,
    holdId: string,
    actualChargeUsd: number,
    requestId?: string,
  ): Promise<number> {
    const charge = roundUsd(Math.max(0, actualChargeUsd));
    const res = await this.store.settleHold(organizationId, holdId, charge, {
      kind: 'debit',
      requestId,
      idempotencyKey: holdId,
      description: 'tiered request charge (settled hold)',
    });
    return res.balanceUsd;
  }

  /** Release a reservation without charging (e.g. the request failed before spending). */
  async release(organizationId: string, holdId: string): Promise<void> {
    return this.store.releaseHold(organizationId, holdId);
  }

  async topUp(organizationId: string, amountUsd: number, requestId?: string): Promise<number> {
    if (!(amountUsd > 0)) throw new Error('top-up amount must be positive');
    return this.store.adjustBalanceUsd(organizationId, roundUsd(amountUsd), {
      kind: 'topup',
      requestId,
      description: 'credit top-up',
    });
  }

  /**
   * Idempotent debit (DI-01). A retried call with the same key charges exactly once.
   * The effective key is `idempotencyKey ?? requestId`; when neither is supplied it
   * falls back to a non-idempotent adjust (legacy behaviour — real call sites always
   * pass the request id). Returns the new ledger balance.
   */
  async debit(
    organizationId: string,
    chargeUsd: number,
    requestId?: string,
    idempotencyKey?: string,
  ): Promise<number> {
    const debit = roundUsd(Math.max(0, chargeUsd));
    if (debit === 0) return this.store.getBalanceUsd(organizationId);
    const key = idempotencyKey ?? requestId;
    if (!key) {
      return this.store.adjustBalanceUsd(organizationId, -debit, {
        kind: 'debit',
        requestId,
        description: 'tiered request charge',
      });
    }
    const res = await this.store.applyDebit(organizationId, debit, key, {
      kind: 'debit',
      requestId,
      idempotencyKey: key,
      description: 'tiered request charge',
    });
    return res.balanceUsd;
  }

  /** Durably record a debit that could not be applied, for observability + retry (DI-08). */
  async recordFailedDebit(record: FailedDebitRecord): Promise<void> {
    return this.store.recordFailedDebit(record);
  }
}

interface HoldEntry {
  organizationId: string;
  amountUsd: number;
  status: 'active' | 'settled' | 'released';
  expiresAtMs: number;
}

/** In-memory store — for tests and local dev (NOT durable). Mirrors the atomic semantics. */
export class InMemoryBalanceStore implements BalanceStore {
  private readonly balances = new Map<string, number>();
  private readonly holds = new Map<string, HoldEntry>();
  /** idempotencyKey -> balance-after at the time it was first applied. */
  private readonly appliedKeys = new Map<string, number>();
  /** Exposed for tests: durable failed-debit records (DI-08). */
  readonly failedDebits: FailedDebitRecord[] = [];

  constructor(seed?: Record<string, number>) {
    if (seed) for (const [k, v] of Object.entries(seed)) this.balances.set(k, v);
  }

  private bal(organizationId: string): number {
    return this.balances.get(organizationId) ?? 0;
  }

  private reservedUsd(organizationId: string, now: number): number {
    let total = 0;
    for (const h of this.holds.values()) {
      if (h.organizationId === organizationId && h.status === 'active' && h.expiresAtMs > now) {
        total += h.amountUsd;
      }
    }
    return roundUsd(total);
  }

  async getBalanceUsd(organizationId: string): Promise<number> {
    return this.bal(organizationId);
  }

  async getAvailableUsd(organizationId: string): Promise<number> {
    return roundUsd(this.bal(organizationId) - this.reservedUsd(organizationId, Date.now()));
  }

  async adjustBalanceUsd(organizationId: string, deltaUsd: number, _memo: CreditMemo): Promise<number> {
    const next = roundUsd(this.bal(organizationId) + deltaUsd);
    this.balances.set(organizationId, next);
    return next;
  }

  async applyDebit(
    organizationId: string,
    amountUsd: number,
    idempotencyKey: string,
    _memo: CreditMemo,
  ): Promise<DebitResult> {
    const prior = this.appliedKeys.get(idempotencyKey);
    if (prior !== undefined) return { balanceUsd: prior, applied: false };
    const next = roundUsd(this.bal(organizationId) - amountUsd);
    this.balances.set(organizationId, next);
    this.appliedKeys.set(idempotencyKey, next);
    return { balanceUsd: next, applied: true };
  }

  async reserveHold(
    organizationId: string,
    holdId: string,
    amountUsd: number,
    opts?: ReserveOptions,
  ): Promise<ReserveResult> {
    const now = Date.now();
    const existing = this.holds.get(holdId);
    if (existing) {
      // Idempotent: re-reserving the same id is a no-op that reports current state.
      const available = await this.getAvailableUsd(organizationId);
      return { ok: existing.status === 'active', availableUsd: available, balanceUsd: this.bal(organizationId) };
    }
    const floor = opts?.minBalanceUsd ?? 0;
    const ttl = opts?.ttlMs ?? DEFAULT_HOLD_TTL_MS;
    const available = roundUsd(this.bal(organizationId) - this.reservedUsd(organizationId, now));
    if (available - amountUsd < floor) {
      return { ok: false, availableUsd: available, balanceUsd: this.bal(organizationId) };
    }
    this.holds.set(holdId, {
      organizationId,
      amountUsd,
      status: 'active',
      expiresAtMs: now + ttl,
    });
    return { ok: true, availableUsd: roundUsd(available - amountUsd), balanceUsd: this.bal(organizationId) };
  }

  async settleHold(
    organizationId: string,
    holdId: string,
    actualChargeUsd: number,
    memo: CreditMemo,
  ): Promise<DebitResult> {
    const key = memo.idempotencyKey ?? holdId;
    const hold = this.holds.get(holdId);
    const prior = this.appliedKeys.get(key);
    if (prior !== undefined) {
      if (hold && hold.status === 'active') hold.status = 'settled';
      return { balanceUsd: prior, applied: false };
    }
    const next = roundUsd(this.bal(organizationId) - actualChargeUsd);
    this.balances.set(organizationId, next);
    this.appliedKeys.set(key, next);
    if (hold && hold.status === 'active') hold.status = 'settled';
    return { balanceUsd: next, applied: true };
  }

  async releaseHold(_organizationId: string, holdId: string): Promise<void> {
    const hold = this.holds.get(holdId);
    if (hold && hold.status === 'active') hold.status = 'released';
  }

  async recordFailedDebit(record: FailedDebitRecord): Promise<void> {
    this.failedDebits.push(record);
  }
}
