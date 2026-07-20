-- Broadcast feature (ADR-014 through ADR-020)
-- Sends trace envelopes to external observability platforms via transactional outbox.
--
-- Tables:
--   1. broadcast_trace_outbox      — immutable trace envelopes (written in request transaction)
--   2. broadcast_destination       — tenant-scoped destination configs (encrypted, ADR-017)
--   3. broadcast_delivery          — per-destination delivery attempts and status
--   4. broadcast_processed_trace   — idempotency guard per (envelope, destination) pair (ADR-007 pattern)
--   5. broadcast_dlq               — permanently failed deliveries with full context
--   6. routing_event               — persistent replacement for in-memory ring buffer (L11 migration)

-- ============================================================================
-- 1. broadcast_trace_outbox
-- ============================================================================
-- Atomic write alongside chat completion business data. Immutable after insert.
-- Read by BroadcastOutboxPoller (BullMQ JobScheduler, per ARCHITECTURE-GOVERNANCE §3).
-- Retention: 7 days (enforced by scheduled cleanup job).
CREATE TABLE "broadcast_trace_outbox" (
    "envelope_id"       UUID            NOT NULL,
    "schema_version"    VARCHAR(16)     NOT NULL,
    "organization_id"   UUID,
    "user_id"           UUID,
    "api_key_id"        UUID,
    "resolution_scope"  VARCHAR(16)     NOT NULL CHECK ("resolution_scope" IN ('organization', 'user', 'chatroom')),
    "envelope"          JSONB           NOT NULL,
    "occurred_at"       TIMESTAMPTZ     NOT NULL,
    "drained_at"        TIMESTAMPTZ,
    "destinations_resolved_count" INTEGER,
    "created_at"        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT "broadcast_trace_outbox_pkey" PRIMARY KEY ("envelope_id")
);

-- Primary query path: poller selects rows where drained_at IS NULL ordered by created_at
CREATE INDEX "broadcast_trace_outbox_drain_idx"
    ON "broadcast_trace_outbox" ("created_at")
    WHERE "drained_at" IS NULL;

-- Tenant lookup (rare, for admin queries and retention cleanup)
CREATE INDEX "broadcast_trace_outbox_org_idx"  ON "broadcast_trace_outbox" ("organization_id", "occurred_at");
CREATE INDEX "broadcast_trace_outbox_user_idx" ON "broadcast_trace_outbox" ("user_id", "occurred_at");

-- Retention cleanup
CREATE INDEX "broadcast_trace_outbox_retention_idx"
    ON "broadcast_trace_outbox" ("occurred_at")
    WHERE "drained_at" IS NOT NULL;

-- ============================================================================
-- 2. broadcast_destination
-- ============================================================================
-- Destination configs per tenant (org OR user). Config encrypted via KMS envelope
-- encryption (ADR-017). Row-level security enforced by application layer; we provide
-- the infrastructure hooks via current_setting keys.
CREATE TABLE "broadcast_destination" (
    "id"                    UUID            NOT NULL DEFAULT gen_random_uuid(),
    "tenant_type"           VARCHAR(16)     NOT NULL CHECK ("tenant_type" IN ('organization', 'user')),
    "tenant_id"             UUID            NOT NULL,
    "destination_type"      VARCHAR(32)     NOT NULL,   -- 'langfuse', 'datadog', 'webhook', 'otlp_collector', ...
    "name"                  VARCHAR(128)    NOT NULL,
    "enabled"               BOOLEAN         NOT NULL DEFAULT TRUE,

    -- Envelope encryption (ADR-017)
    "config_ciphertext"     BYTEA           NOT NULL,
    "config_iv"             BYTEA           NOT NULL,
    "config_auth_tag"       BYTEA           NOT NULL,
    "config_aad"            TEXT            NOT NULL,
    "config_dek_wrapped"    BYTEA           NOT NULL,
    "config_kek_resource"   TEXT            NOT NULL,

    -- Filtering and sampling (ADR-018)
    "api_key_filter"        JSONB           NOT NULL DEFAULT '[]'::jsonb,
    "sampling_rate"         NUMERIC(5,4)    NOT NULL DEFAULT 1.0
                            CHECK ("sampling_rate" BETWEEN 0 AND 1),

    -- Privacy mode (ADR-016)
    "privacy_mode"          BOOLEAN         NOT NULL DEFAULT FALSE,
    "privacy_custom_fields" JSONB           NOT NULL DEFAULT '[]'::jsonb,

    -- Lifecycle
    "release_status"        VARCHAR(16)     NOT NULL DEFAULT 'stable'
                            CHECK ("release_status" IN ('alpha', 'beta', 'stable', 'deprecated')),
    "last_used_at"          TIMESTAMPTZ,
    "created_at"            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "updated_at"            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "deleted_at"            TIMESTAMPTZ,

    CONSTRAINT "broadcast_destination_pkey" PRIMARY KEY ("id")
);

-- Resolution path: poller queries enabled destinations for a tenant.
-- ADR-020: partial index on enabled=true, not-deleted rows.
CREATE INDEX "broadcast_destination_resolution_idx"
    ON "broadcast_destination" ("tenant_type", "tenant_id", "destination_type")
    WHERE "enabled" = TRUE AND "deleted_at" IS NULL;

-- Unique name per tenant (prevents confusion in UI)
CREATE UNIQUE INDEX "broadcast_destination_unique_name_idx"
    ON "broadcast_destination" ("tenant_type", "tenant_id", "name")
    WHERE "deleted_at" IS NULL;

-- Quota enforcement: count active destinations per tenant
CREATE INDEX "broadcast_destination_quota_idx"
    ON "broadcast_destination" ("tenant_type", "tenant_id")
    WHERE "deleted_at" IS NULL;

-- ============================================================================
-- 3. broadcast_delivery
-- ============================================================================
-- Per-destination delivery state for an envelope. Many-to-many between
-- broadcast_trace_outbox and broadcast_destination.
CREATE TABLE "broadcast_delivery" (
    "id"                 UUID            NOT NULL DEFAULT gen_random_uuid(),
    "envelope_id"        UUID            NOT NULL,
    "destination_id"     UUID            NOT NULL,
    "status"             VARCHAR(16)     NOT NULL CHECK ("status" IN ('pending', 'sent', 'failed', 'dlq', 'sampled_out')),
    "attempts"           INTEGER         NOT NULL DEFAULT 0,
    "last_error_class"   VARCHAR(32),
    "last_error"         TEXT,
    "first_attempt_at"   TIMESTAMPTZ,
    "last_attempt_at"    TIMESTAMPTZ,
    "sent_at"            TIMESTAMPTZ,
    "next_retry_at"      TIMESTAMPTZ,
    "created_at"         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT "broadcast_delivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "broadcast_delivery_envelope_destination_unique"
        UNIQUE ("envelope_id", "destination_id"),
    CONSTRAINT "broadcast_delivery_envelope_fk"
        FOREIGN KEY ("envelope_id") REFERENCES "broadcast_trace_outbox" ("envelope_id") ON DELETE CASCADE,
    CONSTRAINT "broadcast_delivery_destination_fk"
        FOREIGN KEY ("destination_id") REFERENCES "broadcast_destination" ("id") ON DELETE CASCADE
);

-- Retry worker query path: find pending/failed deliveries ready for next attempt
CREATE INDEX "broadcast_delivery_retry_idx"
    ON "broadcast_delivery" ("status", "next_retry_at")
    WHERE "status" IN ('pending', 'failed');

-- Ops dashboards
CREATE INDEX "broadcast_delivery_destination_status_idx"
    ON "broadcast_delivery" ("destination_id", "status", "last_attempt_at");

-- ============================================================================
-- 4. broadcast_processed_trace
-- ============================================================================
-- Idempotency guard (ADR-007 pattern). Prevents duplicate delivery of the same
-- (envelope, destination) pair if the poller retries. Stricter than broadcast_delivery
-- because it's write-only-once.
-- Partitioned by week; drop partitions older than 30 days.
CREATE TABLE "broadcast_processed_trace" (
    "envelope_id"   UUID            NOT NULL,
    "destination_id" UUID           NOT NULL,
    "processed_at"  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT "broadcast_processed_trace_pkey"
        PRIMARY KEY ("envelope_id", "destination_id", "processed_at")
) PARTITION BY RANGE ("processed_at");

-- Initial partition (first week). Additional partitions created by scheduled job.
CREATE TABLE "broadcast_processed_trace_default"
    PARTITION OF "broadcast_processed_trace" DEFAULT;

-- ============================================================================
-- 5. broadcast_dlq
-- ============================================================================
-- Permanently failed deliveries. Retained for 30 days for manual replay.
CREATE TABLE "broadcast_dlq" (
    "id"                UUID            NOT NULL DEFAULT gen_random_uuid(),
    "envelope_id"       UUID            NOT NULL,
    "destination_id"    UUID            NOT NULL,
    "envelope_snapshot" JSONB           NOT NULL,   -- full envelope at time of failure
    "error_class"       VARCHAR(32)     NOT NULL,
    "error_message"     TEXT            NOT NULL,
    "error_context"     JSONB           NOT NULL DEFAULT '{}',
    "total_attempts"    INTEGER         NOT NULL,
    "first_attempted_at" TIMESTAMPTZ    NOT NULL,
    "dead_lettered_at"  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "replayed_at"       TIMESTAMPTZ,
    "replayed_by_user_id" UUID,

    CONSTRAINT "broadcast_dlq_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "broadcast_dlq_destination_idx"
    ON "broadcast_dlq" ("destination_id", "dead_lettered_at");

CREATE INDEX "broadcast_dlq_unreplayed_idx"
    ON "broadcast_dlq" ("dead_lettered_at")
    WHERE "replayed_at" IS NULL;

-- ============================================================================
-- 6. routing_event (L11 migration: in-memory ring buffer → PostgreSQL)
-- ============================================================================
-- Persistent replacement for routing-event-store.ts ring buffer. Feeds Broadcast.
-- Retention: 30 days (per original L11 design note).
-- Partitioned by week.
CREATE TABLE "routing_event" (
    "id"                   UUID            NOT NULL DEFAULT gen_random_uuid(),
    "request_id"           VARCHAR(128)    NOT NULL,
    "model_id"             VARCHAR(128)    NOT NULL,
    "equivalence_group"    VARCHAR(128),
    "selected_provider"    VARCHAR(64)     NOT NULL,
    "reason"               TEXT            NOT NULL,
    "candidates_considered" JSONB          NOT NULL DEFAULT '[]'::jsonb,
    "bandit_state"         JSONB,
    "outcome"              JSONB,
    "occurred_at"          TIMESTAMPTZ     NOT NULL,
    "outcome_at"           TIMESTAMPTZ,

    CONSTRAINT "routing_event_pkey" PRIMARY KEY ("id", "occurred_at")
) PARTITION BY RANGE ("occurred_at");

CREATE TABLE "routing_event_default"
    PARTITION OF "routing_event" DEFAULT;

CREATE INDEX "routing_event_request_id_idx" ON "routing_event" ("request_id");
CREATE INDEX "routing_event_model_id_idx"   ON "routing_event" ("model_id", "occurred_at");
CREATE INDEX "routing_event_provider_idx"   ON "routing_event" ("selected_provider", "occurred_at");

-- ============================================================================
-- Trigger: keep broadcast_destination.updated_at fresh
-- ============================================================================
CREATE OR REPLACE FUNCTION broadcast_destination_touch_updated_at()
    RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER broadcast_destination_touch_updated_at_trg
    BEFORE UPDATE ON broadcast_destination
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_destination_touch_updated_at();

-- ============================================================================
-- Comments (self-documenting schema)
-- ============================================================================
COMMENT ON TABLE  "broadcast_trace_outbox"   IS 'Immutable trace envelopes for broadcast pipeline (ADR-014). 7-day retention.';
COMMENT ON TABLE  "broadcast_destination"    IS 'Tenant-scoped observability destination configs, KMS-encrypted (ADR-017, ADR-020).';
COMMENT ON TABLE  "broadcast_delivery"       IS 'Per-destination delivery state for each envelope.';
COMMENT ON TABLE  "broadcast_processed_trace" IS 'Idempotency guard for at-least-once → effectively-once semantics (ADR-007 pattern).';
COMMENT ON TABLE  "broadcast_dlq"            IS 'Dead-letter queue for permanently failed broadcast deliveries (ADR-019).';
COMMENT ON TABLE  "routing_event"            IS 'Persistent routing decisions (L11 migration from in-memory ring buffer).';

COMMENT ON COLUMN "broadcast_destination"."config_ciphertext"  IS 'AES-256-GCM ciphertext of destination config JSON';
COMMENT ON COLUMN "broadcast_destination"."config_dek_wrapped" IS 'Per-row DEK, wrapped by KMS KEK (envelope encryption)';
COMMENT ON COLUMN "broadcast_destination"."config_aad"         IS 'AAD binding ciphertext to tenant+destination (prevents cross-tenant decrypt)';
