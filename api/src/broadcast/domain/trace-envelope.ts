// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * TraceEnvelope v1 — Canonical trace schema for Broadcast
 *
 * See ADR-014 (Transactional Outbox), ADR-015 (OTLP Canonical Wire Format),
 * ADR-016 (Privacy Mode at Serializer).
 *
 * This is the immutable, Zod-validated envelope that carries every request's
 * observability data from the hot path into the broadcast outbox. Serializers
 * (src/broadcast/infrastructure/serialization/*) transform this envelope into
 * destination-specific wire formats.
 *
 * Schema versioning:
 *   - Increment TRACE_ENVELOPE_SCHEMA_VERSION on breaking changes.
 *   - Consumers MUST support version N and N-1 (see ARCHITECTURE-GOVERNANCE §6).
 *   - Field deprecation: mark with `.describe('DEPRECATED: removed in v2')`.
 *
 * Branded types:
 *   - TraceId, SpanId, EnvelopeId prevent accidental cross-wiring between
 *     OTEL trace_ids, our internal request_ids, and envelope identifiers.
 */

import { z } from 'zod';

// ─── Schema Version ──────────────────────────────────────────────────────

export const TRACE_ENVELOPE_SCHEMA_VERSION = '1.0' as const;

// ─── Branded Types ───────────────────────────────────────────────────────

const Brand = <B extends string>(schema: z.ZodString, _brand: B) =>
  schema.transform((v) => v as string & { readonly __brand: B });

/** 16-byte hex (32 chars). OTEL trace_id. */
export const TraceIdSchema = Brand(
  z.string().regex(/^[0-9a-f]{32}$/i, 'must be 32 lowercase hex chars (OTEL trace_id)'),
  'TraceId'
);
export type TraceId = z.infer<typeof TraceIdSchema>;

/** 8-byte hex (16 chars). OTEL span_id. */
export const SpanIdSchema = Brand(
  z.string().regex(/^[0-9a-f]{16}$/i, 'must be 16 lowercase hex chars (OTEL span_id)'),
  'SpanId'
);
export type SpanId = z.infer<typeof SpanIdSchema>;

/** UUID identifying a row in broadcast_trace_outbox. */
export const EnvelopeIdSchema = Brand(z.string().uuid(), 'EnvelopeId');
export type EnvelopeId = z.infer<typeof EnvelopeIdSchema>;

/** Our internal request identifier (propagated via AsyncLocalStorage). */
export const RequestIdSchema = Brand(z.string().min(1).max(128), 'RequestId');
export type RequestId = z.infer<typeof RequestIdSchema>;

// ─── Tenant ──────────────────────────────────────────────────────────────

export const TenantContextSchema = z.object({
  organizationId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  apiKeyId: z.string().uuid().nullable(),
  // The effective tenant used for destination resolution (see ADR-020).
  // 'organization' means org-scoped destinations apply; 'user' means user-scoped.
  // 'chatroom' means only org-scoped destinations apply (no user context).
  resolutionScope: z.enum(['organization', 'user', 'chatroom']),
});
export type TenantContext = z.infer<typeof TenantContextSchema>;

// ─── Resource (OTEL resource attributes) ─────────────────────────────────

export const ResourceSchema = z.object({
  serviceName: z.string().default('ailin-ci-api'),
  serviceVersion: z.string().optional(),
  deploymentEnvironment: z.enum(['development', 'staging', 'production']),
  // Host identity (pod/container) for horizontal scaling diagnostics.
  hostInstanceId: z.string().optional(),
});
export type Resource = z.infer<typeof ResourceSchema>;

// ─── Generation (GenAI semantic conventions) ─────────────────────────────

export const GenerationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  // Reasoning tokens (for models that expose them, e.g., Claude extended thinking)
  reasoningTokens: z.number().int().nonnegative().optional(),
  // Cached input tokens (Claude/OpenAI caching)
  cachedInputTokens: z.number().int().nonnegative().optional(),
  // Cost in USD, high precision to preserve fractional-cent accuracy
  costUsd: z.number().nonnegative().describe('Total cost in USD (decimal 18,10 in DB)'),
});

export const GenerationTimingSchema = z.object({
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  latencyMs: z.number().int().nonnegative(),
  // Time to first token (streaming); absent for non-streaming
  ttftMs: z.number().int().nonnegative().optional(),
  // Time spent in our queue before hitting the provider
  queueTimeMs: z.number().int().nonnegative().optional(),
});

export const GenerationModelSchema = z.object({
  // Canonical model slug (e.g., 'anthropic/claude-opus-4-6')
  slug: z.string().min(1).max(128),
  // Provider that executed the request (e.g., 'anthropic', 'openrouter')
  provider: z.string().min(1).max(64),
  // Provider originally hosting the model (may differ for hubs; e.g., slug
  // 'openai/gpt-5' but executed via 'aihubmix')
  originProvider: z.string().min(1).max(64).optional(),
});

export const GenerationSchema = z.object({
  model: GenerationModelSchema,
  usage: GenerationUsageSchema,
  timing: GenerationTimingSchema,
  finishReason: z
    .enum(['stop', 'length', 'tool_calls', 'content_filter', 'error', 'cancelled'])
    .optional(),
  /** True if the response was delivered via streaming. */
  streaming: z.boolean().default(false),
});
export type Generation = z.infer<typeof GenerationSchema>;

// ─── Routing (ci/api-specific) ───────────────────────────────────────────

export const RoutingCandidateSchema = z.object({
  providerId: z.string(),
  score: z.number(),
  excluded: z.string().optional().describe('Reason for exclusion if not selected'),
});

export const BanditStateSchema = z.object({
  alpha: z.number().positive(),
  beta: z.number().positive(),
  sampledScore: z.number().min(0).max(1),
  // LinUCB contextual bandit state (L10)
  contextVector: z.array(z.number()).optional(),
});

export const RoutingSchema = z.object({
  equivalenceGroup: z.string().optional(),
  selectedProvider: z.string(),
  reason: z.string().describe('Human-readable selection rationale'),
  candidatesConsidered: z.array(RoutingCandidateSchema),
  banditState: BanditStateSchema.optional(),
  circuitBreakerState: z.enum(['closed', 'half_open', 'open']).optional(),
  creditMonitorState: z.enum(['has-credits', 'no-credits', 'unknown']).optional(),
  canaryGateDecision: z.enum(['pass', 'fail', 'not_applicable']).optional(),
  /** Number of retry attempts (cross-provider fallback) before success or final failure. */
  retryAttempts: z.number().int().nonnegative().default(0),
});
export type Routing = z.infer<typeof RoutingSchema>;

// ─── Content (privacy-sensitive; redacted per ADR-016) ───────────────────

export const MessageContentSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().or(z.array(z.any())).describe('String or multimodal content parts'),
  name: z.string().optional(),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string().describe('JSON-encoded args; redacted in Privacy Mode'),
  }),
});

export const ChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  message: MessageContentSchema,
  toolCalls: z.array(ToolCallSchema).optional(),
  finishReason: z.string().optional(),
});

export const ContentSchema = z.object({
  messages: z.array(MessageContentSchema).describe('Input messages; redacted in Privacy Mode'),
  choices: z.array(ChoiceSchema).describe('Output choices; redacted in Privacy Mode'),
  toolsDefinedInRequest: z.array(z.record(z.unknown())).optional(),
  // Multimodal content (images, audio) is stripped before envelope construction
  // to keep outbox rows bounded. A marker records presence.
  multimodalStripped: z.boolean().default(false),
});
export type Content = z.infer<typeof ContentSchema>;

// ─── Custom metadata (user-supplied via `trace` field) ───────────────────

export const CustomTraceMetadataSchema = z
  .object({
    traceId: z.string().max(128).optional().describe('Groups multiple API requests'),
    traceName: z.string().max(256).optional(),
    spanName: z.string().max(256).optional(),
    generationName: z.string().max(256).optional(),
    parentSpanId: z.string().max(64).optional(),
    sessionId: z.string().max(128).optional(),
    userId: z.string().max(128).optional().describe('End-user identifier (not our userId)'),
    environment: z.string().max(64).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    version: z.string().max(64).optional(),
    feature: z.string().max(128).optional(),
  })
  // Allow any additional string/number/boolean keys (bounded size)
  .catchall(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe('User-supplied trace metadata, passed through to destinations');
export type CustomTraceMetadata = z.infer<typeof CustomTraceMetadataSchema>;

// ─── Status ──────────────────────────────────────────────────────────────

export const StatusSchema = z.object({
  code: z.enum(['ok', 'error', 'cancelled']),
  httpStatus: z.number().int().optional(),
  errorClass: z.string().optional().describe('Our error classification (e.g., "rate_limit")'),
  errorMessage: z.string().max(4096).optional(),
});
export type Status = z.infer<typeof StatusSchema>;

// ─── Top-Level Envelope ──────────────────────────────────────────────────

export const TraceEnvelopeSchema = z.object({
  schemaVersion: z.literal(TRACE_ENVELOPE_SCHEMA_VERSION),
  envelopeId: EnvelopeIdSchema,
  traceId: TraceIdSchema,
  spanId: SpanIdSchema,
  parentSpanId: SpanIdSchema.optional(),
  requestId: RequestIdSchema,
  occurredAt: z.string().datetime({ offset: true }),

  tenant: TenantContextSchema,
  resource: ResourceSchema,
  generation: GenerationSchema,
  routing: RoutingSchema,
  content: ContentSchema,
  custom: CustomTraceMetadataSchema.default({}),
  status: StatusSchema,
});
export type TraceEnvelope = z.infer<typeof TraceEnvelopeSchema>;

// ─── Parse Helpers ───────────────────────────────────────────────────────

/**
 * Strict parse — throws on invalid envelope.
 * Use on trusted code paths (after construction by our own code).
 */
export function parseTraceEnvelope(input: unknown): TraceEnvelope {
  return TraceEnvelopeSchema.parse(input);
}

/**
 * Safe parse — returns Result-style tuple.
 * Use on untrusted inputs (e.g., replay from outbox after a schema upgrade).
 */
export function safeParseTraceEnvelope(
  input: unknown
): { ok: true; envelope: TraceEnvelope } | { ok: false; error: z.ZodError } {
  const r = TraceEnvelopeSchema.safeParse(input);
  return r.success ? { ok: true, envelope: r.data } : { ok: false, error: r.error };
}

/**
 * Schema-version check for forward compatibility.
 * Outbox envelopes persisted under an older schema version are detected here.
 */
export function isCompatibleSchemaVersion(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const v = (input as { schemaVersion?: unknown }).schemaVersion;
  return v === TRACE_ENVELOPE_SCHEMA_VERSION;
}
