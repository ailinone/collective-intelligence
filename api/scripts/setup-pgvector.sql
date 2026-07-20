-- Copyright (C) 2026 Ailin One, Inc.
--
-- This file is part of Collective Intelligence Engine (ci).
-- Licensed under the GNU Affero General Public License v3.0 or later.
-- See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Source: https://github.com/ailinone/collective-intelligence

-- ============================================
-- pgvector Setup Script for Ailin Dev
-- ============================================
-- Run this script on your PostgreSQL database before running migrations
-- if pgvector is not already installed.
-- 
-- For GCP Cloud SQL, pgvector is available as an extension.
-- For self-hosted PostgreSQL, you may need to install pgvector first.
-- See: https://github.com/pgvector/pgvector
-- ============================================

-- 1. Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Verify installation
SELECT * FROM pg_available_extensions WHERE name = 'vector';

-- 3. Create semantic_memories table (if not created by Prisma migration)
-- Note: This table is managed by Prisma, this is just for reference
/*
CREATE TABLE IF NOT EXISTS semantic_memories (
    id VARCHAR(255) PRIMARY KEY,
    organization_id UUID NOT NULL,
    user_id UUID,
    type VARCHAR(50) NOT NULL, -- 'episodic', 'semantic', 'procedural'
    content TEXT NOT NULL,
    embedding vector(1536), -- OpenAI text-embedding-3-small dimensions
    metadata JSONB DEFAULT '{}',
    importance FLOAT DEFAULT 0.5,
    access_count INT DEFAULT 0,
    last_accessed_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP
);
*/

-- 4. Create indexes for efficient querying
-- These will be created after the table exists

-- Regular indexes (created by Prisma)
-- CREATE INDEX IF NOT EXISTS idx_semantic_memories_org ON semantic_memories(organization_id);
-- CREATE INDEX IF NOT EXISTS idx_semantic_memories_org_type ON semantic_memories(organization_id, type);
-- CREATE INDEX IF NOT EXISTS idx_semantic_memories_org_user ON semantic_memories(organization_id, user_id);
-- CREATE INDEX IF NOT EXISTS idx_semantic_memories_expires ON semantic_memories(expires_at);

-- HNSW index for fast approximate nearest neighbor search
-- This is significantly faster than exact search for large datasets
-- CREATE INDEX IF NOT EXISTS idx_semantic_memories_embedding_hnsw 
-- ON semantic_memories USING hnsw (embedding vector_cosine_ops)
-- WITH (m = 16, ef_construction = 64);

-- Alternative: IVFFlat index (faster to build, slightly less accurate)
-- CREATE INDEX IF NOT EXISTS idx_semantic_memories_embedding_ivf
-- ON semantic_memories USING ivfflat (embedding vector_cosine_ops)
-- WITH (lists = 100);

-- 5. Example queries for semantic search

-- Find similar memories using cosine distance (<=> operator)
/*
SELECT 
    id,
    content,
    type,
    importance,
    1 - (embedding <=> '[0.1, 0.2, ...]'::vector) as similarity
FROM semantic_memories
WHERE organization_id = 'your-org-id'
  AND (expires_at IS NULL OR expires_at > NOW())
  AND 1 - (embedding <=> '[0.1, 0.2, ...]'::vector) >= 0.7
ORDER BY similarity DESC
LIMIT 10;
*/

-- Find memories within a certain distance
/*
SELECT *
FROM semantic_memories
WHERE organization_id = 'your-org-id'
  AND embedding <=> '[0.1, 0.2, ...]'::vector < 0.3
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 10;
*/

RAISE NOTICE 'pgvector setup complete!';

