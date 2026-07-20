-- Drop foreign keys that depend on provider/model IDs before altering types
ALTER TABLE "models" DROP CONSTRAINT IF EXISTS "models_provider_id_fkey";
ALTER TABLE "model_configs" DROP CONSTRAINT IF EXISTS "model_configs_model_id_fkey";
ALTER TABLE "request_logs" DROP CONSTRAINT IF EXISTS "request_logs_model_id_fkey";

DO $$
DECLARE provider_id_type text;
BEGIN
  SELECT data_type INTO provider_id_type
  FROM information_schema.columns
  WHERE table_name = 'providers' AND column_name = 'id';

  IF provider_id_type = 'uuid' THEN
    EXECUTE 'ALTER TABLE "providers" ALTER COLUMN "id" DROP DEFAULT';
    EXECUTE 'ALTER TABLE "providers" ALTER COLUMN "id" TYPE TEXT USING "id"::text';
    EXECUTE 'ALTER TABLE "providers" ALTER COLUMN "id" TYPE VARCHAR(64)';
  END IF;
END;
$$;

DO $$
DECLARE model_id_type text;
BEGIN
  SELECT data_type INTO model_id_type
  FROM information_schema.columns
  WHERE table_name = 'models' AND column_name = 'id';

  IF model_id_type = 'uuid' THEN
    EXECUTE 'ALTER TABLE "models" ALTER COLUMN "id" TYPE TEXT USING "id"::text';
    EXECUTE 'ALTER TABLE "models" ALTER COLUMN "id" TYPE VARCHAR(128)';
  END IF;

  SELECT data_type INTO model_id_type
  FROM information_schema.columns
  WHERE table_name = 'models' AND column_name = 'provider_id';

  IF model_id_type = 'uuid' THEN
    EXECUTE '' ||
      'ALTER TABLE "models" ' ||
      'ALTER COLUMN "provider_id" TYPE TEXT USING "provider_id"::text';
    EXECUTE 'ALTER TABLE "models" ALTER COLUMN "provider_id" TYPE VARCHAR(64)';
  END IF;

  SELECT data_type INTO model_id_type
  FROM information_schema.columns
  WHERE table_name = 'model_configs' AND column_name = 'model_id';

  IF model_id_type = 'uuid' THEN
    EXECUTE 'ALTER TABLE "model_configs" ALTER COLUMN "model_id" TYPE TEXT USING "model_id"::text';
    EXECUTE 'ALTER TABLE "model_configs" ALTER COLUMN "model_id" TYPE VARCHAR(128)';
  END IF;

  SELECT data_type INTO model_id_type
  FROM information_schema.columns
  WHERE table_name = 'request_logs' AND column_name = 'model_id';

  IF model_id_type = 'uuid' THEN
    EXECUTE 'ALTER TABLE "request_logs" ALTER COLUMN "model_id" TYPE TEXT USING "model_id"::text';
    EXECUTE 'ALTER TABLE "request_logs" ALTER COLUMN "model_id" TYPE VARCHAR(128)';
  END IF;
END;
$$;

-- Add usage count and last synced columns to models
ALTER TABLE "models"
  ADD COLUMN IF NOT EXISTS "usage_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_synced_at" TIMESTAMP(3);

-- Create model_health table for health weighting
CREATE TABLE IF NOT EXISTS "model_health" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "model_id" VARCHAR(128) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'healthy',
  "latency_ms" INTEGER,
  "error_rate" DOUBLE PRECISION,
  "availability" DOUBLE PRECISION,
  "load_factor" DOUBLE PRECISION,
  "last_checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "model_health_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "model_health_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE,
  CONSTRAINT "model_health_model_id_key" UNIQUE ("model_id")
);

-- Recreate foreign keys with updated types
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'models_provider_id_fkey'
      AND table_name = 'models'
  ) THEN
    ALTER TABLE "models"
      ADD CONSTRAINT "models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'model_configs_model_id_fkey'
      AND table_name = 'model_configs'
  ) THEN
    ALTER TABLE "model_configs"
      ADD CONSTRAINT "model_configs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'request_logs_model_id_fkey'
      AND table_name = 'request_logs'
  ) THEN
    ALTER TABLE "request_logs"
      ADD CONSTRAINT "request_logs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL;
  END IF;
END;
$$;

-- Indices for performance
CREATE INDEX IF NOT EXISTS "models_usage_count_idx" ON "models"("usage_count");
CREATE INDEX IF NOT EXISTS "model_health_status_idx" ON "model_health"("status");
CREATE INDEX IF NOT EXISTS "model_health_last_checked_at_idx" ON "model_health"("last_checked_at");

-- Trigger to maintain updated_at on model_health
CREATE OR REPLACE FUNCTION set_model_health_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updated_at" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'model_health_set_updated_at'
  ) THEN
    CREATE TRIGGER model_health_set_updated_at
    BEFORE UPDATE ON "model_health"
    FOR EACH ROW EXECUTE PROCEDURE set_model_health_updated_at();
  END IF;
END;
$$;

