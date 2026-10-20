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
  kind: 'topup' | 'debit' | 'adjustment' | 'refund' | 'grant' | 'grant_expiry';
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

/** Result of an idempotent promotional grant (money in + allocation bucket). */
export interface GrantResult {
  /** Ledger balance after the grant (or the prior balance-after, on replay). */
  balanceUsd: number;
  /** false when the grant id had already been applied — no money moved. */
  applied: boolean;
}

/** Aggregate result of one expiry sweep pass. */
export interface ExpirySweepResult {
  /** Number of grants flipped active → expired by this pass. */
  grantsExpired: number;
  /** Total unspent promotional credit reclaimed from balances. */
  reclaimedUsd: number;
}

/** Result of a grant reversal (campaign clawback). */
export interface GrantReversalResult {
  /** The grant's status AFTER this call (active grants → 'reversed'). */
  status: 'active' | 'exhausted' | 'expired' | 'reversed' | 'missing';
  /** How much was reclaimed from the balance by THIS call (0 on replay). */
  reversedUsd: number;
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
   * NOT idempotent — use for adjustments only (and legacy no-reference top-ups).
   * Reference-carrying top-ups go through `applyTopup`; money-moving debits go
   * through `applyDebit`/`settleHold`. Both are idempotent.
   */
  adjustBalanceUsd(organizationId: string, deltaUsd: number, memo: CreditMemo): Promise<number>;
  /**
   * Atomically apply a credit top-up EXACTLY ONCE per `idempotencyKey` — the
   * credit-side twin of `applyDebit`. Concurrent or retried calls with the same
   * key credit the balance once; later calls return the prior result with
   * `applied: false`. Enforced by a DB unique constraint on the key, so the key
   * MUST be namespaced (e.g. `topup:<reference>`) when the dedup table is shared
   * with debits.
   */
  applyTopup(
    organizationId: string,
    amountUsd: number,
    idempotencyKey: string,
    memo: CreditMemo
  ): Promise<DebitResult>;
  /**
   * Atomically apply a debit EXACTLY ONCE per `idempotencyKey`. Concurrent or
   * retried calls with the same key move money once; later calls return the prior
   * result with `applied: false`. Enforced by a DB unique constraint on the key.
   */
  applyDebit(
    organizationId: string,
    amountUsd: number,
    idempotencyKey: string,
    memo: CreditMemo
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
    opts?: ReserveOptions
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
    memo: CreditMemo
  ): Promise<DebitResult>;
  /** Release a hold with NO charge (e.g. the request failed before spending). Idempotent. */
  releaseHold(organizationId: string, holdId: string): Promise<void>;
  /**
   * Atomically credit a promotional grant EXACTLY ONCE per `grantId` and open
   * its allocation bucket: the balance grows by `amountUsd` and a grant row
   * with `remaining_usd = amountUsd` / `expiresAtMs` is created. Debit-time
   * allocation (`applyDebit` / `settleHold`) consumes from grants first,
   * soonest-expiring first — deliberately WITHOUT an expiry filter (#703):
   * an expired-but-unswept grant still absorbs the debit (remaining_usd is
   * reduced), and the expiry sweep later reclaims only the unspent remainder.
   * A retried call with the same id is a
   * no-op returning the prior result (`applied: false`). An `expiresAtMs`
   * already in the past MUST be rejected, not silently granted-and-expired.
   */
  applyGrant(
    organizationId: string,
    grantId: string,
    amountUsd: number,
    expiresAtMs: number,
    memo: CreditMemo
  ): Promise<GrantResult>;
  /**
   * Sweep expired grants: for each org with active grants past `expiresAtMs`,
   * atomically (under the org lock) reclaim `remaining_usd` from the balance,
   * append a `grant_expiry` ledger row (idempotent per grant id) and flip the
   * grant to `expired` (remaining_usd kept as the unspent-at-expiry history).
   * MUST be safe to run concurrently with debits and with itself.
   */
  expireGrants(nowMs?: number): Promise<ExpirySweepResult>;
  /**
   * Reverse a grant (campaign clawback): under the org lock, reclaim the
   * CURRENT unspent `remaining_usd` from the balance, append a
   * `grant_reversal` ledger row (idempotent per grant id) and flip an active
   * grant to `reversed`. Already-reversed/expired/exhausted grants are a
   * no-op reporting their status (idempotent — a retried reversal never
   * takes money twice). Money already SPENT from the grant is not clawed
   * back from purchased balance; the campaign ledger (billing) records the
   * full reversal for accounting.
   */
  reverseGrant(grantId: string): Promise<GrantReversalResult>;
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
  | {
      allowed: false;
      reason: 'insufficient_funds';
      balanceUsd: number;
      estimatedMaxChargeUsd: number;
    };

/** Decide whether a request may start, given the (spendable) balance and the worst-case charge. */
export function evaluateSpendGate(
  balanceUsd: number,
  estimatedMaxChargeUsd: number,
  opts: SpendGateOptions = {}
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
  maxCompletionTokens: number
): number {
  return roundUsd(
    (Math.max(0, promptTokens) / 1_000_000) * tierInputPer1MUsd +
      (Math.max(0, maxCompletionTokens) / 1_000_000) * tierOutputPer1MUsd
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
    opts?: SpendGateOptions
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
    opts?: SpendGateOptions & { ttlMs?: number }
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
    requestId?: string
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

  /**
   * Credit a top-up. IDEMPOTENT when a `requestId`/reference is supplied: the
   * dedup key is `topup:<reference>` (namespaced so it can never collide with a
   * debit key in the shared ledger), and a retried call with the same reference
   * credits exactly once, returning the current balance on replay. Without a
   * reference it falls back to a plain adjust (legacy, non-idempotent) so
   * existing callers keep their exact behaviour.
   */
  async topUp(organizationId: string, amountUsd: number, requestId?: string): Promise<number> {
    if (!(amountUsd > 0)) throw new Error('top-up amount must be positive');
    const amount = roundUsd(amountUsd);
    if (!requestId) {
      return this.store.adjustBalanceUsd(organizationId, amount, {
        kind: 'topup',
        description: 'credit top-up',
      });
    }
    const res = await this.store.applyTopup(organizationId, amount, `topup:${requestId}`, {
      kind: 'topup',
      requestId,
      idempotencyKey: `topup:${requestId}`,
      description: 'credit top-up',
    });
    return res.balanceUsd;
  }

  /**
   * Credit a promotional grant (referral campaign engine → wallet) and open its
   * expiry-bucketed allocation. IDEMPOTENT per `grantId` (the billing campaign
   * redemption id): a retried call credits exactly once and returns the current
   * balance. The credit is spendable like any top-up; the difference is that
   * debit-time allocation consumes the promotional portion first (soonest
   * expiry first) and an expiry sweep reclaims whatever is still unspent at
   * `expiresAtMs`. A grant with a past expiry is rejected — granting credit
   * that is already expired is a caller bug, not a wallet state.
   */
  async grant(
    organizationId: string,
    grantId: string,
    amountUsd: number,
    expiresAtMs: number
  ): Promise<GrantResult> {
    if (!(amountUsd > 0)) throw new Error('grant amount must be positive');
    if (!grantId) throw new Error('grantId is required');
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error('grant expiry must be in the future');
    }
    return this.store.applyGrant(organizationId, grantId, roundUsd(amountUsd), expiresAtMs, {
      kind: 'grant',
      requestId: grantId,
      idempotencyKey: `grant:${grantId}`,
      description: 'promotional credit grant (campaign)',
    });
  }

  /**
   * Run one expiry sweep over all organizations (see BalanceStore.expireGrants).
   * Exposed for the background sweeper; also safe to invoke manually.
   */
  async expireGrants(): Promise<ExpirySweepResult> {
    return this.store.expireGrants(Date.now());
  }

  /**
   * Reverse a grant (campaign clawback). Idempotent: money already spent from
   * the grant is not clawed back; only the unspent remainder is reclaimed.
   */
  async reverseGrant(grantId: string): Promise<GrantReversalResult> {
    return this.store.reverseGrant(grantId);
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
    idempotencyKey?: string
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

interface GrantEntry {
  organizationId: string;
  remainingUsd: number;
  status: 'active' | 'exhausted' | 'expired' | 'reversed';
  expiresAtMs: number;
}

/** In-memory store — for tests and local dev (NOT durable). Mirrors the atomic semantics. */
export class InMemoryBalanceStore implements BalanceStore {
  private readonly balances = new Map<string, number>();
  private readonly holds = new Map<string, HoldEntry>();
  /** grantId -> promotional bucket (allocation overlay over the balance). */
  private readonly grants = new Map<string, GrantEntry>();
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

  async adjustBalanceUsd(
    organizationId: string,
    deltaUsd: number,
    _memo: CreditMemo
  ): Promise<number> {
    const next = roundUsd(this.bal(organizationId) + deltaUsd);
    this.balances.set(organizationId, next);
    return next;
  }

  async applyTopup(
    organizationId: string,
    amountUsd: number,
    idempotencyKey: string,
    _memo: CreditMemo
  ): Promise<DebitResult> {
    const prior = this.appliedKeys.get(idempotencyKey);
    if (prior !== undefined) return { balanceUsd: prior, applied: false };
    const next = roundUsd(this.bal(organizationId) + amountUsd);
    this.balances.set(organizationId, next);
    this.appliedKeys.set(idempotencyKey, next);
    return { balanceUsd: next, applied: true };
  }

  /**
   * Debit-time grant allocation: consume `amountUsd` from this org's grants,
   * soonest-expiring first. Returns the amount actually taken from grants
   * (the rest of the debit hits purchased balance). Mirrors the FOR UPDATE
   * loop in the Prisma store — including the deliberate ABSENCE of an
   * expiry filter: a debit in the expiry→sweep window must still reduce the
   * grant, or the sweep double-reclaims money the debit already consumed.
   */
  private consumeGrants(organizationId: string, amountUsd: number): number {
    let remaining = amountUsd;
    const due = [...this.grants.entries()]
      .filter(([, g]) => g.organizationId === organizationId && g.status === 'active')
      .sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs);
    for (const [, g] of due) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, g.remainingUsd);
      g.remainingUsd = roundUsd(g.remainingUsd - take);
      if (g.remainingUsd <= 0) g.status = 'exhausted';
      remaining = roundUsd(remaining - take);
    }
    return roundUsd(amountUsd - remaining);
  }

  async applyGrant(
    organizationId: string,
    grantId: string,
    amountUsd: number,
    expiresAtMs: number,
    memo: CreditMemo
  ): Promise<GrantResult> {
    const key = memo.idempotencyKey ?? `grant:${grantId}`;
    const prior = this.appliedKeys.get(key);
    if (prior !== undefined) return { balanceUsd: prior, applied: false };
    if (expiresAtMs <= Date.now()) throw new Error('grant expiry must be in the future');
    const next = roundUsd(this.bal(organizationId) + amountUsd);
    this.balances.set(organizationId, next);
    this.grants.set(grantId, {
      organizationId,
      remainingUsd: roundUsd(amountUsd),
      status: 'active',
      expiresAtMs,
    });
    this.appliedKeys.set(key, next);
    return { balanceUsd: next, applied: true };
  }

  async expireGrants(nowMs: number = Date.now()): Promise<ExpirySweepResult> {
    let grantsExpired = 0;
    let reclaimedUsd = 0;
    for (const [id, g] of this.grants.entries()) {
      if (g.status !== 'active' || g.expiresAtMs > nowMs || g.remainingUsd <= 0) continue;
      // Idempotent per grant: the reclaim key guards a concurrent/duplicate sweep.
      const key = `grant_expiry:${id}`;
      if (this.appliedKeys.has(key)) continue;
      const next = roundUsd(this.bal(g.organizationId) - g.remainingUsd);
      this.balances.set(g.organizationId, next);
      this.appliedKeys.set(key, next);
      g.status = 'expired'; // remainingUsd kept as the unspent-at-expiry history
      grantsExpired += 1;
      reclaimedUsd = roundUsd(reclaimedUsd + g.remainingUsd);
    }
    return { grantsExpired, reclaimedUsd };
  }

  async applyDebit(
    organizationId: string,
    amountUsd: number,
    idempotencyKey: string,
    _memo: CreditMemo
  ): Promise<DebitResult> {
    const prior = this.appliedKeys.get(idempotencyKey);
    if (prior !== undefined) return { balanceUsd: prior, applied: false };
    this.consumeGrants(organizationId, amountUsd);
    const next = roundUsd(this.bal(organizationId) - amountUsd);
    this.balances.set(organizationId, next);
    this.appliedKeys.set(idempotencyKey, next);
    return { balanceUsd: next, applied: true };
  }

  async reverseGrant(grantId: string): Promise<GrantReversalResult> {
    const g = this.grants.get(grantId);
    if (!g) return { status: 'missing', reversedUsd: 0 };
    if (g.status !== 'active' || g.remainingUsd <= 0) {
      return { status: g.status, reversedUsd: 0 };
    }
    const key = `grant_reversal:${grantId}`;
    if (this.appliedKeys.has(key)) return { status: 'reversed', reversedUsd: 0 };
    const next = roundUsd(this.bal(g.organizationId) - g.remainingUsd);
    this.balances.set(g.organizationId, next);
    this.appliedKeys.set(key, next);
    g.status = 'reversed'; // remaining kept as history, same as expiry
    return { status: 'reversed', reversedUsd: g.remainingUsd };
  }

  async reserveHold(
    organizationId: string,
    holdId: string,
    amountUsd: number,
    opts?: ReserveOptions
  ): Promise<ReserveResult> {
    const now = Date.now();
    const existing = this.holds.get(holdId);
    if (existing) {
      // Idempotent: re-reserving the same id is a no-op that reports current state.
      const available = await this.getAvailableUsd(organizationId);
      return {
        ok: existing.status === 'active',
        availableUsd: available,
        balanceUsd: this.bal(organizationId),
      };
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
    return {
      ok: true,
      availableUsd: roundUsd(available - amountUsd),
      balanceUsd: this.bal(organizationId),
    };
  }

  async settleHold(
    organizationId: string,
    holdId: string,
    actualChargeUsd: number,
    memo: CreditMemo
  ): Promise<DebitResult> {
    const key = memo.idempotencyKey ?? holdId;
    const hold = this.holds.get(holdId);
    const prior = this.appliedKeys.get(key);
    if (prior !== undefined) {
      if (hold && hold.status === 'active') hold.status = 'settled';
      return { balanceUsd: prior, applied: false };
    }
    this.consumeGrants(organizationId, actualChargeUsd);
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
