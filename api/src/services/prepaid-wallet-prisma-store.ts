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
 *    appends the ledger row.
 *  - Idempotent debit + hold settle: guarded by the UNIQUE index on
 *    `credit_transaction.idempotency_key` — the same key moves money exactly once.
 *  - Reserve + settle serialize per-organization on a transaction-scoped ADVISORY
 *    LOCK, so the read-compute-write of "spendable = balance − active holds" is atomic
 *    and two concurrent gates can never both take the last dollar (no oversell).
 *
 * NOT wired into the request path until the migration is applied — see the pricing
 * docs "Rollout" section.
 */

import { prisma, Prisma } from '@/database/client';
import { DEFAULT_HOLD_TTL_MS } from './prepaid-wallet';
import type {
  BalanceStore,
  CreditMemo,
  DebitResult,
  FailedDebitRecord,
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

/** Transaction-scoped advisory lock so all per-org money ops serialize with each other. */
function lockOrg(tx: Prisma.TransactionClient, organizationId: string): Promise<number> {
  return tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`);
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
    memo: CreditMemo,
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

  async applyDebit(
    organizationId: string,
    amountUsd: number,
    idempotencyKey: string,
    memo: CreditMemo,
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
    opts?: ReserveOptions,
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
    memo: CreditMemo,
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
