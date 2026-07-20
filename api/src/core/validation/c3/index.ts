// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Class 3 Validation Infrastructure — Barrel Export
 *
 * All modules required for the transition from Class 2 to Class 3
 * scientific validation of collective intelligence.
 */

// P0.4: Scoring policy (LLM-Judge mandatory for learning)
export {
  type ScoringPolicy,
  type PolicyAwareScore,
  isValidForLearning,
  checkRewardHackingDivergence,
} from './scoring-policy';

// P0.2: Ablation framework
export {
  type AblationComponent,
  type AblationModeConfig,
  type AblationFlags,
  ALL_ABLATION_COMPONENTS,
  createAblationFlags,
  isAblated,
  NO_ABLATION,
  generateAblationMatrix,
} from './ablation-config';

// P0.1: Budget governor — REMOVED (2026-06-11). Superseded by the live,
// wired credit-governor (`@/core/budget/credit-governor`), which the
// experiment-runner already uses for per-arm budget + route-exhaustion
// tracking. The c3 copy was a test-only duplicate; keeping it risked
// someone wiring the wrong governor.

// P1.1: Independence test
export {
  IndependenceTestService,
  getIndependenceTestService,
  type IntermediateOutput,
  type DiversityMeasurement,
  type PairwiseSimilarity,
} from './independence-test';

// P1.2: Hidden-information benchmark
export {
  HIDDEN_INFORMATION_SUITE,
  calculateIRR,
  type HiddenInfoTask,
  type HiddenInfoResult,
} from './hidden-information-suite';

// P1.3: Herding/cascade test
export {
  HERDING_SCENARIOS,
  checkBiasFollowing,
  computeHerdingStats,
  type HerdingScenario,
  type HerdingResult,
  type HerdingStats,
} from './herding-test';

// P1.4: Longitudinal learning snapshots
export {
  snapshotBanditParams,
  snapshotArchiveFitness,
  snapshotParetoFrontier,
  snapshotKnowledgeGraph,
  snapshotTriageAccuracy,
  snapshotScorerCorrelation,
  snapshotSelectionRegret,
  getSnapshots,
  computeLearningTrend,
  type LearningSnapshot,
  type SnapshotMetricType,
} from './learning-snapshots';

// P1.5 / P3.2: Learning baselines (implemented in strategy-bandit.ts modifications)

// P1.6 / G.1-G.3: ROI estimation
export {
  ROIEstimator,
  getROIEstimator,
  type DomainROI,
  type ROIReport,
  type ExecutionDataPoint,
} from './roi-estimator';

// A.3: Reward hacking detection
export {
  RewardHackingDetector,
  getRewardHackingDetector,
  type RewardHackingReport,
} from './reward-hacking-detector';

// A.2 / P0.3: Human calibration
export {
  HumanCalibrationService,
  getHumanCalibrationService,
  type CalibrationSample,
  type HumanAnnotation,
  type CalibrationResult,
  type CalibrationReport,
  type InterRaterReliability,
} from './human-calibration';
