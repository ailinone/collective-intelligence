-- CreateTable
CREATE TABLE IF NOT EXISTS "auth_login_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "organization_id" UUID,
    "code_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_sent_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "metadata" JSONB DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
    CONSTRAINT "auth_login_challenges_pkey" PRIMARY KEY ("id")
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS "auth_login_challenges_email_idx" ON "auth_login_challenges" ("email");
CREATE INDEX IF NOT EXISTS "auth_login_challenges_email_status_idx" ON "auth_login_challenges" ("email", "status");
CREATE INDEX IF NOT EXISTS "auth_login_challenges_organization_id_idx" ON "auth_login_challenges" ("organization_id");

