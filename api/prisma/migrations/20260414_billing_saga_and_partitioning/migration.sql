-- Sprint 5: Billing saga + request_logs partitioning cutover

-- ============================================================
-- I1 fix: Billing Saga — add updatedAt, lastError, and change default status
-- ============================================================

-- Add updatedAt column (auto-managed by Prisma @updatedAt)
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Add lastError column for tracking Stripe sync failures
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "last_error" TEXT;

-- Add index for reconciliation queries: find stale pending_stripe_sync invoices
CREATE INDEX IF NOT EXISTS "invoices_status_updated_at_idx"
    ON "invoices"("status", "updated_at");

-- Change default status from 'draft' to 'pending_stripe_sync' for new invoices.
-- Existing 'draft' invoices are left unchanged — they predate the saga pattern.
ALTER TABLE "invoices" ALTER COLUMN "status" SET DEFAULT 'pending_stripe_sync';

-- ============================================================
-- I3 fix: request_logs partitioning cutover
-- Renames the original table and activates the partitioned table.
-- The partitioned table was created in migration 20251229120000_add_request_logs_partitioning
-- but the cutover was deferred to a maintenance window.
-- ============================================================

-- Step 1: Rename original to _old (keeps data intact for recovery)
DO $$
BEGIN
  -- Only run cutover if the partitioned table exists and the original hasn't been renamed yet
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'request_logs_partitioned')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'request_logs')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'request_logs_old')
  THEN
    -- Rename original → old
    ALTER TABLE "request_logs" RENAME TO "request_logs_old";

    -- Rename partitioned → request_logs (Prisma model maps to this name)
    ALTER TABLE "request_logs_partitioned" RENAME TO "request_logs";

    -- Drop and recreate the view to point to the new (partitioned) table
    DROP VIEW IF EXISTS "request_logs_v";
    CREATE VIEW "request_logs_v" AS SELECT * FROM "request_logs";

    RAISE NOTICE 'request_logs partitioning cutover complete';
  ELSE
    RAISE NOTICE 'Partitioning cutover skipped: preconditions not met (table may already be partitioned)';
  END IF;
END $$;
