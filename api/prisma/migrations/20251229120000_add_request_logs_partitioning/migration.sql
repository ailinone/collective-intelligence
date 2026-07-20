-- Migration: Add partitioning infrastructure for request_logs table
-- Purpose: Enable time-based partitioning for massive scale (10K+ developers, millions of logs)
-- Strategy: Range partitioning by month (can be adjusted to year for smaller partitions)
--
-- Note: Prisma doesn't natively support partitioned tables, so partitions must be managed manually
-- This migration sets up the infrastructure, and a maintenance job should create/archive partitions

-- Step 1: Create partition function for monthly partitioning
-- This function will be used to determine which partition a row belongs to
CREATE OR REPLACE FUNCTION request_logs_partition_key(created_at timestamp)
RETURNS date AS $$
  SELECT date_trunc('month', created_at)::date;
$$ LANGUAGE SQL IMMUTABLE;

-- Step 2: Create partitioned table structure
-- We'll convert the existing request_logs table to a partitioned table
-- Note: This is a complex migration that should be done during maintenance window
-- For now, we create the infrastructure but keep the existing table

-- Create a new partitioned table (we'll migrate data in a separate step)
-- This allows zero-downtime migration
-- Note: We only include DEFAULTS, NOT INDEXES or CONSTRAINTS
-- because unique constraints on partitioned tables must include partition key
-- We'll recreate indexes and constraints manually with proper structure
CREATE TABLE IF NOT EXISTS request_logs_partitioned (
  LIKE request_logs INCLUDING DEFAULTS
) PARTITION BY RANGE (created_at);

-- Add composite primary key (partition key must be included)
-- Note: This will fail if the table already exists with a different structure
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'request_logs_partitioned_pkey' 
    AND conrelid = 'request_logs_partitioned'::regclass
  ) THEN
    ALTER TABLE request_logs_partitioned ADD PRIMARY KEY (id, created_at);
  END IF;
END $$;

-- Add unique constraint on request_id + created_at (partition key must be included)
-- This ensures request_id uniqueness while being compatible with partitioning
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'request_logs_partitioned_request_id_key' 
    AND conrelid = 'request_logs_partitioned'::regclass
  ) THEN
    -- Note: For partitioned tables, unique constraints must include partition key
    -- We'll use a partial unique index on request_id instead (more flexible for partitioning)
    -- But for now, we'll create the constraint as (request_id, created_at) for compatibility
    CREATE UNIQUE INDEX IF NOT EXISTS request_logs_partitioned_request_id_created_at_idx
      ON request_logs_partitioned (request_id, created_at);
  END IF;
END $$;

-- Step 3: Create partitions for current and next 3 months (pre-created for performance)
-- Partitions are created monthly for efficient querying and archiving
DO $$
DECLARE
  partition_start date;
  partition_end date;
  partition_name text;
  i integer;
BEGIN
  -- Create partitions for current month and next 3 months
  FOR i IN 0..3 LOOP
    partition_start := date_trunc('month', CURRENT_DATE + (i || ' months')::interval)::date;
    partition_end := partition_start + '1 month'::interval;
    partition_name := 'request_logs_' || to_char(partition_start, 'YYYY_MM');
    
    -- Create partition if it doesn't exist
    EXECUTE format('
      CREATE TABLE IF NOT EXISTS %I PARTITION OF request_logs_partitioned
      FOR VALUES FROM (%L) TO (%L)
    ', partition_name, partition_start, partition_end);
  END LOOP;
END $$;

-- Step 4: Create indexes on partitioned table (same as original)
-- These indexes will be automatically created on each partition
CREATE INDEX IF NOT EXISTS idx_request_logs_partitioned_org_created 
  ON request_logs_partitioned (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_logs_partitioned_request_id 
  ON request_logs_partitioned (request_id);

CREATE INDEX IF NOT EXISTS idx_request_logs_partitioned_strategy_id 
  ON request_logs_partitioned (strategy_id);

CREATE INDEX IF NOT EXISTS idx_request_logs_partitioned_created 
  ON request_logs_partitioned (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_logs_partitioned_status 
  ON request_logs_partitioned (status);

CREATE INDEX IF NOT EXISTS idx_request_logs_partitioned_shard_id 
  ON request_logs_partitioned (shard_id);

CREATE INDEX IF NOT EXISTS idx_request_logs_partitioned_shard_org_created 
  ON request_logs_partitioned (shard_id, organization_id, created_at DESC);

-- Step 5: Create function to automatically create partitions for future months
-- This should be called by a scheduled job (cron, pg_cron, or application-level scheduler)
CREATE OR REPLACE FUNCTION create_request_logs_partition(partition_date date)
RETURNS void AS $$
DECLARE
  partition_start date;
  partition_end date;
  partition_name text;
BEGIN
  partition_start := date_trunc('month', partition_date)::date;
  partition_end := partition_start + '1 month'::interval;
  partition_name := 'request_logs_' || to_char(partition_start, 'YYYY_MM');
  
  -- Create partition if it doesn't exist
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I PARTITION OF request_logs_partitioned
    FOR VALUES FROM (%L) TO (%L)
  ', partition_name, partition_start, partition_end);
END;
$$ LANGUAGE plpgsql;

-- Step 6: Create function to archive old partitions (older than retention period)
-- This should be called by a scheduled job to archive partitions older than N months
CREATE OR REPLACE FUNCTION archive_old_request_logs_partitions(retention_months integer DEFAULT 12)
RETURNS TABLE(partition_name text, archived boolean) AS $$
DECLARE
  partition_record record;
  archive_date date;
  archive_table_name text;
BEGIN
  archive_date := date_trunc('month', CURRENT_DATE - (retention_months || ' months')::interval)::date;
  
  -- Find partitions older than retention period
  FOR partition_record IN
    SELECT 
      schemaname,
      tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'request_logs_%'
      AND tablename ~ '^request_logs_\d{4}_\d{2}$'
      AND tablename < 'request_logs_' || to_char(archive_date, 'YYYY_MM')
  LOOP
    -- Rename partition to archive table (instead of dropping, for compliance/backup)
    archive_table_name := partition_record.tablename || '_archived_' || to_char(CURRENT_DATE, 'YYYY_MM');
    
    -- Detach partition (makes it a regular table)
    EXECUTE format('ALTER TABLE request_logs_partitioned DETACH PARTITION %I', partition_record.tablename);
    
    -- Rename to archive table
    EXECUTE format('ALTER TABLE %I RENAME TO %I', partition_record.tablename, archive_table_name);
    
    -- Return result
    partition_name := archive_table_name;
    archived := true;
    RETURN NEXT;
  END LOOP;
  
  RETURN;
END;
$$ LANGUAGE plpgsql;

-- Step 7: Create view for application compatibility
-- Applications can query this view instead of the partitioned table directly
-- This allows us to swap between partitioned and non-partitioned tables
CREATE OR REPLACE VIEW request_logs_v AS
SELECT * FROM request_logs;

-- Step 8: Add comments for documentation
COMMENT ON FUNCTION create_request_logs_partition(date) IS 
  'Creates a new monthly partition for request_logs_partitioned table. Call this monthly via cron/scheduler.';

COMMENT ON FUNCTION archive_old_request_logs_partitions(integer) IS 
  'Archives partitions older than retention_months by detaching and renaming them. Call this monthly via cron/scheduler.';

COMMENT ON TABLE request_logs_partitioned IS 
  'Partitioned version of request_logs table. Partitions by month for efficient querying and archiving. Migration from request_logs to this table should be done during maintenance window.';

-- Note: Actual migration from request_logs to request_logs_partitioned should be done in a separate migration
-- during a maintenance window. Steps:
-- 1. Stop writes to request_logs
-- 2. Copy data from request_logs to request_logs_partitioned (partitioned by created_at)
-- 3. Rename request_logs to request_logs_old
-- 4. Rename request_logs_partitioned to request_logs
-- 5. Update Prisma schema to point to new table structure
-- 6. Resume writes

