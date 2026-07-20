-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "quick_hash" TEXT,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "last_request_ip" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "rotation_count" INTEGER NOT NULL DEFAULT 0,
    "previous_key_id" UUID,
    "next_key_id" UUID,
    "ip_whitelist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "permissions" JSONB,
    "auto_rotate" BOOLEAN NOT NULL DEFAULT false,
    "rotation_interval_days" INTEGER,
    "grace_period_days" INTEGER NOT NULL DEFAULT 7,
    "metadata" JSONB,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key_rotation_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "api_key_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "old_key_id" UUID,
    "new_key_id" UUID,
    "performed_by" UUID,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "api_key_rotation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" VARCHAR(64) NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "health" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "models" (
    "id" VARCHAR(128) NOT NULL,
    "provider_id" VARCHAR(64) NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "context_window" INTEGER NOT NULL,
    "max_output_tokens" INTEGER NOT NULL,
    "input_cost_per_1k" DECIMAL(10,6) NOT NULL,
    "output_cost_per_1k" DECIMAL(10,6) NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "performance" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "model_id" VARCHAR(128) NOT NULL,
    "alias" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_health" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "model_id" VARCHAR(128) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'healthy',
    "latency_ms" INTEGER,
    "error_rate" DOUBLE PRECISION,
    "availability" DOUBLE PRECISION,
    "load_factor" DOUBLE PRECISION,
    "last_checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "strategy_id" TEXT,
    "strategy_name" TEXT,
    "models_used" JSONB NOT NULL DEFAULT '[]',
    "model_count" INTEGER NOT NULL DEFAULT 1,
    "model_id" VARCHAR(128),
    "duration_ms" INTEGER NOT NULL,
    "queue_time_ms" INTEGER,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,6) NOT NULL,
    "quality_score" DECIMAL(3,2),
    "request" JSONB NOT NULL DEFAULT '{}',
    "response" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'success',
    "error_code" TEXT,
    "error_message" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shard_id" INTEGER,

    CONSTRAINT "request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_data" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bucket" VARCHAR(50) NOT NULL,
    "task_type" VARCHAR(50) NOT NULL,
    "complexity" VARCHAR(20) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "avg_quality" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "avg_cost" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "avg_latency" INTEGER NOT NULL DEFAULT 0,
    "strategy_distribution" JSONB NOT NULL DEFAULT '{}',
    "top_patterns" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shard_config" (
    "shard_id" INTEGER NOT NULL,
    "shard_name" VARCHAR(50) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "org_count" INTEGER NOT NULL DEFAULT 0,
    "request_count" BIGINT NOT NULL DEFAULT 0,
    "total_size_mb" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shard_config_pkey" PRIMARY KEY ("shard_id")
);

-- CreateTable
CREATE TABLE "usage_quotas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "request_limit" INTEGER NOT NULL,
    "token_limit" BIGINT,
    "cost_limit_usd" DECIMAL(10,2),
    "file_limit" INTEGER,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "token_count" BIGINT NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "file_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codebase_projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "root_path" TEXT NOT NULL,
    "default_branch" TEXT,
    "latest_commit_sha" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codebase_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codebase_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "last_modified_at" TIMESTAMP(3) NOT NULL,
    "language" TEXT,
    "executable" BOOLEAN NOT NULL DEFAULT false,
    "encoding" TEXT,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codebase_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "billing_email" TEXT NOT NULL,
    "payment_method" TEXT,
    "default_payment_method_id" TEXT,
    "auto_pay" BOOLEAN NOT NULL DEFAULT false,
    "tax_rate" DECIMAL(6,3),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "metadata" JSONB DEFAULT '{}',
    "stripe_customer_id" TEXT,
    "stripe_portal_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "subtotal" DECIMAL(14,4) NOT NULL,
    "tax" DECIMAL(14,4) NOT NULL,
    "total" DECIMAL(14,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "due_date" TIMESTAMP(3) NOT NULL,
    "hosted_invoice_url" TEXT,
    "stripe_invoice_id" TEXT,
    "stripe_payment_intent_id" TEXT,
    "stripe_customer_id" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "metadata" JSONB DEFAULT '{}',

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(14,4) NOT NULL,
    "total" DECIMAL(14,4) NOT NULL,
    "metadata" JSONB DEFAULT '{}',
    "stripe_price_id" TEXT,
    "billing_price_id" UUID,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "billing_cycle" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3),
    "payment_method_id" TEXT,
    "price_id" UUID,
    "metadata" JSONB DEFAULT '{}',
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "stripe_subscription_id" TEXT,
    "stripe_customer_id" TEXT,
    "stripe_status" TEXT,
    "stripe_default_payment_method_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tier" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "features" JSONB DEFAULT '{}',
    "trial_days" INTEGER,
    "stripe_product_id" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_prices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "billing_plan_id" UUID NOT NULL,
    "stripe_price_id" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "amount" DECIMAL(14,4) NOT NULL,
    "billing_cycle" TEXT NOT NULL,
    "interval_count" INTEGER NOT NULL DEFAULT 1,
    "usage_type" TEXT NOT NULL DEFAULT 'licensed',
    "tax_behavior" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "team_id" TEXT,
    "user_id" TEXT,
    "event_type" TEXT NOT NULL,
    "metadata" JSONB DEFAULT '{}',
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_login_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "organization_id" UUID,
    "code_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_sent_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_login_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_buckets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bucket_time" TIMESTAMP(3) NOT NULL,
    "strategy_id" TEXT NOT NULL,
    "strategy_name" TEXT NOT NULL,
    "execution_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "avg_duration_ms" INTEGER NOT NULL,
    "avg_cost_usd" DECIMAL(10,6) NOT NULL,
    "avg_quality" DECIMAL(3,2),
    "total_tokens" BIGINT NOT NULL DEFAULT 0,
    "insights" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_weights" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "strategy_id" TEXT NOT NULL,
    "strategy_name" TEXT NOT NULL,
    "weight" DECIMAL(5,4) NOT NULL DEFAULT 1.0,
    "confidence" DECIMAL(3,2) NOT NULL DEFAULT 0.5,
    "total_executions" BIGINT NOT NULL DEFAULT 0,
    "success_rate" DECIMAL(5,4) NOT NULL,
    "avg_cost_usd" DECIMAL(10,6) NOT NULL,
    "avg_quality" DECIMAL(3,2) NOT NULL,
    "last_updated" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_weights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cache_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cache_key" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "last_hit_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cache_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_access_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event" TEXT NOT NULL,
    "secret_key" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "provider_type" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "cache_hit" BOOLEAN NOT NULL,
    "duration_ms" INTEGER,
    "error_message" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secret_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_secrets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "secret_key" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "length" INTEGER NOT NULL,
    "interval_days" INTEGER NOT NULL,
    "rotate_automatically" BOOLEAN NOT NULL DEFAULT true,
    "last_rotated_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "user_id" UUID,
    "organization_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_organization_id_idx" ON "users"("organization_id");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys"("key_prefix");

-- CreateIndex
CREATE INDEX "api_keys_quick_hash_idx" ON "api_keys"("quick_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "api_keys_organization_id_idx" ON "api_keys"("organization_id");

-- CreateIndex
CREATE INDEX "api_keys_status_idx" ON "api_keys"("status");

-- CreateIndex
CREATE INDEX "api_keys_status_expires_at_idx" ON "api_keys"("status", "expires_at");

-- CreateIndex
CREATE INDEX "api_key_rotation_logs_api_key_id_idx" ON "api_key_rotation_logs"("api_key_id");

-- CreateIndex
CREATE INDEX "api_key_rotation_logs_performed_at_idx" ON "api_key_rotation_logs"("performed_at");

-- CreateIndex
CREATE UNIQUE INDEX "providers_name_key" ON "providers"("name");

-- CreateIndex
CREATE INDEX "models_provider_id_idx" ON "models"("provider_id");

-- CreateIndex
CREATE INDEX "models_status_idx" ON "models"("status");

-- CreateIndex
CREATE INDEX "models_usage_count_idx" ON "models"("usage_count");

-- CreateIndex
CREATE UNIQUE INDEX "models_provider_id_name_key" ON "models"("provider_id", "name");

-- CreateIndex
CREATE INDEX "model_configs_organization_id_idx" ON "model_configs"("organization_id");

-- CreateIndex
CREATE INDEX "model_configs_model_id_idx" ON "model_configs"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_configs_organization_id_model_id_key" ON "model_configs"("organization_id", "model_id");

-- CreateIndex
CREATE INDEX "model_health_status_idx" ON "model_health"("status");

-- CreateIndex
CREATE INDEX "model_health_last_checked_at_idx" ON "model_health"("last_checked_at");

-- CreateIndex
CREATE UNIQUE INDEX "model_health_model_id_key" ON "model_health"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "request_logs_request_id_key" ON "request_logs"("request_id");

-- CreateIndex
CREATE INDEX "request_logs_organization_id_created_at_idx" ON "request_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "request_logs_request_id_idx" ON "request_logs"("request_id");

-- CreateIndex
CREATE INDEX "request_logs_strategy_id_idx" ON "request_logs"("strategy_id");

-- CreateIndex
CREATE INDEX "request_logs_created_at_idx" ON "request_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "request_logs_status_idx" ON "request_logs"("status");

-- CreateIndex
CREATE INDEX "request_logs_shard_id_idx" ON "request_logs"("shard_id");

-- CreateIndex
CREATE INDEX "request_logs_shard_id_organization_id_created_at_idx" ON "request_logs"("shard_id", "organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "learning_data_bucket_idx" ON "learning_data"("bucket");

-- CreateIndex
CREATE INDEX "learning_data_task_type_complexity_idx" ON "learning_data"("task_type", "complexity");

-- CreateIndex
CREATE UNIQUE INDEX "learning_data_bucket_task_type_complexity_key" ON "learning_data"("bucket", "task_type", "complexity");

-- CreateIndex
CREATE INDEX "usage_quotas_organization_id_period_start_idx" ON "usage_quotas"("organization_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "usage_quotas_organization_id_period_period_start_key" ON "usage_quotas"("organization_id", "period", "period_start");

-- CreateIndex
CREATE INDEX "codebase_projects_organization_id_idx" ON "codebase_projects"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "codebase_projects_organization_id_external_id_default_branc_key" ON "codebase_projects"("organization_id", "external_id", "default_branch");

-- CreateIndex
CREATE INDEX "codebase_files_project_id_checksum_idx" ON "codebase_files"("project_id", "checksum");

-- CreateIndex
CREATE INDEX "codebase_files_project_id_path_idx" ON "codebase_files"("project_id", "path");

-- CreateIndex
CREATE INDEX "codebase_files_language_idx" ON "codebase_files"("language");

-- CreateIndex
CREATE UNIQUE INDEX "codebase_files_project_id_path_key" ON "codebase_files"("project_id", "path");

-- CreateIndex
CREATE UNIQUE INDEX "billing_profiles_organization_id_key" ON "billing_profiles"("organization_id");

-- CreateIndex
CREATE INDEX "invoices_organization_id_period_start_idx" ON "invoices"("organization_id", "period_start");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "invoice_items_invoice_id_idx" ON "invoice_items"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_items_billing_price_id_idx" ON "invoice_items"("billing_price_id");

-- CreateIndex
CREATE INDEX "billing_subscriptions_organization_id_status_idx" ON "billing_subscriptions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "billing_subscriptions_stripe_subscription_id_idx" ON "billing_subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "billing_subscriptions_price_id_idx" ON "billing_subscriptions"("price_id");

-- CreateIndex
CREATE INDEX "billing_plans_organization_id_idx" ON "billing_plans"("organization_id");

-- CreateIndex
CREATE INDEX "billing_plans_tier_status_idx" ON "billing_plans"("tier", "status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_plans_stripe_product_id_key" ON "billing_plans"("stripe_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_prices_stripe_price_id_key" ON "billing_prices"("stripe_price_id");

-- CreateIndex
CREATE INDEX "billing_prices_billing_plan_id_active_idx" ON "billing_prices"("billing_plan_id", "active");

-- CreateIndex
CREATE INDEX "usage_events_organization_id_timestamp_idx" ON "usage_events"("organization_id", "timestamp");

-- CreateIndex
CREATE INDEX "usage_events_event_type_idx" ON "usage_events"("event_type");

-- CreateIndex
CREATE INDEX "auth_login_challenges_email_idx" ON "auth_login_challenges"("email");

-- CreateIndex
CREATE INDEX "auth_login_challenges_email_status_idx" ON "auth_login_challenges"("email", "status");

-- CreateIndex
CREATE INDEX "auth_login_challenges_organization_id_idx" ON "auth_login_challenges"("organization_id");

-- CreateIndex
CREATE INDEX "learning_buckets_bucket_time_idx" ON "learning_buckets"("bucket_time" DESC);

-- CreateIndex
CREATE INDEX "learning_buckets_strategy_id_idx" ON "learning_buckets"("strategy_id");

-- CreateIndex
CREATE UNIQUE INDEX "learning_buckets_strategy_id_bucket_time_key" ON "learning_buckets"("strategy_id", "bucket_time");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_weights_strategy_id_key" ON "strategy_weights"("strategy_id");

-- CreateIndex
CREATE INDEX "strategy_weights_weight_idx" ON "strategy_weights"("weight" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cache_entries_cache_key_key" ON "cache_entries"("cache_key");

-- CreateIndex
CREATE INDEX "cache_entries_expires_at_idx" ON "cache_entries"("expires_at");

-- CreateIndex
CREATE INDEX "cache_entries_layer_hit_count_idx" ON "cache_entries"("layer", "hit_count" DESC);

-- CreateIndex
CREATE INDEX "secret_access_logs_secret_key_idx" ON "secret_access_logs"("secret_key");

-- CreateIndex
CREATE INDEX "secret_access_logs_created_at_idx" ON "secret_access_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "managed_secrets_secret_key_key" ON "managed_secrets"("secret_key");

-- CreateIndex
CREATE INDEX "managed_secrets_provider_id_idx" ON "managed_secrets"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_name_key" ON "permissions"("name");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE INDEX "user_roles_organization_id_idx" ON "user_roles"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_organization_id_role_id_key" ON "user_roles"("user_id", "organization_id", "role_id");

-- CreateIndex
CREATE INDEX "security_audit_logs_organization_id_idx" ON "security_audit_logs"("organization_id");

-- CreateIndex
CREATE INDEX "security_audit_logs_event_type_idx" ON "security_audit_logs"("event_type");

-- CreateIndex
CREATE INDEX "security_audit_logs_created_at_idx" ON "security_audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key_rotation_logs" ADD CONSTRAINT "api_key_rotation_logs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "models" ADD CONSTRAINT "models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_health" ADD CONSTRAINT "model_health_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_quotas" ADD CONSTRAINT "usage_quotas_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codebase_projects" ADD CONSTRAINT "codebase_projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codebase_files" ADD CONSTRAINT "codebase_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "codebase_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_billing_price_id_fkey" FOREIGN KEY ("billing_price_id") REFERENCES "billing_prices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "billing_prices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "billing_profiles"("organization_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_prices" ADD CONSTRAINT "billing_prices_billing_plan_id_fkey" FOREIGN KEY ("billing_plan_id") REFERENCES "billing_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_audit_logs" ADD CONSTRAINT "security_audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_audit_logs" ADD CONSTRAINT "security_audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
