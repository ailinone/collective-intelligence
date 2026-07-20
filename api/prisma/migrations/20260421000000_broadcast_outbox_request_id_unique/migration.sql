-- Broadcast outbox — structural idempotency by request_id.
--
-- Problem this closes (final residual ressalva):
--   emitChatCompletion generates a fresh envelopeId UUID on every call, so the
--   PK alone can never protect against a caller that stages the same chat
--   completion twice (e.g. a future retry wrapper). Today the emitter is
--   invoked only AFTER executeRouteWithRetry succeeds, so double-emission is
--   structurally impossible — but "structurally impossible by convention" is
--   an evolution footgun. One careless move of the emit call inside the retry
--   loop would silently produce duplicate deliveries.
--
-- Fix:
--   Add `request_id` as a first-class column on broadcast_trace_outbox and
--   enforce a PARTIAL unique index over it. `ON CONFLICT (request_id) DO
--   NOTHING` in the writer then turns a double-emit into a no-op at DB level,
--   independent of any caller assumptions.
--
-- Why PARTIAL (`WHERE request_id IS NOT NULL`):
--   - Legacy rows written before this migration have NULL request_id and must
--     not collide with each other.
--   - Non-chat emission paths (future: async jobs, webhooks) may legitimately
--     have no request_id. Those rows stay non-deduplicated — which is what we
--     want because there's no shared key to dedupe on.
--
-- Why VARCHAR(128) not UUID:
--   RequestIdSchema is `z.string().min(1).max(128)` — free-form string, not
--   necessarily a UUID. The column width mirrors the domain schema exactly.

ALTER TABLE "broadcast_trace_outbox"
  ADD COLUMN "request_id" VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_trace_outbox_request_id_unique"
  ON "broadcast_trace_outbox" ("request_id")
  WHERE "request_id" IS NOT NULL;

COMMENT ON COLUMN "broadcast_trace_outbox"."request_id"
  IS 'Caller request id for idempotent staging. Partial-unique when not null.';
