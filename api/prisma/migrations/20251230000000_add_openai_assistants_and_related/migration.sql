-- Files
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
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "files_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
CREATE INDEX "files_organization_id_purpose_idx" ON "files"("organization_id", "purpose");
CREATE INDEX "files_organization_id_created_at_idx" ON "files"("organization_id", "created_at");
CREATE INDEX "files_status_idx" ON "files"("status");

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
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "in_progress_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "finalizing_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "expired_at" TIMESTAMP(3),
  "cancelling_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "metadata" JSONB,
  "errors" JSONB,
  CONSTRAINT "batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
CREATE INDEX "batches_organization_id_idx" ON "batches"("organization_id");
CREATE INDEX "batches_status_idx" ON "batches"("status");
CREATE INDEX "batches_created_at_idx" ON "batches"("created_at" DESC);

CREATE TABLE "fine_tuning_jobs" (
  "id" VARCHAR(64) PRIMARY KEY,
  "organization_id" UUID NOT NULL,
  "user_id" UUID,
  "provider" TEXT NOT NULL,
  "provider_job_id" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "fine_tuned_model" TEXT,
  "training_file_id" TEXT NOT NULL,
  "validation_file_id" TEXT,
  "status" TEXT NOT NULL,
  "hyperparameters" JSONB NOT NULL,
  "integrations" JSONB,
  "result_files" TEXT[] NOT NULL DEFAULT '{}',
  "trained_tokens" INTEGER,
  "seed" INTEGER,
  "error" JSONB,
  "estimated_finish" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "fine_tuning_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
CREATE INDEX "fine_tuning_jobs_organization_id_idx" ON "fine_tuning_jobs"("organization_id");
CREATE INDEX "fine_tuning_jobs_organization_id_status_idx" ON "fine_tuning_jobs"("organization_id", "status");
CREATE INDEX "fine_tuning_jobs_organization_id_created_at_idx" ON "fine_tuning_jobs"("organization_id", "created_at");
CREATE INDEX "fine_tuning_jobs_provider_job_id_idx" ON "fine_tuning_jobs"("provider_job_id");
CREATE INDEX "fine_tuning_jobs_status_idx" ON "fine_tuning_jobs"("status");

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
  "temperature" DOUBLE PRECISION,
  "top_p" DOUBLE PRECISION,
  "response_format" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
CREATE INDEX "assistants_organization_id_idx" ON "assistants"("organization_id");
CREATE INDEX "assistants_organization_id_user_id_idx" ON "assistants"("organization_id", "user_id");

CREATE TABLE "assistant_files" (
  "id" VARCHAR(64) PRIMARY KEY,
  "assistant_id" VARCHAR(64) NOT NULL,
  "file_id" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_files_assistant_id_fkey" FOREIGN KEY ("assistant_id") REFERENCES "assistants"("id") ON DELETE CASCADE,
  CONSTRAINT "assistant_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "assistant_files_assistant_id_file_id_key" ON "assistant_files"("assistant_id", "file_id");
CREATE INDEX "assistant_files_assistant_id_idx" ON "assistant_files"("assistant_id");
CREATE INDEX "assistant_files_file_id_idx" ON "assistant_files"("file_id");

CREATE TABLE "threads" (
  "id" VARCHAR(64) PRIMARY KEY,
  "organization_id" UUID NOT NULL,
  "user_id" UUID,
  "assistant_id" VARCHAR(64),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "threads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "threads_assistant_id_fkey" FOREIGN KEY ("assistant_id") REFERENCES "assistants"("id") ON DELETE SET NULL
);
CREATE INDEX "threads_organization_id_idx" ON "threads"("organization_id");
CREATE INDEX "threads_organization_id_user_id_idx" ON "threads"("organization_id", "user_id");
CREATE INDEX "threads_assistant_id_idx" ON "threads"("assistant_id");

CREATE TABLE "thread_messages" (
  "id" VARCHAR(64) PRIMARY KEY,
  "thread_id" VARCHAR(64) NOT NULL,
  "role" TEXT NOT NULL,
  "content" JSONB NOT NULL,
  "file_ids" TEXT[] NOT NULL DEFAULT '{}',
  "assistant_id" VARCHAR(64),
  "run_id" VARCHAR(64),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "thread_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE
);
CREATE INDEX "thread_messages_thread_id_idx" ON "thread_messages"("thread_id");
CREATE INDEX "thread_messages_thread_id_created_at_idx" ON "thread_messages"("thread_id", "created_at");
CREATE INDEX "thread_messages_run_id_idx" ON "thread_messages"("run_id");

CREATE TABLE "thread_runs" (
  "id" VARCHAR(64) PRIMARY KEY,
  "thread_id" VARCHAR(64) NOT NULL,
  "assistant_id" VARCHAR(64) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "model" TEXT,
  "instructions" TEXT,
  "tools" JSONB NOT NULL DEFAULT '[]',
  "tool_resources" JSONB,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "temperature" DOUBLE PRECISION,
  "top_p" DOUBLE PRECISION,
  "max_prompt_tokens" INTEGER,
  "max_completion_tokens" INTEGER,
  "truncation_strategy" JSONB,
  "tool_choice" JSONB,
  "response_format" JSONB,
  "parallel_tool_calls" BOOLEAN DEFAULT true,
  "incomplete_details" JSONB,
  "usage" JSONB,
  "temperature_last" DOUBLE PRECISION,
  "top_p_last" DOUBLE PRECISION,
  "started_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "required_action" JSONB,
  "last_error" JSONB,
  "file_ids" TEXT[] NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "thread_runs_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE,
  CONSTRAINT "thread_runs_assistant_id_fkey" FOREIGN KEY ("assistant_id") REFERENCES "assistants"("id") ON DELETE CASCADE
);
CREATE INDEX "thread_runs_thread_id_idx" ON "thread_runs"("thread_id");
CREATE INDEX "thread_runs_thread_id_created_at_idx" ON "thread_runs"("thread_id", "created_at");
CREATE INDEX "thread_runs_assistant_id_idx" ON "thread_runs"("assistant_id");
CREATE INDEX "thread_runs_status_idx" ON "thread_runs"("status");

ALTER TABLE "thread_messages" ADD CONSTRAINT "thread_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "thread_runs"("id") ON DELETE SET NULL;

CREATE TABLE "thread_run_checkpoints" (
  "id" VARCHAR(64) PRIMARY KEY,
  "run_id" VARCHAR(64) NOT NULL,
  "checkpoint_number" INTEGER NOT NULL,
  "model" TEXT NOT NULL,
  "instructions" TEXT,
  "tools" JSONB NOT NULL DEFAULT '[]',
  "tool_resources" JSONB,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "temperature" DOUBLE PRECISION,
  "top_p" DOUBLE PRECISION,
  "max_prompt_tokens" INTEGER,
  "max_completion_tokens" INTEGER,
  "truncation_strategy" JSONB,
  "tool_choice" JSONB,
  "response_format" JSONB,
  "parallel_tool_calls" BOOLEAN DEFAULT true,
  "usage" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "thread_run_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "thread_runs"("id") ON DELETE CASCADE
);
CREATE INDEX "thread_run_checkpoints_run_id_idx" ON "thread_run_checkpoints"("run_id");
CREATE INDEX "thread_run_checkpoints_run_id_checkpoint_number_idx" ON "thread_run_checkpoints"("run_id", "checkpoint_number");

CREATE TABLE "thread_run_steps" (
  "id" VARCHAR(64) PRIMARY KEY,
  "run_id" VARCHAR(64) NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "step_details" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "thread_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "thread_runs"("id") ON DELETE CASCADE
);
CREATE INDEX "thread_run_steps_run_id_idx" ON "thread_run_steps"("run_id");
CREATE INDEX "thread_run_steps_run_id_created_at_idx" ON "thread_run_steps"("run_id", "created_at");

CREATE TABLE "vector_stores" (
  "id" VARCHAR(64) PRIMARY KEY,
  "organization_id" UUID NOT NULL,
  "user_id" UUID,
  "name" TEXT,
  "status" TEXT NOT NULL DEFAULT 'in_progress',
  "expires_after" JSONB,
  "expires_at" TIMESTAMP(3),
  "last_active_at" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vector_stores_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
CREATE INDEX "vector_stores_organization_id_idx" ON "vector_stores"("organization_id");
CREATE INDEX "vector_stores_organization_id_user_id_idx" ON "vector_stores"("organization_id", "user_id");
CREATE INDEX "vector_stores_status_idx" ON "vector_stores"("status");

CREATE TABLE "vector_store_files" (
  "id" VARCHAR(64) PRIMARY KEY,
  "vector_store_id" VARCHAR(64) NOT NULL,
  "file_id" VARCHAR(64) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'in_progress',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vector_store_files_vector_store_id_fkey" FOREIGN KEY ("vector_store_id") REFERENCES "vector_stores"("id") ON DELETE CASCADE,
  CONSTRAINT "vector_store_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "vector_store_files_vector_store_id_file_id_key" ON "vector_store_files"("vector_store_id", "file_id");
CREATE INDEX "vector_store_files_vector_store_id_idx" ON "vector_store_files"("vector_store_id");
CREATE INDEX "vector_store_files_file_id_idx" ON "vector_store_files"("file_id");
CREATE INDEX "vector_store_files_status_idx" ON "vector_store_files"("status");
