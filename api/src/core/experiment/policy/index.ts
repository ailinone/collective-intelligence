// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Policy module — public surface.
 *
 * Phase 1 of the corrected SOTA experimental architecture: per-arm
 * evaluation policies replacing the previous global strictProviderIsolation
 * rule. Lets baselines be strict, dynamic routers be free, and integrity
 * be enforced at the level the arm declares.
 */

export {
  type ArmRole,
  type IdentityLevel,
  type SubstitutionLevel,
  type FallbackScope,
  type HedgedRequestPolicy,
  type AdaptiveLearningPolicy,
  type AttemptRoleInStrategy,
  type SelectionReason,
  type ArmEvaluationPolicy,
  type ArmPolicyHints,
  type ResolvedExperimentArm,
  type ModelAttemptRecord,
  type IntegrityResult,
  type PolicyViolation,
  type PolicyViolationKind,
  POLICY_STRICT_BASELINE,
  POLICY_FAMILY_BASELINE,
  POLICY_DYNAMIC_ROUTER,
  POLICY_COLLECTIVE_STRATEGY,
  POLICY_RESILIENCE_STRATEGY,
  POLICIES_BY_KIND,
  ROLE_TO_DEFAULT_POLICY,
  SUBSTITUTION_LEVEL_ORDER,
  isSubstitutionLevelAllowed,
  isOllamaProviderId,
} from './arm-evaluation-policy';

export {
  type ClassifiedModel,
  type CapabilityTier,
  inferCapabilityTier,
  resolveProviderFamily,
  listProvidersByFamily,
  isCatalogProvider,
  classifyModelById,
  classifyModelsByIds,
  classifyFromFields,
} from './model-classification';

export {
  type ModeConfigWithHints,
  resolveExperimentArm,
  deriveDefaultRole,
  deriveDefaultIdentityLevel,
  deriveArmId,
  getCanonicalPolicy,
} from './policy-arm-resolver';

export {
  type ExperimentPolicyEngine,
  type CandidateVerdict,
  type FallbackVerdict,
  type ParallelVerdict,
  type AttemptClassification,
  type SelectionContext,
  type FallbackContext,
  DefaultExperimentPolicyEngine,
  computeSubstitutionLevel,
  getDefaultPolicyEngine,
} from './experiment-policy-engine';

export {
  type ExperimentIntegrityGuard,
  type ExecutionRecord,
  DefaultExperimentIntegrityGuard,
  getDefaultIntegrityGuard,
  formatIntegrityResult,
} from './experiment-integrity-guard';

export {
  type ExperimentGoal,
  type ArmReadinessDecision,
  type ExperimentReadinessDecision,
  type ProviderHealthSnapshot,
  type ArmReadinessReport,
  type FamilyCoverage,
  type ReadinessMatrix,
  type ExperimentReadinessValidator,
  DefaultExperimentReadinessValidator,
  getDefaultReadinessValidator,
} from './experiment-readiness-validator';

export {
  type SmartCanaryRequest,
  type SmartCanaryResult,
  type SmartCanaryGates,
  type SingleCanaryResult,
  runSmartCanary,
} from './smart-canary';
