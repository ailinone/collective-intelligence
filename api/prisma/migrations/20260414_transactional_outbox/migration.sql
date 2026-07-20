-- C1 fix: Transactional Outbox table (ADR-001)
-- Eliminates dual-write between DB persist and domain event publish.
-- Events are inserted into this table within the same $transaction as business data.
-- A background poller reads unpublished events, publishes them, and marks as delivered.

CREATE TABLE "domain_event_outbox" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id"        UUID NOT NULL,
    "aggregate_id"    TEXT NOT NULL,
    "aggregate_type"  VARCHAR(64) NOT NULL,
    "event_name"      VARCHAR(128) NOT NULL,
    "event_version"   INTEGER NOT NULL DEFAULT 1,
    "payload"         JSONB NOT NULL,
    "metadata"        JSONB DEFAULT '{}',
    "occurred_at"     TIMESTAMP(3) NOT NULL,
    "published_at"    TIMESTAMP(3),
    "attempts"        INTEGER NOT NULL DEFAULT 0,
    "last_error"      TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_event_outbox_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on event_id prevents duplicate event writes
CREATE UNIQUE INDEX "domain_event_outbox_event_id_key" ON "domain_event_outbox"("event_id");

-- Primary query path: poller reads unpublished events ordered by creation time
CREATE INDEX "domain_event_outbox_published_at_created_at_idx"
    ON "domain_event_outbox"("published_at", "created_at");

-- Secondary: monitor poison events (high attempt count)
CREATE INDEX "domain_event_outbox_attempts_idx"
    ON "domain_event_outbox"("attempts");
