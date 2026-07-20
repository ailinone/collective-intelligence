-- Decision Audit Trail (BL-08)
-- Records every routing decision for traceability and governance.
CREATE TABLE IF NOT EXISTS "decision_audit" (
  "id"                          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "request_id"                  TEXT NOT NULL UNIQUE,
  "organization_id"             UUID NOT NULL,
  "task_type"                   TEXT NOT NULL,
  "complexity"                  TEXT NOT NULL,
  "requested_strategy"          TEXT,
  "triage_intent"               TEXT,
  "triage_complexity"           TEXT,
  "triage_confidence"           DOUBLE PRECISION,
  "triage_recommended_strategy" TEXT,
  "strategy_scores"             JSONB NOT NULL DEFAULT '{}',
  "selected_strategy"           TEXT NOT NULL,
  "selection_reason"            TEXT NOT NULL,
  "models_considered"           TEXT[] NOT NULL DEFAULT '{}',
  "models_selected"             TEXT[] NOT NULL DEFAULT '{}',
  "created_at"                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "decision_audit_organization_id_idx"
  ON "decision_audit" ("organization_id");
CREATE INDEX IF NOT EXISTS "decision_audit_selected_strategy_idx"
  ON "decision_audit" ("selected_strategy");
CREATE INDEX IF NOT EXISTS "decision_audit_created_at_idx"
  ON "decision_audit" ("created_at");

-- Knowledge Graph Edges (BL-10)
-- Lightweight directed graph of execution relationships.
CREATE TABLE IF NOT EXISTS "knowledge_edges" (
  "id"         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "source_id"  TEXT NOT NULL,
  "target_id"  TEXT NOT NULL,
  "edge_type"  TEXT NOT NULL, -- model_task, model_model, strategy_model
  "weight"     DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  "hit_count"  INT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_edges_source_target_type_key"
  ON "knowledge_edges" ("source_id", "target_id", "edge_type");
CREATE INDEX IF NOT EXISTS "knowledge_edges_source_type_idx"
  ON "knowledge_edges" ("source_id", "edge_type");
CREATE INDEX IF NOT EXISTS "knowledge_edges_target_type_idx"
  ON "knowledge_edges" ("target_id", "edge_type");
CREATE INDEX IF NOT EXISTS "knowledge_edges_type_weight_idx"
  ON "knowledge_edges" ("edge_type", "weight" DESC);

-- HNSW index on semantic_memories embedding column (BL-13)
-- Accelerates vector similarity searches from O(n) to O(log n).
-- Uses cosine distance operator (<=>) for semantic similarity.
-- Only created if pgvector extension and vector column exist.
-- Workflow Executions (BL-07)
-- Persists workflow state for resume after crash/restart.
CREATE TABLE IF NOT EXISTS "workflow_executions" (
  "id"               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "workflow_id"      TEXT NOT NULL,
  "organization_id"  UUID NOT NULL,
  "user_id"          UUID,
  "status"           TEXT NOT NULL DEFAULT 'running',
  "current_step_idx" INT NOT NULL DEFAULT 0,
  "total_steps"      INT NOT NULL,
  "variables"        JSONB NOT NULL DEFAULT '{}',
  "step_results"     JSONB NOT NULL DEFAULT '[]',
  "error"            TEXT,
  "started_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completed_at"     TIMESTAMPTZ,
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "workflow_executions_org_id_idx"
  ON "workflow_executions" ("organization_id");
CREATE INDEX IF NOT EXISTS "workflow_executions_workflow_id_idx"
  ON "workflow_executions" ("workflow_id");
CREATE INDEX IF NOT EXISTS "workflow_executions_status_idx"
  ON "workflow_executions" ("status");

-- HNSW index on semantic_memories embedding column (BL-13)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'semantic_memories' AND column_name = 'embedding'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "semantic_memories_embedding_hnsw_idx"
      ON "semantic_memories"
      USING hnsw ("embedding" vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)';
  END IF;
END
$$;
