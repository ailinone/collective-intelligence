-- v5.0: API Key Rotation System
-- Add rotation and security fields to api_keys table

-- Add new columns to api_keys
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "quick_hash" TEXT;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "request_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "last_request_ip" TEXT;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rotated_at" TIMESTAMP(3);
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMP(3);
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rotation_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "previous_key_id" UUID;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "next_key_id" UUID;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "ip_whitelist" TEXT[] DEFAULT '{}';
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "permissions" JSONB;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "auto_rotate" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rotation_interval_days" INTEGER;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "grace_period_days" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- Update status to support 'rotating'
-- (Already supports it via enum values)

-- Create indexes for new columns
CREATE INDEX IF NOT EXISTS "api_keys_quick_hash_idx" ON "api_keys"("quick_hash");
CREATE INDEX IF NOT EXISTS "api_keys_status_expires_at_idx" ON "api_keys"("status", "expires_at");

-- Create api_key_rotation_logs table
CREATE TABLE IF NOT EXISTS "api_key_rotation_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "api_key_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "old_key_id" UUID,
    "new_key_id" UUID,
    "performed_by" UUID,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "api_key_rotation_logs_pkey" PRIMARY KEY ("id")
);

-- Add foreign key constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'api_key_rotation_logs_api_key_id_fkey'
      AND table_name = 'api_key_rotation_logs'
  ) THEN
    ALTER TABLE "api_key_rotation_logs"
    ADD CONSTRAINT "api_key_rotation_logs_api_key_id_fkey"
    FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END;
$$;

-- Create indexes
CREATE INDEX IF NOT EXISTS "api_key_rotation_logs_api_key_id_idx" ON "api_key_rotation_logs"("api_key_id");
CREATE INDEX IF NOT EXISTS "api_key_rotation_logs_performed_at_idx" ON "api_key_rotation_logs"("performed_at");

-- Add comments
COMMENT ON TABLE "api_key_rotation_logs" IS 'v5.0: Audit trail for API key rotation events';
COMMENT ON COLUMN "api_keys"."quick_hash" IS 'v5.0: SHA-256 hash for fast lookup';
COMMENT ON COLUMN "api_keys"."auto_rotate" IS 'v5.0: Enable automatic key rotation';
COMMENT ON COLUMN "api_keys"."rotation_interval_days" IS 'v5.0: Auto-rotation frequency in days';
COMMENT ON COLUMN "api_keys"."grace_period_days" IS 'v5.0: Grace period for old key after rotation';

