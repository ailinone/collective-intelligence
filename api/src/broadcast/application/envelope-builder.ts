// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * TraceEnvelope builder — assembles a validated envelope from chat completion
 * data available at the edge of the /v1/chat/completions handler.
 *
 * Separation-of-concerns note: this builder is PURE. It does no I/O, holds no
 * Prisma client, and does not decide privacy policy. Privacy and destination
 * resolution happen downstream (executor → redactor). The builder only
 * guarantees envelope shape conformance via Zod.
 *
 * Coverage:
 *   - Input: what the caller sent (messages, tools, strategy).
 *   - Generation: output tokens + cost + timing.
 *   - Routing: which model answered + any fallback trail in ailin_metadata.
 *   - Status: ok/error + http status.
 *
 * Out of scope for this builder (future work):
 *   - Streaming envelopes (chunk-level trace) — TODO: Fase 3.
 *   - Tool-call argument capture — currently only the CHOICES toolCalls are
 *     mirrored because our input schema doesn't carry a defined tool_calls
 *     array of the right shape; in a follow-up we can lift the `toolsDefinedInRequest`.
 */

import { randomUUID } from 'node:crypto';

import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  AilinMetadata,
} from '@/types';
import {
  TRACE_ENVELOPE_SCHEMA_VERSION,
  parseTraceEnvelope,
  type TraceEnvelope,
} from '@/broadcast/domain/trace-envelope';

/**
 * Hex trace_id (32 chars) / span_id (16 chars) as required by OTEL.
 * We generate them per-envelope because the HTTP edge has no incoming OTEL
 * context (this is the trace root).
 */
function randomHex(bytes: number): string {
  // Using nanoid-like base16 via crypto.randomUUID stripped of dashes + padding.
  // randomUUID() is 32 hex chars — reuse it for trace_id (32 chars); for
  // span_id take the first 16 chars.
  const uuid = randomUUID().replace(/-/g, '');
  return uuid.slice(0, bytes * 2);
}

export interface BuildEnvelopeArgs {
  /** The canonical chat request after normalization. */
  chatRequest: ChatRequest;
  /** The assistant response produced by orchestration. */
  chatResponse: ChatResponse;
  /** Our internal request identifier (propagated via AsyncLocalStorage). */
  requestId: string;
  /** Tenant context resolved from the authenticated principal. */
  tenant: {
    organizationId: string | null;
    userId: string | null;
    apiKeyId: string | null;
    resolutionScope: 'organization' | 'user' | 'chatroom';
  };
  /** Wall-clock start / end of the request. */
  startedAt: Date;
  endedAt: Date;
  /** Resource-level attributes. */
  deploymentEnvironment: 'development' | 'staging' | 'production';
  serviceVersion?: string;
  hostInstanceId?: string;
  /** Whether the response was streamed. Default false. */
  streaming?: boolean;
  /**
   * Terminal status. `ok` means the response was delivered successfully;
   * `error` means the orchestrator threw; `cancelled` means client aborted.
   */
  status?: 'ok' | 'error' | 'cancelled';
  httpStatus?: number;
  errorClass?: string;
  errorMessage?: string;
}

/**
 * Build a TraceEnvelope. Throws if the assembled envelope fails Zod validation —
 * that would indicate a defect in the builder (not a runtime issue), so the
 * caller should log and continue rather than failing the user's request.
 */
export function buildChatTraceEnvelope(args: BuildEnvelopeArgs): TraceEnvelope {
  const metadata = args.chatResponse.ailin_metadata as AilinMetadata | undefined;
  const latencyMs = Math.max(
    0,
    Math.round(args.endedAt.getTime() - args.startedAt.getTime()),
  );

  const finishReason = normalizeFinishReason(args.chatResponse.choices?.[0]?.finish_reason);

  const modelSlug =
    (args.chatResponse.model as string | undefined) ??
    metadata?.resolved_model ??
    metadata?.final_decider_model_id ??
    (args.chatRequest.model as string | undefined) ??
    'unknown';

  const provider =
    (metadata?.provider as string | undefined) ??
    inferProviderFromSlug(modelSlug) ??
    'unknown';

  const tokensInput = args.chatResponse.usage?.prompt_tokens ?? 0;
  const tokensOutput = args.chatResponse.usage?.completion_tokens ?? 0;
  const tokensTotal =
    args.chatResponse.usage?.total_tokens ?? tokensInput + tokensOutput;

  const costUsd =
    typeof metadata?.cost_usd === 'number' && Number.isFinite(metadata.cost_usd)
      ? metadata.cost_usd
      : 0;

  const messages = (args.chatRequest.messages ?? []).map((m) => ({
    role: normalizeRole(m.role),
    content: coerceContent(m.content),
    ...(m.name ? { name: m.name } : {}),
  }));

  const choices = (args.chatResponse.choices ?? []).map((c, i) => ({
    index: typeof c.index === 'number' ? c.index : i,
    message: {
      role: 'assistant' as const,
      content: coerceContent(c.message?.content),
    },
    finishReason: c.finish_reason ?? undefined,
  }));

  const multimodalStripped = detectMultimodal(args.chatRequest.messages);

  const candidatesConsidered = Array.isArray(metadata?.fallback_chain)
    ? metadata.fallback_chain.map((slug) => ({
        providerId: typeof slug === 'string' ? slug : String(slug),
        score: 0,
      }))
    : [];

  const envelope = {
    schemaVersion: TRACE_ENVELOPE_SCHEMA_VERSION,
    envelopeId: randomUUID(),
    traceId: randomHex(16),
    spanId: randomHex(8),
    requestId: args.requestId,
    occurredAt: args.endedAt.toISOString(),
    tenant: {
      organizationId: args.tenant.organizationId,
      userId: args.tenant.userId,
      apiKeyId: args.tenant.apiKeyId,
      resolutionScope: args.tenant.resolutionScope,
    },
    resource: {
      serviceName: 'ailin-ci-api',
      serviceVersion: args.serviceVersion,
      deploymentEnvironment: args.deploymentEnvironment,
      hostInstanceId: args.hostInstanceId,
    },
    generation: {
      model: { slug: modelSlug.slice(0, 128), provider: provider.slice(0, 64) },
      usage: {
        inputTokens: tokensInput,
        outputTokens: tokensOutput,
        totalTokens: tokensTotal,
        costUsd,
      },
      timing: {
        startedAt: args.startedAt.toISOString(),
        endedAt: args.endedAt.toISOString(),
        latencyMs,
      },
      finishReason,
      streaming: args.streaming ?? false,
    },
    routing: {
      selectedProvider: provider.slice(0, 64),
      reason:
        (metadata?.resolved_strategy as string | undefined) ??
        (args.chatRequest.strategy as string | undefined) ??
        'default',
      candidatesConsidered,
      retryAttempts: Math.max(0, candidatesConsidered.length - 1),
    },
    content: {
      messages,
      choices,
      multimodalStripped,
    },
    custom: {},
    status: {
      code: args.status ?? 'ok',
      httpStatus: args.httpStatus,
      errorClass: args.errorClass,
      errorMessage: args.errorMessage,
    },
  };

  return parseTraceEnvelope(envelope);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function normalizeRole(role: string): 'system' | 'user' | 'assistant' | 'tool' {
  switch (role) {
    case 'system':
    case 'user':
    case 'assistant':
    case 'tool':
      return role;
    case 'function':
      return 'tool';
    default:
      return 'user';
  }
}

function normalizeFinishReason(
  fr: string | null | undefined,
):
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'cancelled'
  | undefined {
  if (!fr) return undefined;
  switch (fr) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
    case 'error':
    case 'cancelled':
      return fr;
    case 'function_call':
      return 'tool_calls';
    default:
      return undefined;
  }
}

function coerceContent(content: ChatMessage['content'] | undefined): string | unknown[] {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content;
  if (content == null) return '';
  // TraceEnvelope schema accepts string | array — stringify objects.
  return JSON.stringify(content);
}

function detectMultimodal(messages: ChatMessage[] | undefined): boolean {
  if (!messages) return false;
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content as Array<{ type?: string }>) {
        if (part && typeof part === 'object' && part.type && part.type !== 'text') {
          return true;
        }
      }
    }
  }
  return false;
}

function inferProviderFromSlug(slug: string): string | undefined {
  const idx = slug.indexOf(':');
  if (idx > 0) return slug.slice(0, idx);
  const idx2 = slug.indexOf('/');
  if (idx2 > 0) return slug.slice(0, idx2);
  return undefined;
}
