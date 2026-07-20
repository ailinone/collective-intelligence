-- Ensure organizations table has JSON settings column for tenant overrides
ALTER TABLE "organizations"
ADD COLUMN IF NOT EXISTS "settings" JSONB DEFAULT '{}'::jsonb;

