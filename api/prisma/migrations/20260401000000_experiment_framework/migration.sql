-- Comparative Experiment Framework
-- Structured comparison: Mode A (single model) vs Mode B (collective intelligence) vs Mode C (adaptive system)

CREATE TABLE "experiments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "progress" JSONB NOT NULL DEFAULT '{}',
    "total_executions" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "experiment_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "experiment_id" UUID NOT NULL,
    "task_index" INTEGER NOT NULL,
    "repetition" INTEGER NOT NULL,
    "execution_mode" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "model" TEXT,
    "task_type" TEXT NOT NULL,
    "complexity" TEXT NOT NULL,
    "domain" TEXT,
    "prompt" TEXT NOT NULL,
    "quality_score" DECIMAL(5,4),
    "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL,
    "models_used" TEXT[],
    "judge_score" DECIMAL(5,4),
    "judge_rubric" TEXT,
    "response_summary" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_executions_pkey" PRIMARY KEY ("id")
);

-- Indexes for experiments
CREATE INDEX "experiments_state_idx" ON "experiments"("state");
CREATE INDEX "experiments_created_at_idx" ON "experiments"("created_at");

-- Indexes for experiment_executions
CREATE INDEX "experiment_executions_experiment_id_idx" ON "experiment_executions"("experiment_id");
CREATE INDEX "experiment_executions_execution_mode_idx" ON "experiment_executions"("execution_mode");
CREATE INDEX "experiment_executions_task_type_complexity_idx" ON "experiment_executions"("task_type", "complexity");
CREATE INDEX "experiment_executions_strategy_idx" ON "experiment_executions"("strategy");
CREATE INDEX "experiment_executions_created_at_idx" ON "experiment_executions"("created_at");

-- Foreign key
ALTER TABLE "experiment_executions" ADD CONSTRAINT "experiment_executions_experiment_id_fkey"
    FOREIGN KEY ("experiment_id") REFERENCES "experiments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
