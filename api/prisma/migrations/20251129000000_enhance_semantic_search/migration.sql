-- Migration: Enhance Semantic Search
-- Date: 2025-11-29
-- Description: Add advanced semantic search functions with ranking, fuzzy matching, and multi-source search

-- Create enhanced semantic search function
CREATE OR REPLACE FUNCTION search_codebase_semantic(
  search_query TEXT,
  project_id_param UUID DEFAULT NULL,
  symbol_types TEXT[] DEFAULT NULL,
  limit_param INTEGER DEFAULT 50,
  similarity_threshold FLOAT DEFAULT 0.1
)
RETURNS TABLE (
  id UUID,
  file_path TEXT,
  symbol_name TEXT,
  symbol_type TEXT,
  start_line INTEGER,
  end_line INTEGER,
  relevance_score FLOAT,
  match_type TEXT, -- 'symbol_exact', 'symbol_fuzzy', 'content', 'dependency'
  match_context TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH ranked_results AS (
    -- Exact symbol name matches (highest priority)
    SELECT
      s.id,
      f.path as file_path,
      s.name as symbol_name,
      s.type as symbol_type,
      s.start_line,
      s.end_line,
      1.0::FLOAT as relevance_score,
      'symbol_exact'::TEXT as match_type,
      s.signature as match_context
    FROM codebase_symbols s
    JOIN codebase_files f ON f.id = s.file_id
    WHERE (project_id_param IS NULL OR f.project_id = project_id_param)
      AND s.name ILIKE '%' || search_query || '%'
      AND (symbol_types IS NULL OR s.type = ANY(symbol_types))

    UNION ALL

    -- Fuzzy symbol name matches using trigram similarity
    SELECT
      s.id,
      f.path as file_path,
      s.name as symbol_name,
      s.type as symbol_type,
      s.start_line,
      s.end_line,
      GREATEST(similarity(s.name, search_query), similarity_threshold)::FLOAT as relevance_score,
      'symbol_fuzzy'::TEXT as match_type,
      s.signature as match_context
    FROM codebase_symbols s
    JOIN codebase_files f ON f.id = s.file_id
    WHERE (project_id_param IS NULL OR f.project_id = project_id_param)
      AND similarity(s.name, search_query) >= similarity_threshold
      AND (symbol_types IS NULL OR s.type = ANY(symbol_types))
      AND s.name NOT ILIKE '%' || search_query || '%' -- Exclude exact matches

    UNION ALL

    -- Content matches with ranking
    SELECT
      NULL::UUID as id,
      f.path as file_path,
      NULL::TEXT as symbol_name,
      NULL::TEXT as symbol_type,
      NULL::INTEGER as start_line,
      NULL::INTEGER as end_line,
      ts_rank_cd(to_tsvector('english', f.content), plainto_tsquery('english', search_query))::FLOAT as relevance_score,
      'content'::TEXT as match_type,
      substring(f.content, greatest(1, position(search_query in lower(f.content)) - 50), 100) as match_context
    FROM codebase_files f
    WHERE (project_id_param IS NULL OR f.project_id = project_id_param)
      AND f.content ILIKE '%' || search_query || '%'
      AND ts_rank_cd(to_tsvector('english', f.content), plainto_tsquery('english', search_query)) > 0

    UNION ALL

    -- Dependency-based matches
    SELECT
      s.id,
      f.path as file_path,
      s.name as symbol_name,
      s.type as symbol_type,
      s.start_line,
      s.end_line,
      0.7::FLOAT as relevance_score, -- Lower priority than direct matches
      'dependency'::TEXT as match_type,
      d.import_path as match_context
    FROM codebase_dependencies d
    JOIN codebase_symbols s ON (
      (d.source_symbol_id IS NOT NULL AND s.id = d.source_symbol_id) OR
      (d.target_symbol_id IS NOT NULL AND s.id = d.target_symbol_id)
    )
    JOIN codebase_files f ON f.id = s.file_id
    WHERE (project_id_param IS NULL OR f.project_id = project_id_param)
      AND (
        d.import_path ILIKE '%' || search_query || '%' OR
        d.source_symbol_name ILIKE '%' || search_query || '%' OR
        d.target_symbol_name ILIKE '%' || search_query || '%'
      )
  )
  SELECT DISTINCT
    r.id,
    r.file_path,
    r.symbol_name,
    r.symbol_type,
    r.start_line,
    r.end_line,
    r.relevance_score,
    r.match_type,
    r.match_context
  FROM ranked_results r
  ORDER BY
    r.relevance_score DESC,
    CASE r.match_type
      WHEN 'symbol_exact' THEN 1
      WHEN 'symbol_fuzzy' THEN 2
      WHEN 'content' THEN 3
      WHEN 'dependency' THEN 4
      ELSE 5
    END,
    r.file_path,
    r.start_line
  LIMIT limit_param;
END;
$$ LANGUAGE plpgsql;

-- Create function to find symbol references
CREATE OR REPLACE FUNCTION find_symbol_references(
  symbol_name_param TEXT,
  project_id_param UUID DEFAULT NULL,
  include_definition BOOLEAN DEFAULT true
)
RETURNS TABLE (
  reference_type TEXT, -- 'definition', 'usage', 'import', 'export'
  file_path TEXT,
  symbol_name TEXT,
  symbol_type TEXT,
  start_line INTEGER,
  end_line INTEGER,
  context TEXT,
  confidence INTEGER -- 1-100, higher is better
) AS $$
BEGIN
  RETURN QUERY
  WITH symbol_refs AS (
    -- Symbol definitions
    SELECT
      'definition'::TEXT as reference_type,
      f.path as file_path,
      s.name as symbol_name,
      s.type as symbol_type,
      s.start_line,
      s.end_line,
      COALESCE(s.signature, s.name) as context,
      100 as confidence
    FROM codebase_symbols s
    JOIN codebase_files f ON f.id = s.file_id
    WHERE s.name = symbol_name_param
      AND (project_id_param IS NULL OR f.project_id = project_id_param)
      AND include_definition = true

    UNION ALL

    -- Symbol usages via dependencies
    SELECT
      CASE
        WHEN d.type = 'call' THEN 'usage'
        WHEN d.type = 'reference' THEN 'usage'
        WHEN d.type = 'type_reference' THEN 'usage'
        WHEN d.type = 'import' THEN 'import'
        WHEN d.type = 'export' THEN 'export'
        ELSE 'usage'
      END as reference_type,
      f.path as file_path,
      COALESCE(d.source_symbol_name, d.target_symbol_name) as symbol_name,
      NULL::TEXT as symbol_type,
      NULL::INTEGER as start_line,
      NULL::INTEGER as end_line,
      d.import_path as context,
      CASE
        WHEN d.type = 'call' THEN 90
        WHEN d.type = 'reference' THEN 80
        WHEN d.type = 'type_reference' THEN 75
        WHEN d.type = 'import' THEN 95
        WHEN d.type = 'export' THEN 95
        ELSE 70
      END as confidence
    FROM codebase_dependencies d
    JOIN codebase_files f ON (
      (d.source_file_id IS NOT NULL AND f.id = d.source_file_id) OR
      (d.target_file_id IS NOT NULL AND f.id = d.target_file_id)
    )
    WHERE (
      d.source_symbol_name = symbol_name_param OR
      d.target_symbol_name = symbol_name_param OR
      d.import_path ILIKE '%' || symbol_name_param || '%'
    )
    AND (project_id_param IS NULL OR f.project_id = project_id_param)

    UNION ALL

    -- Text-based references in content
    SELECT
      'usage'::TEXT as reference_type,
      f.path as file_path,
      symbol_name_param as symbol_name,
      NULL::TEXT as symbol_type,
      NULL::INTEGER as start_line,
      NULL::INTEGER as end_line,
      substring(f.content, greatest(1, position(lower(symbol_name_param) in lower(f.content)) - 30), 80) as context,
      60 as confidence
    FROM codebase_files f
    WHERE f.content ILIKE '%' || symbol_name_param || '%'
      AND (project_id_param IS NULL OR f.project_id = project_id_param)
      -- Exclude files that already have the symbol defined
      AND NOT EXISTS (
        SELECT 1 FROM codebase_symbols s
        WHERE s.file_id = f.id AND s.name = symbol_name_param
      )
  )
  SELECT DISTINCT
    sr.reference_type,
    sr.file_path,
    sr.symbol_name,
    sr.symbol_type,
    sr.start_line,
    sr.end_line,
    sr.context,
    sr.confidence
  FROM symbol_refs sr
  ORDER BY
    CASE sr.reference_type
      WHEN 'definition' THEN 1
      WHEN 'import' THEN 2
      WHEN 'export' THEN 3
      WHEN 'usage' THEN 4
      ELSE 5
    END,
    sr.confidence DESC,
    sr.file_path,
    sr.start_line;
END;
$$ LANGUAGE plpgsql;

-- Add performance indexes
-- NOTE: CONCURRENTLY removed for test compatibility
-- For production: Apply CONCURRENTLY manually during low-traffic period
CREATE INDEX IF NOT EXISTS idx_codebase_symbols_search_name_trgm
  ON codebase_symbols USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_codebase_files_content_search
  ON codebase_files USING gin (to_tsvector('english', content));

CREATE INDEX IF NOT EXISTS idx_codebase_dependencies_symbols
  ON codebase_dependencies (source_symbol_id, target_symbol_id);

CREATE INDEX IF NOT EXISTS idx_codebase_dependencies_import_path
  ON codebase_dependencies USING gin (import_path gin_trgm_ops);

-- Add comments for documentation
COMMENT ON FUNCTION search_codebase_semantic(TEXT, UUID, TEXT[], INTEGER, FLOAT) IS
'Semantic search across codebase symbols, content, and dependencies with ranking';

COMMENT ON FUNCTION find_symbol_references(TEXT, UUID, BOOLEAN) IS
'Find all references to a symbol including definitions, usages, imports, and exports';

-- Ensure trigram extension is available (for similarity searches)
-- This should be done at database level, not in migration
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;


