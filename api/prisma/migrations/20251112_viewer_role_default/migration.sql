-- Update default role for users to viewer (read-only baseline)
ALTER TABLE "users"
  ALTER COLUMN "role" SET DEFAULT 'viewer';

-- Ensure existing users without role explicitly set default to viewer where appropriate
UPDATE "users"
SET "role" = COALESCE(NULLIF(TRIM("role"), ''), 'viewer')
WHERE "role" IS NULL OR TRIM("role") = '';

