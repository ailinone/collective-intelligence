-- Convert request_logs to the hash-only IP policy.
--
-- 20261001000000 (as applied on main via #700) added a raw ip_address TEXT
-- column and the request path briefly persisted real client IPs there. The
-- corrected write path stores only sha256(ip) in ip_hash (same policy as
-- anonymous_chat_logs.ip_hash; see ipPseudonymHash in request-logger.ts).
--
-- This migration converts the real DB state without touching the already
-- applied 20261001000000 (Prisma never re-runs it): backfill ip_hash from
-- any raw values collected in the window, then DROP the raw column so no
-- client IP can persist again. encode(sha256(...), 'hex') byte-matches the
-- Node sha256 digest of the same UTF-8 string.
ALTER TABLE "request_logs" ADD COLUMN IF NOT EXISTS "ip_hash" TEXT;
UPDATE "request_logs"
   SET "ip_hash" = encode(sha256("ip_address"::bytea), 'hex')
 WHERE "ip_address" IS NOT NULL AND "ip_hash" IS NULL;
ALTER TABLE "request_logs" DROP COLUMN IF EXISTS "ip_address";
