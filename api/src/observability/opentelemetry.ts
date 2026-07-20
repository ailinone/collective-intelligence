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
import { ATTR_SERVICE_NAME, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions';
import { config, isDevelopment } from '@/config';
import { logger } from '@/utils/logger';

let sdk: NodeSDK | null = null;

function createTraceExporter(): OTLPTraceExporter | JaegerExporter {
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

  return new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
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
        '@opentelemetry/instrumentation-http': { enabled: true },
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
