-- Closed-Loop Adaptive System Migration
-- Adds: execution_outcomes, shadow_evaluations, strategy_performance_snapshots,
--        drift_events, rollback_events, learning_validation_reports
-- Enhances: decision_audit with decision_source, expected outcomes, candidate details

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Enhance decision_audit with closed-loop fields
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE "decision_audit"
  ADD COLUMN IF NOT EXISTS "decision_source" TEXT,
  ADD COLUMN IF NOT EXISTS "decision_confidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "expected_quality" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "expected_latency_ms" INTEGER,
  ADD COLUMN IF NOT EXISTS "expected_cost_usd" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "candidate_details" JSONB,
  ADD COLUMN IF NOT EXISTS "input_hash" TEXT;

CREATE INDEX IF NOT EXISTS "decision_audit_decision_source_idx" ON "decision_audit" ("decision_source");

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. execution_outcomes — links decisions to measured results
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "execution_outcomes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "decision_trace_id" TEXT NOT NULL,
  "strategy" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "finished_at" TIMESTAMP(3) NOT NULL,
  "latency_ms" INTEGER NOT NULL,
  "cost_usd" DECIMAL(10, 6) NOT NULL DEFAULT 0,
  "total_tokens" INTEGER NOT NULL DEFAULT 0,
  "success" BOOLEAN NOT NULL,
  "failure_reason" TEXT,
  "retries" INTEGER NOT NULL DEFAULT 0,
  "fallback_used" BOOLEAN NOT NULL DEFAULT false,
  "escalation_used" BOOLEAN NOT NULL DEFAULT false,
  "quality_score" DECIMAL(5, 4),
  "quality_dimensions" JSONB,
  "feedback_iterations" INTEGER NOT NULL DEFAULT 1,
  "models_used" TEXT[] NOT NULL DEFAULT '{}',
  "observed_metrics" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "execution_outcomes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "execution_outcomes_decision_trace_id_key" ON "execution_outcomes" ("decision_trace_id");
CREATE INDEX "execution_outcomes_strategy_idx" ON "execution_outcomes" ("strategy");
CREATE INDEX "execution_outcomes_success_idx" ON "execution_outcomes" ("success");
CREATE INDEX "execution_outcomes_created_at_idx" ON "execution_outcomes" ("created_at");
CREATE INDEX "execution_outcomes_quality_score_idx" ON "execution_outcomes" ("quality_score");

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. shadow_evaluations — compares chosen strategy vs alternatives
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "shadow_evaluations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "decision_trace_id" TEXT NOT NULL,
  "task_type" TEXT NOT NULL,
  "complexity" TEXT NOT NULL,
  "chosen_strategy" TEXT NOT NULL,
  "chosen_quality" DECIMAL(5, 4) NOT NULL,
  "chosen_latency_ms" INTEGER NOT NULL,
  "chosen_cost_usd" DECIMAL(10, 6) NOT NULL,
  "shadow_strategy" TEXT NOT NULL,
  "shadow_quality" DECIMAL(5, 4) NOT NULL,
  "shadow_latency_ms" INTEGER NOT NULL,
  "shadow_cost_usd" DECIMAL(10, 6) NOT NULL,
  "quality_regret" DECIMAL(5, 4) NOT NULL,
  "winner_strategy" TEXT NOT NULL,
  "comparison_summary" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shadow_evaluations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shadow_evaluations_task_type_complexity_idx" ON "shadow_evaluations" ("task_type", "complexity");
CREATE INDEX "shadow_evaluations_chosen_strategy_idx" ON "shadow_evaluations" ("chosen_strategy");
CREATE INDEX "shadow_evaluations_shadow_strategy_idx" ON "shadow_evaluations" ("shadow_strategy");
CREATE INDEX "shadow_evaluations_created_at_idx" ON "shadow_evaluations" ("created_at");

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. strategy_performance_snapshots — aggregated metrics per time window
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "strategy_performance_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "strategy" TEXT NOT NULL,
  "task_type" TEXT NOT NULL,
  "complexity" TEXT NOT NULL,
  "time_window" TEXT NOT NULL,
  "window_type" TEXT NOT NULL,
  "sample_size" INTEGER NOT NULL,
  "win_rate" DECIMAL(5, 4) NOT NULL,
  "avg_quality" DECIMAL(5, 4) NOT NULL,
  "avg_latency_ms" INTEGER NOT NULL,
  "avg_cost_usd" DECIMAL(10, 6) NOT NULL,
  "success_rate" DECIMAL(5, 4) NOT NULL,
  "avg_regret" DECIMAL(5, 4) NOT NULL DEFAULT 0,
  "quality_p10" DECIMAL(5, 4) NOT NULL DEFAULT 0,
  "quality_p90" DECIMAL(5, 4) NOT NULL DEFAULT 0,
  "stability_index" DECIMAL(5, 4) NOT NULL DEFAULT 0,
  "drift_score" DECIMAL(5, 4) NOT NULL DEFAULT 0,
  "confidence_score" DECIMAL(5, 4) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "strategy_performance_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "strategy_performance_snapshots_unique" ON "strategy_performance_snapshots" ("strategy", "task_type", "complexity", "time_window", "window_type");
CREATE INDEX "strategy_performance_snapshots_strategy_idx" ON "strategy_performance_snapshots" ("strategy", "task_type", "complexity");
CREATE INDEX "strategy_performance_snapshots_time_window_idx" ON "strategy_performance_snapshots" ("time_window");
CREATE INDEX "strategy_performance_snapshots_created_at_idx" ON "strategy_performance_snapshots" ("created_at");

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. drift_events — detected performance/decision/context drift
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "drift_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "drift_type" TEXT NOT NULL,
  "scope_type" TEXT NOT NULL,
  "scope_key" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "baseline_value" DECIMAL(10, 6) NOT NULL,
  "current_value" DECIMAL(10, 6) NOT NULL,
  "delta_percent" DECIMAL(10, 4) NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "action_taken" TEXT,
  "resolved_at" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'open',

  CONSTRAINT "drift_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "drift_events_drift_type_idx" ON "drift_events" ("drift_type");
CREATE INDEX "drift_events_scope_idx" ON "drift_events" ("scope_type", "scope_key");
CREATE INDEX "drift_events_severity_idx" ON "drift_events" ("severity");
CREATE INDEX "drift_events_detected_at_idx" ON "drift_events" ("detected_at");
CREATE INDEX "drift_events_status_idx" ON "drift_events" ("status");

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. rollback_events — auditable rollback history
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "rollback_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "trigger_event_id" UUID,
  "scope_type" TEXT NOT NULL,
  "scope_key" TEXT NOT NULL,
  "previous_policy" JSONB NOT NULL,
  "new_policy" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "expected_recovery" TEXT,
  "executed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validated_at" TIMESTAMP(3),
  "validation_result" JSONB,

  CONSTRAINT "rollback_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rollback_events_scope_idx" ON "rollback_events" ("scope_type", "scope_key");
CREATE INDEX "rollback_events_executed_at_idx" ON "rollback_events" ("executed_at");

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. learning_validation_reports — proves learning is real
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "learning_validation_reports" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "scope_type" TEXT NOT NULL,
  "scope_key" TEXT NOT NULL,
  "baseline_window" TEXT NOT NULL,
  "comparison_window" TEXT NOT NULL,
  "baseline_metrics" JSONB NOT NULL,
  "comparison_metrics" JSONB NOT NULL,
  "improvement_delta" JSONB NOT NULL,
  "regressions" JSONB NOT NULL DEFAULT '[]',
  "learning_velocity" DECIMAL(10, 6) NOT NULL,
  "stability_index" DECIMAL(5, 4) NOT NULL,
  "validated" BOOLEAN NOT NULL DEFAULT false,
  "verdict" TEXT NOT NULL DEFAULT 'inconclusive',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "learning_validation_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "learning_validation_reports_scope_idx" ON "learning_validation_reports" ("scope_type", "scope_key");
CREATE INDEX "learning_validation_reports_verdict_idx" ON "learning_validation_reports" ("verdict");
CREATE INDEX "learning_validation_reports_created_at_idx" ON "learning_validation_reports" ("created_at");
