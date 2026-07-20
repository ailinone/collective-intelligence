// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Core Types
 *
 * This module defines the data contracts for sensitivity-based coordination
 * between multiple AI models. It captures not just final decisions, but also
 * the conditions under which each agent would change their decision.
 *
 * Design principles:
 * - Agents think. Protocols coordinate.
 * - Decisions + sensitivities, not just outputs.
 * - State is mutable across rounds but ephemeral per run.
 * - Every signal is typed, validated, and traceable.
 *
 * Part of the Ailin¹ Collective Coordination Layer.
 * integrated with the CI stack — sensitivity-based coordination as a
 * native primitive of the Collective Intelligence platform.
 */

// ============================================
// Enums
// ============================================

export const SENSITIVITY_DIRECTIONS = [
  'increase',
  'decrease',
  'hold',
  'block',
  'unlock',
] as const;
export type SensitivityDirection = (typeof SENSITIVITY_DIRECTIONS)[number];

export const RISK_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export const COORDINATION_STOP_REASONS = [
  'converged',
  'max_rounds',
  'max_cost',
  'max_latency',
  'critical_risk',
  'stagnation',
  'persistent_divergence',
  'insufficient_valid_signals',
  'fallback_triggered',
] as const;
export type CoordinationStopReason = (typeof COORDINATION_STOP_REASONS)[number];

export const AGGREGATION_METHODS = [
  'weighted_confidence',
  'median',
  'trimmed_mean',
  'llm_synthesis',
  'hybrid',
] as const;
export type AggregationMethod = (typeof AGGREGATION_METHODS)[number];

// ============================================
// Sensitivity — conditional flexibility of a single agent
// ============================================

export interface Sensitivity {
  /** Variable name this sensitivity refers to (e.g. "test_coverage", "auth_risk") */
  variable: string;
  /** How this variable would change the agent's position */
  direction: SensitivityDirection;
  /** Human-readable condition that would trigger this change */
  trigger: string;
  /** Expected magnitude of change (optional, for numeric variables) */
  expectedDelta?: number;
  /** Agent's confidence in this sensitivity (0..1) */
  confidence: number;
  /** Why this sensitivity exists */
  rationale: string;
  /** Risk level if this condition is not addressed */
  risk?: RiskSeverity;
}

// ============================================
// Decision — an agent's current position
// ============================================

export interface AgentDecision {
  /** Category of the decision (e.g. "approve", "request_changes", "reject") */
  type: string;
  /** The actual decision payload */
  value: unknown;
  /** Confidence in this decision (0..1) */
  confidence: number;
  /** Brief rationale for the decision */
  rationale?: string;
}

// ============================================
// CoordinationSignal — a single agent's complete output for one round
// ============================================

export interface CoordinationSignal {
  /** Unique signal identifier */
  id: string;
  /** The coordination run this signal belongs to */
  runId: string;
  /** Round number (1-based) */
  round: number;

  /** Which agent/model produced this */
  agentId: string;
  modelId: string;
  providerId: string;
  role?: string;

  /** The agent's decision */
  decision: AgentDecision;
  /** The agent's sensitivities — conditions for changing the decision */
  sensitivities: Sensitivity[];

  /** Execution metrics for this signal */
  metrics?: {
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  };

  /** ISO timestamp */
  createdAt: string;
}

// ============================================
// VariableState — a tracked coordination variable
// ============================================

export interface VariableState {
  /** Current value of the variable */
  value: number | string | boolean | object;
  /** Aggregated confidence in this value (0..1) */
  confidence: number;
  /** Which agents contributed to this value */
  updatedBy: string[];
  /** Why this value is what it is */
  rationale: string;
  /** Stability score (0..1, how much this variable changed across rounds) */
  stability: number;
}

// ============================================
// ConvergenceMetrics — how close the population is to agreement
// ============================================

export interface ConvergenceMetrics {
  /** Overall convergence score (0..1, target >= threshold) */
  score: number;
  /** Rate of agents changing decisions between rounds */
  decisionFlipRate: number;
  /** Fraction of agents disagreeing with the majority */
  dissent: number;
  /** Confidence scores per round */
  confidenceTrend: number[];
  /** Variables that have stabilized */
  stableVariables: string[];
  /** Variables still changing significantly */
  unstableVariables: string[];
}

// ============================================
// CoordinationRisk — a risk detected during coordination
// ============================================

export interface CoordinationRisk {
  /** Risk category */
  type: string;
  /** How severe */
  severity: RiskSeverity;
  /** Human-readable description */
  description: string;
  /** Which signals contributed to this risk */
  sourceSignalIds: string[];
}

// ============================================
// CoordinationLimits — budget and safety constraints
// ============================================

export interface CoordinationLimits {
  /** Maximum number of coordination rounds (default: 3, hard max: 5) */
  maxRounds: number;
  /** Maximum total tokens across all rounds */
  maxTokens?: number;
  /** Maximum total cost in USD */
  maxCostUsd?: number;
  /** Maximum wall-clock time */
  maxLatencyMs?: number;
  /** Minimum convergence score to stop (default: 0.82) */
  minConvergenceScore: number;
  /** Maximum decision flip rate to consider stable (default: 0.15) */
  maxDecisionFlipRate: number;
  /** Maximum dissent ratio (default: 0.35) */
  maxDissent: number;
  /** Stop immediately on critical risk (default: true) */
  stopOnCriticalRisk: boolean;
  /** Minimum signals that must be valid per round (default: 2) */
  minValidSignalsPerRound: number;
  /** Enable stagnation detection (default: true) */
  detectStagnation: boolean;
}

// ============================================
// CoordinationState — the mutable collective state across rounds
// ============================================

export interface CoordinationState {
  /** Unique run identifier */
  runId: string;
  /** Strategy name */
  strategy: string;
  /** Current round number (1-based) */
  round: number;

  /** Tracked variables and their current collective values */
  variables: Record<string, VariableState>;

  /** Convergence metrics */
  convergence: ConvergenceMetrics;

  /** Active risks */
  risks: CoordinationRisk[];

  /** All signals from all rounds (runtime only, not persisted by default) */
  history: CoordinationSignal[];

  /** Budget and safety limits */
  limits: CoordinationLimits;

  /** Why the coordination stopped (set at termination) */
  stopReason?: CoordinationStopReason;

  /** Total accumulated cost */
  totalCostUsd: number;

  /** Total accumulated latency */
  totalLatencyMs: number;

  /** Total accumulated tokens */
  totalTokens: number;
}

// ============================================
// SensitivityAggregationResult — output of aggregating signals
// ============================================

export interface SensitivityAggregationResult {
  /** Updated state after aggregation */
  nextState: CoordinationState;
  /** Variables where agents broadly agree */
  dominantSignals: string[];
  /** Variables where agents disagree */
  conflictingSignals: string[];
  /** Variables that changed in this round */
  updatedVariables: string[];
  /** Whether another round is recommended */
  recommendedNextRound: boolean;
  /** Why coordination should stop (if applicable) */
  stopReason?: CoordinationStopReason;
  /** Risks detected during aggregation */
  risks: CoordinationRisk[];
}

// ============================================
// CoordinationResult — final output of the coordination run
// ============================================

export interface CoordinationResult {
  /** The final decision */
  decision: AgentDecision;
  /** Models that participated */
  participatingModels: Array<{
    modelId: string;
    modelName: string;
    providerId: string;
    role?: string;
  }>;
  /** Final convergence state */
  convergence: ConvergenceMetrics;
  /** Number of rounds executed */
  roundsExecuted: number;
  /** Why coordination stopped */
  stopReason: CoordinationStopReason;
  /** Variables that most influenced the decision */
  criticalVariables: string[];
  /** Sensitivities that dominated the consensus */
  dominantSensitivities: Sensitivity[];
  /** Dissenting positions */
  dissent: Array<{
    agentId: string;
    modelId: string;
    decision: AgentDecision;
    rationale: string;
  }>;
  /** Final aggregated response text */
  finalResponseText: string;
  /** Cost breakdown */
  totalCostUsd: number;
  totalLatencyMs: number;
  totalTokens: number;
  /** All signals for audit trail (optional, controlled by config) */
  auditTrail?: CoordinationSignal[];
}

// ============================================
// CoordinationConfig — feature flag and runtime configuration
// ============================================

export interface CoordinationConfig {
  /** Master switch (default: false) */
  enabled: boolean;
  /** Maximum rounds (default: 3) */
  maxRounds: number;
  /** Minimum convergence to stop (default: 0.82) */
  minConvergenceScore: number;
  /** Maximum decision flip rate (default: 0.15) */
  maxDecisionFlipRate: number;
  /** Maximum dissent (default: 0.35) */
  maxDissent: number;
  /** Maximum cost per run in USD (default: 0.50) */
  maxCostUsd: number;
  /** Maximum latency per run in ms (default: 60000) */
  maxLatencyMs: number;
  /** Stop on critical risk (default: true) */
  stopOnCriticalRisk: boolean;
  /** Minimum models per round (default: 3) */
  minModelsPerRound: number;
  /** Maximum models per round (default: 5) */
  maxModelsPerRound: number;
  /** Minimum quality target to enable (default: 0.8) */
  requireQualityTarget: number;
  /** Aggregation method (default: weighted_confidence) */
  aggregationMethod: AggregationMethod;
  /** Persist full audit trail (default: false) */
  persistAuditTrail: boolean;
  /** Enable for experiment runner (default: true) */
  enableForExperiments: boolean;
  /**
   * Anti-herding primitive (F1.1). When enabled, each per-agent prompt is
   * prefixed with an instruction asking the model to first emit a short
   * random string before its decision/sensitivities, then use that string
   * as a diversity seed for its reasoning. Designed to mitigate the
   * herding pattern detected by `convergence-evaluator.ts:detectHerding`,
   * where agents anchor on the dominant prior-round position instead of
   * exploring divergent hypotheses. Default: false (opt-in via env).
   */
  entropySeedEnabled: boolean;
  /**
   * Per-agent state mode (F2.3). When enabled, the strategy maintains
   * one local θᵢ per agent (filtered by topology) instead of a single
   * shared coordination state. After max rounds, an OPTIONAL
   * coordinate-wise median produces the consensus answer. Default
   * `false` so existing runs keep the shared-state behaviour.
   *
   * The `topologyKind` field below selects which network model
   * defines the neighborhoods. When `perAgentStateEnabled = false`
   * (default), `topologyKind` is ignored.
   */
  perAgentStateEnabled: boolean;
  /**
   * Topology used by the per-agent path (F2.2 / F2.3). Ignored when
   * `perAgentStateEnabled = false`. Default `fully_connected` —
   * preserves current shared-information behaviour even when the
   * per-agent flag is on.
   */
  topologyKind: 'fully_connected' | 'ring' | 'small_world' | 'sparse_random';
}

// ============================================
// Defaults
// ============================================

export const DEFAULT_COORDINATION_CONFIG: CoordinationConfig = {
  enabled: false,
  maxRounds: 3,
  minConvergenceScore: 0.82,
  maxDecisionFlipRate: 0.15,
  maxDissent: 0.35,
  maxCostUsd: 0.50,
  maxLatencyMs: 60000,
  stopOnCriticalRisk: true,
  minModelsPerRound: 3,
  maxModelsPerRound: 5,
  requireQualityTarget: 0.8,
  aggregationMethod: 'weighted_confidence',
  persistAuditTrail: false,
  enableForExperiments: true,
  entropySeedEnabled: false,
  perAgentStateEnabled: false,
  topologyKind: 'fully_connected',
};

/**
 * Read coordination config from environment variables.
 * Falls back to defaults for any unset values.
 */
export function getCoordinationConfigFromEnv(): CoordinationConfig {
  const env = (key: string, fallback: string): string =>
    process.env[key] ?? fallback;

  return {
    enabled: env('CI_SENSITIVITY_CONSENSUS_ENABLED', 'false') === 'true',
    maxRounds: Math.min(5, Math.max(1, parseInt(env('CI_COORDINATION_MAX_ROUNDS', '3'), 10))),
    minConvergenceScore: parseFloat(env('CI_COORDINATION_MIN_CONVERGENCE_SCORE', '0.82')),
    maxDecisionFlipRate: parseFloat(env('CI_COORDINATION_MAX_DECISION_FLIP_RATE', '0.15')),
    maxDissent: parseFloat(env('CI_COORDINATION_MAX_DISSENT', '0.35')),
    maxCostUsd: parseFloat(env('CI_COORDINATION_MAX_COST_USD', '0.50')),
    maxLatencyMs: parseInt(env('CI_COORDINATION_MAX_LATENCY_MS', '60000'), 10),
    stopOnCriticalRisk: env('CI_COORDINATION_STOP_ON_CRITICAL_RISK', 'true') === 'true',
    minModelsPerRound: Math.max(2, parseInt(env('CI_COORDINATION_MIN_MODELS', '3'), 10)),
    maxModelsPerRound: Math.min(7, parseInt(env('CI_COORDINATION_MAX_MODELS', '5'), 10)),
    requireQualityTarget: parseFloat(env('CI_COORDINATION_REQUIRE_QUALITY', '0.8')),
    aggregationMethod: (env('CI_COORDINATION_AGGREGATION_METHOD', 'weighted_confidence') as AggregationMethod),
    persistAuditTrail: env('CI_COORDINATION_PERSIST_AUDIT', 'false') === 'true',
    enableForExperiments: env('CI_COORDINATION_ENABLE_EXPERIMENTS', 'true') === 'true',
    entropySeedEnabled: env('CI_COLLECTIVE_ENTROPY_SEED_ENABLED', 'false') === 'true',
    perAgentStateEnabled: env('CI_COLLECTIVE_PER_AGENT_STATE_ENABLED', 'false') === 'true',
    topologyKind: parseTopologyKind(env('CI_COLLECTIVE_TOPOLOGY_KIND', 'fully_connected')),
  };
}

const VALID_TOPOLOGY_KINDS = new Set(['fully_connected', 'ring', 'small_world', 'sparse_random']);

function parseTopologyKind(value: string): CoordinationConfig['topologyKind'] {
  if (VALID_TOPOLOGY_KINDS.has(value)) {
    return value as CoordinationConfig['topologyKind'];
  }
  return 'fully_connected';
}
