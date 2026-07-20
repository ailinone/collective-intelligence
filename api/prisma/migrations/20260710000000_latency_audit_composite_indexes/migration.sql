-- Composite indexes identified by the system-wide latency audit (2026-07-10).
-- Both tables are queried filtered by one column + ordered/windowed by a
-- second — a single-column index on each forces Postgres to bitmap-AND two
-- separate indexes instead of index-scanning directly.
--
-- NOTE: CONCURRENTLY removed for test/CI compatibility (Prisma migrations run
-- inside a transaction; CONCURRENTLY cannot).
-- For production: apply CONCURRENTLY manually during a low-traffic window,
-- e.g.:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "execution_outcomes_strategy_created_at_idx"
--     ON "execution_outcomes" ("strategy", "created_at");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "security_audit_logs_organization_id_created_at_idx"
--     ON "security_audit_logs" ("organization_id", "created_at" DESC);

-- learning-validation.ts / drift-detection.ts: getWindowMetrics() filters by
-- strategy + a created_at baseline/comparison window.
CREATE INDEX IF NOT EXISTS "execution_outcomes_strategy_created_at_idx"
  ON "execution_outcomes" ("strategy", "created_at");

-- org-governance-service.ts queryAuditEvents(): filters by organizationId,
-- ordered by createdAt desc, paginated — the table's most common access
-- pattern, and it only grows (every security/governance event lands here).
CREATE INDEX IF NOT EXISTS "security_audit_logs_organization_id_created_at_idx"
  ON "security_audit_logs" ("organization_id", "created_at" DESC);
