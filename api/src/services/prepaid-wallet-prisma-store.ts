// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * prepaid-wallet-prisma-store.ts — durable `BalanceStore` backed by Postgres.
 *
 * Uses RAW SQL (not the generated client) on purpose: the `organization_balance`,
 * `credit_transaction`, `wallet_hold` and `wallet_failed_debit` tables ship in
 * SEPARATE, operator-applied migrations (`prisma/migrations/*_prepaid_wallet*`), so
 * this compiles and ships ahead of the schema without a client regen.
 *
 * ATOMICITY (money correctness):
 *  - Top-up/adjust: a single upsert-with-increment inside a transaction that also
 *    appends the ledger row. Reference-carrying top-ups go through `applyTopup`,
 *    which is idempotent per key.
 *  - Idempotent top-up, debit + hold settle: guarded by the UNIQUE index on
 *    `credit_transaction.idempotency_key` — the same key moves money exactly once.
 *  - Reserve + settle serialize per-organization on a transaction-scoped ADVISORY
 *    LOCK, so the read-compute-write of "spendable = balance − active holds" is atomic
 *    and two concurrent gates can never both take the last dollar (no oversell).
 *
 * NOT wired into the request path until the migration is applied — see the pricing
 * docs "Rollout" section.
 */

import { prisma, Prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import { DEFAULT_HOLD_TTL_MS, roundUsd } from './prepaid-wallet';
import type {
  BalanceStore,
  CreditMemo,
  DebitResult,
  ExpirySweepResult,
  FailedDebitRecord,
  GrantResult,
  GrantReversalResult,
  ReserveOptions,
  ReserveResult,
} from './prepaid-wallet';

interface BalanceRow {
  balance_usd: string | number;
}
interface AvailableRow {
  balance_usd: string | number;
  available_usd: string | number;
}
interface HoldRow {
  amount_usd: string | number;
  status: string;
}
interface GrantRow {
  id: string;
  remaining_usd: string | number;
}

/** Transaction-scoped advisory lock so all per-org money ops serialize with each other. */
function lockOrg(tx: Prisma.TransactionClient, organizationId: string): Promise<number> {
  return tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`
  );
}

/**
 * Debit-time grant allocation: consume `amountUsd` from this org's grants,
 * soonest-expiring first (the promotional portion of the balance is spent
 * before purchased credit). MUST run inside the money transaction, after
 * `lockOrg` — the FOR UPDATE below plus the advisory lock keep a concurrent
 * grant/expiry sweep from racing this loop. Returns the amount consumed from
 * grants; the balance itself is decremented by the FULL amount by the caller
 * (grants are an allocation overlay, not separate money).
 *
 * Deliberately NO `expires_at > NOW()` filter: between a grant's expiry and
 * the 60s sweep pass that reclaims it, the expired-but-not-yet-reclaimed
 * promotional money is still in the pooled balance. A debit in that window
 * MUST reduce the grant's `remaining_usd` too — otherwise the sweep later
 * reclaims the FULL remaining (money the debit already consumed) and the
 * org is charged twice for the same spend. The sweep only reclaims what is
 * genuinely unspent. (`status='active'` already excludes swept grants.)
 */
async function consumeGrants(
  tx: Prisma.TransactionClient,
  organizationId: string,
  amountUsd: number
): Promise<number> {
  const grants = await tx.$queryRaw<GrantRow[]>(Prisma.sql`
    SELECT id, remaining_usd FROM wallet_grants
    WHERE organization_id = ${organizationId} AND status = 'active'
      AND remaining_usd > 0
    ORDER BY expires_at ASC
    FOR UPDATE
  `);
  let remaining = amountUsd;
  for (const g of grants) {
    if (remaining <= 0) break;
    const grantRemaining = Number(g.remaining_usd);
    const take = Math.min(remaining, grantRemaining);
    const nextRemaining = roundUsd(grantRemaining - take);
    await tx.$executeRaw(Prisma.sql`
      UPDATE wallet_grants
      SET remaining_usd = ${nextRemaining}::numeric,
          status = CASE WHEN ${nextRemaining}::numeric <= 0 THEN 'exhausted' ELSE status END,
          updated_at = NOW()
      WHERE id = ${g.id}
    `);
    remaining = roundUsd(remaining - take);
  }
  return roundUsd(amountUsd - remaining);
}

/**
 * Deploy-order safety for the debit path: consumeGrants reads wallet_grants,
 * which ships in a SEPARATE operator-applied migration. If the code deploys
 * before the migration, every tiered debit would fail inside its transaction
 * (relation does not exist → 42P01) and land in the failed-debit outbox —
 * zero charging until fixed. This probe runs ONCE per process (cached), OUT
 * SIDE the money transaction (a failing SELECT poisons a PG transaction), and
 * disables grant allocation loudly until the table exists. Money correctness
 * is unaffected: without allocation, debits behave exactly as pre-grant.
 * The cache is one-way DOWN only: a successful applyGrant re-enables
 * allocation (#703), so applying the migration no longer requires a restart.
 */
let grantsTableMissing: boolean | null = null;
async function grantsTableReady(): Promise<boolean> {
  if (grantsTableMissing === false) return true;
  if (grantsTableMissing === true) return false;
  try {
    await prisma.$queryRaw(Prisma.sql`SELECT 1 FROM wallet_grants LIMIT 1`);
    grantsTableMissing = false;
    return true;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === '42P01') {
      grantsTableMissing = true;
      logger.error(
        'wallet_grants table missing — promotional grant allocation DISABLED on the debit path (apply the wallet_grants migration; deploy-order guard)'
      );
      return false;
    }
    throw err;
  }
}

export class PrismaBalanceStore implements BalanceStore {
  async getBalanceUsd(organizationId: string): Promise<number> {
    const rows = await prisma.$queryRaw<BalanceRow[]>(Prisma.sql`
      SELECT balance_usd FROM organization_balance WHERE organization_id = ${organizationId}
    `);
    return rows.length ? Number(rows[0].balance_usd) : 0;
  }

  async getAvailableUsd(organizationId: string): Promise<number> {
    const rows = await prisma.$queryRaw<AvailableRow[]>(Prisma.sql`
      SELECT
        COALESCE((SELECT balance_usd FROM organization_balance WHERE organization_id = ${organizationId}), 0) AS balance_usd,
        COALESCE((SELECT balance_usd FROM organization_balance WHERE organization_id = ${organizationId}), 0)
          - COALESCE((
              SELECT SUM(amount_usd) FROM wallet_hold
              WHERE organization_id = ${organizationId} AND status = 'active' AND expires_at > NOW()
            ), 0) AS available_usd
    `);
    return rows.length ? Number(rows[0].available_usd) : 0;
  }

  async adjustBalanceUsd(
    organizationId: string,
    deltaUsd: number,
    memo: CreditMemo
  ): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        INSERT INTO organization_balance (organization_id, balance_usd, updated_at)
        VALUES (${organizationId}, ${deltaUsd}::numeric, NOW())
        ON CONFLICT (organization_id)
        DO UPDATE SET balance_usd = organization_balance.balance_usd + ${deltaUsd}::numeric,
                      updated_at  = NOW()
        RETURNING balance_usd
      `);
      const balanceAfter = Number(rows[0].balance_usd);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO credit_transaction
          (organization_id, kind, amount_usd, balance_after_usd, request_id, description, idempotency_key, created_at)
        VALUES
          (${organizationId}, ${memo.kind}, ${deltaUsd}::numeric, ${balanceAfter}::numeric,
           ${memo.requestId ?? null}, ${memo.description ?? null}, ${memo.idempotencyKey ?? null}, NOW())
      `);

      return balanceAfter;
    });
  }

  async applyTopup(
    organizationId: string,
    amountUsd: number,
    idempotencyKey: string,
    memo: CreditMemo
  ): Promise<DebitResult> {
    return prisma.$transaction(async (tx) => {
      await lockOrg(tx, organizationId);

      // Idempotency guard: if this key already moved money, return the prior result.
      const prior = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        SELECT balance_after_usd AS balance_usd FROM credit_transaction WHERE idempotency_key = ${idempotencyKey}
      `);
      if (prior.length) {
        return { balanceUsd: Number(prior[0].balance_usd), applied: false };
      }

      const rows = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        INSERT INTO organization_balance (organization_id, balance_usd, updated_at)
        VALUES (${organizationId}, ${amountUsd}::numeric, NOW())
        ON CONFLICT (organization_id)
        DO UPDATE SET balance_usd = organization_balance.balance_usd + ${amountUsd}::numeric,
                      updated_at  = NOW()
        RETURNING balance_usd
      `);
      const balanceAfter = Number(rows[0].balance_usd);

      // Same UNIQUE-index backstop as applyDebit; the key is namespaced by the
      // caller (`topup:<reference>`) so it can never collide with a debit key.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO credit_transaction
          (organization_id, kind, amount_usd, balance_after_usd, request_id, description, idempotency_key, created_at)
        VALUES
          (${organizationId}, ${memo.kind}, ${amountUsd}::numeric, ${balanceAfter}::numeric,
           ${memo.requestId ?? null}, ${memo.description ?? null}, ${idempotencyKey}, NOW())
      `);

      return { balanceUsd: balanceAfter, applied: true };
    });
  }

  async applyGrant(
    organizationId: string,
    grantId: string,
    amountUsd: number,
    expiresAtMs: number,
    memo: CreditMemo
  ): Promise<GrantResult> {
    const idempotencyKey = memo.idempotencyKey ?? `grant:${grantId}`;
    const expiresAt = new Date(expiresAtMs);
    // Contract: an already-past expiry is a caller bug, not wallet state —
    // reject rather than mint a grant the sweeper would immediately reclaim.
    if (!Number.isFinite(expiresAtMs) || expiresAt.getTime() <= Date.now()) {
      throw new Error('grant expiry must be in the future');
    }

    const result = await prisma.$transaction(async (tx) => {
      await lockOrg(tx, organizationId);

      // Idempotency guard (same pattern as applyTopup/applyDebit): the ledger
      // key backstops a concurrent duplicate insert via the UNIQUE index.
      const prior = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        SELECT balance_after_usd AS balance_usd FROM credit_transaction WHERE idempotency_key = ${idempotencyKey}
      `);
      if (prior.length) {
        return { balanceUsd: Number(prior[0].balance_usd), applied: false };
      }
      const priorGrant = await tx.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
        SELECT organization_id FROM wallet_grants WHERE id = ${grantId}
      `);
      if (priorGrant.length) {
        // A grant row exists without a matching ledger key (should not happen:
        // both are written in one tx) OR the grantId was reused for a
        // DIFFERENT org. The id is a global PK — cross-org reuse is a caller
        // bug and must fail loudly, never silently report a wrong balance.
        if (priorGrant[0].organization_id !== organizationId) {
          throw new Error(`grantId ${grantId} already used by another organization`);
        }
        const current = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
          SELECT balance_usd FROM organization_balance WHERE organization_id = ${organizationId}
        `);
        return { balanceUsd: current.length ? Number(current[0].balance_usd) : 0, applied: false };
      }

      const rows = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        INSERT INTO organization_balance (organization_id, balance_usd, updated_at)
        VALUES (${organizationId}, ${amountUsd}::numeric, NOW())
        ON CONFLICT (organization_id)
        DO UPDATE SET balance_usd = organization_balance.balance_usd + ${amountUsd}::numeric,
                      updated_at  = NOW()
        RETURNING balance_usd
      `);
      const balanceAfter = Number(rows[0].balance_usd);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO credit_transaction
          (organization_id, kind, amount_usd, balance_after_usd, request_id, description, idempotency_key, created_at)
        VALUES
          (${organizationId}, ${memo.kind}, ${amountUsd}::numeric, ${balanceAfter}::numeric,
           ${memo.requestId ?? null}, ${memo.description ?? null}, ${idempotencyKey}, NOW())
      `);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO wallet_grants
          (id, organization_id, source, granted_usd, remaining_usd, status, expires_at, created_at, updated_at)
        VALUES
          (${grantId}, ${organizationId}, 'campaign', ${amountUsd}::numeric, ${amountUsd}::numeric,
           'active', ${expiresAt}, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `);

      return { balanceUsd: balanceAfter, applied: true };
    });
    // #703: the debit-path probe is cached one-way — without this reset,
    // applying the migration WITHOUT a restart would let grants be credited
    // while allocation stayed off (spend bypassed remaining_usd, and a later
    // restart let the sweep reclaim the full grant: double charge).
    if (result.applied) grantsTableMissing = false;
    return result;
  }

  async expireGrants(_nowMs?: number): Promise<ExpirySweepResult> {
    // Pass 1 (no lock): find orgs with reclaimable grants — empty until the
    // campaign engine starts granting, so idle sweeps cost one indexed scan.
    const orgs = await prisma.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
      SELECT DISTINCT organization_id FROM wallet_grants
      WHERE status = 'active' AND expires_at <= NOW() AND remaining_usd > 0
    `);

    let grantsExpired = 0;
    let reclaimedUsd = 0;

    for (const { organization_id: orgId } of orgs) {
      // Per-org transaction under the org lock so a concurrent debit/settle
      // (which allocates from grants under the same lock) can never race the
      // reclaim. Idempotent per grant via the grant_expiry:<id> ledger key.
      const perOrg = await prisma.$transaction(async (tx) => {
        await lockOrg(tx, orgId);

        // hold×sweep window (#703): an active hold may be covered by
        // promotional balance. If the sweep reclaimed the grant between
        // reserveHold and settleHold, the settle would charge full against
        // purchased balance (or negative). consumeGrants has no expiry filter,
        // so as long as the grant still exists the settle absorbs it first —
        // skip reclaiming this org while any hold is active; the grant is
        // swept on a later pass (holds self-expire by TTL).
        const activeHold = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT id FROM wallet_hold
          WHERE organization_id = ${orgId} AND status = 'active' AND expires_at > NOW()
          LIMIT 1
        `);
        if (activeHold.length) return { orgExpired: 0, orgReclaimed: 0 };
        const due = await tx.$queryRaw<GrantRow[]>(Prisma.sql`
          SELECT id, remaining_usd FROM wallet_grants
          WHERE organization_id = ${orgId} AND status = 'active'
            AND expires_at <= NOW() AND remaining_usd > 0
          ORDER BY expires_at ASC
          FOR UPDATE
        `);
        let orgExpired = 0;
        let orgReclaimed = 0;
        for (const g of due) {
          const key = `grant_expiry:${g.id}`;
          const prior = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
            SELECT balance_after_usd AS balance_usd FROM credit_transaction WHERE idempotency_key = ${key}
          `);
          if (prior.length) continue;
          const reclaim = Number(g.remaining_usd);
          const rows = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
            INSERT INTO organization_balance (organization_id, balance_usd, updated_at)
            VALUES (${orgId}, ${-reclaim}::numeric, NOW())
            ON CONFLICT (organization_id)
            DO UPDATE SET balance_usd = organization_balance.balance_usd - ${reclaim}::numeric,
                          updated_at  = NOW()
            RETURNING balance_usd
          `);
          const balanceAfter = Number(rows[0].balance_usd);
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO credit_transaction
              (organization_id, kind, amount_usd, balance_after_usd, request_id, description, idempotency_key, created_at)
            VALUES
              (${orgId}, 'grant_expiry', ${-reclaim}::numeric, ${balanceAfter}::numeric,
               ${g.id}, 'promotional grant expired — unspent remainder reclaimed', ${key}, NOW())
          `);
          // remaining_usd is deliberately kept: it is the historical
          // "unspent at expiry" figure the campaign analytics read.
          await tx.$executeRaw(Prisma.sql`
            UPDATE wallet_grants SET status = 'expired', updated_at = NOW() WHERE id = ${g.id}
          `);
          orgExpired += 1;
          orgReclaimed = roundUsd(orgReclaimed + reclaim);
        }
        return { orgExpired, orgReclaimed };
      });
      grantsExpired += perOrg.orgExpired;
      reclaimedUsd = roundUsd(reclaimedUsd + perOrg.orgReclaimed);
    }

    return { grantsExpired, reclaimedUsd };
  }

  async reverseGrant(grantId: string): Promise<GrantReversalResult> {
    // Pass 0 (no lock): find the grant + its org. Missing → caller bug or
    // wrong side; report, never throw (the billing task records the outcome).
    const found = await prisma.$queryRaw<{ organization_id: string; status: string; remaining_usd: string | number }[]>(Prisma.sql`
      SELECT organization_id, status, remaining_usd FROM wallet_grants WHERE id = ${grantId}
    `);
    if (!found.length) {
      return { status: 'missing', reversedUsd: 0 };
    }
    const orgId = found[0].organization_id;
    if (found[0].status !== 'active') {
      return { status: found[0].status as GrantReversalResult['status'], reversedUsd: 0 };
    }

    const key = `grant_reversal:${grantId}`;
    return prisma.$transaction(async (tx) => {
      await lockOrg(tx, orgId);

      const prior = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        SELECT balance_after_usd AS balance_usd FROM credit_transaction WHERE idempotency_key = ${key}
      `);
      if (prior.length) {
        return { status: 'reversed' as const, reversedUsd: 0 };
      }

      const rows = await tx.$queryRaw<
        { status: string; remaining_usd: string | number }[]
      >(Prisma.sql`
        SELECT status, remaining_usd FROM wallet_grants WHERE id = ${grantId} FOR UPDATE
      `);
      if (!rows.length || rows[0].status !== 'active' || Number(rows[0].remaining_usd) <= 0) {
        return {
          status: (rows[0]?.status ?? 'missing') as GrantReversalResult['status'],
          reversedUsd: 0,
        };
      }

      const reclaim = Number(rows[0].remaining_usd);
      const bal = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        INSERT INTO organization_balance (organization_id, balance_usd, updated_at)
        VALUES (${orgId}, ${-reclaim}::numeric, NOW())
        ON CONFLICT (organization_id)
        DO UPDATE SET balance_usd = organization_balance.balance_usd - ${reclaim}::numeric,
                      updated_at  = NOW()
        RETURNING balance_usd
      `);
      const balanceAfter = Number(bal[0].balance_usd);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO credit_transaction
          (organization_id, kind, amount_usd, balance_after_usd, request_id, description, idempotency_key, created_at)
        VALUES
          (${orgId}, 'grant_reversal', ${-reclaim}::numeric, ${balanceAfter}::numeric,
           ${grantId}, 'promotional grant reversed (campaign clawback) — unspent remainder reclaimed', ${key}, NOW())
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE wallet_grants SET status = 'reversed', updated_at = NOW() WHERE id = ${grantId}
      `);

      return { status: 'reversed' as const, reversedUsd: reclaim };
    });
  }

  async applyDebit(
    organizationId: string,
    amountUsd: number,
    idempotencyKey: string,
    memo: CreditMemo
  ): Promise<DebitResult> {
    return prisma.$transaction(async (tx) => {
      await lockOrg(tx, organizationId);

      // Idempotency guard: if this key already moved money, return the prior result.
      const prior = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        SELECT balance_after_usd AS balance_usd FROM credit_transaction WHERE idempotency_key = ${idempotencyKey}
      `);
      if (prior.length) {
        return { balanceUsd: Number(prior[0].balance_usd), applied: false };
      }

      // Promotional allocation FIRST (soonest expiry), then the balance
      // decrement below removes the full amount — grants are an overlay.
      // Deploy-order guard: skips allocation (pre-grant behaviour) when the
      // wallet_grants migration has not been applied yet.
      if (await grantsTableReady()) {
        await consumeGrants(tx, organizationId, amountUsd);
      }

      const rows = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        INSERT INTO organization_balance (organization_id, balance_usd, updated_at)
        VALUES (${organizationId}, ${-amountUsd}::numeric, NOW())
        ON CONFLICT (organization_id)
        DO UPDATE SET balance_usd = organization_balance.balance_usd - ${amountUsd}::numeric,
                      updated_at  = NOW()
        RETURNING balance_usd
      `);
      const balanceAfter = Number(rows[0].balance_usd);

      // The UNIQUE index on idempotency_key is the backstop against a concurrent
      // double-insert; the advisory lock above already serializes same-org debits.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO credit_transaction
          (organization_id, kind, amount_usd, balance_after_usd, request_id, description, idempotency_key, created_at)
        VALUES
          (${organizationId}, ${memo.kind}, ${-amountUsd}::numeric, ${balanceAfter}::numeric,
           ${memo.requestId ?? null}, ${memo.description ?? null}, ${idempotencyKey}, NOW())
      `);

      return { balanceUsd: balanceAfter, applied: true };
    });
  }

  async reserveHold(
    organizationId: string,
    holdId: string,
    amountUsd: number,
    opts?: ReserveOptions
  ): Promise<ReserveResult> {
    const floor = opts?.minBalanceUsd ?? 0;
    const ttlSeconds = Math.max(1, Math.ceil((opts?.ttlMs ?? DEFAULT_HOLD_TTL_MS) / 1000));

    return prisma.$transaction(async (tx) => {
      await lockOrg(tx, organizationId);

      // Idempotent: a hold with this id already exists → report current state.
      const existing = await tx.$queryRaw<HoldRow[]>(Prisma.sql`
        SELECT amount_usd, status FROM wallet_hold WHERE id = ${holdId}
      `);

      const avail = await tx.$queryRaw<AvailableRow[]>(Prisma.sql`
        SELECT
          COALESCE((SELECT balance_usd FROM organization_balance WHERE organization_id = ${organizationId}), 0) AS balance_usd,
          COALESCE((SELECT balance_usd FROM organization_balance WHERE organization_id = ${organizationId}), 0)
            - COALESCE((
                SELECT SUM(amount_usd) FROM wallet_hold
                WHERE organization_id = ${organizationId} AND status = 'active' AND expires_at > NOW()
              ), 0) AS available_usd
      `);
      const balanceUsd = Number(avail[0].balance_usd);
      const availableUsd = Number(avail[0].available_usd);

      if (existing.length) {
        return { ok: existing[0].status === 'active', availableUsd, balanceUsd };
      }

      if (availableUsd - amountUsd < floor) {
        return { ok: false, availableUsd, balanceUsd };
      }

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO wallet_hold (id, organization_id, amount_usd, status, created_at, expires_at)
        VALUES (${holdId}, ${organizationId}, ${amountUsd}::numeric, 'active', NOW(),
                NOW() + (${ttlSeconds} * INTERVAL '1 second'))
        ON CONFLICT (id) DO NOTHING
      `);

      return { ok: true, availableUsd: availableUsd - amountUsd, balanceUsd };
    });
  }

  async settleHold(
    organizationId: string,
    holdId: string,
    actualChargeUsd: number,
    memo: CreditMemo
  ): Promise<DebitResult> {
    const key = memo.idempotencyKey ?? holdId;

    return prisma.$transaction(async (tx) => {
      await lockOrg(tx, organizationId);

      // Lock the hold row so a concurrent settle/release serializes behind us.
      await tx.$queryRaw<HoldRow[]>(Prisma.sql`
        SELECT amount_usd, status FROM wallet_hold WHERE id = ${holdId} FOR UPDATE
      `);

      // Idempotency guard: this settle already moved money → release + return prior.
      const prior = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        SELECT balance_after_usd AS balance_usd FROM credit_transaction WHERE idempotency_key = ${key}
      `);
      if (prior.length) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE wallet_hold SET status = 'settled', settled_at = NOW()
          WHERE id = ${holdId} AND status = 'active'
        `);
        return { balanceUsd: Number(prior[0].balance_usd), applied: false };
      }

      // Promotional allocation FIRST (soonest expiry) — same overlay rule as
      // applyDebit; the balance decrement below removes the full charge.
      // Deploy-order guard: see grantsTableReady.
      if (await grantsTableReady()) {
        await consumeGrants(tx, organizationId, actualChargeUsd);
      }

      const rows = await tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        INSERT INTO organization_balance (organization_id, balance_usd, updated_at)
        VALUES (${organizationId}, ${-actualChargeUsd}::numeric, NOW())
        ON CONFLICT (organization_id)
        DO UPDATE SET balance_usd = organization_balance.balance_usd - ${actualChargeUsd}::numeric,
                      updated_at  = NOW()
        RETURNING balance_usd
      `);
      const balanceAfter = Number(rows[0].balance_usd);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO credit_transaction
          (organization_id, kind, amount_usd, balance_after_usd, request_id, description, idempotency_key, created_at)
        VALUES
          (${organizationId}, ${memo.kind}, ${-actualChargeUsd}::numeric, ${balanceAfter}::numeric,
           ${memo.requestId ?? null}, ${memo.description ?? null}, ${key}, NOW())
      `);

      // Releasing the hold (status != 'active') frees the unused remainder.
      await tx.$executeRaw(Prisma.sql`
        UPDATE wallet_hold SET status = 'settled', settled_at = NOW()
        WHERE id = ${holdId} AND status = 'active'
      `);

      return { balanceUsd: balanceAfter, applied: true };
    });
  }

  async releaseHold(_organizationId: string, holdId: string): Promise<void> {
    await prisma.$executeRaw(Prisma.sql`
      UPDATE wallet_hold SET status = 'released', settled_at = NOW()
      WHERE id = ${holdId} AND status = 'active'
    `);
  }

  async recordFailedDebit(record: FailedDebitRecord): Promise<void> {
    // Best-effort durable outbox for retry + observability (DI-08). MUST NOT throw.
    try {
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO wallet_failed_debit
          (organization_id, idempotency_key, amount_usd, request_id, error, status, attempts, created_at, updated_at)
        VALUES
          (${record.organizationId}, ${record.idempotencyKey ?? null}, ${record.amountUsd}::numeric,
           ${record.requestId ?? null}, ${record.error}, 'pending', 1, NOW(), NOW())
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
        DO UPDATE SET attempts   = wallet_failed_debit.attempts + 1,
                      error      = ${record.error},
                      status     = 'pending',
                      updated_at = NOW()
      `);
    } catch {
      // Swallowing here is intentional and safe: the caller has ALREADY logged the
      // structured debit failure. This outbox write is a best-effort durability upgrade.
    }
  }
}
