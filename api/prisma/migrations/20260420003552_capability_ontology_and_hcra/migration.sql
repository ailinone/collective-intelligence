-- HCRA Sprint 1 — Foundation (ADR-022)
--
-- Tables:
--   1. capability_ontology               — URI-keyed capability catalog (governance layer)
--   2. model_capability_assertions       — append-only provenance log (event-sourced)
--   3. models patches                    — capability_uris/confidence/sources/embedding columns
--
-- The legacy models.capabilities JSONB column is RETAINED during the migration window;
-- it is now a derived projection of capability_uris. To be dropped in the next major
-- once all consumers have migrated.

-- ============================================================================
-- pgvector (already enabled by 20250101000000_add_pgvector_extension, idempotent)
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- 1. capability_ontology
-- ============================================================================
-- URI-keyed catalog. Capabilities are first-class data; the TypeScript union
-- becomes a generated cached snapshot. Adding a capability is one INSERT,
-- not a code deploy.
CREATE TABLE "capability_ontology" (
    "uri"               TEXT            PRIMARY KEY,
    "schema_version"    INTEGER         NOT NULL DEFAULT 1,
    "preferred_label"   TEXT            NOT NULL,
    "labels"            JSONB           NOT NULL DEFAULT '{}',
    "synonyms"          TEXT[]          NOT NULL DEFAULT '{}',
    "description"       TEXT,
    "broader"           TEXT[]          NOT NULL DEFAULT '{}',
    "narrower"          TEXT[]          NOT NULL DEFAULT '{}',
    "category"          TEXT            NOT NULL,
    "status"            TEXT            NOT NULL DEFAULT 'active',
    "embedding"         vector(384),
    "created_at"        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "updated_at"        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "deprecated_by"     TEXT,
    CONSTRAINT "chk_cap_ont_status"
        CHECK ("status" IN ('active', 'deprecated', 'experimental')),
    CONSTRAINT "chk_cap_ont_category"
        CHECK ("category" IN ('modality', 'task', 'safety', 'language', 'tool', 'meta')),
    CONSTRAINT "chk_cap_ont_uri_format"
        CHECK ("uri" ~ '^http://ailin\.dev/cap/v[0-9]+/[a-z0-9_-]+$'),
    CONSTRAINT "fk_cap_ont_deprecated_by"
        FOREIGN KEY ("deprecated_by") REFERENCES "capability_ontology"("uri")
        ON DELETE SET NULL
);

CREATE INDEX "idx_cap_ont_synonyms_gin"     ON "capability_ontology" USING GIN ("synonyms");
CREATE INDEX "idx_cap_ont_labels_gin"       ON "capability_ontology" USING GIN ("labels" jsonb_path_ops);
CREATE INDEX "idx_cap_ont_broader_gin"      ON "capability_ontology" USING GIN ("broader");
CREATE INDEX "idx_cap_ont_narrower_gin"     ON "capability_ontology" USING GIN ("narrower");
CREATE INDEX "idx_cap_ont_category_active"  ON "capability_ontology" ("category") WHERE "status" = 'active';
-- HNSW for query-side semantic expansion (small table, ef_construction can be modest)
CREATE INDEX "idx_cap_ont_embedding_hnsw"   ON "capability_ontology"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

COMMENT ON TABLE "capability_ontology" IS
    'ADR-022 — URI-keyed capability catalog. Capabilities are data, not code.';

-- ============================================================================
-- 2. model_capability_assertions
-- ============================================================================
-- Append-only provenance log. Mirrors L11 routing_event pattern. The
-- materialised projection on `models` is rebuilt by assertions/materialiser.ts
-- using Bayesian fusion. Querying history: read this table directly.
CREATE TABLE "model_capability_assertions" (
    "id"             BIGSERIAL       PRIMARY KEY,
    "model_uid"      VARCHAR(32)     NOT NULL,
    "capability_uri" TEXT            NOT NULL,
    "source"         TEXT            NOT NULL,
    "source_detail"  JSONB           NOT NULL DEFAULT '{}',
    "confidence"     REAL            NOT NULL,
    "asserted_value" BOOLEAN         NOT NULL DEFAULT TRUE,
    "observed_at"    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "ttl_days"       INTEGER         NOT NULL DEFAULT 30,
    "superseded_at"  TIMESTAMPTZ,
    "superseded_by"  BIGINT,
    CONSTRAINT "chk_mca_source"
        CHECK ("source" IN (
            'provider-declared', 'helicone-oracle', 'modality-derived',
            'parameter-derived', 'name-regex', 'llm-extracted', 'operator-override'
        )),
    CONSTRAINT "chk_mca_confidence"
        CHECK ("confidence" BETWEEN 0 AND 1),
    CONSTRAINT "chk_mca_ttl_positive"
        CHECK ("ttl_days" > 0),
    CONSTRAINT "fk_mca_model"
        FOREIGN KEY ("model_uid") REFERENCES "models"("uid") ON DELETE CASCADE,
    CONSTRAINT "fk_mca_capability"
        FOREIGN KEY ("capability_uri") REFERENCES "capability_ontology"("uri") ON DELETE RESTRICT,
    CONSTRAINT "fk_mca_superseded_by"
        FOREIGN KEY ("superseded_by") REFERENCES "model_capability_assertions"("id") ON DELETE SET NULL
);

-- Hot path: materialiser scans active assertions for one (model, capability) pair.
CREATE INDEX "idx_mca_model_cap_active"
    ON "model_capability_assertions" ("model_uid", "capability_uri")
    WHERE "superseded_at" IS NULL;
-- Append-only time-series → BRIN is the right tool, ~1000× smaller than B-tree.
CREATE INDEX "idx_mca_observed_brin"
    ON "model_capability_assertions" USING BRIN ("observed_at");
CREATE INDEX "idx_mca_source"
    ON "model_capability_assertions" ("source")
    WHERE "superseded_at" IS NULL;

COMMENT ON TABLE "model_capability_assertions" IS
    'ADR-022 — append-only provenance log. Materialiser projects to models.capability_*.';

-- ============================================================================
-- 3. models patches
-- ============================================================================
-- New columns are the materialised projection of assertions. The legacy
-- `capabilities JSONB` column stays for one release window — backfill writes
-- to both so consumers can migrate at their pace.
ALTER TABLE "models"
    ADD COLUMN "capability_uris"       TEXT[]      NOT NULL DEFAULT '{}',
    ADD COLUMN "capability_confidence" JSONB       NOT NULL DEFAULT '{}',
    ADD COLUMN "capability_sources"    JSONB       NOT NULL DEFAULT '{}',
    ADD COLUMN "capability_updated_at" TIMESTAMPTZ,
    ADD COLUMN "embedding"             vector(384);

COMMENT ON COLUMN "models"."capability_uris" IS
    'ADR-022 — primary capability index. URIs reference capability_ontology(uri).';
COMMENT ON COLUMN "models"."capability_confidence" IS
    'ADR-022 — {uri: 0..1} Bayesian-fused confidence. Read by L5/L10 bandits for ranking.';
COMMENT ON COLUMN "models"."capability_sources" IS
    'ADR-022 — {uri: [source,...]} provenance summary, sorted strongest-first.';
COMMENT ON COLUMN "models"."capabilities" IS
    'DEPRECATED — derived projection of capability_uris. Read capability_uris instead. Drop in next major.';

-- Hot path: bandit recall narrows to active models with ALL required capabilities.
CREATE INDEX "idx_models_cap_uris_gin"          ON "models" USING GIN ("capability_uris");
CREATE INDEX "idx_models_active_cap_uris_gin"   ON "models" USING GIN ("capability_uris")
    WHERE "status" = 'active';
CREATE INDEX "idx_models_cap_confidence_gin"    ON "models" USING GIN ("capability_confidence" jsonb_path_ops);
CREATE INDEX "idx_models_embedding_hnsw"        ON "models"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE "status" = 'active';
CREATE INDEX "idx_models_cap_updated_brin"      ON "models" USING BRIN ("capability_updated_at");
