-- Bucket-fair candidate retrieval (dynamic-model-selector.ts,
-- getBucketFairCandidateUids) — catalog-visibility fix, 2026-09-07.
--
-- The bucket-only form of the new query already resolves in ~5-7ms via the
-- existing `models_usage_count_idx` backward index scan (measured live,
-- 2026-09-07: no extra predicate). But combining either bucket predicate with
-- a moderately selective `context_window >= N` filter forces a near-full-table
-- scan (measured live: ~147ms for the curated+aggregated union at
-- context_window>=8000, ~28% table selectivity overall but only 119/73,770
-- rows in the aggregated bucket also satisfy it) because no existing index
-- combines either bucket predicate with context_window. This mirrors the
-- proven `models_callable_downloads_idx` technique already in this migration
-- history (20260801000000_selection_hot_query_functional_indexes): a partial
-- index scoped to the exact bucket predicate turns an otherwise-rare
-- AND-combination into a fast index scan instead of a scan of nearly the
-- whole table.
--
-- Both partial predicates below match the WHERE clauses
-- getBucketFairCandidateUids() uses EXACTLY (required for a partial index to
-- be eligible) and are ordinary B-tree indexes over a scalar column — cost
-- stays O(log n) as the catalog grows; nothing here depends on table size for
-- correctness, only for the constant factor.
--
-- NOTE: CONCURRENTLY removed for test/CI compatibility (Prisma migrations run
-- inside a transaction; CONCURRENTLY cannot run inside one).
-- For production: apply CONCURRENTLY manually during a low-traffic window,
-- e.g.:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "models_curated_context_idx"
--     ON "models" (context_window DESC)
--     WHERE status <> 'disabled' AND (metadata->>'hubInventoryClass') IS DISTINCT FROM 'aggregated_index';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "models_aggregated_context_idx"
--     ON "models" (context_window DESC)
--     WHERE status <> 'disabled' AND metadata @> '{"serverless_callable":true}'::jsonb;

CREATE INDEX IF NOT EXISTS "models_curated_context_idx"
  ON "models" (context_window DESC)
  WHERE status <> 'disabled' AND (metadata->>'hubInventoryClass') IS DISTINCT FROM 'aggregated_index';

CREATE INDEX IF NOT EXISTS "models_aggregated_context_idx"
  ON "models" (context_window DESC)
  WHERE status <> 'disabled' AND metadata @> '{"serverless_callable":true}'::jsonb;
