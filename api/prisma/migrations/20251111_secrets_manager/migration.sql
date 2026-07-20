-- Secret access audit table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'secret_access_logs' AND table_schema = 'public'
  ) THEN
    CREATE TABLE "secret_access_logs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "event" TEXT NOT NULL,
        "secret_key" TEXT NOT NULL,
        "provider_id" TEXT NOT NULL,
        "provider_type" TEXT NOT NULL,
        "success" BOOLEAN NOT NULL,
        "cache_hit" BOOLEAN NOT NULL,
        "duration_ms" INTEGER,
        "error_message" TEXT,
        "metadata" JSONB,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "secret_access_logs_secret_key_idx" ON "secret_access_logs" ("secret_key");
CREATE INDEX IF NOT EXISTS "secret_access_logs_created_at_idx" ON "secret_access_logs" ("created_at");

-- Managed secrets metadata (rotation policies)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'managed_secrets' AND table_schema = 'public'
  ) THEN
    CREATE TABLE "managed_secrets" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "secret_key" TEXT NOT NULL UNIQUE,
        "provider_id" TEXT NOT NULL,
        "length" INTEGER NOT NULL,
        "interval_days" INTEGER NOT NULL,
        "rotate_automatically" BOOLEAN NOT NULL DEFAULT TRUE,
        "last_rotated_at" TIMESTAMP WITH TIME ZONE,
        "metadata" JSONB,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "managed_secrets_provider_id_idx" ON "managed_secrets" ("provider_id");

