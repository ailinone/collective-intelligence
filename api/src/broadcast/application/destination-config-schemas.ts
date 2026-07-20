// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Destination-type-specific config validation.
 *
 * Each destination adapter parses its config at send-time, but we also
 * validate on INSERT/UPDATE so a typo doesn't live in the DB and fill the
 * DLQ three days later. These schemas are strict supersets of what the
 * adapter's own parseConfig expects — they reject extra fields so secrets
 * can't be smuggled via typos like `apiKEy`.
 */

import { z } from 'zod';

import type { DestinationType } from '@/broadcast/infrastructure/destinations/destination-adapter';

// ─── Shared URL validation ──────────────────────────────────────────────

/**
 * https-first URL validator. Also rejects:
 *   - URLs with userinfo (http://user:pass@host) — credentials in URLs are
 *     a classic exfiltration smell and never needed for legitimate destinations.
 *   - Obvious SSRF targets at schema time (localhost / 127.* / ::1). The
 *     runtime SSRF guard catches more (private IPs, link-local, etc.) but
 *     this gives operators fast feedback on destination create/update.
 *   - Non-http(s) schemes — javascript:, data:, file:, gopher:, etc.
 *
 * HTTP (not HTTPS) is allowed only when BROADCAST_ALLOW_HTTP === 'true'
 * (dev/staging only); production deployments keep the default https-only.
 */
function validatedHttpUrl(opts: { label: string }) {
  return z
    .string()
    .url({ message: `${opts.label} must be a valid URL` })
    .superRefine((raw, ctx) => {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.label} is not a parseable URL`,
        });
        return;
      }
      const allowHttp = process.env.BROADCAST_ALLOW_HTTP === 'true';
      const scheme = u.protocol.replace(/:$/, '');
      if (scheme !== 'https' && !(allowHttp && scheme === 'http')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.label} must use https:// (http:// only when BROADCAST_ALLOW_HTTP=true)`,
        });
      }
      if (u.username.length > 0 || u.password.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.label} must not embed credentials (user:pass@host)`,
        });
      }
      // URL parses "[::1]" into hostname "::1" on some runtimes and "[::1]"
      // on others — strip brackets so the check matches either shape.
      const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '0.0.0.0'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.label} host ${host} is not a permitted destination target`,
        });
      }
    });
}

// ─── Per-type schemas ───────────────────────────────────────────────────

const WebhookConfigSchema = z
  .object({
    url: validatedHttpUrl({ label: 'url' }),
    secret: z.string().min(16, 'secret must be at least 16 chars'),
    signatureScheme: z.enum(['v1', 'v2']).default('v1'),
    signatureHeader: z.string().min(1).max(64).default('x-ailin-signature'),
    timestampHeader: z.string().min(1).max(64).default('x-ailin-timestamp'),
    signatureToleranceSeconds: z.number().int().positive().max(900).default(300),
    customHeaders: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const LangfuseConfigSchema = z
  .object({
    baseUrl: validatedHttpUrl({ label: 'baseUrl' }),
    publicKey: z.string().min(1),
    secretKey: z.string().min(1),
  })
  .strict();

const OtlpConfigSchema = z
  .object({
    endpoint: validatedHttpUrl({ label: 'endpoint' }),
    tracesPath: z.string().startsWith('/').optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const ALLOWED_DATADOG_SITES = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ddog-gov.com',
  'ap1.datadoghq.com',
] as const;

const DatadogConfigSchema = z
  .object({
    apiKey: z.string().min(20, 'Datadog API keys are at least 32 chars'),
    site: z.enum(ALLOWED_DATADOG_SITES).default('datadoghq.com'),
    service: z.string().min(1).max(128).default('ailin-ci-api'),
    env: z.string().min(1).max(64).optional(),
    tags: z.array(z.string().regex(/^[a-z0-9_][a-z0-9_\-:./]*$/i)).optional(),
    hostname: z.string().min(1).max(253).optional(),
    urlOverride: validatedHttpUrl({ label: 'urlOverride' }).optional(),
  })
  .strict();

// ─── Registry ───────────────────────────────────────────────────────────

const SCHEMAS = {
  webhook: WebhookConfigSchema,
  langfuse: LangfuseConfigSchema,
  otlp_collector: OtlpConfigSchema,
  datadog: DatadogConfigSchema,
} as const;

// Keep the union typed rather than `unknown` so callers get inference.
export type DestinationConfigInput =
  | { type: 'webhook'; config: z.infer<typeof WebhookConfigSchema> }
  | { type: 'langfuse'; config: z.infer<typeof LangfuseConfigSchema> }
  | { type: 'otlp_collector'; config: z.infer<typeof OtlpConfigSchema> }
  | { type: 'datadog'; config: z.infer<typeof DatadogConfigSchema> };

export type DestinationConfigValidation =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; error: string };

export function validateDestinationConfig(
  destinationType: DestinationType,
  raw: unknown,
): DestinationConfigValidation {
  const schema = SCHEMAS[destinationType];
  if (!schema) {
    return { ok: false, error: `unknown destinationType: ${destinationType}` };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: flattenZodError(result.error) };
  }
  return { ok: true, config: result.data as Record<string, unknown> };
}

function flattenZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
