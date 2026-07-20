-- Migration: Add codebase symbols, dependencies, and enhanced search
-- Purpose: Support CLI tool integration for code analysis and semantic search

-- 1. Create codebase_symbols table for storing extracted symbols
CREATE TABLE IF NOT EXISTS codebase_symbols (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id UUID NOT NULL REFERENCES codebase_files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    qualified_name TEXT, -- Full qualified name (e.g., "module.class.method")
    type TEXT NOT NULL CHECK (type IN ('function', 'class', 'variable', 'method', 'interface', 'enum', 'constant', 'type', 'import', 'export')),
    kind TEXT, -- Language-specific kind (e.g., 'async function', 'arrow function')
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_column INTEGER,
    end_column INTEGER,
    signature TEXT, -- Function/method signature
    documentation TEXT, -- JSDoc, docstring, etc.
    visibility TEXT CHECK (visibility IN ('public', 'private', 'protected', 'internal')),
    is_async BOOLEAN DEFAULT false,
    is_static BOOLEAN DEFAULT false,
    is_exported BOOLEAN DEFAULT false,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create codebase_dependencies table for tracking relationships
CREATE TABLE IF NOT EXISTS codebase_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES codebase_projects(id) ON DELETE CASCADE,
    source_file_id UUID NOT NULL REFERENCES codebase_files(id) ON DELETE CASCADE,
    target_file_id UUID REFERENCES codebase_files(id) ON DELETE SET NULL, -- NULL for external deps
    source_symbol_id UUID REFERENCES codebase_symbols(id) ON DELETE CASCADE,
    target_symbol_id UUID REFERENCES codebase_symbols(id) ON DELETE SET NULL,
    dependency_type TEXT NOT NULL CHECK (dependency_type IN ('import', 'export', 'call', 'inherit', 'implement', 'reference', 'type_reference')),
    import_path TEXT, -- Original import path
    is_external BOOLEAN DEFAULT false, -- External (npm) dependency
    is_dynamic BOOLEAN DEFAULT false, -- Dynamic import
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create codebase_checkpoints table for incremental indexing
CREATE TABLE IF NOT EXISTS codebase_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES codebase_projects(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    commit_sha TEXT,
    file_count INTEGER DEFAULT 0,
    symbol_count INTEGER DEFAULT 0,
    dependency_count INTEGER DEFAULT 0,
    total_lines INTEGER DEFAULT 0,
    total_size_bytes BIGINT DEFAULT 0,
    file_hashes JSONB DEFAULT '{}', -- Map of file path -> hash for change detection
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'indexing', 'completed', 'failed')),
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(project_id, branch)
);

-- 4. Performance indexes for symbols
CREATE INDEX IF NOT EXISTS idx_codebase_symbols_file_id ON codebase_symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_codebase_symbols_type ON codebase_symbols(type);
CREATE INDEX IF NOT EXISTS idx_codebase_symbols_name ON codebase_symbols(name);
CREATE INDEX IF NOT EXISTS idx_codebase_symbols_file_type ON codebase_symbols(file_id, type);
CREATE INDEX IF NOT EXISTS idx_codebase_symbols_exported ON codebase_symbols(is_exported) WHERE is_exported = true;

-- 5. Full-text search index for symbol names
CREATE INDEX IF NOT EXISTS idx_codebase_symbols_name_gin ON codebase_symbols USING gin(to_tsvector('english', name));

-- 6. Trigram index for fuzzy search on symbol names
CREATE INDEX IF NOT EXISTS idx_codebase_symbols_name_trgm ON codebase_symbols USING gin(name gin_trgm_ops);

-- 7. Performance indexes for dependencies
CREATE INDEX IF NOT EXISTS idx_codebase_dependencies_project ON codebase_dependencies(project_id);
CREATE INDEX IF NOT EXISTS idx_codebase_dependencies_source ON codebase_dependencies(source_file_id);
CREATE INDEX IF NOT EXISTS idx_codebase_dependencies_target ON codebase_dependencies(target_file_id);
CREATE INDEX IF NOT EXISTS idx_codebase_dependencies_type ON codebase_dependencies(dependency_type);
CREATE INDEX IF NOT EXISTS idx_codebase_dependencies_source_target ON codebase_dependencies(source_file_id, target_file_id);

-- 8. Indexes for checkpoints
CREATE INDEX IF NOT EXISTS idx_codebase_checkpoints_project ON codebase_checkpoints(project_id);
CREATE INDEX IF NOT EXISTS idx_codebase_checkpoints_status ON codebase_checkpoints(status);

-- 9. Enhanced full-text search on codebase_files content
CREATE INDEX IF NOT EXISTS idx_codebase_files_content_gin ON codebase_files USING gin(to_tsvector('english', content));

-- 10. Trigram index for fuzzy content search
CREATE INDEX IF NOT EXISTS idx_codebase_files_content_trgm ON codebase_files USING gin(content gin_trgm_ops);

-- 11. Composite index for file path searching
CREATE INDEX IF NOT EXISTS idx_codebase_files_path_trgm ON codebase_files USING gin(path gin_trgm_ops);

-- 12. Function for semantic search ranking
CREATE OR REPLACE FUNCTION search_codebase_semantic(
    p_project_id UUID,
    p_query TEXT,
    p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
    file_id UUID,
    file_path TEXT,
    content_snippet TEXT,
    symbol_matches JSONB,
    relevance_score FLOAT,
    match_type TEXT
) AS $$
BEGIN
    RETURN QUERY
    WITH 
    -- Full-text search on content
    content_matches AS (
        SELECT 
            cf.id,
            cf.path,
            ts_headline('english', cf.content, plainto_tsquery('english', p_query), 
                'MaxWords=60, MinWords=30, StartSel=<<<, StopSel=>>>') as snippet,
            ts_rank(to_tsvector('english', cf.content), plainto_tsquery('english', p_query)) as rank,
            'content' as match_type
        FROM codebase_files cf
        WHERE cf.project_id = p_project_id
        AND to_tsvector('english', cf.content) @@ plainto_tsquery('english', p_query)
    ),
    -- Symbol name matches
    symbol_matches AS (
        SELECT 
            cf.id,
            cf.path,
            jsonb_agg(jsonb_build_object(
                'name', cs.name,
                'type', cs.type,
                'line', cs.start_line
            )) as symbols,
            MAX(similarity(cs.name, p_query)) as rank,
            'symbol' as match_type
        FROM codebase_files cf
        JOIN codebase_symbols cs ON cs.file_id = cf.id
        WHERE cf.project_id = p_project_id
        AND (
            cs.name ILIKE '%' || p_query || '%'
            OR similarity(cs.name, p_query) > 0.3
        )
        GROUP BY cf.id, cf.path
    )
    -- Combine and rank results
    SELECT 
        COALESCE(cm.id, sm.id) as file_id,
        COALESCE(cm.path, sm.path) as file_path,
        cm.snippet as content_snippet,
        COALESCE(sm.symbols, '[]'::jsonb) as symbol_matches,
        GREATEST(COALESCE(cm.rank, 0), COALESCE(sm.rank, 0)) as relevance_score,
        CASE 
            WHEN cm.id IS NOT NULL AND sm.id IS NOT NULL THEN 'both'
            WHEN cm.id IS NOT NULL THEN 'content'
            ELSE 'symbol'
        END as match_type
    FROM content_matches cm
    FULL OUTER JOIN symbol_matches sm ON cm.id = sm.id
    ORDER BY relevance_score DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- 13. Function for finding symbol references
CREATE OR REPLACE FUNCTION find_symbol_references(
    p_project_id UUID,
    p_symbol_name TEXT,
    p_symbol_type TEXT DEFAULT NULL
)
RETURNS TABLE (
    symbol_id UUID,
    file_path TEXT,
    symbol_name TEXT,
    symbol_type TEXT,
    start_line INTEGER,
    end_line INTEGER,
    is_definition BOOLEAN,
    reference_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        cs.id,
        cf.path,
        cs.name,
        cs.type,
        cs.start_line,
        cs.end_line,
        cs.is_exported as is_definition,
        (
            SELECT COUNT(*)
            FROM codebase_dependencies cd
            WHERE cd.target_symbol_id = cs.id
        ) as reference_count
    FROM codebase_symbols cs
    JOIN codebase_files cf ON cf.id = cs.file_id
    JOIN codebase_projects cp ON cp.id = cf.project_id
    WHERE cp.id = p_project_id
    AND cs.name = p_symbol_name
    AND (p_symbol_type IS NULL OR cs.type = p_symbol_type)
    ORDER BY cs.is_exported DESC, reference_count DESC;
END;
$$ LANGUAGE plpgsql;

-- 14. Function for dependency graph
CREATE OR REPLACE FUNCTION get_dependency_graph(
    p_project_id UUID,
    p_file_path TEXT DEFAULT NULL,
    p_depth INTEGER DEFAULT 2
)
RETURNS TABLE (
    source_file TEXT,
    target_file TEXT,
    dependency_type TEXT,
    import_path TEXT,
    depth INTEGER
) AS $$
WITH RECURSIVE dep_tree AS (
    -- Base case: direct dependencies
    SELECT 
        sf.path as source_file,
        COALESCE(tf.path, cd.import_path) as target_file,
        cd.dependency_type,
        cd.import_path,
        1 as depth
    FROM codebase_dependencies cd
    JOIN codebase_files sf ON sf.id = cd.source_file_id
    LEFT JOIN codebase_files tf ON tf.id = cd.target_file_id
    WHERE cd.project_id = p_project_id
    AND (p_file_path IS NULL OR sf.path = p_file_path)
    
    UNION ALL
    
    -- Recursive case: transitive dependencies
    SELECT 
        dt.target_file as source_file,
        COALESCE(tf.path, cd.import_path) as target_file,
        cd.dependency_type,
        cd.import_path,
        dt.depth + 1
    FROM dep_tree dt
    JOIN codebase_files sf ON sf.path = dt.target_file
    JOIN codebase_dependencies cd ON cd.source_file_id = sf.id
    LEFT JOIN codebase_files tf ON tf.id = cd.target_file_id
    WHERE dt.depth < p_depth
    AND cd.project_id = p_project_id
)
SELECT DISTINCT source_file, target_file, dependency_type, import_path, depth
FROM dep_tree
ORDER BY depth, source_file, target_file;
$$ LANGUAGE SQL;

-- 15. Add updated_at trigger for symbols
CREATE OR REPLACE FUNCTION update_codebase_symbols_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_codebase_symbols_updated_at ON codebase_symbols;
CREATE TRIGGER trigger_update_codebase_symbols_updated_at
    BEFORE UPDATE ON codebase_symbols
    FOR EACH ROW
    EXECUTE FUNCTION update_codebase_symbols_updated_at();

-- 16. Add updated_at trigger for checkpoints
CREATE OR REPLACE FUNCTION update_codebase_checkpoints_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_codebase_checkpoints_updated_at ON codebase_checkpoints;
CREATE TRIGGER trigger_update_codebase_checkpoints_updated_at
    BEFORE UPDATE ON codebase_checkpoints
    FOR EACH ROW
    EXECUTE FUNCTION update_codebase_checkpoints_updated_at();

