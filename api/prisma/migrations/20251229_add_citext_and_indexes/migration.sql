-- Migration: Add citext for emails + additional performance indexes
-- This improves correctness (case-insensitive email comparisons) and performance (query planning / reduced scan time).

-- Enable case-insensitive text type for PostgreSQL
CREATE EXTENSION IF NOT EXISTS citext;

-- Make emails case-insensitive (important for auth flows and tests)
ALTER TABLE "users" ALTER COLUMN "email" TYPE CITEXT;
ALTER TABLE "auth_login_challenges" ALTER COLUMN "email" TYPE CITEXT;

-- Performance indexes (non-destructive, enterprise scaling)
-- Models
CREATE INDEX IF NOT EXISTS "models_provider_id_status_idx" ON "models"("provider_id", "status");
CREATE INDEX IF NOT EXISTS "models_status_usage_count_idx" ON "models"("status", "usage_count");
CREATE INDEX IF NOT EXISTS "models_provider_id_status_usage_count_idx" ON "models"("provider_id", "status", "usage_count");
CREATE INDEX IF NOT EXISTS "models_last_synced_at_idx" ON "models"("last_synced_at");
CREATE INDEX IF NOT EXISTS "models_updated_at_idx" ON "models"("updated_at");

-- Providers
CREATE INDEX IF NOT EXISTS "providers_status_idx" ON "providers"("status");
CREATE INDEX IF NOT EXISTS "providers_status_last_discovery_at_idx" ON "providers"("status", "last_discovery_at");
CREATE INDEX IF NOT EXISTS "providers_updated_at_idx" ON "providers"("updated_at");

-- Users (tenant isolation + common filters)
CREATE INDEX IF NOT EXISTS "users_organization_id_status_idx" ON "users"("organization_id", "status");
CREATE INDEX IF NOT EXISTS "users_organization_id_email_idx" ON "users"("organization_id", "email");
CREATE INDEX IF NOT EXISTS "users_organization_id_role_idx" ON "users"("organization_id", "role");


