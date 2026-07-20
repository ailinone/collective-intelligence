-- Add slug column to organizations for tenant-friendly identifiers
ALTER TABLE "organizations"
ADD COLUMN "slug" TEXT;

-- Enforce uniqueness when provided
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug")
WHERE "slug" IS NOT NULL;

