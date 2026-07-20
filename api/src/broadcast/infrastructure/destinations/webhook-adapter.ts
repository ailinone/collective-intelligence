// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Webhook Destination Adapter — POSTs the trace envelope as JSON to a
 * tenant-configured URL, signed with HMAC-SHA256.
 *
 * Config shape (decrypted):
 *   {
 *     url:             string              REQUIRED — https:// strongly preferred
 *     secret:          string              REQUIRED — HMAC key (utf8)
 *     signatureHeader: string?             default: 'X-Webhook-Signature'
 *     timestampHeader: string?             default: 'X-Webhook-Timestamp'
 *     signatureScheme: 'v1' | 'v2'?        default: 'v1'
 *     customHeaders:   Record<string,string>?  extra headers (keys normalized)
 *   }
 *
 * Signature scheme v1 (OpenRouter parity):
 *   timestamp = Math.floor(Date.now() / 1000).toString()
 *   message   = timestamp + "." + body
 *   digest    = HMAC_SHA256(secret, message).hexdigest()
 *   header    = "t=" + timestamp + ",v1=" + digest
 *
 * Signature scheme v2 (simpler):
 *   header = "sha256=" + HMAC_SHA256(secret, body).hexdigest()
 *   separate X-Webhook-Timestamp header with the unix seconds.
 *
 * Error classification:
 *   - 2xx                                       → success
 *   - 400, 401, 403, 404, 410, 422, 451         → permanent (config wrong)
 *   - 408, 425, 429, 5xx                        → retryable
 *   - network / DNS / timeout / SSRF-block      → retryable (SSRF = permanent)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  DeliveryContext,
  DeliveryOutcome,
  DestinationAdapter,
} from './destination-adapter';
import { EgressBlockedError, safeFetch } from './safe-http';

// ─── Config types ───────────────────────────────────────────────────────

export interface WebhookConfig {
  url: string;
  secret: string;
  signatureHeader?: string;
  timestampHeader?: string;
  signatureScheme?: 'v1' | 'v2';
  customHeaders?: Record<string, string>;
}

// ─── Permanent vs retryable classification ──────────────────────────────

const PERMANENT_STATUS = new Set([400, 401, 403, 404, 410, 422, 451]);
const RETRYABLE_STATUS = new Set([408, 425, 429]);

function classifyStatus(status: number): 'success' | 'retryable' | 'permanent' {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 500) return 'retryable';
  if (RETRYABLE_STATUS.has(status)) return 'retryable';
  if (PERMANENT_STATUS.has(status)) return 'permanent';
  // 3xx shouldn't reach here (safeFetch follows them). Anything else
  // unclassified (like 3xx without Location, or 1xx) — be conservative.
  return 'retryable';
}

// ─── Headers banned from caller override ────────────────────────────────

const RESERVED_HEADERS = new Set([
  'content-type',
  'content-length',
  'host',
  'authorization', // caller provides via custom only; we don't compute it
  'user-agent',
]);

const USER_AGENT = 'ailin-broadcast/1.0';

// ─── Config validation ──────────────────────────────────────────────────

function parseConfig(raw: Record<string, unknown>): WebhookConfig | { error: string } {
  if (typeof raw.url !== 'string' || raw.url.length === 0) {
    return { error: 'missing or invalid "url"' };
  }
  if (typeof raw.secret !== 'string' || raw.secret.length === 0) {
    return { error: 'missing or invalid "secret"' };
  }
  const scheme = raw.signatureScheme ?? 'v1';
  if (scheme !== 'v1' && scheme !== 'v2') {
    return { error: `invalid signatureScheme: ${String(scheme)}` };
  }
  let customHeaders: Record<string, string> | undefined;
  if (raw.customHeaders && typeof raw.customHeaders === 'object' && !Array.isArray(raw.customHeaders)) {
    customHeaders = {};
    for (const [k, v] of Object.entries(raw.customHeaders)) {
      const kl = k.toLowerCase();
      if (RESERVED_HEADERS.has(kl)) continue;
      if (typeof v !== 'string') continue;
      customHeaders[k] = v;
    }
  }
  return {
    url: raw.url,
    secret: raw.secret,
    signatureHeader:
      typeof raw.signatureHeader === 'string' ? raw.signatureHeader : undefined,
    timestampHeader:
      typeof raw.timestampHeader === 'string' ? raw.timestampHeader : undefined,
    signatureScheme: scheme as 'v1' | 'v2',
    ...(customHeaders ? { customHeaders } : {}),
  };
}

// ─── Signature construction ─────────────────────────────────────────────

export interface SignHeaders {
  [header: string]: string;
}

export function signRequest(
  body: string,
  cfg: Required<Pick<WebhookConfig, 'secret' | 'signatureScheme'>> &
    Pick<WebhookConfig, 'signatureHeader' | 'timestampHeader'>,
  now: number = Date.now(),
): SignHeaders {
  const timestampSeconds = Math.floor(now / 1000).toString();
  const scheme = cfg.signatureScheme;
  const sigHeader = cfg.signatureHeader ?? 'X-Webhook-Signature';
  const tsHeader = cfg.timestampHeader ?? 'X-Webhook-Timestamp';

  if (scheme === 'v1') {
    const mac = createHmac('sha256', cfg.secret).update(timestampSeconds + '.' + body).digest('hex');
    return {
      [sigHeader]: `t=${timestampSeconds},v1=${mac}`,
      // Also emit a plain timestamp header for convenience; receivers can
      // choose which they prefer.
      [tsHeader]: timestampSeconds,
    };
  }
  // v2
  const mac = createHmac('sha256', cfg.secret).update(body).digest('hex');
  return {
    [sigHeader]: `sha256=${mac}`,
    [tsHeader]: timestampSeconds,
  };
}

/**
 * Receiver-side verification helper — exported for consumers that want to
 * reuse the same logic in their own handlers. Uses timingSafeEqual.
 */
export function verifyV1Signature(
  body: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
  now: number = Date.now(),
): boolean {
  // Parse "t=<ts>,v1=<hex>"
  const parts = header.split(',').map((p) => p.trim());
  const kv: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) kv[p.slice(0, eq)] = p.slice(eq + 1);
  }
  const ts = Number(kv.t);
  const sig = kv.v1;
  if (!sig || !Number.isFinite(ts)) return false;
  const ageSeconds = Math.abs(Math.floor(now / 1000) - ts);
  if (ageSeconds > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(ts.toString() + '.' + body).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

// ─── Adapter ────────────────────────────────────────────────────────────

export class WebhookDestinationAdapter implements DestinationAdapter {
  readonly type = 'webhook' as const;

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

    // Serialize envelope. JSON.stringify never throws for our envelope shape
    // (no BigInts, no cycles — the schema guarantees it).
    const body = JSON.stringify({
      deliveryAttemptId: ctx.deliveryAttemptId,
      envelope: ctx.envelope,
    });

    const signHeaders = signRequest(body, {
      secret: cfg.secret,
      signatureScheme: cfg.signatureScheme ?? 'v1',
      signatureHeader: cfg.signatureHeader,
      timestampHeader: cfg.timestampHeader,
    });

    const headers: Record<string, string> = {
      ...cfg.customHeaders,
      ...signHeaders,
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'x-broadcast-delivery-id': ctx.deliveryAttemptId,
      'x-broadcast-destination-id': ctx.destinationId,
    };

    try {
      const res = await safeFetch(cfg.url, {
        method: 'POST',
        headers,
        body,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      });
      const latencyMs = Date.now() - start;
      const kind = classifyStatus(res.status);
      if (kind === 'success') {
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
        // SSRF hits are ALWAYS permanent — the URL won't magically become
        // safe on retry. `host_resolution_failed` is the gray area; we treat
        // it as retryable because transient DNS failures are a thing.
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
      const err = e as Error & { cause?: { code?: string } };
      if (err.name === 'AbortError') {
        return {
          kind: 'retryable',
          errorClass: 'timeout',
          errorMessage: 'request aborted by timeout or caller',
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

function errorClassForStatus(status: number): string {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 422 || status === 400) return 'bad_request';
  if (status === 429) return 'rate_limited';
  if (status === 408) return 'request_timeout';
  if (status === 413) return 'payload_too_large';
  if (status >= 500) return 'server_error';
  // Exotic/unexpected statuses get a bounded fallback so Prometheus
  // `error_class` label cardinality doesn't explode on unusual responses.
  // Raw status still makes it into DLQ via statusCode on the outcome.
  return 'http_other';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
