-- Attribution columns for security monitoring and per-key usage analytics
-- (request_logs previously had NO user/api-key/IP attribution — the userId
-- accepted by RequestLoggerService was silently dropped in the Prisma
-- mapping; see the note in internal-usage-routes.ts).
--
-- Nullable with no defaults -> no table rewrite; the ALTER on the partitioned
-- parent cascades to every request_logs_YYYY_MM partition (PostgreSQL 11+).
-- No indexes yet: if the security views need them, add
-- (api_key_id, created_at DESC) following the ON ONLY + ATTACH PARTITION
-- low-lock procedure documented in 20260711000000_request_logs_endpoint_index.
ALTER TABLE "request_logs" ADD COLUMN IF NOT EXISTS "user_id" TEXT;
ALTER TABLE "request_logs" ADD COLUMN IF NOT EXISTS "api_key_id" TEXT;
ALTER TABLE "request_logs" ADD COLUMN IF NOT EXISTS "ip_address" TEXT;
