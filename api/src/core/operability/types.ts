// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Operability Plane — shared types
 *
 * Phase 1 (2026-05-08): types for control-plane discovery, error classification,
 * health registry, and near-zero skip. These coexist with the legacy
 * `provider-operability-hub.ts` (route-based, runtime-event-driven) and provide
 * a finer granularity that the legacy hub lacks: per-(providerId, modelId,
 * accountId, endpointId) records instead of per-(executionProvider, modelFamily).
 *
 * The legacy hub is NOT removed — it continues to track route-level runtime
 * events. This module adds:
 *   - explicit health-state taxonomy mappable to skip-or-attempt decisions
 *   - per-tuple TTLs (so a fatal state on (aihubmix, gpt-4o-mini) does not
 *     poison (aihubmix, claude-haiku-4-5))
 *   - reason codes propagated end-to-end via CandidateTrace
 *
 * Phase 1 deliberately does NOT include: HNSW, TEI wiring, observer pool,
 * speculative dispatch, edge migration. Those land in later phases.
 */

// ─── Provider error taxonomy ──────────────────────────────────────────────

export type ProviderErrorClass =
  | 'insufficient_credit'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'auth_failed'
  | 'endpoint_not_found'
  | 'model_not_found'
  | 'provider_timeout'
  | 'provider_5xx'
  | 'adapter_error'
  | 'invalid_request'
  | 'context_exceeded'
  | 'unsupported_capability'
  | 'malformed_response'
  | 'streaming_broken'
  | 'unknown_error';

/**
 * Health state of a provider/model tuple. Distinct from the legacy
 * `OperabilityState` enum in `provider-operability-hub.ts`:
 *   - This taxonomy classifies CAUSE (auth_failed, insufficient_credit)
 *   - The legacy taxonomy classifies AGGREGATE (healthy, degraded, recovering)
 *
 * `mapToLegacyOperabilityState()` projects between them when wiring into
 * the existing CreditGovernor / hub.
 */
export type ProviderHealthState =
  | 'unknown'
  | 'probing'
  | 'healthy'
  | 'degraded'
  | 'rate_limited'
  | 'insufficient_credit'
  | 'auth_failed'
  | 'endpoint_not_found'
  | 'model_not_found'
  | 'timeout_suspected'
  | 'temporarily_disabled'
  | 'permanently_disabled';

/**
 * Scope of a failure.
 *
 * Critical anti-pattern this prevents: a `model_not_found` error on
 * (aihubmix, gpt-4o-mini) being treated as `scope: 'provider'` and removing
 * `aihubmix` entirely from the candidate pool. Correct scope is
 * `'provider_model'` — only that tuple is removed; (aihubmix, claude-haiku-4-5)
 * remains healthy.
 */
export type ProviderErrorScope =
  | 'provider'
  | 'provider_model'
  | 'request'
  | 'account'
  | 'endpoint';

export type ProviderErrorRetryability =
  | 'non_retryable'
  | 'retryable_after_cooldown'
  | 'retryable_immediately'
  | 'never_retry_same_request';

export interface ProviderErrorClassification {
  errorClass: ProviderErrorClass;
  scope: ProviderErrorScope;
  retryability: ProviderErrorRetryability;
  cooldownMs: number;
  healthState: ProviderHealthState;
  shouldRemoveFromCandidatePool: boolean;
  shouldSkipNearZero: boolean;
  /** Diagnostic message extracted from the underlying error (truncated). */
  message?: string;
  /** HTTP status if extractable. */
  httpStatus?: number;
  /** Retry-After header value in ms, if present. */
  retryAfterMs?: number;
}

// ─── Health record (per granularity tuple) ─────────────────────────────────

/**
 * Composite key for the health registry.
 *
 * `providerId` is required. `modelId`/`accountId`/`endpointId` are optional
 * dimensions — when present, they narrow the scope. A record with
 * `(providerId='aihubmix', modelId='gpt-4o-mini')` does NOT poison a record
 * with `(providerId='aihubmix', modelId='claude-haiku-4-5')`.
 */
export interface HealthKey {
  providerId: string;
  modelId?: string;
  accountId?: string;
  endpointId?: string;
}

export interface ProviderHealthRecord extends HealthKey {
  state: ProviderHealthState;
  reason?: string;
  errorClass?: ProviderErrorClass;

  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastProbeAt?: string;
  /**
   * Earliest time the next probe/attempt is allowed. Before this timestamp,
   * `shouldSkipNearZero` returns `skip: true` for fatal states.
   */
  nextProbeAfter?: string;

  ttlMs: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;

  p50LatencyMs?: number;
  p95LatencyMs?: number;
  p99LatencyMs?: number;

  successRateWindow?: number;
  failureRateWindow?: number;
}

// ─── Skip decision (hot path) ──────────────────────────────────────────────

export interface SkipDecision {
  skip: boolean;
  /** When `skip=true`, the health state OR a reason string. */
  reason?: ProviderHealthState | string;
  /** When `skip=true`, the timestamp of the cached failure. */
  cachedAt?: string;
  /** When `skip=true`, when reprobe becomes allowed. */
  nextProbeAfter?: string;
  /**
   * Latency class label for telemetry. `'near_zero'` indicates the skip
   * decision returned in <5ms via in-memory lookup.
   */
  latencyClass?: 'near_zero' | 'measured';
}

// ─── Candidate trace (end-to-end observability) ────────────────────────────

export type CandidateStage =
  | 'configured'
  | 'credential_validated'
  | 'credit_validated'
  | 'endpoint_validated'
  | 'models_listed'
  | 'alias_mapped'
  | 'capability_indexed'
  | 'operational_pool'
  | 'semantic_topk'
  | 'health_filtered'
  | 'policy_filtered'
  | 'capability_filtered'
  | 'ranked'
  | 'fallback_plan'
  | 'attempted'
  | 'skipped'
  | 'cancelled'
  | 'succeeded'
  | 'failed';

export interface CandidateTrace {
  /** ISO 8601, set automatically. */
  timestamp: string;
  requestId?: string;
  experimentId?: string;
  armId?: string;

  providerId: string;
  modelId?: string;
  modelFamily?: string;

  stage: CandidateStage;
  /** True if the candidate passed this stage; false if removed/skipped. */
  included: boolean;
  reason?: string;
  latencyMs?: number;
  healthState?: ProviderHealthState;
  policyKind?: string;
  score?: number;
}

// ─── Discovery types ───────────────────────────────────────────────────────

export type DiscoveryConfidence =
  | 'verified'
  | 'partially_verified'
  | 'inferred'
  | 'unknown';

export interface DiscoveredModel {
  modelId: string;
  family?: string;
  contextWindow?: number;
  capabilities?: readonly string[];
}

export interface ProviderDiscoveryResult {
  providerId: string;
  status: 'available' | 'unavailable';
  healthState: ProviderHealthState;
  reason?: string;
  errorClass?: ProviderErrorClass;
  discoveryConfidence: DiscoveryConfidence;
  /** Models enumerated for this provider. May be empty if listModels not supported. */
  models: readonly DiscoveredModel[];
  /** Whether this provider should be considered for execution. */
  includeInOperationalPool: boolean;
  discoveredAt: string;
  /** ISO timestamp until which this result is fresh. */
  validUntil: string;
  /** Latency of the discovery probe in ms. */
  probeLatencyMs: number;
}

export interface ProviderDiscoverySnapshot {
  generatedAt: string;
  durationMs: number;
  totalConfigured: number;
  totalAvailable: number;
  totalUnavailable: number;
  results: ReadonlyMap<string, ProviderDiscoveryResult>;
}

// ─── Probe strategy ────────────────────────────────────────────────────────

export type CredentialProbeKind =
  | 'env_only'
  | 'auth_endpoint'
  | 'models_api'
  | 'minimal_completion'
  | 'not_supported';

export type CreditProbeKind =
  | 'billing_api'
  | 'quota_header'
  | 'manual_config'
  | 'not_supported';

export type EndpointProbeKind =
  | 'models_api'
  | 'minimal_completion'
  | 'health_endpoint'
  | 'not_supported';

export type ModelProbeKind =
  | 'list_models'
  | 'known_catalog_alias'
  | 'minimal_completion'
  | 'not_supported';

export interface ProviderProbeStrategy {
  providerId: string;
  credentialProbe: CredentialProbeKind;
  creditProbe: CreditProbeKind;
  endpointProbe: EndpointProbeKind;
  modelProbe: ModelProbeKind;
  /** Override the default discovery timeout for this provider. */
  probeTimeoutMs?: number;
}

// ─── Cooldown defaults (ms) ────────────────────────────────────────────────

/**
 * Default cooldowns by error class. Overridden when the provider returns
 * an explicit Retry-After header (rate_limited, quota_exceeded).
 *
 * Rationale:
 *   - auth_failed: 6h (config change required, not transient)
 *   - insufficient_credit: 30min (operator may top up)
 *   - rate_limited: 60s (default if no Retry-After)
 *   - model_not_found: 24h (model is unlikely to appear without config change)
 *   - context_exceeded: 0 (request-scoped, not provider-scoped)
 *   - provider_timeout: 30s (transient infra issue)
 */
export const DEFAULT_COOLDOWNS: Readonly<Record<ProviderErrorClass, number>> = Object.freeze({
  auth_failed: 6 * 60 * 60 * 1000,
  insufficient_credit: 30 * 60 * 1000,
  quota_exceeded: 5 * 60 * 1000,
  rate_limited: 60 * 1000,
  endpoint_not_found: 60 * 60 * 1000,
  model_not_found: 24 * 60 * 60 * 1000,
  provider_timeout: 30 * 1000,
  provider_5xx: 60 * 1000,
  adapter_error: 30 * 1000,
  invalid_request: 0,
  context_exceeded: 0,
  unsupported_capability: 24 * 60 * 60 * 1000,
  malformed_response: 60 * 1000,
  streaming_broken: 60 * 1000,
  unknown_error: 30 * 1000,
});

/**
 * Maps `ProviderHealthState` (this module's cause-oriented taxonomy) to the
 * legacy `OperabilityState` (aggregate health used by CreditGovernor and
 * `provider-operability-hub.ts`).
 *
 * Used to keep the legacy hub in sync when this module records observations.
 */
export function mapHealthStateToLegacyOperability(
  state: ProviderHealthState,
): 'healthy' | 'degraded' | 'recovering' | 'no_credits' | 'rate_limited' | 'auth_failed' | 'temporarily_unavailable' | 'unknown' {
  switch (state) {
    case 'healthy':
      return 'healthy';
    case 'degraded':
    case 'timeout_suspected':
      return 'degraded';
    case 'rate_limited':
      return 'rate_limited';
    case 'insufficient_credit':
      return 'no_credits';
    case 'auth_failed':
      return 'auth_failed';
    case 'endpoint_not_found':
    case 'model_not_found':
    case 'temporarily_disabled':
    case 'permanently_disabled':
      return 'temporarily_unavailable';
    case 'probing':
    case 'unknown':
    default:
      return 'unknown';
  }
}

/**
 * Build a deterministic string key for the health registry from a HealthKey.
 * Used as the Map key in the in-memory registry and as the Redis key suffix.
 */
export function buildHealthKey(key: HealthKey): string {
  const parts = [key.providerId];
  if (key.modelId) parts.push(`m:${key.modelId}`);
  if (key.accountId) parts.push(`a:${key.accountId}`);
  if (key.endpointId) parts.push(`e:${key.endpointId}`);
  return parts.join('|');
}
