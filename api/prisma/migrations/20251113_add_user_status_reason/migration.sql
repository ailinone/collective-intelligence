-- Add status_reason column to users table to align with domain entity
ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "status_reason" TEXT;

