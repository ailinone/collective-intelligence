-- CreateTable
CREATE TABLE "cached_contexts" (
    "id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "messages" JSONB NOT NULL,
    "token_count" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "ttl" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_accessed_at" TIMESTAMP(3) NOT NULL,
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "cached_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cached_contexts_organization_id_idx" ON "cached_contexts"("organization_id");

-- CreateIndex
CREATE INDEX "cached_contexts_organization_id_expires_at_idx" ON "cached_contexts"("organization_id", "expires_at");

-- CreateIndex
CREATE INDEX "cached_contexts_hash_idx" ON "cached_contexts"("hash");

