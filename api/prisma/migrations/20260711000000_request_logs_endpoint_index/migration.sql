-- Latency audit (2026-07-11): index for getRuntimeSignals() in
-- models-routes.ts, which runs on every runtime-signal cache refresh (60s TTL,
-- i.e. up to 1440x/day) with:
--   WHERE endpoint = '/v1/chat/completions' AND created_at > now() - 48h
-- `request_logs` has no index on `endpoint` at all, so this leaned on the
-- created_at index alone and scanned/filtered every row in the 48h window —
-- competing for I/O with the chat write path that inserts into the same table.
--
-- PARTITIONING NOTE: `request_logs` is a PARTITIONED table in production
-- (relkind='p', monthly partitions, managed manually — Prisma does not know
-- about the partitioning; see 20251229120000_add_request_logs_partitioning).
-- CREATE INDEX on the partitioned parent cascades to every existing partition
-- and auto-applies to future ones (PostgreSQL 11+). It cannot use CONCURRENTLY
-- on a partitioned parent, so each partition takes a brief lock while its
-- sub-index builds.
--
-- For production, the LOW-LOCK procedure instead is:
--   1. CREATE INDEX ... ON ONLY request_logs (endpoint, created_at DESC);  -- parent shell, invalid
--   2. For each partition:
--      CREATE INDEX CONCURRENTLY ... ON request_logs_YYYY_MM (endpoint, created_at DESC);
--      ALTER INDEX <parent_index> ATTACH PARTITION <partition_index>;
--   3. The parent index becomes valid when all partitions are attached.
-- This migration uses the simple cascading form so dev/CI databases (usually
-- small or non-partitioned) converge automatically; production should apply
-- the procedure above manually during a low-traffic window and this statement
-- then no-ops via IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS "request_logs_endpoint_created_at_idx"
  ON "request_logs" ("endpoint", "created_at" DESC);
