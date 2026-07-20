-- Hardening Bloco H: Structured execution metadata columns
-- Adds machine-parseable JSONB column for subcalls/cost/degradation/retry/error
-- plus a dedicated failure_mode column (avoids fragile string parsing).
--
-- Idempotent: re-runs safely via IF NOT EXISTS guards.

ALTER TABLE "experiment_executions"
  ADD COLUMN IF NOT EXISTS "structured_metadata" JSONB,
  ADD COLUMN IF NOT EXISTS "failure_mode" TEXT;

-- Indexes for fast analytics queries (failure triage + structured lookups)
CREATE INDEX IF NOT EXISTS "experiment_executions_failure_mode_idx"
  ON "experiment_executions" ("failure_mode")
  WHERE "failure_mode" IS NOT NULL;

-- GIN index enables fast containment queries: e.g. WHERE structured_metadata @> '{"cost_source": "hub_reported"}'
CREATE INDEX IF NOT EXISTS "experiment_executions_structured_metadata_gin_idx"
  ON "experiment_executions" USING GIN ("structured_metadata")
  WHERE "structured_metadata" IS NOT NULL;
