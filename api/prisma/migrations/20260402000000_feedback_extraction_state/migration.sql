-- Feedback Extraction Pipeline: watermark state + audit log
-- Enables idempotent, resumable data export from API to model-stack

CREATE TABLE IF NOT EXISTS "feedback_extraction_state" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "extraction_type" TEXT NOT NULL,
  "last_watermark" TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  "last_extraction_id" TEXT,
  "rows_extracted" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "feedback_extraction_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "feedback_extraction_state_extraction_type_key" ON "feedback_extraction_state" ("extraction_type");

-- Seed initial watermark rows
INSERT INTO "feedback_extraction_state" ("extraction_type") VALUES ('outcomes'), ('shadow')
ON CONFLICT ("extraction_type") DO NOTHING;

CREATE TABLE IF NOT EXISTS "feedback_extraction_log" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "extraction_id" TEXT NOT NULL,
  "extraction_type" TEXT NOT NULL,
  "watermark_start" TIMESTAMPTZ NOT NULL,
  "watermark_end" TIMESTAMPTZ NOT NULL,
  "row_count" INTEGER NOT NULL,
  "file_path" TEXT NOT NULL,
  "file_sha256" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "feedback_extraction_log_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "feedback_extraction_log_extraction_id_key" ON "feedback_extraction_log" ("extraction_id");
CREATE INDEX "feedback_extraction_log_extraction_type_idx" ON "feedback_extraction_log" ("extraction_type");
CREATE INDEX "feedback_extraction_log_created_at_idx" ON "feedback_extraction_log" ("created_at");
