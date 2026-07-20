-- Add phase column to track sanity-check vs warmup vs frozen vs confirmation
ALTER TABLE "experiment_executions"
  ADD COLUMN IF NOT EXISTS "phase" TEXT NOT NULL DEFAULT 'frozen';

CREATE INDEX IF NOT EXISTS "experiment_executions_phase_idx"
  ON "experiment_executions"("phase");
