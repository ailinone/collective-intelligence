-- F1.5 — Ailin¹ Collective Coordination Layer persistence
--
-- Tables:
--   1. collective_runs    — one row per multi-round coordination attempt
--   2. collective_signals — one row per agent emission within a run
--
-- The strategy persists these tables only when
-- `CoordinationConfig.persistAuditTrail = true` (default `false`), so
-- under default operation this layer adds zero write traffic. PII is
-- already redacted by signal-validator before any field reaches this
-- migration's columns.

-- ============================================================================
-- 1. collective_runs
-- ============================================================================
CREATE TABLE "collective_runs" (
    "id"                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "organization_id"     UUID            NOT NULL,
    "request_id"          TEXT,
    "strategy"            VARCHAR(64)     NOT NULL,
    "config"              JSONB           NOT NULL DEFAULT '{}',

    -- Outcome
    "rounds"              INTEGER         NOT NULL,
    "stop_reason"         VARCHAR(64)     NOT NULL,
    "convergence_score"   DECIMAL(4, 3)   NOT NULL DEFAULT 0,
    "decision_flip_rate"  DECIMAL(4, 3)   NOT NULL DEFAULT 0,
    "dissent"             DECIMAL(4, 3)   NOT NULL DEFAULT 0,

    -- Resource accounting
    "total_cost_usd"      DECIMAL(10, 6)  NOT NULL DEFAULT 0,
    "total_latency_ms"    INTEGER         NOT NULL DEFAULT 0,
    "total_tokens"        INTEGER         NOT NULL DEFAULT 0,

    -- Final decision
    "final_decision_type" VARCHAR(64),
    "final_confidence"    DECIMAL(3, 2),

    -- Free-form audit / dominantSensitivities / criticalVariables
    "metadata"            JSONB           NOT NULL DEFAULT '{}',

    "created_at"          TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fk_collective_runs_organization"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE INDEX "collective_runs_org_created_idx"
    ON "collective_runs" ("organization_id", "created_at" DESC);
CREATE INDEX "collective_runs_request_idx"
    ON "collective_runs" ("request_id");
CREATE INDEX "collective_runs_strategy_idx"
    ON "collective_runs" ("strategy");

COMMENT ON TABLE "collective_runs" IS
    'F1.5 — one row per Ailin¹ collective coordination run (multi-round). Org-scoped via organization_id; query path always includes organization_id for tenant isolation.';

-- ============================================================================
-- 2. collective_signals
-- ============================================================================
CREATE TABLE "collective_signals" (
    "id"                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "run_id"              UUID            NOT NULL,
    "round"               INTEGER         NOT NULL,

    -- Agent identification
    "agent_id"            VARCHAR(128)    NOT NULL,
    "model_id"            VARCHAR(128)    NOT NULL,
    "provider_id"         VARCHAR(64)     NOT NULL,
    "role"                VARCHAR(32),

    -- Decision (PII-redacted upstream)
    "decision_type"       VARCHAR(64)     NOT NULL,
    "decision_value"      JSONB           NOT NULL,
    "decision_confidence" DECIMAL(3, 2)   NOT NULL,
    "decision_rationale"  TEXT,

    -- Sensitivities (Sensitivity[])
    "sensitivities"       JSONB           NOT NULL DEFAULT '[]',

    -- Per-call metrics
    "latency_ms"          INTEGER,
    "input_tokens"        INTEGER,
    "output_tokens"       INTEGER,
    "cost_usd"            DECIMAL(10, 6),

    "created_at"          TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fk_collective_signals_run"
        FOREIGN KEY ("run_id") REFERENCES "collective_runs"("id") ON DELETE CASCADE
);

CREATE INDEX "collective_signals_run_round_idx"
    ON "collective_signals" ("run_id", "round");
CREATE INDEX "collective_signals_model_idx"
    ON "collective_signals" ("model_id");

COMMENT ON TABLE "collective_signals" IS
    'F1.5 — one row per agent emission within a collective_runs row. Cascade deletes with run.';
