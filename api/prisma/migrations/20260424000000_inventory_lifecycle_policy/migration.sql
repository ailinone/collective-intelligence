-- ADR-023 — Inventory Lifecycle Policy
--
-- Adds three freshness-of-observation columns to `models`, orthogonal to the
-- catalog-availability `status` column. Populated by
-- `scripts/hcra-lifecycle-classify.ts` using the canonical CASE expression in
-- `src/capability/inventory-lifecycle-policy.ts`.
--
-- Idempotent. `hcra-lifecycle-classify.ts` has been issuing the equivalent
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` since 2026-04-24; this migration
-- formalises the columns as the source of truth for `prisma migrate` drift
-- detection and makes future schema changes first-class migration artifacts.
--
-- Semantics
-- ---------
--   lifecycle_status       — closed enum 'active' / 'stale' / 'inactive'
--                            (enforced by CHECK; NULL until the first classifier
--                            run on pre-existing rows).
--   lifecycle_reason       — machine-parseable reason string for non-active rows.
--                            Format: 'no-discovery-since:YYYY-MM-DD' (stale) or
--                                    'absent-from-source-for>Nd'   (inactive).
--   lifecycle_evaluated_at — timestamp of the most recent classifier pass.
--                            Operators monitor this for classifier liveness.
--
-- Index
-- -----
--   idx_models_lifecycle_status is a PARTIAL index on status='active' because
--   all SLO-grade queries already include that predicate — the partial index
--   is significantly smaller and hotter in cache than a full-table equivalent.

-- ============================================================================
-- 1. Columns
-- ============================================================================
ALTER TABLE "models"
  ADD COLUMN IF NOT EXISTS "lifecycle_status"       VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "lifecycle_reason"       TEXT,
  ADD COLUMN IF NOT EXISTS "lifecycle_evaluated_at" TIMESTAMPTZ;

-- ============================================================================
-- 2. Closed-enum check constraint (I4 invariant: three-bucket partition)
-- ============================================================================
-- NULL permitted until first classifier pass; all non-NULL values MUST be one
-- of the three canonical literals from INVENTORY_LIFECYCLE_STATUSES.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_models_lifecycle_status'
  ) THEN
    ALTER TABLE "models"
      ADD CONSTRAINT "chk_models_lifecycle_status"
      CHECK ("lifecycle_status" IS NULL
             OR "lifecycle_status" IN ('active', 'stale', 'inactive'));
  END IF;
END $$;

-- ============================================================================
-- 3. Partial hot-path index
-- ============================================================================
-- Used by LIVE_UNIVERSE_WHERE consumers (bandit recall, dashboards, admin UIs).
-- Partial on status='active' mirrors the universe those consumers restrict to.
CREATE INDEX IF NOT EXISTS "idx_models_lifecycle_status"
  ON "models" ("lifecycle_status")
  WHERE "status" = 'active';
