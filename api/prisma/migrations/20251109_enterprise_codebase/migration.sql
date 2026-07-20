-- Add file limit tracking to usage_quotas
ALTER TABLE "usage_quotas"
  ADD COLUMN IF NOT EXISTS "file_limit" INTEGER;

ALTER TABLE "usage_quotas"
  ADD COLUMN IF NOT EXISTS "file_count" INTEGER NOT NULL DEFAULT 0;

-- Create codebase project and file tables
CREATE TABLE IF NOT EXISTS "codebase_projects" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "external_id" TEXT NOT NULL,
  "root_path" TEXT NOT NULL,
  "default_branch" TEXT,
  "latest_commit_sha" TEXT,
  "metadata" JSONB DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ DEFAULT now(),
  "updated_at" TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "codebase_projects_organization_id_external_id_default_branch_key"
  ON "codebase_projects" ("organization_id", "external_id", "default_branch");

CREATE INDEX IF NOT EXISTS "codebase_projects_organization_id_idx"
  ON "codebase_projects" ("organization_id");

CREATE TABLE IF NOT EXISTS "codebase_files" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "project_id" UUID NOT NULL REFERENCES "codebase_projects"("id") ON DELETE CASCADE,
  "path" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "checksum" TEXT NOT NULL,
  "last_modified_at" TIMESTAMPTZ NOT NULL,
  "language" TEXT,
  "executable" BOOLEAN NOT NULL DEFAULT FALSE,
  "encoding" TEXT,
  "content" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ DEFAULT now(),
  "updated_at" TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "codebase_files_project_id_path_key"
  ON "codebase_files" ("project_id", "path");

CREATE INDEX IF NOT EXISTS "codebase_files_project_id_checksum_idx"
  ON "codebase_files" ("project_id", "checksum");

CREATE INDEX IF NOT EXISTS "codebase_files_project_id_path_idx"
  ON "codebase_files" ("project_id", "path");

CREATE INDEX IF NOT EXISTS "codebase_files_language_idx"
  ON "codebase_files" ("language");

-- Accelerate substring search on code content
CREATE INDEX IF NOT EXISTS "codebase_files_content_trgm_idx"
  ON "codebase_files" USING GIN ("content" gin_trgm_ops);

-- Billing profile configuration
CREATE TABLE IF NOT EXISTS "billing_profiles" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "organization_id" UUID NOT NULL UNIQUE REFERENCES "organizations"("id") ON DELETE CASCADE,
  "billing_email" TEXT NOT NULL,
  "payment_method" TEXT,
  "auto_pay" BOOLEAN NOT NULL DEFAULT FALSE,
  "tax_rate" NUMERIC(6, 3),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "metadata" JSONB DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ DEFAULT now(),
  "updated_at" TIMESTAMPTZ DEFAULT now()
);

-- Invoices and invoice items
CREATE TABLE IF NOT EXISTS "invoices" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "period_start" TIMESTAMPTZ NOT NULL,
  "period_end" TIMESTAMPTZ NOT NULL,
  "subtotal" NUMERIC(14, 4) NOT NULL,
  "tax" NUMERIC(14, 4) NOT NULL,
  "total" NUMERIC(14, 4) NOT NULL,
  "currency" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "due_date" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ DEFAULT now(),
  "paid_at" TIMESTAMPTZ,
  "metadata" JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "invoices_organization_id_period_start_idx"
  ON "invoices" ("organization_id", "period_start");

CREATE INDEX IF NOT EXISTS "invoices_status_idx"
  ON "invoices" ("status");

CREATE TABLE IF NOT EXISTS "invoice_items" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "invoice_id" UUID NOT NULL REFERENCES "invoices"("id") ON DELETE CASCADE,
  "description" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price" NUMERIC(14, 4) NOT NULL,
  "total" NUMERIC(14, 4) NOT NULL,
  "metadata" JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "invoice_items_invoice_id_idx"
  ON "invoice_items" ("invoice_id");

-- Billing subscriptions
CREATE TABLE IF NOT EXISTS "billing_subscriptions" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "plan" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "billing_cycle" TEXT NOT NULL,
  "amount" NUMERIC(14, 4) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "start_date" TIMESTAMPTZ NOT NULL,
  "end_date" TIMESTAMPTZ,
  "payment_method_id" TEXT,
  "metadata" JSONB DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ DEFAULT now(),
  "updated_at" TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "billing_subscriptions_organization_id_status_idx"
  ON "billing_subscriptions" ("organization_id", "status");

-- Usage analytics events
CREATE TABLE IF NOT EXISTS "usage_events" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "team_id" TEXT,
  "user_id" TEXT,
  "event_type" TEXT NOT NULL,
  "metadata" JSONB DEFAULT '{}'::jsonb,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "usage_events_organization_id_timestamp_idx"
  ON "usage_events" ("organization_id", "timestamp");

CREATE INDEX IF NOT EXISTS "usage_events_event_type_idx"
  ON "usage_events" ("event_type");

