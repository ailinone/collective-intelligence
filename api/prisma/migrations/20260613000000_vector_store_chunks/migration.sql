-- Vector Store Chunks — real vector search for RAG (F3/F1 §P4)
--
-- Turns vector-stores from metadata-only into a real embedding store. When a
-- file is associated with a vector store, its content is chunked, embedded
-- (384-dim, HCRA embedder — OpenAI text-embedding-3-small@384 or a TEI
-- sidecar) and persisted here. `POST /v1/vector_stores/{id}/search` embeds the
-- query and runs a pgvector cosine kNN over these rows.
--
-- Reuses the SAME pgvector(384) + HNSW(vector_cosine_ops, m=16,
-- ef_construction=64) infrastructure as capability-search / the models table.
-- Embedding reads/writes go through the shared capability pg.Pool via raw SQL
-- because Prisma has no first-class pgvector type.

-- pgvector (already enabled by 20250101000000_add_pgvector_extension; idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Per-file processing bookkeeping added to the association table.
ALTER TABLE "vector_store_files"
    ADD COLUMN "last_error"  TEXT,
    ADD COLUMN "chunk_count" INTEGER NOT NULL DEFAULT 0;

-- ============================================================================
-- vector_store_chunks
-- ============================================================================
CREATE TABLE "vector_store_chunks" (
    "id"                   TEXT          NOT NULL,
    "vector_store_id"      TEXT          NOT NULL,
    "file_id"              TEXT          NOT NULL,
    "vector_store_file_id" TEXT          NOT NULL,
    "organization_id"      UUID          NOT NULL,
    "chunk_index"          INTEGER       NOT NULL,
    "content"              TEXT          NOT NULL,
    "embedding"            vector(384),
    "embedding_model"      VARCHAR(64),
    "metadata"             JSONB         NOT NULL DEFAULT '{}',
    "created_at"           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT "vector_store_chunks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_vsc_vector_store"
        FOREIGN KEY ("vector_store_id") REFERENCES "vector_stores"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_vsc_vector_store_file"
        FOREIGN KEY ("vector_store_file_id") REFERENCES "vector_store_files"("id") ON DELETE CASCADE
);

-- Filter indexes: search scopes to one store (and optionally one file); tenant
-- isolation filters on organization_id. The hot path is "all chunks for a
-- store, ranked by cosine distance" — the HNSW index serves the kNN, these
-- btree indexes serve the equality pre-filters and cascade deletes.
CREATE INDEX "idx_vsc_vector_store"      ON "vector_store_chunks" ("vector_store_id");
CREATE INDEX "idx_vsc_vector_store_file" ON "vector_store_chunks" ("vector_store_file_id");
CREATE INDEX "idx_vsc_file"              ON "vector_store_chunks" ("file_id");
CREATE INDEX "idx_vsc_organization"      ON "vector_store_chunks" ("organization_id");

-- HNSW cosine ANN — same parameters as capability_ontology / models. Online
-- inserts/updates are accepted without REINDEX.
CREATE INDEX "idx_vsc_embedding_hnsw"    ON "vector_store_chunks"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

COMMENT ON TABLE "vector_store_chunks" IS
    'F3/F1 §P4 — per-chunk embeddings for vector-store similarity search (RAG).';
COMMENT ON COLUMN "vector_store_chunks"."embedding" IS
    '384-dim embedding (HCRA embedder). NULL until ingest completes.';
