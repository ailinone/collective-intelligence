-- Semantic response cache — pgvector-backed ANN (scale-to-100k Phase 5, issue #150)
--
-- Replaces the prior Redis-only semantic cache, which stored every
-- organization's entries in one Redis SET and, on every lookup, fetched
-- EVERY member (up to maxEntriesPerOrg, default 10,000) and computed cosine
-- similarity in application code — an O(N) scan in both Redis round-trips
-- and CPU that grew unbounded with cache size.
--
-- Reuses the SAME pgvector(384) + HNSW(vector_cosine_ops, m=16,
-- ef_construction=64) infrastructure as vector_store_chunks /
-- semantic_memories (see 20260613000000_vector_store_chunks,
-- 20241226_add_semantic_memory). Embedding reads/writes go through the
-- shared capability pg.Pool via raw SQL because Prisma has no first-class
-- pgvector type.

-- pgvector (already enabled by 20250101000000_add_pgvector_extension; idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "semantic_cache_entries" (
    "id"                TEXT          NOT NULL,
    "organization_id"   UUID          NOT NULL,
    "request_hash"      TEXT          NOT NULL,
    "strategy_key"      TEXT          NOT NULL,
    "model"             TEXT          NOT NULL,
    "embedding"         vector(384),
    "embedding_model"   VARCHAR(64),
    "original_request"  TEXT          NOT NULL,
    "response"          JSONB         NOT NULL,
    "hit_count"         INTEGER       NOT NULL DEFAULT 0,
    "tokens_saved"      INTEGER       NOT NULL DEFAULT 0,
    "cost_saved_usd"    DECIMAL(12,6) NOT NULL DEFAULT 0,
    "created_at"        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    "expires_at"        TIMESTAMPTZ   NOT NULL,

    CONSTRAINT "semantic_cache_entries_pkey" PRIMARY KEY ("id")
);

-- Exact-match fast path: same (org, requestHash) as before, now a plain
-- indexed equality lookup instead of a Redis GET-by-derived-key.
CREATE INDEX "idx_sce_org_hash" ON "semantic_cache_entries" ("organization_id", "request_hash");

-- ANN pre-filter: similarity search is scoped to (org, strategyKey, not
-- expired) before the HNSW kNN ranks candidates — mirrors the prior Redis
-- implementation's strategyKey/expiresAt filtering, now pushed into SQL
-- instead of post-fetch application-code filtering.
CREATE INDEX "idx_sce_org_strategy_expires" ON "semantic_cache_entries" ("organization_id", "strategy_key", "expires_at");

-- TTL sweep (replaces Redis's automatic key expiry — Postgres has no native
-- TTL, so expired rows are deleted lazily on lookup + reaped by a periodic
-- job filtering on this index).
CREATE INDEX "idx_sce_expires" ON "semantic_cache_entries" ("expires_at");

-- HNSW cosine ANN — same parameters as vector_store_chunks / capability
-- search. Online inserts/updates are accepted without REINDEX.
CREATE INDEX "idx_sce_embedding_hnsw" ON "semantic_cache_entries"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

COMMENT ON TABLE "semantic_cache_entries" IS
    'Scale-to-100k Phase 5 (issue #150) — pgvector-backed semantic response cache, replacing the prior O(N) Redis scan.';
COMMENT ON COLUMN "semantic_cache_entries"."embedding" IS
    '384-dim embedding (capability embedder). NULL when only a non-provider fallback embedding was available — those rows are excluded from ANN search but remain reachable via request_hash exact match.';
