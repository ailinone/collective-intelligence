-- Copyright (C) 2026 Ailin One, Inc.
--
-- This file is part of Collective Intelligence Engine (ci).
-- Licensed under the GNU Affero General Public License v3.0 or later.
-- See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Source: https://github.com/ailinone/collective-intelligence

-- Ailin Dev API - Complete Database Schema
-- Generated from prisma/schema.prisma
-- PostgreSQL 16

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================
-- Organizations & Users
-- ============================================

CREATE TABLE "organizations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "tier" TEXT NOT NULL DEFAULT 'free',
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "organization_id" UUID NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "status" TEXT NOT NULL DEFAULT 'active',
  "last_login_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE INDEX "users_organization_id_idx" ON "users"("organization_id");
CREATE INDEX "users_email_idx" ON "users"("email");

CREATE TABLE "api_keys" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "key_prefix" TEXT NOT NULL,
  "quick_hash" TEXT,
  "user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "last_used_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "last_request_ip" TEXT,
  "expires_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotated_at" TIMESTAMP,
  "revoked_at" TIMESTAMP,
  "rotation_count" INTEGER NOT NULL DEFAULT 0,
  "previous_key_id" UUID,
  "next_key_id" UUID,
  "ip_whitelist" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "permissions" JSONB,
  "auto_rotate" BOOLEAN NOT NULL DEFAULT false,
  "rotation_interval_days" INTEGER,
  "grace_period_days" INTEGER NOT NULL DEFAULT 7,
  "metadata" JSONB,
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys"("key_prefix");
CREATE INDEX "api_keys_quick_hash_idx" ON "api_keys"("quick_hash");
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");
CREATE INDEX "api_keys_organization_id_idx" ON "api_keys"("organization_id");
CREATE INDEX "api_keys_status_idx" ON "api_keys"("status");
CREATE INDEX "api_keys_status_expires_at_idx" ON "api_keys"("status", "expires_at");

CREATE TABLE "api_key_rotation_logs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "api_key_id" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT,
  "old_key_id" UUID,
  "new_key_id" UUID,
  "performed_by" UUID,
  "performed_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE
);

CREATE INDEX "api_key_rotation_logs_api_key_id_idx" ON "api_key_rotation_logs"("api_key_id");
CREATE INDEX "api_key_rotation_logs_performed_at_idx" ON "api_key_rotation_logs"("performed_at");

-- ============================================
-- Models & Providers
-- ============================================

CREATE TABLE "providers" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL UNIQUE,
  "display_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "health" JSONB NOT NULL DEFAULT '{}',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "models" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "context_window" INTEGER NOT NULL,
  "max_output_tokens" INTEGER NOT NULL,
  "input_cost_per_1k" DECIMAL(10, 6) NOT NULL,
  "output_cost_per_1k" DECIMAL(10, 6) NOT NULL,
  "capabilities" JSONB NOT NULL DEFAULT '[]',
  "performance" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'active',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE,
  UNIQUE ("provider_id", "name")
);

CREATE INDEX "models_provider_id_idx" ON "models"("provider_id");
CREATE INDEX "models_status_idx" ON "models"("status");

CREATE TABLE "model_configs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "model_id" UUID NOT NULL,
  "alias" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "config" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE,
  UNIQUE ("organization_id", "model_id")
);

CREATE INDEX "model_configs_organization_id_idx" ON "model_configs"("organization_id");
CREATE INDEX "model_configs_model_id_idx" ON "model_configs"("model_id");

-- ============================================
-- Request Logs & Analytics
-- ============================================

CREATE TABLE "request_logs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "request_id" TEXT NOT NULL UNIQUE,
  "endpoint" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "strategy_id" TEXT,
  "strategy_name" TEXT,
  "models_used" JSONB NOT NULL DEFAULT '[]',
  "model_count" INTEGER NOT NULL DEFAULT 1,
  "model_id" UUID,
  "duration_ms" INTEGER NOT NULL,
  "queue_time_ms" INTEGER,
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "total_tokens" INTEGER NOT NULL DEFAULT 0,
  "cost_usd" DECIMAL(10, 6) NOT NULL,
  "quality_score" DECIMAL(3, 2),
  "request" JSONB NOT NULL DEFAULT '{}',
  "response" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'success',
  "error_code" TEXT,
  "error_message" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "shard_id" INTEGER,
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL
);

CREATE INDEX "request_logs_organization_id_created_at_idx" ON "request_logs"("organization_id", "created_at" DESC);
CREATE INDEX "request_logs_request_id_idx" ON "request_logs"("request_id");
CREATE INDEX "request_logs_strategy_id_idx" ON "request_logs"("strategy_id");
CREATE INDEX "request_logs_created_at_idx" ON "request_logs"("created_at" DESC);
CREATE INDEX "request_logs_status_idx" ON "request_logs"("status");
CREATE INDEX "request_logs_shard_id_idx" ON "request_logs"("shard_id");
CREATE INDEX "request_logs_shard_id_organization_id_created_at_idx" ON "request_logs"("shard_id", "organization_id", "created_at" DESC);

-- ============================================
-- Auto-Learning System
-- ============================================

CREATE TABLE "learning_data" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "bucket" VARCHAR(50) NOT NULL,
  "task_type" VARCHAR(50) NOT NULL,
  "complexity" VARCHAR(20) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "success_count" INTEGER NOT NULL DEFAULT 0,
  "avg_quality" DECIMAL(3, 2) NOT NULL DEFAULT 0,
  "avg_cost" DECIMAL(10, 6) NOT NULL DEFAULT 0,
  "avg_latency" INTEGER NOT NULL DEFAULT 0,
  "strategy_distribution" JSONB NOT NULL DEFAULT '{}',
  "top_patterns" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("bucket", "task_type", "complexity")
);

CREATE INDEX "learning_data_bucket_idx" ON "learning_data"("bucket");
CREATE INDEX "learning_data_task_type_complexity_idx" ON "learning_data"("task_type", "complexity");

CREATE TABLE "learning_buckets" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "bucket_time" TIMESTAMP NOT NULL,
  "strategy_id" TEXT NOT NULL,
  "strategy_name" TEXT NOT NULL,
  "execution_count" INTEGER NOT NULL DEFAULT 0,
  "success_count" INTEGER NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "avg_duration_ms" INTEGER NOT NULL,
  "avg_cost_usd" DECIMAL(10, 6) NOT NULL,
  "avg_quality" DECIMAL(3, 2),
  "total_tokens" BIGINT NOT NULL DEFAULT 0,
  "insights" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("strategy_id", "bucket_time")
);

CREATE INDEX "learning_buckets_bucket_time_idx" ON "learning_buckets"("bucket_time" DESC);
CREATE INDEX "learning_buckets_strategy_id_idx" ON "learning_buckets"("strategy_id");

CREATE TABLE "strategy_weights" (
  "id" UUID NOT NULL,
  "task_type" VARCHAR(50) NOT NULL,
  "complexity" VARCHAR(20) NOT NULL,
  "strategy" TEXT NOT NULL,
  "weight" DECIMAL(10,6) NOT NULL DEFAULT 1.0,
  "success_rate" DECIMAL(10,6) NOT NULL DEFAULT 0,
  "avg_quality" DECIMAL(10,6) NOT NULL DEFAULT 0,
  "avg_cost_efficiency" DECIMAL(10,6) NOT NULL DEFAULT 0,
  "sample_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "strategy_weights_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "strategy_weights_task_type_complexity_strategy_key" ON "strategy_weights"("task_type", "complexity", "strategy");
CREATE INDEX "strategy_weights_task_type_complexity_idx" ON "strategy_weights"("task_type", "complexity");

-- ============================================
-- Sharding Configuration
-- ============================================

CREATE TABLE "shard_config" (
  "shard_id" INTEGER PRIMARY KEY,
  "shard_name" VARCHAR(50) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "org_count" INTEGER NOT NULL DEFAULT 0,
  "request_count" BIGINT NOT NULL DEFAULT 0,
  "total_size_mb" DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- Usage & Quotas
-- ============================================

CREATE TABLE "usage_quotas" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "period" TEXT NOT NULL,
  "period_start" TIMESTAMP NOT NULL,
  "period_end" TIMESTAMP NOT NULL,
  "request_limit" INTEGER NOT NULL,
  "token_limit" BIGINT,
  "cost_limit_usd" DECIMAL(10, 2),
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "token_count" BIGINT NOT NULL DEFAULT 0,
  "cost_usd" DECIMAL(10, 6) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  UNIQUE ("organization_id", "period", "period_start")
);

CREATE INDEX "usage_quotas_organization_id_period_start_idx" ON "usage_quotas"("organization_id", "period_start");

-- ============================================
-- Cache Metadata
-- ============================================

CREATE TABLE "cache_entries" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "cache_key" TEXT NOT NULL UNIQUE,
  "layer" TEXT NOT NULL,
  "hit_count" INTEGER NOT NULL DEFAULT 0,
  "last_hit_at" TIMESTAMP,
  "expires_at" TIMESTAMP NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "cache_entries_expires_at_idx" ON "cache_entries"("expires_at");
CREATE INDEX "cache_entries_layer_hit_count_idx" ON "cache_entries"("layer", "hit_count" DESC);

-- ============================================
-- Secret Access Logs
-- ============================================

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
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "secret_access_logs_secret_key_idx" ON "secret_access_logs"("secret_key");
CREATE INDEX "secret_access_logs_created_at_idx" ON "secret_access_logs"("created_at");

-- ============================================
-- Files (OpenAI-compatible)
-- ============================================

CREATE TABLE "files" (
  "id" VARCHAR(64) PRIMARY KEY,
  "organization_id" UUID NOT NULL,
  "user_id" UUID,
  "filename" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "bytes" INTEGER NOT NULL,
  "content_type" TEXT NOT NULL,
  "gcs_path" TEXT NOT NULL,
  "gcs_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'uploaded',
  "status_details" TEXT,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE INDEX "files_organization_id_purpose_idx" ON "files"("organization_id", "purpose");
CREATE INDEX "files_organization_id_created_at_idx" ON "files"("organization_id", "created_at");
CREATE INDEX "files_status_idx" ON "files"("status");

-- ============================================
-- Batches (Batch API)
-- ============================================

CREATE TABLE "batches" (
  "id" VARCHAR(64) PRIMARY KEY,
  "organization_id" UUID NOT NULL,
  "user_id" UUID,
  "endpoint" TEXT NOT NULL,
  "input_file_id" TEXT NOT NULL,
  "output_file_id" TEXT,
  "error_file_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'validating',
  "completion_window" TEXT NOT NULL,
  "request_counts_total" INTEGER NOT NULL DEFAULT 0,
  "request_counts_completed" INTEGER NOT NULL DEFAULT 0,
  "request_counts_failed" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "in_progress_at" TIMESTAMP,
  "expires_at" TIMESTAMP NOT NULL,
  "finalizing_at" TIMESTAMP,
  "completed_at" TIMESTAMP,
  "failed_at" TIMESTAMP,
  "expired_at" TIMESTAMP,
  "cancelling_at" TIMESTAMP,
  "cancelled_at" TIMESTAMP,
  "metadata" JSONB,
  "errors" JSONB,
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE INDEX "batches_organization_id_idx" ON "batches"("organization_id");
CREATE INDEX "batches_status_idx" ON "batches"("status");
CREATE INDEX "batches_created_at_idx" ON "batches"("created_at" DESC);

-- ============================================
-- Assistants (OpenAI-compatible)
-- ============================================

CREATE TABLE "assistants" (
  "id" VARCHAR(64) PRIMARY KEY,
  "organization_id" UUID NOT NULL,
  "user_id" UUID,
  "name" TEXT,
  "description" TEXT,
  "model" TEXT NOT NULL,
  "instructions" TEXT,
  "tools" JSONB NOT NULL DEFAULT '[]',
  "tool_resources" JSONB,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "temperature" FLOAT,
  "top_p" FLOAT,
  "response_format" JSONB,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE INDEX "assistants_organization_id_idx" ON "assistants"("organization_id");
CREATE INDEX "assistants_organization_id_user_id_idx" ON "assistants"("organization_id", "user_id");

-- ============================================
-- Threads (OpenAI-compatible)
-- ============================================

CREATE TABLE "threads" (
  "id" VARCHAR(64) PRIMARY KEY,
  "organization_id" UUID NOT NULL,
  "user_id" UUID,
  "assistant_id" VARCHAR(64),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assistant_id") REFERENCES "assistants"("id") ON DELETE SET NULL
);

CREATE INDEX "threads_organization_id_idx" ON "threads"("organization_id");
CREATE INDEX "threads_organization_id_user_id_idx" ON "threads"("organization_id", "user_id");
CREATE INDEX "threads_assistant_id_idx" ON "threads"("assistant_id");

-- ============================================
-- Thread Messages
-- ============================================

CREATE TABLE "thread_messages" (
  "id" VARCHAR(64) PRIMARY KEY,
  "thread_id" VARCHAR(64) NOT NULL,
  "role" TEXT NOT NULL,
  "content" JSONB NOT NULL,
  "file_ids" TEXT[] DEFAULT '{}',
  "assistant_id" VARCHAR(64),
  "run_id" VARCHAR(64),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE
);

CREATE INDEX "thread_messages_thread_id_idx" ON "thread_messages"("thread_id");
CREATE INDEX "thread_messages_thread_id_created_at_idx" ON "thread_messages"("thread_id", "created_at");

-- ============================================
-- Thread Runs
-- ============================================

CREATE TABLE "thread_runs" (
  "id" VARCHAR(64) PRIMARY KEY,
  "thread_id" VARCHAR(64) NOT NULL,
  "assistant_id" VARCHAR(64) NOT NULL,
  "model" TEXT,
  "instructions" TEXT,
  "tools" JSONB NOT NULL DEFAULT '[]',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'queued',
  "required_action" JSONB,
  "last_error" JSONB,
  "expires_at" TIMESTAMP,
  "started_at" TIMESTAMP,
  "cancelled_at" TIMESTAMP,
  "completed_at" TIMESTAMP,
  "failed_at" TIMESTAMP,
  "usage" JSONB,
  "temperature" FLOAT,
  "top_p" FLOAT,
  "max_prompt_tokens" INTEGER,
  "max_completion_tokens" INTEGER,
  "truncation_strategy" JSONB,
  "response_format" JSONB,
  "tool_choice" JSONB,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assistant_id") REFERENCES "assistants"("id") ON DELETE CASCADE
);

CREATE INDEX "thread_runs_thread_id_idx" ON "thread_runs"("thread_id");
CREATE INDEX "thread_runs_status_idx" ON "thread_runs"("status");

-- ============================================
-- Prisma Migrations Table
-- ============================================

CREATE TABLE "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMP,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMP,
  "started_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);

-- Insert initial migration record
INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "finished_at", "applied_steps_count")
VALUES (
  gen_random_uuid()::text,
  'manual-schema',
  'manual_schema_initialization',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  1
);

