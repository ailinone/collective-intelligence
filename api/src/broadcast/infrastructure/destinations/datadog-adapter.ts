// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Datadog Destination Adapter — POSTs the envelope as a single LLM
 * observability event to Datadog's ingest API.
 *
 * We use Datadog's /api/v2/logs (logs intake) endpoint because it's the
 * simplest lowest-friction target and Datadog LLM Observability is
 * built on top of it. For richer LLM features, tenants can upgrade to
 * the LLM-specific API in a future version.
 *
 * Config shape (decrypted):
 *   {
 *     apiKey:  string   REQUIRED
 *     site:    string?  default: 'datadoghq.com'
 *                       options: 'datadoghq.com' | 'datadoghq.eu' | 'us3.datadoghq.com' | …
 *     service: string?  default: 'ailin-broadcast'
 *     env:     string?  default: envelope.resource.deploymentEnvironment
 *     tags:    string[]? extra tags appended to ddtags
 *   }
 *
 * Request:
 *   POST https://http-intake.logs.{site}/api/v2/logs
 *   DD-API-KEY: <apiKey>
 *   Content-Type: application/json
 *   Body: [ { ...event... } ]
 */

import type {
  DeliveryContext,
  DeliveryOutcome,
  DestinationAdapter,
} from './destination-adapter';
import { EgressBlockedError, safeFetch } from './safe-http';

// ─── Config ─────────────────────────────────────────────────────────────

interface DatadogConfig {
  apiKey: string;
  site: string;
  service: string;
  env?: string;
  tags: string[];
}

const ALLOWED_SITES = new Set([
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ddog-gov.com',
  'ap1.datadoghq.com',
]);

function parseConfig(raw: Record<string, unknown>): DatadogConfig | { error: string } {
  if (typeof raw.apiKey !== 'string' || raw.apiKey.length === 0) {
    return { error: 'missing or invalid "apiKey"' };
  }
  const site =
    typeof raw.site === 'string' && raw.site.length > 0 ? raw.site : 'datadoghq.com';
  // Allowlist prevents a malicious tenant from pointing us at an attacker
  // domain that happens to match `*.datadoghq.com` lookalikes.
  if (!ALLOWED_SITES.has(site)) {
    return { error: `site "${site}" is not in the allowlist` };
  }
  const service =
    typeof raw.service === 'string' && raw.service.length > 0
      ? raw.service
      : 'ailin-broadcast';
  const env = typeof raw.env === 'string' ? raw.env : undefined;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string').slice(0, 32)
    : [];
  return { apiKey: raw.apiKey, site, service, env, tags };
}

// ─── Event construction ─────────────────────────────────────────────────

export function buildDatadogEvents(
  ctx: DeliveryContext,
  cfg: DatadogConfig,
): Array<Record<string, unknown>> {
  const env = ctx.envelope;
  const envLabel = cfg.env ?? env.resource.deploymentEnvironment;

  const ddtags = [
    `service:${cfg.service}`,
    `env:${envLabel}`,
    `provider:${env.generation.model.provider}`,
    `model:${env.generation.model.slug}`,
    `status:${env.status.code}`,
    ...(env.tenant.organizationId ? [`organization_id:${env.tenant.organizationId}`] : []),
    ...(env.tenant.userId ? [`user_id:${env.tenant.userId}`] : []),
    ...cfg.tags,
  ].join(',');

  // Single event representing the LLM call.
  const event: Record<string, unknown> = {
    message: `chat.completion ${env.generation.model.slug} ${env.status.code}`,
    ddsource: 'ailin-broadcast',
    ddtags,
    hostname: env.resource.serviceName,
    service: cfg.service,
    status: env.status.code === 'error' ? 'error' : 'info',
    // Nested structured attributes for Datadog's JSON auto-extraction.
    attributes: {
      timestamp: env.occurredAt,
      trace_id: env.traceId,
      span_id: env.spanId,
      request_id: env.requestId,
      envelope_id: env.envelopeId,
      delivery_attempt_id: ctx.deliveryAttemptId,
      tenant: env.tenant,
      resource: env.resource,
      generation: env.generation,
      routing: env.routing,
      content: env.content,
      custom: env.custom,
      status: env.status,
    },
  };

  return [event];
}

// ─── Classification ─────────────────────────────────────────────────────

function classifyStatus(status: number): 'success' | 'retryable' | 'permanent' {
  if (status >= 200 && status < 300) return 'success';
  if (status === 401 || status === 403 || status === 413) return 'permanent';
  if (status === 400) return 'permanent';
  if (status === 429 || status === 408 || status >= 500) return 'retryable';
  return 'retryable';
}

function errorClassForStatus(status: number): string {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 413) return 'payload_too_large';
  if (status === 400) return 'bad_request';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  // Bounded fallback — see webhook-adapter for rationale.
  return 'http_other';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// ─── Adapter ────────────────────────────────────────────────────────────

export class DatadogDestinationAdapter implements DestinationAdapter {
  readonly type = 'datadog' as const;

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

    // `urlOverride` is a test-only escape hatch to point the adapter at a
    // local http.Server without spoofing DNS. In production it's a full
    // SSRF bypass (it skips the `ALLOWED_SITES` allowlist above), so we
    // REFUSE to honor it unless the same env gate that allows private-IP
    // egress is set. `BROADCAST_EGRESS_ALLOW_PRIVATE=true` is documented
    // as test-only and is never set in any production deployment.
    const testEgressAllowed = process.env.BROADCAST_EGRESS_ALLOW_PRIVATE === 'true';
    const urlOverride =
      testEgressAllowed && typeof ctx.config.urlOverride === 'string'
        ? ctx.config.urlOverride
        : undefined;

    const url = urlOverride ?? `https://http-intake.logs.${cfg.site}/api/v2/logs`;
    const events = buildDatadogEvents(ctx, cfg);
    const body = JSON.stringify(events);

    try {
      const res = await safeFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'dd-api-key': cfg.apiKey,
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
