-- Prepaid wallet — organization credit balance + an append-only transaction ledger.
-- Metered tiered requests HOLD the worst-case charge at the 402 gate and DEBIT the
-- actual charge (user tokens × tier rate) after execution. NUMERIC(18,6) = micro-USD,
-- matching the `roundUsd` precision in prepaid-wallet.ts.

CREATE TABLE IF NOT EXISTS "organization_balance" (
  "organization_id" TEXT PRIMARY KEY,
  "balance_usd"     NUMERIC(18,6) NOT NULL DEFAULT 0,
  "updated_at"      TIMESTAMP(3)  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "credit_transaction" (
  "id"                BIGSERIAL     PRIMARY KEY,
  "organization_id"   TEXT          NOT NULL,
  "kind"              TEXT          NOT NULL,
  "amount_usd"        NUMERIC(18,6) NOT NULL,
  "balance_after_usd" NUMERIC(18,6) NOT NULL,
  "request_id"        TEXT,
  "description"       TEXT,
  "created_at"        TIMESTAMP(3)  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "credit_transaction_org_created_idx"
  ON "credit_transaction" ("organization_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "credit_transaction_request_idx"
  ON "credit_transaction" ("request_id");
