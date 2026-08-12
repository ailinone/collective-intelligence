-- Functional indexes for the two raw-SQL queries on the hot model-selection
-- path (identified by latency audit + live-prod profiling, 2026-07-31/08-01):
-- both filter/sort on JSONB text-extraction expressions that the existing
-- GIN(jsonb_path_ops) index on `metadata` cannot serve — that index type only
-- accelerates containment (`@>`/`?`), not `->>'key'` comparisons or
-- `ORDER BY (expr)::numeric`. Symptom in prod: model-selection latency spikes
-- to 14-19s under concurrency (avg ~1.3s), on a table of ~76.5k rows.
--
-- NOTE: CONCURRENTLY removed for test/CI compatibility (Prisma migrations run
-- inside a transaction; CONCURRENTLY cannot).
-- For production: apply CONCURRENTLY manually during a low-traffic window,
-- e.g.:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "models_hub_inventory_class_idx"
--     ON "models" ((metadata->>'hubInventoryClass'));
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "models_callable_downloads_idx"
--     ON "models" (((metadata->>'downloads')::numeric) DESC)
--     WHERE (metadata->>'serverless_callable') = 'true' AND (metadata->>'downloads') IS NOT NULL;

-- getVerifiedHubUids() (dynamic-model-selector.ts): process-wide 60s-cached,
-- but on every cache-miss scans the full table evaluating
-- `(metadata->>'hubInventoryClass') IS DISTINCT FROM 'aggregated_index'`
-- per row before the usage_count sort/limit.
CREATE INDEX IF NOT EXISTS "models_hub_inventory_class_idx"
  ON "models" ((metadata->>'hubInventoryClass'));

-- Popularity-seed query (dynamic-model-selector.ts, findModelsByRequirements):
-- UNCACHED, runs on effectively every selection that reaches the database
-- path. Partial + expression index matches the query's WHERE and ORDER BY
-- exactly, so it can serve as a direct index scan instead of a sequential
-- scan + in-memory sort over the full callable subset.
CREATE INDEX IF NOT EXISTS "models_callable_downloads_idx"
  ON "models" (((metadata->>'downloads')::numeric) DESC)
  WHERE (metadata->>'serverless_callable') = 'true' AND (metadata->>'downloads') IS NOT NULL;
