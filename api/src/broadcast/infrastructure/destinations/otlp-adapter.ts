// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OTLP Collector Destination Adapter — POSTs OTLP/HTTP-JSON `ExportTraceServiceRequest`
 * to any OTEL collector endpoint (Honeycomb, Grafana Tempo, Jaeger, self-hosted).
 *
 * Spec: https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/
 * Request format (OTLP/HTTP-JSON):
 *   POST {endpoint}/v1/traces
 *   Content-Type: application/json
 *   { resourceSpans: [{ resource: {...}, scopeSpans: [{ spans: [...] }] }] }
 *
 * Config shape:
 *   {
 *     endpoint:   string              REQUIRED — base URL of the collector
 *     headers:    Record<string,string>?  custom headers (Auth typically)
 *     compression: 'none' | 'gzip'?   default: 'none'  (gzip unsupported for now)
 *     tracesPath: string?             default: '/v1/traces'
 *   }
 */

import type {
  DeliveryContext,
  DeliveryOutcome,
  DestinationAdapter,
} from './destination-adapter';
import { EgressBlockedError, safeFetch } from './safe-http';

// ─── Config ─────────────────────────────────────────────────────────────

interface OtlpConfig {
  endpoint: string;
  tracesPath: string;
  headers: Record<string, string>;
}

const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type']);

function parseConfig(raw: Record<string, unknown>): OtlpConfig | { error: string } {
  if (typeof raw.endpoint !== 'string' || !raw.endpoint.startsWith('http')) {
    return { error: 'missing or invalid "endpoint"' };
  }
  const tracesPath =
    typeof raw.tracesPath === 'string' && raw.tracesPath.length > 0
      ? raw.tracesPath
      : '/v1/traces';
  const headers: Record<string, string> = {};
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [k, v] of Object.entries(raw.headers)) {
      if (RESERVED_HEADERS.has(k.toLowerCase())) continue;
      if (typeof v === 'string') headers[k] = v;
    }
  }
  return {
    endpoint: raw.endpoint.replace(/\/$/, ''),
    tracesPath: tracesPath.startsWith('/') ? tracesPath : `/${tracesPath}`,
    headers,
  };
}

// ─── OTLP payload construction ──────────────────────────────────────────

/**
 * Convert an ISO date to the OTLP nanoseconds-since-epoch string.
 * OTLP wire format uses string for int64 so we don't lose precision.
 */
function nanosFromIso(iso: string): string {
  const ms = Date.parse(iso);
  // Millisecond precision × 1e6 = nanoseconds. For higher precision, the
  // envelope would need to carry it explicitly.
  return (BigInt(ms) * 1_000_000n).toString();
}

export function buildOtlpPayload(ctx: DeliveryContext): unknown {
  const env = ctx.envelope;
  const start = nanosFromIso(env.generation.timing.startedAt);
  const end = nanosFromIso(env.generation.timing.endedAt);

  // Attributes: flatten tenant + usage + routing.
  const attributes = [
    attrString('service.name', env.resource.serviceName),
    attrString('deployment.environment', env.resource.deploymentEnvironment),
    attrString('gen_ai.system', env.generation.model.provider),
    attrString('gen_ai.request.model', env.generation.model.slug),
    attrString('gen_ai.response.model', env.generation.model.slug),
    attrInt('gen_ai.usage.input_tokens', env.generation.usage.inputTokens),
    attrInt('gen_ai.usage.output_tokens', env.generation.usage.outputTokens),
    attrInt('gen_ai.usage.total_tokens', env.generation.usage.totalTokens),
    attrDouble('gen_ai.usage.cost_usd', env.generation.usage.costUsd),
    attrBool('gen_ai.streaming', env.generation.streaming),
    attrString('ailin.routing.reason', env.routing.reason),
    attrInt('ailin.routing.retry_attempts', env.routing.retryAttempts),
    attrString('ailin.request_id', env.requestId),
    ...(env.tenant.organizationId
      ? [attrString('ailin.organization_id', env.tenant.organizationId)]
      : []),
    ...(env.tenant.userId ? [attrString('ailin.user_id', env.tenant.userId)] : []),
    ...(env.tenant.apiKeyId ? [attrString('ailin.api_key_id', env.tenant.apiKeyId)] : []),
  ];

  const span = {
    traceId: env.traceId,
    spanId: env.spanId,
    name: `chat.completion:${env.generation.model.slug}`,
    kind: 3, // SPAN_KIND_CLIENT per OTLP enum
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes,
    status: {
      code: env.status.code === 'error' ? 2 : env.status.code === 'ok' ? 1 : 0,
      message: env.status.errorMessage,
    },
  };

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attrString('service.name', env.resource.serviceName),
            attrString('deployment.environment', env.resource.deploymentEnvironment),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'ailin-broadcast', version: '1.0' },
            spans: [span],
          },
        ],
      },
    ],
  };
}

// ─── Attribute helpers ──────────────────────────────────────────────────

function attrString(key: string, value: string) {
  return { key, value: { stringValue: value } };
}
function attrInt(key: string, value: number) {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}
function attrDouble(key: string, value: number) {
  return { key, value: { doubleValue: value } };
}
function attrBool(key: string, value: boolean) {
  return { key, value: { boolValue: value } };
}

// ─── Classification ─────────────────────────────────────────────────────

function classifyStatus(status: number): 'success' | 'retryable' | 'permanent' {
  if (status >= 200 && status < 300) return 'success';
  if (status === 401 || status === 403 || status === 404) return 'permanent';
  if (status === 400 || status === 422) return 'permanent';
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

export class OtlpCollectorDestinationAdapter implements DestinationAdapter {
  readonly type = 'otlp_collector' as const;

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

    const payload = buildOtlpPayload(ctx);
    const body = JSON.stringify(payload);

    try {
      const res = await safeFetch(`${parsed.endpoint}${parsed.tracesPath}`, {
        method: 'POST',
        headers: {
          ...parsed.headers,
          'content-type': 'application/json',
          'user-agent': 'ailin-broadcast/1.0',
          'x-broadcast-delivery-id': ctx.deliveryAttemptId,
        },
        body,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      });
      const latencyMs = Date.now() - start;
      const kind = classifyStatus(res.status);
      if (kind === 'success') return { kind: 'success', statusCode: res.status, latencyMs };
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
