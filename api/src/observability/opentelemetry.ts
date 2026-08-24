// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';
import { config, isDevelopment } from '@/config';
import { logger } from '@/utils/logger';

let sdk: NodeSDK | null = null;

function createTraceExporter(): OTLPTraceExporter | JaegerExporter {
  // NOTE (2026-07-29): the JaegerExporter branch below is kept for operator
  // flexibility (OTEL_TRACES_EXPORTER=jaeger / OTEL_EXPORTER_JAEGER_ENDPOINT),
  // but production does NOT use it. The installed
  // @opentelemetry/exporter-jaeger@2.10.0 package is itself upstream-deprecated
  // ("Jaeger supports the OpenTelemetry protocol natively" — see its
  // build/src/jaeger.js). Our self-hosted Jaeger (ci-jaeger, added in
  // docker/docker-compose.production.yml) ingests OTLP/HTTP directly on 4318, so
  // production instead leaves OTEL_TRACES_EXPORTER/jaegerEndpoint unset and
  // points OTEL_EXPORTER_OTLP_ENDPOINT at ci-jaeger's OTLP receiver, falling
  // through to the OTLPTraceExporter branch below.
  const explicitExporter = process.env.OTEL_TRACES_EXPORTER?.toLowerCase();

  if (explicitExporter === 'jaeger' || config.observability.jaegerEndpoint) {
    return new JaegerExporter({
      endpoint:
        config.observability.jaegerEndpoint ||
        process.env.OTEL_EXPORTER_JAEGER_ENDPOINT ||
        'http://localhost:14268/api/traces',
    });
  }

  const headers: Record<string, string> = {};
  if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
    for (const header of process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',')) {
      const [key, value] = header.split('=');
      if (key && value) {
        headers[key.trim()] = value.trim();
      }
    }
  }

  // P0.23 (2026-08-17): URL resolution is left to the SDK env contract.
  // OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (signal-specific) is used verbatim;
  // the generic OTEL_EXPORTER_OTLP_ENDPOINT is a BASE the SDK appends
  // /v1/traces to. Passing the env value as an explicit `url` here caused
  // path-doubling 404s in production whenever exporter construction reached
  // the env-only path (reproduced with otlp-exporter-base@0.221).
  return new OTLPTraceExporter({
    headers,
  });
}

export async function initializeOpenTelemetry(): Promise<void> {
  if (!config.observability.otelEnabled) {
    return;
  }

  if (sdk) {
    return;
  }

  diag.setLogger(new DiagConsoleLogger(), isDevelopment ? DiagLogLevel.DEBUG : DiagLogLevel.ERROR);

  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.observability.serviceName,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.env,
    })
  );

  sdk = new NodeSDK({
    traceExporter: createTraceExporter(),
    resource,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          enabled: true,
          // SECURITY (2026-07-29): verified against the installed
          // @opentelemetry/instrumentation-http@0.220.0 source — request/response
          // headers are NEVER added as span attributes unless `headersToSpanAttributes`
          // is explicitly set (it defaults to an empty allowlist per direction). We
          // deliberately leave it unset, so Authorization / X-API-Key / Cookie / any
          // other credential-bearing header on every incoming or outgoing HTTP
          // request never becomes a span attribute. Do NOT set
          // `headersToSpanAttributes` without re-reviewing this comment and using an
          // explicit allowlist of known-safe header names — never a "capture
          // everything" config. Request/response BODY content is never captured by
          // this instrumentation regardless of config (also verified against the
          // installed source) — LLM prompts/completions are not at risk here.
          //
          // Outbound request URLs ARE captured as the http.url / url.full span
          // attribute. A few provider adapters embed live credentials directly in
          // the URL query string for websocket handshakes instead of using headers
          // (see providers/cartesia/cartesia-adapter.ts `?api_key=...` and
          // providers/openai/realtime-client.ts `?client_secret=...`). The
          // instrumentation's built-in redaction list (sig, Signature,
          // AWSAccessKeyId, X-Goog-Signature — cloud-storage presigned-URL params)
          // doesn't cover those, so we extend it below. NOTE: `redactedQueryParams`
          // REPLACES the built-in list rather than merging with it, so the built-in
          // entries are repeated here.
          redactedQueryParams: [
            'sig',
            'Signature',
            'AWSAccessKeyId',
            'X-Goog-Signature',
            'api_key',
            'apikey',
            'access_token',
            'client_secret',
            'token',
            'password',
            'secret',
          ],
        },
        '@opentelemetry/instrumentation-pino': { enabled: true },
      }),
    ],
  });

  try {
    await sdk.start();
    logger.info('✅ OpenTelemetry instrumentation started');
  } catch (error) {
    logger.error({ error }, 'Failed to start OpenTelemetry SDK');
    sdk = null;
  }
}

export async function shutdownOpenTelemetry(): Promise<void> {
  if (!sdk) {
    return;
  }

  try {
    await sdk.shutdown();
    logger.info('✅ OpenTelemetry instrumentation shutdown complete');
  } catch (error) {
    logger.error({ error }, 'Error shutting down OpenTelemetry SDK');
  } finally {
    sdk = null;
  }
}
