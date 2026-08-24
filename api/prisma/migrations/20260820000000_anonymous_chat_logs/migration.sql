-- Anonymous chat audit trail (2026-08-20): one investigable row per
-- anonymous chat completion. See schema.prisma's AnonymousChatLog docs.

CREATE TABLE "anonymous_chat_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" TEXT NOT NULL,
    "api_key_id" UUID NOT NULL,
    "visitor_fingerprint" TEXT NOT NULL,
    "visitor_ip" TEXT,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "accept_language" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "model_requested" TEXT,
    "models_served" JSONB NOT NULL DEFAULT '[]',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "response_text" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'success',
    "error_code" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anonymous_chat_logs_pkey" PRIMARY KEY ("id")
);

-- One audit row per request (matches request_logs.requestId uniqueness).
CREATE UNIQUE INDEX "anonymous_chat_logs_request_id_key" ON "anonymous_chat_logs"("request_id");

-- Abuse investigation: everything a fingerprint or IP did, newest first.
CREATE INDEX "anonymous_chat_logs_visitor_fingerprint_created_at_idx" ON "anonymous_chat_logs"("visitor_fingerprint", "created_at" DESC);
CREATE INDEX "anonymous_chat_logs_ip_hash_created_at_idx" ON "anonymous_chat_logs"("ip_hash", "created_at" DESC);
CREATE INDEX "anonymous_chat_logs_created_at_idx" ON "anonymous_chat_logs"("created_at" DESC);
