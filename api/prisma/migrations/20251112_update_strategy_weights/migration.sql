CREATE TABLE IF NOT EXISTS "__strategy_weights_backup" AS
SELECT * FROM "strategy_weights";

DROP TABLE "strategy_weights";

CREATE TABLE "strategy_weights" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "task_type" VARCHAR(50) NOT NULL,
  "complexity" VARCHAR(20) NOT NULL,
  "strategy" TEXT NOT NULL,
  "weight" DECIMAL(10,6) NOT NULL DEFAULT 1.0,
  "success_rate" DECIMAL(10,6) NOT NULL DEFAULT 0,
  "avg_quality" DECIMAL(10,6) NOT NULL DEFAULT 0,
  "avg_cost_efficiency" DECIMAL(10,6) NOT NULL DEFAULT 0,
  "sample_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "strategy_weights_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "strategy_weights_task_type_complexity_strategy_key" ON "strategy_weights"("task_type", "complexity", "strategy");
CREATE INDEX "strategy_weights_task_type_complexity_idx" ON "strategy_weights"("task_type", "complexity");

INSERT INTO "strategy_weights" (
  id, task_type, complexity, strategy, weight, success_rate, avg_quality, avg_cost_efficiency, sample_count, created_at, updated_at
)
SELECT
  b.id,
  COALESCE(NULLIF(to_jsonb(b)->>'task_type', ''), 'general') AS task_type,
  COALESCE(NULLIF(to_jsonb(b)->>'complexity', ''), 'simple') AS complexity,
  COALESCE(
    NULLIF(to_jsonb(b)->>'strategy', ''),
    NULLIF(to_jsonb(b)->>'strategy_id', ''),
    NULLIF(to_jsonb(b)->>'strategy_name', ''),
    'single'
  ) AS strategy,
  COALESCE(NULLIF(to_jsonb(b)->>'weight', '')::DECIMAL(10,6), 1.0) AS weight,
  COALESCE(NULLIF(to_jsonb(b)->>'success_rate', '')::DECIMAL(10,6), 0) AS success_rate,
  COALESCE(NULLIF(to_jsonb(b)->>'avg_quality', '')::DECIMAL(10,6), 0) AS avg_quality,
  COALESCE(
    NULLIF(to_jsonb(b)->>'avg_cost_efficiency', '')::DECIMAL(10,6),
    NULLIF(to_jsonb(b)->>'avg_cost_usd', '')::DECIMAL(10,6),
    0
  ) AS avg_cost_efficiency,
  COALESCE(
    NULLIF(to_jsonb(b)->>'sample_count', '')::INTEGER,
    NULLIF(to_jsonb(b)->>'total_executions', '')::INTEGER,
    0
  ) AS sample_count,
  COALESCE(NULLIF(to_jsonb(b)->>'created_at', '')::TIMESTAMP, NOW()) AS created_at,
  COALESCE(
    NULLIF(to_jsonb(b)->>'updated_at', '')::TIMESTAMP,
    NULLIF(to_jsonb(b)->>'last_updated', '')::TIMESTAMP,
    NOW()
  ) AS updated_at
FROM "__strategy_weights_backup" AS b;

DROP TABLE "__strategy_weights_backup";
