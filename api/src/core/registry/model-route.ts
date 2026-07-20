// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * ProviderModelRoute — rota concreta de execução de uma Offering.
 *
 * MVP 1 invariant: type + pure helper. No I/O. The factory that
 * derives Routes from `(Model row, ProviderRegistry adapter, hub state)`
 * is a later MVP.
 *
 * Pertinência:
 *   - endpoint, pricing, quota, health, latency, readiness, route_kind
 *     → ProviderModelRoute
 *   - aliases, provider naming → ModelProviderOffering
 *   - canonical identity, semantic, capabilities, freshness → CanonicalModel
 *
 * Distinguishing routes: two routes with the same `accessProviderId` +
 * `requestModelId` BUT different `credentialRef` OR `region` OR
 * `deploymentId` OR `accountId` are DISTINCT entities with independent
 * `routeId`, pricing, health and latency stats. Tested by
 * `route-distinctness-by-credential.test.ts` (in this MVP's roundtrip).
 */

import type {
  RouteKind,
  OperabilityState,
  CreditStatus,
  MinimalChatStatus,
  Currency,
} from './types';

export interface ProviderModelRoute {
  // ─── Identity ─────────────────────────────────────────────────────────
  readonly routeId: string;
  readonly canonicalModelId: string;
  readonly offeringId: string;

  /** Adapter that actually runs the call — `adapter.getName()`. */
  readonly accessProviderId: string;
  /** Upstream that serves the model — same as `Offering.servingProviderId`
   *  for native routes; differs for hubs/aggregators. */
  readonly servingProviderId: string;
  readonly routeKind: RouteKind;

  // ─── Connection ───────────────────────────────────────────────────────
  readonly endpointBaseUrl: string;
  readonly endpointPath: string;
  /** Provider's internal id (same as Offering.providerModelId for most). */
  readonly providerModelId: string;
  /** What goes in the request body's `model` field. May be aliased. */
  readonly requestModelId: string;

  // ─── Pricing (route-level) ────────────────────────────────────────────
  readonly inputCostPer1M: number;
  readonly outputCostPer1M: number;
  readonly cachedInputCostPer1M: number | null;
  readonly currency: Currency;
  readonly pricingSource: 'provider-api' | 'static-file' | 'manual' | 'inferred';
  readonly lastPricingUpdateAt: string;

  // ─── Capability surface (route-level — may differ from Offering) ──────
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly supportsStreaming: boolean;
  readonly supportsJson: boolean;
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
  readonly supportsImages: boolean;
  readonly supportsAudio: boolean;

  // ─── Runtime state (route-level) ──────────────────────────────────────
  readonly healthState: OperabilityState;
  readonly creditStatus: CreditStatus;
  readonly minimalChatStatus: MinimalChatStatus;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly ttftP50Ms: number | null;
  readonly ttftP95Ms: number | null;
  /** Rolling success ratio in the recent window. [0..1]. */
  readonly successRateWindow: number;
  /** Rolling error ratio in the recent window. [0..1]. */
  readonly errorRateWindow: number;
  readonly lastProbeAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly failureCooldownUntil: string | null;
  readonly blockedReason: string | null;

  // ─── v1.1 — multi-tenancy / region / credential ───────────────────────
  /** Logical billing/access account (e.g. `prod`, `dev`, `team-alpha`). */
  readonly accountId?: string;
  /** Opaque reference to a credential in vault — NOT the credential itself. */
  readonly credentialRef?: string;
  /** Region tag — e.g. `us-east-1`, `europe-west4`. */
  readonly region?: string;
  /** Provider-specific deployment id — Azure deployment, Databricks endpoint slug. */
  readonly deploymentId?: string;
  /** Some providers have per-account rate-limit buckets. */
  readonly rateLimitBucketId?: string;
  /** Distinct from `accountId` when billing entity differs from access account. */
  readonly billingAccountId?: string;
  /** Gateway identifier — `cloudflare-prod`, `vercel-ai-gateway-staging`. */
  readonly gatewayId?: string;
  /** Multi-tenant provider tenant — e.g. Snowflake Cortex tenant. */
  readonly tenantId?: string;
  /** Vertex AI project, OCI compartment, etc. */
  readonly projectId?: string;
}

// ─── Pure id helper ─────────────────────────────────────────────────────

export interface BuildRouteIdInput {
  readonly offeringId: string;
  readonly accessProviderId: string;
  readonly credentialRef?: string;
  readonly region?: string;
  readonly deploymentId?: string;
  readonly accountId?: string;
}

/**
 * Builds a deterministic `routeId` from the tuple of identity-bearing
 * fields. Two routes with the same `(offeringId, accessProviderId)` but
 * different credentials/region/deployment/account get distinct ids and
 * are therefore distinct entities for health, pricing and latency
 * tracking.
 *
 * Pure function. No I/O. No randomness.
 */
export function buildRouteId(input: BuildRouteIdInput): string {
  const parts: string[] = [input.offeringId, input.accessProviderId];
  if (input.credentialRef) parts.push(`cred:${input.credentialRef}`);
  if (input.region) parts.push(`region:${input.region}`);
  if (input.deploymentId) parts.push(`depl:${input.deploymentId}`);
  if (input.accountId) parts.push(`acct:${input.accountId}`);
  return parts.join('::');
}
