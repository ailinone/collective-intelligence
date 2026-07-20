// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SemanticRoutingEngine — shared types (MVP 1)
 *
 * MVP 1 invariant: this file is PURE TypeScript types.
 * It does NOT import anything that has runtime side effects:
 *   - no Prisma client
 *   - no Redis client
 *   - no TEI client
 *   - no provider adapters
 *   - no orchestration engine
 *   - no ProviderOperabilityHub singleton
 *   - no DB query helpers
 *
 * Importing this module from anywhere in the codebase must remain
 * side-effect free. The `module-load-safety.test.ts` enforces this.
 */

// ─── Routing modes (rollout gates) ──────────────────────────────────────

/**
 * Routing decision modes. Default is `legacy`; the engine remains
 * dormant until a future MVP wires `RuntimeRoutingConfigProvider`.
 */
export type RoutingMode =
  | 'legacy'
  | 'registry_cache'
  | 'shadow_trace_only'
  | 'shadow_registry_only'
  | 'shadow_structural_full'
  | 'shadow_semantic_full'
  | 'semantic_primary';

export type RoutingFlag =
  | 'freshness_in_hot_path'
  | 'bandit_primary'
  | 'speculative_dispatch'
  | 'trace_enabled'
  | 'admin_routes_enabled';

// ─── Route classification ───────────────────────────────────────────────

/**
 * Classification of how a route reaches its serving provider.
 *
 *   native       — provider serves its own models on its own API
 *   aggregator   — provider re-serves third-party models under its own naming
 *   gateway      — managed proxy/cache layer over multiple upstreams
 *   edge         — edge-deployed inference (Cloudflare Workers AI, etc.)
 *   local        — locally-hosted runtime (Ollama, vLLM, LM Studio) opt-in
 *   self_hosted  — operator-owned non-OpenAI-compat self-hosted runtime
 */
export type RouteKind =
  | 'native'
  | 'aggregator'
  | 'gateway'
  | 'edge'
  | 'local'
  | 'self_hosted';

// ─── Operability state (mirrors ProviderOperabilityHub) ─────────────────

/**
 * Operability state. Mirrors `provider-operability-hub.OperabilityState`
 * BUT is declared independently to keep the MVP 1 module side-effect free.
 * A future MVP can introduce a thin re-export / equality test.
 */
export type OperabilityState =
  | 'healthy'
  | 'degraded'
  | 'recovering'
  | 'no_credits'
  | 'rate_limited'
  | 'auth_failed'
  | 'temporarily_unavailable'
  | 'unknown';

export type CreditStatus = 'has_credits' | 'no_credits' | 'unknown';

export type MinimalChatStatus = 'verified' | 'untested' | 'failed';

// ─── Currency (forward-compat) ──────────────────────────────────────────

/**
 * Currency for pricing. Locked to USD in MVP 1 (matches current schema
 * which has no currency column). A future MVP migration can broaden this
 * union when the column is added.
 */
export type Currency = 'USD';

// ─── Lifecycle (canonical + offering) ───────────────────────────────────

/**
 * Lifecycle of a CanonicalModel — vendor-neutral generation stage.
 */
export type CanonicalLifecycle =
  | 'preview'
  | 'current'
  | 'deprecated'
  | 'retired';

/**
 * Lifecycle of a ModelProviderOffering — per-provider serving stage.
 * Different from CanonicalLifecycle because a provider may sunset an
 * offering of a model that itself is still 'current' in the canonical sense.
 */
export type OfferingLifecycle = 'active' | 'sunset' | 'retired';

// ─── Freshness × readiness composite ────────────────────────────────────

/**
 * Composite signal joining a CanonicalModel's freshness with the
 * readiness of its concrete route. A scorer that selects a stale model
 * when a fresher one exists MUST cite one of the not-routable statuses
 * as `mandatoryReason` — see `freshness-readiness-coupling.test.ts`
 * (MVP 4) for enforcement.
 */
export type FreshnessCandidateStatus =
  | 'current_and_routable'
  | 'current_but_no_credit'
  | 'current_but_auth_failed'
  | 'current_but_rate_limited'
  | 'current_but_minimal_chat_failed'
  | 'current_but_capability_mismatch'
  | 'stale_but_best_routable'
  | 'deprecated_blocked'
  | 'preview_uncertain';

// ─── CanonicalResolution (hardening per v1.1) ───────────────────────────

/**
 * Source of a canonical-model resolution. Higher entries take priority
 * over lower entries when both match.
 */
export type CanonicalResolutionSource =
  | 'declared_alias'
  | 'provider_metadata'
  | 'exact_normalized_name'
  | 'heuristic_family_version'
  | 'model_equivalence_service'
  | 'manual_override'
  | 'fallback_provider_model_id';

export interface CanonicalResolution {
  readonly canonicalModelId: string;
  /** Confidence in [0..1]. >= 0.7 may auto-merge into existing canonical. */
  readonly confidence: number;
  readonly source: CanonicalResolutionSource;
  /** Short human-readable rationale. */
  readonly reason: string;
  /** Set when this resolution joins/creates a conflict group. */
  readonly conflictGroupId?: string;
  /** Alternative resolutions considered but not selected. */
  readonly alternatives?: ReadonlyArray<{
    readonly canonicalModelId: string;
    readonly confidence: number;
    readonly source: CanonicalResolutionSource;
  }>;
}

// ─── TaskProfile (consumed by ModelScorer / StrategyPlanner in later MVPs) ─

export type TaskType =
  | 'general'
  | 'code'
  | 'chat'
  | 'translation'
  | 'summarization'
  | 'analysis'
  | 'creative'
  | 'reasoning'
  | 'extraction'
  | 'classification';

export type Complexity = 'low' | 'medium' | 'high';
export type RiskLevel = 'low' | 'medium' | 'high';
export type CostSensitivity = 'low' | 'medium' | 'high';

/**
 * Privacy mode requested by the caller.
 *   standard         — no constraint
 *   local_preferred  — local routes get a scoring boost
 *   local_required   — only local/self_hosted routes are considered
 */
export type PrivacyMode = 'standard' | 'local_preferred' | 'local_required';

export type FreshnessRequirement = 'any' | 'recent' | 'frontier';
export type ToolUseRequirement = 'none' | 'optional' | 'required';
export type OutputFormat = 'text' | 'json' | 'markdown' | 'code' | 'structured';
export type Modality = 'text' | 'image' | 'audio' | 'video';
export type StrategyHint = string;

export interface TaskProfile {
  readonly taskType: TaskType;
  readonly complexity: Complexity;
  readonly requiredCapabilities: ReadonlySet<string>;
  readonly desiredCapabilities: ReadonlySet<string>;
  readonly modalities: ReadonlySet<Modality>;
  readonly contextRequirementTokens: number;
  readonly riskLevel: RiskLevel;
  readonly latencyBudgetMs: number;
  readonly costSensitivity: CostSensitivity;
  readonly privacyMode: PrivacyMode;
  /** [0..1] — how confident the caller needs to be in the result. */
  readonly confidenceNeeded: number;
  readonly strategyHints: ReadonlyArray<StrategyHint>;
  readonly outputFormatRequirements: ReadonlyArray<OutputFormat>;
  readonly toolUseRequirement: ToolUseRequirement;
  readonly freshnessRequirement: FreshnessRequirement;
}

// ─── RoutingPolicy (loaded by RuntimeRoutingConfigProvider in MVP 3+) ───

/**
 * Per-criterion scoring weights consumed by `ModelScorer` (MVP 4).
 * All defaults shipped via `config/routing-policy.json` (later MVP).
 *
 * Weights are not assumed to sum to 1.0; the scorer normalises the final
 * result into [0..1] inside the context of a single query.
 */
export interface ScorerWeights {
  readonly semantic: number;
  readonly capability: number;
  readonly quality: number;
  readonly freshness: number;
  readonly health: number;
  readonly latency: number;
  readonly ttft: number;
  readonly cost: number;
  readonly context: number;
  readonly routeKind: number;
  readonly local: number;
  readonly feedback: number;
  readonly risk: number;
}

export type SelfHostedPolicy =
  | 'never'
  | 'last_resort'
  | 'prefer_for_privacy'
  | 'always_consider';

export interface RoutingPolicy {
  readonly scorerWeights: ScorerWeights;
  readonly selfHostedPolicy: SelfHostedPolicy;
  /** Score margin above top-2 needed to pick `single_best` strategy. */
  readonly singleConfidenceMargin: number;
  /** Below this divergence ratio, shadow mode is considered green. */
  readonly shadowDivergenceLogThreshold: number;
  /** Cap on dry-run/explain admin endpoint invocations. */
  readonly dryRunRateLimitPerMin: number;
  /** Maximum estimated cost per execution in USD. 0 = no cap. */
  readonly maxCostUsd: number;
  /** Configurable per-route-kind multiplier for the routeKind score. */
  readonly routeKindWeights: Readonly<Record<RouteKind, number>>;
}

// ─── Pin handling (Explicit Model Pin Invariant per v1.1) ───────────────

/**
 * Information about an explicit pin in the inbound request. When present,
 * the SemanticRoutingEngine MUST NOT substitute the selection without
 * `ExplicitPinInfo.allowSubstitution === true`.
 */
export interface ExplicitPinInfo {
  /** Where the pin came from. */
  readonly source: 'request_model_field' | 'request_modelPin' | 'experiment_pin' | 'internal_pin';
  /** The pinned canonical model — when known. */
  readonly canonicalModelId?: string;
  /** The pinned offering — when known. */
  readonly offeringId?: string;
  /** The pinned concrete route — when known. */
  readonly routeId?: string;
  /** Whether substitution is permitted under fallback policy. Default `false`. */
  readonly allowSubstitution: boolean;
  /** Free-form policy reference for audit. */
  readonly authorizingPolicy?: string;
}

/**
 * Reason codes for a pin substitution. `policyAuthorized` MUST be true
 * for any substitution to take effect.
 */
export type PinSubstitutionReason =
  | 'original_route_blocked_no_credit'
  | 'original_route_blocked_auth_failed'
  | 'original_route_blocked_rate_limited'
  | 'original_route_minimal_chat_failed'
  | 'original_capability_mismatch'
  | 'original_offering_lifecycle_retired';

export interface PinSubstitution {
  readonly originalCanonicalModelId: string;
  readonly originalRouteId: string;
  readonly substitutedCanonicalModelId: string;
  readonly substitutedRouteId: string;
  readonly reason: PinSubstitutionReason;
  /** Must be true. Substitution without policy authorization is invalid. */
  readonly policyAuthorized: true;
  readonly authorizingPolicy: string;
}
