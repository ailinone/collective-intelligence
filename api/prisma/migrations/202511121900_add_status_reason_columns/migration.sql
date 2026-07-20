CREATE TABLE IF NOT EXISTS _prisma_placeholder (id INT);
-- Add status_reason columns for richer status tracking
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "status_reason" TEXT;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "status_reason" TEXT;

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "status_reason" TEXT;
