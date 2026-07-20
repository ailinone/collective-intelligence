-- Migration: Add GIN indexes for Model JSON fields
-- Purpose: Enable efficient PostgreSQL-native filtering/ordering instead of in-memory processing
-- This supports high-performance queries on capabilities, tags, specializations, quality, reliability
-- 
-- Strategy: Use GIN indexes on JSONB columns for fast containment (@>) and path queries
-- Application code will use raw SQL with JSONB operators for complex queries
-- Prisma JSON filters can leverage these indexes for simple path queries

-- Step 1: Add GIN indexes on JSONB columns for fast containment and path queries
-- GIN indexes with jsonb_path_ops enable fast @> (contains) queries on JSONB arrays
-- This allows efficient queries like: WHERE capabilities @> '["vision"]'::jsonb

CREATE INDEX IF NOT EXISTS idx_models_capabilities_gin 
  ON models USING gin (capabilities jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_models_metadata_gin 
  ON models USING gin (metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_models_performance_gin 
  ON models USING gin (performance jsonb_path_ops);

-- Step 2: Add filtered index for active models with capabilities
-- Most queries filter by status='active', so this index is more efficient
CREATE INDEX IF NOT EXISTS idx_models_active_capabilities_gin 
  ON models USING gin (capabilities jsonb_path_ops) 
  WHERE status = 'active';

-- Step 3: Add composite GIN index for metadata tags/specializations queries
-- Enables fast queries on metadata->tags and metadata->specializations arrays
-- Note: Prisma doesn't support these directly, use raw SQL with JSONB operators
CREATE INDEX IF NOT EXISTS idx_models_active_metadata_gin 
  ON models USING gin (metadata jsonb_path_ops) 
  WHERE status = 'active';

-- Step 4: Add partial index for performance JSON queries on active models
-- Optimizes quality/reliability filtering and sorting for active models
CREATE INDEX IF NOT EXISTS idx_models_active_performance_gin 
  ON models USING gin (performance jsonb_path_ops) 
  WHERE status = 'active';

-- Step 5: Add comments for documentation
COMMENT ON INDEX idx_models_capabilities_gin IS 
  'GIN index for fast JSONB array containment queries on capabilities field. Enables efficient queries like: WHERE capabilities @> ''["vision"]''::jsonb';

COMMENT ON INDEX idx_models_metadata_gin IS 
  'GIN index for fast JSONB queries on metadata field (tags, specializations). Use raw SQL with JSONB operators for array containment.';

COMMENT ON INDEX idx_models_performance_gin IS 
  'GIN index for fast JSONB path queries on performance field (quality, reliability, latencyMs, throughput). Prisma JSON path filters can leverage this.';

COMMENT ON INDEX idx_models_active_capabilities_gin IS 
  'Filtered GIN index on capabilities for active models only. More efficient for common queries that filter by status.';

COMMENT ON INDEX idx_models_active_metadata_gin IS 
  'Filtered GIN index on metadata for active models. Optimizes tag/specialization queries on active models.';

COMMENT ON INDEX idx_models_active_performance_gin IS 
  'Filtered GIN index on performance for active models. Optimizes quality/reliability queries on active models.';

