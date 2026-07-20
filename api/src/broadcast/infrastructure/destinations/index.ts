// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Destination adapters barrel.
 *
 * Each adapter is a stateless class implementing `DestinationAdapter`.
 * The registry binds `DestinationType` → adapter instance and is consumed
 * by `BroadcastDeliveryExecutor`.
 */

export {
  type DestinationAdapter,
  type DestinationAdapterRegistry,
  type DeliveryContext,
  type DeliveryOutcome,
  type DeliveryOutcomeKind,
  type DestinationType,
  DESTINATION_TYPES,
} from './destination-adapter';

export { WebhookDestinationAdapter } from './webhook-adapter';
export { LangfuseDestinationAdapter } from './langfuse-adapter';
export { OtlpCollectorDestinationAdapter } from './otlp-adapter';
export { DatadogDestinationAdapter } from './datadog-adapter';

export {
  safeFetch,
  isForbiddenIp,
  EgressBlockedError,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_REDIRECTS,
} from './safe-http';

import { WebhookDestinationAdapter } from './webhook-adapter';
import { LangfuseDestinationAdapter } from './langfuse-adapter';
import { OtlpCollectorDestinationAdapter } from './otlp-adapter';
import { DatadogDestinationAdapter } from './datadog-adapter';
import type { DestinationAdapterRegistry } from './destination-adapter';

/**
 * Build the default adapter registry with a single instance of each adapter.
 * Adapters are stateless — reusing instances is safe and saves allocation
 * on the hot path.
 */
export function buildDefaultAdapterRegistry(): DestinationAdapterRegistry {
  return Object.freeze({
    webhook: new WebhookDestinationAdapter(),
    langfuse: new LangfuseDestinationAdapter(),
    datadog: new DatadogDestinationAdapter(),
    otlp_collector: new OtlpCollectorDestinationAdapter(),
  });
}
