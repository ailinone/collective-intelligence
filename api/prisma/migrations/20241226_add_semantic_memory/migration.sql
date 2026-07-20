-- Semantic Memory Store Migration
-- Adds vector storage for semantic memory (Collective Intelligence)
-- Requires pgvector extension

-- Enable pgvector extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS vector;

-- Create semantic_memories table
CREATE TABLE IF NOT EXISTS "semantic_memories" (
    "id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "last_accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "semantic_memories_pkey" PRIMARY KEY ("id")
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS "semantic_memories_organization_id_idx" ON "semantic_memories"("organization_id");
CREATE INDEX IF NOT EXISTS "semantic_memories_organization_id_type_idx" ON "semantic_memories"("organization_id", "type");
CREATE INDEX IF NOT EXISTS "semantic_memories_organization_id_user_id_idx" ON "semantic_memories"("organization_id", "user_id");
CREATE INDEX IF NOT EXISTS "semantic_memories_type_idx" ON "semantic_memories"("type");
CREATE INDEX IF NOT EXISTS "semantic_memories_expires_at_idx" ON "semantic_memories"("expires_at");

-- HNSW index for fast approximate nearest neighbor search
-- This significantly speeds up vector similarity queries
CREATE INDEX IF NOT EXISTS "semantic_memories_embedding_idx" ON "semantic_memories" 
USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Comment on table
COMMENT ON TABLE "semantic_memories" IS 'Semantic memory store for Collective Intelligence system';
COMMENT ON COLUMN "semantic_memories"."type" IS 'Memory type: episodic (conversations), semantic (knowledge), procedural (patterns)';
COMMENT ON COLUMN "semantic_memories"."embedding" IS 'Vector embedding (1536 dimensions for OpenAI text-embedding-3-small)';
COMMENT ON COLUMN "semantic_memories"."importance" IS 'Importance score 0-1, higher = more important for retrieval';

