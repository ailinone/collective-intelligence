-- Migration: Add model_count and last_discovery_at columns to providers table
-- These columns are defined in the Prisma schema but were missing from the database

-- Add model_count column with default value 0
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "model_count" INTEGER NOT NULL DEFAULT 0;

-- Add last_discovery_at column (nullable)
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "last_discovery_at" TIMESTAMP(3);

-- Update model_count based on actual model counts per provider
UPDATE "providers" p
SET "model_count" = (
  SELECT COUNT(*)
  FROM "models" m
  WHERE m."provider_id" = p."id"
);

