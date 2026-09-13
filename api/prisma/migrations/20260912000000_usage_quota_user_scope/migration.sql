-- Cross-repo quota-scoping hardening, Phase 3 (PR #582): give `usage_quotas`
-- per-user scope. `billing-usage-tracker.ts` and the `/v1/chat/completions`
-- + `orchestration-gate.ts` admission checks already pass `userId` into
-- `recordQuotaUsage`/`checkQuota` (`QuotaCheckRequest` carries it via
-- `QuotaEntityRef`) -- but `quota-service.ts` silently discarded it, so every
-- `usage_quotas` row was organization-wide only. This adds the column and
-- the DB-level uniqueness the two now-coexisting row shapes need:
--   * ONE org-wide aggregate row per (organization_id, period, period_start)
--     with user_id IS NULL -- unchanged meaning, kept for every caller that
--     does not pass a userId (fully backward compatible).
--   * ONE row per (organization_id, user_id, period, period_start) for each
--     user_id that IS passed.
--
-- Postgres treats every NULL as DISTINCT inside an ordinary unique index, so
-- `UNIQUE (organization_id, user_id, period, period_start)` alone would NOT
-- stop two concurrent first-requests-of-period from each inserting a second
-- org-wide row (both have user_id IS NULL, which never compares equal to
-- itself) -- reintroducing the exact race
-- `usage_quotas_organization_id_period_period_start_key` (dropped below)
-- existed to prevent. Partial unique indexes fix this but are a Postgres
-- feature Prisma's `@@unique` cannot express -- the same technique already
-- used for `broadcast_dlq_active_envelope_destination_unique`
-- (20260420120000_broadcast_dlq_unique_active). Maintained here as raw SQL,
-- intentionally invisible to Prisma introspection / `migrate dev` drift
-- detection -- see the doc comment on `UsageQuota` in schema.prisma.

-- Add the column. Nullable: NULL means "org-wide aggregate", matching every
-- row that existed before this migration (they read as NULL, i.e. stay the
-- org-wide row for their period -- no backfill needed).
ALTER TABLE "usage_quotas"
  ADD COLUMN "user_id" UUID;

-- Drop the old flat unique index: it did not know about user_id and would
-- wrongly reject a legitimate per-user row sharing (organization_id, period,
-- period_start) with the org-wide row or with another user's row.
DROP INDEX IF EXISTS "usage_quotas_organization_id_period_period_start_key";

-- Replace it with two partial unique indexes, one per row shape.
CREATE UNIQUE INDEX IF NOT EXISTS "usage_quotas_org_period_start_org_wide_key"
  ON "usage_quotas" ("organization_id", "period", "period_start")
  WHERE "user_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "usage_quotas_org_user_period_start_key"
  ON "usage_quotas" ("organization_id", "user_id", "period", "period_start")
  WHERE "user_id" IS NOT NULL;

-- Query-support index for the per-user lookup path (findCurrentQuota /
-- getOrCreateCurrentQuota now also filter by user_id when the caller passes
-- one).
CREATE INDEX IF NOT EXISTS "usage_quotas_organization_id_user_id_period_start_idx"
  ON "usage_quotas" ("organization_id", "user_id", "period_start");
