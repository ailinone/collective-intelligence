-- Migration: Multi-Provider Models
-- Allows the same model ID (e.g. "gpt-4o") to exist across multiple providers.
-- Introduces a deterministic `uid` column as the new PK, with (id, provider_id) as composite unique.

-- Step 1: Drop FK constraints that reference models(id)
ALTER TABLE "request_logs" DROP CONSTRAINT IF EXISTS "request_logs_model_id_fkey";
ALTER TABLE "model_configs" DROP CONSTRAINT IF EXISTS "model_configs_model_id_fkey";
ALTER TABLE "model_health" DROP CONSTRAINT IF EXISTS "model_health_model_id_fkey";

-- Step 2: Drop the existing unique constraint/index on (provider_id, name) if it exists
-- Prisma creates these as indexes, not constraints, so we need to drop both forms.
ALTER TABLE "models" DROP CONSTRAINT IF EXISTS "models_provider_id_name_key";
DROP INDEX IF EXISTS "models_provider_id_name_key";

-- Step 3: Drop the old PK
ALTER TABLE "models" DROP CONSTRAINT "models_pkey";

-- Step 4: Add uid column with deterministic values based on provider_id + id
ALTER TABLE "models" ADD COLUMN "uid" VARCHAR(32);
UPDATE "models" SET "uid" = SUBSTRING(MD5("provider_id" || ':' || "id"), 1, 25);
ALTER TABLE "models" ALTER COLUMN "uid" SET NOT NULL;

-- Step 5: Set uid as new PK
ALTER TABLE "models" ADD PRIMARY KEY ("uid");

-- Step 6: Add composite unique constraint (allows same model ID across providers)
CREATE UNIQUE INDEX IF NOT EXISTS "models_id_provider_id_key" ON "models"("id", "provider_id");

-- Step 7: Re-add unique constraint on (provider_id, name)
CREATE UNIQUE INDEX IF NOT EXISTS "models_provider_id_name_key" ON "models"("provider_id", "name");

-- Step 8: Update FK references in related tables
-- request_logs: REMOVE FK (log table doesn't need referential integrity)
-- model_id stays as text reference for auditing, no FK constraint

-- model_configs: re-add FK pointing to new PK
ALTER TABLE "model_configs" ADD COLUMN "model_uid" VARCHAR(32);
UPDATE "model_configs" SET "model_uid" = m."uid" FROM "models" m WHERE "model_configs"."model_id" = m."id";
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_model_uid_fkey" FOREIGN KEY ("model_uid") REFERENCES "models"("uid") ON DELETE CASCADE;

-- model_health: re-add FK pointing to new PK
ALTER TABLE "model_health" ADD COLUMN "model_uid" VARCHAR(32);
UPDATE "model_health" SET "model_uid" = m."uid" FROM "models" m WHERE "model_health"."model_id" = m."id";
ALTER TABLE "model_health" ADD CONSTRAINT "model_health_model_uid_fkey" FOREIGN KEY ("model_uid") REFERENCES "models"("uid") ON DELETE CASCADE;
