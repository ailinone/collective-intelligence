-- Provider capability attributes 3-tier discovery overlay (LOTE AZ, 2026-09-23).
-- See ProviderCapabilityAttributeRecord's doc comment in schema.prisma for why
-- this table exists (the static providers.catalog.ts array cannot be written
-- to at runtime) and why there is no unique constraint narrower than id (a
-- 'probed' row and a disagreeing 'llm_draft' row for the same
-- provider_id+capability must be able to coexist).

CREATE TABLE "provider_capability_attribute_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider_id" VARCHAR(64) NOT NULL,
  "capability" VARCHAR(64) NOT NULL,
  "source" VARCHAR(16) NOT NULL,
  "attributes" JSONB NOT NULL,
  "attributes_verified_at" TIMESTAMP(3),
  "promotion_note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "provider_capability_attribute_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "provider_capability_attribute_records_provider_id_capability_idx"
  ON "provider_capability_attribute_records" ("provider_id", "capability");

CREATE INDEX "provider_capability_attribute_records_source_idx"
  ON "provider_capability_attribute_records" ("source");
