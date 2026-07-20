-- Creates model_performance_metrics table referenced by schema.prisma but
-- never generated as a migration. The log-retention job crashes nightly
-- with P2021 (TableDoesNotExist) on this table.
--
-- Idempotent: IF NOT EXISTS on table and indexes.

CREATE TABLE IF NOT EXISTS "model_performance_metrics" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"    UUID         NOT NULL,
  "model_id"           TEXT         NOT NULL,
  "task_type"          TEXT         NOT NULL,
  "provider"           TEXT         NOT NULL,
  "region"             TEXT,
  "response_time"      DOUBLE PRECISION NOT NULL,
  "token_throughput"   DOUBLE PRECISION NOT NULL,
  "success_rate"       DOUBLE PRECISION NOT NULL,
  "quality_score"      DOUBLE PRECISION,
  "cost_per_token"     DOUBLE PRECISION,
  "time_bucket"        TIMESTAMP(3) NOT NULL,
  "bucket_size"        TEXT         NOT NULL DEFAULT 'hour',
  "request_count"      INTEGER      NOT NULL DEFAULT 1,
  "total_tokens"       INTEGER      NOT NULL DEFAULT 0,
  "total_cost"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  "context_size"       INTEGER,
  "temperature"        DOUBLE PRECISION,
  "metadata"           JSONB,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "model_performance_metrics_pkey" PRIMARY KEY ("id")
);

-- Add FK to organizations (matches @relation in schema.prisma)
DO $$ BEGIN
  ALTER TABLE "model_performance_metrics"
    ADD CONSTRAINT "model_performance_metrics_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "model_performance_metrics_organization_id_idx"
  ON "model_performance_metrics" ("organization_id");

CREATE INDEX IF NOT EXISTS "model_performance_metrics_model_id_idx"
  ON "model_performance_metrics" ("model_id");

CREATE INDEX IF NOT EXISTS "model_performance_metrics_task_type_idx"
  ON "model_performance_metrics" ("task_type");

CREATE INDEX IF NOT EXISTS "model_performance_metrics_provider_idx"
  ON "model_performance_metrics" ("provider");

CREATE INDEX IF NOT EXISTS "model_performance_metrics_time_bucket_idx"
  ON "model_performance_metrics" ("time_bucket");

CREATE INDEX IF NOT EXISTS "model_performance_metrics_bucket_size_idx"
  ON "model_performance_metrics" ("bucket_size");
