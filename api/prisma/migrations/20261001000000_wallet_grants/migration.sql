-- Wallet grants — promotional credit buckets with expiry (referral campaign).
--
-- The ledger balance stays the single source of truth for spend checks; a
-- wallet_grant row is an ALLOCATION OVERLAY: `remaining_usd` records how much
-- of the balance is promotional and must be (a) consumed FIRST at debit time
-- (soonest-expiring first) and (b) RECLAIMED from the balance when it expires.
-- Invariant: balance >= SUM(remaining_usd of non-expired grants) at all times.
--
-- Grants are minted exclusively by the billing campaign engine via
-- POST /v1/internal/wallet/grant (same shared secret as top-up), keyed by the
-- campaign redemption id — idempotent by design (PK + ledger idempotency_key).
--
-- Expand-only / operator-applied ahead of the code that uses it, matching the
-- other *_prepaid_wallet* migrations: every statement is idempotent
-- (IF NOT EXISTS) and no existing structure is touched.

CREATE TABLE IF NOT EXISTS "wallet_grants" (
  -- Caller-supplied grant id (`campaign:<redemption_id>`), mirroring the
  -- caller-supplied hold id convention on wallet_hold.
  "id"              TEXT          PRIMARY KEY,
  "organization_id" TEXT          NOT NULL,
  -- Who granted (reserved for future grant sources; today only 'campaign').
  "source"          TEXT          NOT NULL DEFAULT 'campaign',
  "granted_usd"     NUMERIC(18,6) NOT NULL,
  -- Unspent promotional credit. On expiry the remaining amount is reclaimed
  -- from the balance and the row flips to status='expired' — remaining_usd
  -- is kept (NOT zeroed) as the historical "unspent at expiry" figure.
  "remaining_usd"   NUMERIC(18,6) NOT NULL,
  "status"          TEXT          NOT NULL DEFAULT 'active',  -- active | exhausted | expired
  "expires_at"      TIMESTAMP(3)  NOT NULL,
  "created_at"      TIMESTAMP(3)  NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMP(3)  NOT NULL DEFAULT NOW(),
  CONSTRAINT "wallet_grants_granted_positive_ck" CHECK ("granted_usd" > 0),
  CONSTRAINT "wallet_grants_remaining_range_ck"
    CHECK ("remaining_usd" >= 0 AND "remaining_usd" <= "granted_usd")
);

-- Drives the debit-time allocation lookup (active grants for this org, soonest
-- expiry first).
CREATE INDEX IF NOT EXISTS "wallet_grants_org_active_idx"
  ON "wallet_grants" ("organization_id", "status", "expires_at");

-- Drives the expiry sweep's pass-1 org scan (WHERE status='active' AND
-- expires_at <= NOW() AND remaining_usd > 0) — a partial index keeps it an
-- index scan over exactly the reclaimable set, not a seq scan over history.
CREATE INDEX IF NOT EXISTS "wallet_grants_sweep_idx"
  ON "wallet_grants" ("expires_at")
  WHERE "status" = 'active' AND "remaining_usd" > 0;

-- New ledger kinds (TEXT column, no constraint to alter):
--   'grant'        money IN  — a campaign grant was credited
--   'grant_expiry' money OUT — an expired grant's unspent remainder reclaimed
-- Idempotency keys used: `grant:<grantId>` and `grant_expiry:<grantId>`.
