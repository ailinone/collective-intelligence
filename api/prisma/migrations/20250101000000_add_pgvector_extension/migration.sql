-- Enable pgvector extension for semantic memory
-- This extension is required for vector similarity search

-- Check if extension exists, create if not
CREATE EXTENSION IF NOT EXISTS vector;

-- Create index for vector similarity search on semantic_memories table
-- This will be applied after the semantic_memories table is created
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'semantic_memories') THEN
        -- Create HNSW index for fast approximate nearest neighbor search
        CREATE INDEX IF NOT EXISTS idx_semantic_memories_embedding_hnsw 
        ON semantic_memories USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
        
        RAISE NOTICE 'Created HNSW index on semantic_memories.embedding';
    ELSE
        RAISE NOTICE 'semantic_memories table does not exist yet, index will be created with table';
    END IF;
END $$;

