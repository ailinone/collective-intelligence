-- Prepaid wallet — money-correctness hardening. Expand-only / backward-compatible:
-- every statement is idempotent (IF NOT EXISTS) and adds only new, nullable-by-default
-- structure, so it is safe to apply ahead of the code that uses it.
--
--   DI-01  Idempotent debits: a UNIQUE key on the ledger makes a retried debit a no-op.
--   DI-02  Persisted holds: reservations at the 402 gate so concurrent requests can't
--          oversell the balance. `wallet_hold` rows are subtracted from the spendable
--          balance while active + unexpired; settling/releasing frees the reservation.
--   DI-08  Failed-debit outbox: a debit that can't be applied is recorded here for
--          retry + observability instead of being silently swallowed.

-- ── DI-01: idempotency key on the credit ledger ─────────────────────────────────────
ALTER TABLE "credit_transaction" ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;

-- Partial UNIQUE index: existing rows (NULL key) are unaffected; every keyed debit/settle
-- can be inserted at most once, so a retry with the same key cannot double-charge.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_transaction_idempotency_key_uidx"
  ON "credit_transaction" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- ── DI-02: persisted worst-case holds (the spend reservation) ────────────────────────
CREATE TABLE IF NOT EXISTS "wallet_hold" (
  "id"              TEXT          PRIMARY KEY,                 -- caller-supplied hold id
  "organization_id" TEXT          NOT NULL,
  "amount_usd"      NUMERIC(18,6) NOT NULL,                   -- worst-case reserved charge
  "status"          TEXT          NOT NULL DEFAULT 'active',  -- active | settled | released
  "created_at"      TIMESTAMP(3)  NOT NULL DEFAULT NOW(),
  "expires_at"      TIMESTAMP(3)  NOT NULL,                   -- self-expiry safety net
  "settled_at"      TIMESTAMP(3)
);

-- Drives the "SUM active, unexpired holds for this org" reservation lookup at the gate.
CREATE INDEX IF NOT EXISTS "wallet_hold_org_active_idx"
  ON "wallet_hold" ("organization_id", "status", "expires_at");

-- ── DI-08: failed-debit outbox (surface + enqueue for retry) ─────────────────────────
CREATE TABLE IF NOT EXISTS "wallet_failed_debit" (
  "id"              BIGSERIAL     PRIMARY KEY,
  "organization_id" TEXT          NOT NULL,
  "idempotency_key" TEXT,
  "amount_usd"      NUMERIC(18,6) NOT NULL,
  "request_id"      TEXT,
  "error"           TEXT,
  "status"          TEXT          NOT NULL DEFAULT 'pending', -- pending | resolved
  "attempts"        INTEGER       NOT NULL DEFAULT 1,
  "created_at"      TIMESTAMP(3)  NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMP(3)  NOT NULL DEFAULT NOW()
);

-- One outbox row per idempotency key (retries bump `attempts` instead of duplicating).
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_failed_debit_key_uidx"
  ON "wallet_failed_debit" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "wallet_failed_debit_status_idx"
  ON "wallet_failed_debit" ("status", "created_at");
