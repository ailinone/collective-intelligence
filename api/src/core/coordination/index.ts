// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Module Index
 *
 * Public API for the coordination layer.
 * All internal components are exported for testing and composition.
 */

// Types
export type {
  SensitivityDirection,
  RiskSeverity,
  CoordinationStopReason,
  AggregationMethod,
  Sensitivity,
  AgentDecision,
  CoordinationSignal,
  VariableState,
  ConvergenceMetrics,
  CoordinationRisk,
  CoordinationLimits,
  CoordinationState,
  SensitivityAggregationResult,
  CoordinationResult,
  CoordinationConfig,
} from './coordination-types';

export {
  DEFAULT_COORDINATION_CONFIG,
  getCoordinationConfigFromEnv,
} from './coordination-types';

// Validation
export {
  validateCoordinationSignal,
  validateSensitivity,
  validateDecision,
  looksLikeSignalResponse,
  redactPii,
} from './signal-validator';
export type { SignalValidationResult, PiiRedactionResult } from './signal-validator';

// Aggregation
export {
  createInitialState,
  aggregateSignals,
  evaluateStopConditions,
} from './sensitivity-aggregator';

// Prompt adapter
export {
  buildCoordinationSystemPrompt,
  buildCoordinationUserMessage,
  parseSignalResponse,
  extractResponseText,
} from './sensitivity-prompt-adapter';

// Metrics
export {
  recordCoordinationRun,
  recordSignalParseFailure,
} from './coordination-metrics';
export type { CoordinationRunMetrics } from './coordination-metrics';

// Convergence evaluator
export {
  evaluateConvergence,
} from './convergence-evaluator';
export type { ConvergenceEvaluation } from './convergence-evaluator';
