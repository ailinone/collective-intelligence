// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Langfuse Destination Adapter — POSTs envelopes to Langfuse's `/public/ingestion`
 * batch endpoint.
 *
 * Langfuse ingestion API (v1):
 *   POST {baseUrl}/api/public/ingestion
 *   Auth: HTTP Basic with publicKey:secretKey
 *   Body: { batch: [TraceEvent | GenerationEvent | ...] }
 *
 * Each broadcast envelope becomes ONE batch containing:
 *   - a `trace-create` event (the request as a Langfuse trace)
 *   - a `generation-create` event (the LLM call inside the trace)
 *
 * Config shape (decrypted):
 *   {
 *     baseUrl:   string   REQUIRED — e.g. https://cloud.langfuse.com
 *     publicKey: string   REQUIRED
 *     secretKey: string   REQUIRED
 *   }
 *
 * Langfuse returns:
 *   207 Multi-Status with partial success in `errors[]` — if any errors
 *       are present, we treat the whole batch as a failure but classify
 *       by the worst-case response code.
 *   401/403/404 → permanent
 *   429, 5xx → retryable
 */

import { randomUUID } from 'node:crypto';

import type {
  DeliveryContext,
  DeliveryOutcome,
  DestinationAdapter,
} from './destination-adapter';
import { EgressBlockedError, safeFetch } from './safe-http';

// ─── Config ─────────────────────────────────────────────────────────────

interface LangfuseConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

function parseConfig(raw: Record<string, unknown>): LangfuseConfig | { error: string } {
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl.startsWith('http')) {
    return { error: 'missing or invalid "baseUrl"' };
  }
  if (typeof raw.publicKey !== 'string' || raw.publicKey.length === 0) {
    return { error: 'missing or invalid "publicKey"' };
  }
  if (typeof raw.secretKey !== 'string' || raw.secretKey.length === 0) {
    return { error: 'missing or invalid "secretKey"' };
  }
  return {
    baseUrl: raw.baseUrl.replace(/\/$/, ''),
    publicKey: raw.publicKey,
    secretKey: raw.secretKey,
  };
}

// ─── Event construction ─────────────────────────────────────────────────

/**
 * Build the Langfuse ingestion payload from a TraceEnvelope.
 * Exported so tests can assert the mapping without standing up a server.
 */
export function buildLangfusePayload(ctx: DeliveryContext): {
  batch: Array<Record<string, unknown>>;
} {
  const env = ctx.envelope;
  const traceId = env.traceId; // 32 hex — valid Langfuse id
  const generationId = env.spanId + env.spanId; // 32 hex — unique per generation
  const now = new Date().toISOString();

  const traceEvent: Record<string, unknown> = {
    id: randomUUID(),
    type: 'trace-create',
    timestamp: now,
    body: {
      id: traceId,
      timestamp: env.occurredAt,
      name: `chat.completion:${env.generation.model.slug}`,
      userId: env.tenant.userId ?? undefined,
      sessionId: (env.custom?.sessionId as string | undefined) ?? undefined,
      release: env.resource.deploymentEnvironment,
      metadata: {
        organizationId: env.tenant.organizationId,
        apiKeyId: env.tenant.apiKeyId,
        requestId: env.requestId,
        provider: env.routing.selectedProvider,
        retryAttempts: env.routing.retryAttempts,
      },
      tags: [env.generation.model.provider, env.resource.deploymentEnvironment],
      input: env.content.messages,
      output: env.content.choices,
      public: false,
    },
  };

  const generationEvent: Record<string, unknown> = {
    id: randomUUID(),
    type: 'generation-create',
    timestamp: now,
    body: {
      id: generationId,
      traceId,
      name: env.generation.model.slug,
      startTime: env.generation.timing.startedAt,
      endTime: env.generation.timing.endedAt,
      model: env.generation.model.slug,
      modelParameters: undefined,
      input: env.content.messages,
      output: env.content.choices,
      usage: {
        input: env.generation.usage.inputTokens,
        output: env.generation.usage.outputTokens,
        total: env.generation.usage.totalTokens,
        unit: 'TOKENS',
        inputCost: null,
        outputCost: null,
        totalCost: env.generation.usage.costUsd,
      },
      level: env.status.code === 'error' ? 'ERROR' : 'DEFAULT',
      statusMessage: env.status.errorMessage,
      metadata: {
        streaming: env.generation.streaming,
        latencyMs: env.generation.timing.latencyMs,
        reason: env.routing.reason,
      },
    },
  };

  return { batch: [traceEvent, generationEvent] };
}

// ─── Error classification ───────────────────────────────────────────────

function classifyStatus(status: number): 'success' | 'retryable' | 'permanent' {
  if (status >= 200 && status < 300) return 'success';
  if (status === 207) return 'success'; // multi-status — caller reads errors[]
  if (status === 401 || status === 403 || status === 404) return 'permanent';
  if (status === 422 || status === 400) return 'permanent';
  if (status === 429 || status === 408 || status >= 500) return 'retryable';
  return 'retryable';
}

function errorClassForStatus(status: number): string {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  // Bounded fallback — see webhook-adapter for rationale.
  return 'http_other';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// ─── Adapter ────────────────────────────────────────────────────────────

export class LangfuseDestinationAdapter implements DestinationAdapter {
  readonly type = 'langfuse' as const;

  async send(ctx: DeliveryContext): Promise<DeliveryOutcome> {
    const start = Date.now();
    const parsed = parseConfig(ctx.config);
    if ('error' in parsed) {
      return {
        kind: 'permanent',
        errorClass: 'config_invalid',
        errorMessage: parsed.error,
        latencyMs: 0,
      };
    }
    const cfg = parsed;

    const payload = buildLangfusePayload(ctx);
    const body = JSON.stringify(payload);
    const auth = Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`, 'utf8').toString('base64');

    try {
      const res = await safeFetch(`${cfg.baseUrl}/api/public/ingestion`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${auth}`,
          'user-agent': 'ailin-broadcast/1.0',
          'x-broadcast-delivery-id': ctx.deliveryAttemptId,
        },
        body,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      });
      const latencyMs = Date.now() - start;
      const kind = classifyStatus(res.status);

      if (kind === 'success') {
        // Inspect 207 errors[] even on success — any partial failure is a
        // classification-worthy event but we record success so we don't
        // retry (retry would double-write the trace with new event ids).
        if (res.status === 207) {
          try {
            const parsedBody = JSON.parse(res.body.toString('utf8')) as {
              errors?: Array<{ status?: number; message?: string }>;
            };
            if (parsedBody.errors && parsedBody.errors.length > 0) {
              return {
                kind: 'success',
                statusCode: 207,
                errorClass: 'partial_failure',
                errorMessage: truncate(
                  parsedBody.errors.map((e) => e.message ?? '').join(';'),
                  512,
                ),
                latencyMs,
              };
            }
          } catch {
            /* ignore parse errors */
          }
        }
        return { kind: 'success', statusCode: res.status, latencyMs };
      }

      return {
        kind,
        statusCode: res.status,
        errorClass: errorClassForStatus(res.status),
        errorMessage: truncate(res.body.toString('utf8'), 512),
        latencyMs,
      };
    } catch (e) {
      const latencyMs = Date.now() - start;
      if (e instanceof EgressBlockedError) {
        if (e.reason === 'host_resolution_failed') {
          return {
            kind: 'retryable',
            errorClass: 'dns_resolution_failed',
            errorMessage: truncate(e.message, 512),
            latencyMs,
          };
        }
        return {
          kind: 'permanent',
          errorClass: e.reason,
          errorMessage: truncate(e.message, 512),
          latencyMs,
        };
      }
      const err = e as Error;
      if (err.name === 'AbortError') {
        return {
          kind: 'retryable',
          errorClass: 'timeout',
          errorMessage: 'request aborted',
          latencyMs,
        };
      }
      return {
        kind: 'retryable',
        errorClass: 'network_error',
        errorMessage: truncate(err.message, 512),
        latencyMs,
      };
    }
  }
}
