-- Camada 1a: persisted operability overlay so the ProviderOperabilityHub
-- survives process restarts (instead of resetting to "0 healthy providers").
-- Additive only: new table, no changes to existing tables/data.

CREATE TABLE "provider_operability_snapshots" (
    "provider_key" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "is_native" BOOLEAN NOT NULL DEFAULT false,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_operability_snapshots_pkey" PRIMARY KEY ("provider_key")
);

CREATE INDEX "provider_operability_snapshots_expires_at_idx" ON "provider_operability_snapshots"("expires_at");
