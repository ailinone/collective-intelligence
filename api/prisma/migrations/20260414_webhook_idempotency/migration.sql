-- I2 fix: Webhook idempotency table (ADR-007)
-- Prevents duplicate processing of inbound webhooks (e.g., Stripe events).
-- Handler checks event_id before processing; skip if already exists.

CREATE TABLE "processed_webhook_events" (
    "event_id"     VARCHAR(128) NOT NULL,
    "event_type"   VARCHAR(64) NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhook_events_pkey" PRIMARY KEY ("event_id")
);

-- Index for retention cleanup (DELETE WHERE processed_at < cutoff)
CREATE INDEX "processed_webhook_events_processed_at_idx"
    ON "processed_webhook_events"("processed_at");
