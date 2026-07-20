-- C3 Validation Infrastructure Migration
-- Adds tables and columns required for Class 3 scientific validation

-- ─── New columns on experiment_executions ─────────────────────────────────────

ALTER TABLE "experiment_executions"
  ADD COLUMN IF NOT EXISTS "ablation_disabled" TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "ablation_condition" TEXT,
  ADD COLUMN IF NOT EXISTS "scoring_policy" TEXT,
  ADD COLUMN IF NOT EXISTS "judge_used" BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS "heuristic_score_raw" DECIMAL(5,4);

-- ─── Learning Snapshots (P1.4) ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "learning_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "metric_type" TEXT NOT NULL,
  "niche" TEXT,
  "execution_count" INTEGER NOT NULL,
  "value" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "learning_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "learning_snapshots_metric_type_niche_idx"
  ON "learning_snapshots" ("metric_type", "niche");
CREATE INDEX IF NOT EXISTS "learning_snapshots_metric_type_execution_count_idx"
  ON "learning_snapshots" ("metric_type", "execution_count");
CREATE INDEX IF NOT EXISTS "learning_snapshots_created_at_idx"
  ON "learning_snapshots" ("created_at");

-- ─── Diversity Measurements (P1.1) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "diversity_measurements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "strategy" TEXT NOT NULL,
  "task_type" TEXT NOT NULL,
  "complexity" TEXT NOT NULL,
  "model_count" INTEGER NOT NULL,
  "avg_cosine_similarity" DECIMAL(5,4) NOT NULL,
  "max_cosine_similarity" DECIMAL(5,4) NOT NULL,
  "min_cosine_similarity" DECIMAL(5,4) NOT NULL,
  "diversity_collapsed" BOOLEAN NOT NULL,
  "pairwise_details" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "diversity_measurements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "diversity_measurements_strategy_idx"
  ON "diversity_measurements" ("strategy");
CREATE INDEX IF NOT EXISTS "diversity_measurements_strategy_task_type_idx"
  ON "diversity_measurements" ("strategy", "task_type");
CREATE INDEX IF NOT EXISTS "diversity_measurements_created_at_idx"
  ON "diversity_measurements" ("created_at");

-- ─── Calibration Annotations (P0.3) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "calibration_annotations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "sample_id" TEXT NOT NULL,
  "annotator_id" TEXT NOT NULL,
  "overall_score" DECIMAL(5,4) NOT NULL,
  "correctness_score" DECIMAL(5,4) NOT NULL,
  "completeness_score" DECIMAL(5,4) NOT NULL,
  "clarity_score" DECIMAL(5,4) NOT NULL,
  "relevance_score" DECIMAL(5,4) NOT NULL,
  "reasoning" TEXT NOT NULL,
  "annotation_time_seconds" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "calibration_annotations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "calibration_annotations_sample_id_idx"
  ON "calibration_annotations" ("sample_id");
CREATE INDEX IF NOT EXISTS "calibration_annotations_annotator_id_idx"
  ON "calibration_annotations" ("annotator_id");
CREATE UNIQUE INDEX IF NOT EXISTS "calibration_annotations_sample_id_annotator_id_key"
  ON "calibration_annotations" ("sample_id", "annotator_id");

-- ─── Reward Hacking Events (A.3) ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "reward_hacking_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "correlation" DECIMAL(5,4) NOT NULL,
  "mean_divergence" DECIMAL(5,4) NOT NULL,
  "token_inflation" BOOLEAN NOT NULL,
  "formatting_inflation" BOOLEAN NOT NULL,
  "sample_count" INTEGER NOT NULL,
  "severity" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "reward_hacking_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reward_hacking_events_created_at_idx"
  ON "reward_hacking_events" ("created_at");
CREATE INDEX IF NOT EXISTS "reward_hacking_events_severity_idx"
  ON "reward_hacking_events" ("severity");
