-- Change response_summary from VARCHAR(500) to TEXT for complete response storage
-- Required for publication-grade benchmark analysis with full output comparison
ALTER TABLE "experiment_executions"
  ALTER COLUMN "response_summary" TYPE TEXT;
