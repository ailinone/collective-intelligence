-- HCRA Sprint 3 — Embedding Versioning (ADR-022)
--
-- Adds `embedding_model` + `embedding_updated_at` to the two tables that
-- already carry a `vector(384)` column. The worker uses these to:
--   1. Find rows with no embedding (`embedding IS NULL`).
--   2. Find rows embedded by an OUTDATED model (e.g. we upgrade from
--      bge-small-en-v1.5 → bge-base-en-v1.5 — only the rows tagged with the
--      old model need reprocessing, not the whole catalog).
--   3. Find rows whose payload changed AFTER embedding was generated
--      (compare `updated_at` > `embedding_updated_at`).
--
-- Why TEXT not ENUM: model names rotate frequently and we never query by
-- model name (it's a metadata tag, not a filter dimension). ENUM would
-- require a migration for each new embedder.

ALTER TABLE "capability_ontology"
    ADD COLUMN "embedding_model"      VARCHAR(64),
    ADD COLUMN "embedding_updated_at" TIMESTAMPTZ;

ALTER TABLE "models"
    ADD COLUMN "embedding_model"      VARCHAR(64),
    ADD COLUMN "embedding_updated_at" TIMESTAMPTZ;

-- Partial index: hot path is "find rows that need (re)embedding".
-- Models is large (6,800+ rows growing to 20k); ontology is tiny so no index needed.
CREATE INDEX "idx_models_embedding_stale"
    ON "models" ("embedding_updated_at")
    WHERE "embedding" IS NULL OR "embedding_model" IS NULL;

COMMENT ON COLUMN "capability_ontology"."embedding_model" IS
    'ADR-022 — embedder identity. NULL means embedding is missing or stale.';
COMMENT ON COLUMN "models"."embedding_model" IS
    'ADR-022 — embedder identity. NULL means embedding is missing or stale.';
