ALTER TABLE "organizations"
ADD COLUMN IF NOT EXISTS "settings" JSONB DEFAULT '{}'::jsonb NOT NULL;
