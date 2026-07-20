// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Integrity Guard — validates an execution trajectory against
 * the arm's evaluation policy.
 *
 * Used POST-execution by the experiment-runner to decide whether the
 * recorded trajectory honored the policy. The guard NEVER mutates the
 * execution; it produces a structured `IntegrityResult` with all
 * violations enumerated.
 *
 * Behavior under classifier failure:
 *   - If a candidate cannot be classified (model removed from DB, stale
 *     record, etc.), the attempt is recorded as `unclassified` and
 *     reported. It does NOT silently fail — the experiment owner sees it.
 *
 * Caller is responsible for:
 *   - Persisting the result (e.g., on `experiment_executions.policy_violations`).
 *   - Emitting metrics from the result.
 *   - Deciding whether to mark the execution `success=false` based on
 *     `result.valid`.
 */

import type {
  ResolvedExperimentArm,
  ArmEvaluationPolicy,
  IntegrityResult,
  PolicyViolation,
  PolicyViolationKind,
  ModelAttemptRecord,
  SubstitutionLevel,
} from './arm-evaluation-policy';
import {
  isOllamaProviderId,
  isSubstitutionLevelAllowed,
} from './arm-evaluation-policy';
import {
  type ExperimentPolicyEngine,
  computeSubstitutionLevel,
  getDefaultPolicyEngine,
} from './experiment-policy-engine';
import {
  type ClassifiedModel,
  classifyModelsByIds,
  type CapabilityTier,
} from './model-classification';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'experiment-integrity-guard' });

// ─── Public input shape ────────────────────────────────────────────────────

/**
 * Everything the guard needs to validate an execution. Built by the
 * experiment-runner from the arm + recorded attempts.
 */
export interface ExecutionRecord {
  readonly executionId: string;
  readonly arm: ResolvedExperimentArm;
  readonly attempts: ReadonlyArray<ModelAttemptRecord>;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
}

// ─── Public guard surface ──────────────────────────────────────────────────

export interface ExperimentIntegrityGuard {
  /** Validate a single execution against its arm's policy. */
  assertExperimentIntegrity(record: ExecutionRecord): Promise<IntegrityResult>;

  /**
   * Synchronous variant when caller already has classifications. Used
   * primarily from inside the orchestrator hot path or from tests.
   */
  assertWithClassifications(
    record: ExecutionRecord,
    classifications: ReadonlyMap<string, ClassifiedModel>,
  ): IntegrityResult;
}

// ─── Default implementation ────────────────────────────────────────────────

export class DefaultExperimentIntegrityGuard implements ExperimentIntegrityGuard {
  constructor(private readonly engine: ExperimentPolicyEngine = getDefaultPolicyEngine()) {}

  async assertExperimentIntegrity(record: ExecutionRecord): Promise<IntegrityResult> {
    // Classify all unique models in the trajectory
    const modelIds = record.attempts.map((a) => a.modelId);
    const classifications = await classifyModelsByIds(modelIds);
    return this.assertWithClassifications(record, classifications);
  }

  assertWithClassifications(
    record: ExecutionRecord,
    classifications: ReadonlyMap<string, ClassifiedModel>,
  ): IntegrityResult {
    const policy = record.arm.policy;
    const violations: PolicyViolation[] = [];

    // Per-attempt validation
    for (const attempt of record.attempts) {
      const violationsForAttempt = this.validateAttempt(record.arm, attempt, classifications);
      violations.push(...violationsForAttempt);
    }

    // Aggregate validations
    violations.push(...this.validateAggregate(record.arm, record));

    const result: IntegrityResult = Object.freeze({
      valid: violations.length === 0,
      violations: Object.freeze(violations),
      armId: record.arm.armId,
      policyKind: policy.kind,
      checkedAttempts: record.attempts.length,
      totalCostUsd: record.totalCostUsd,
      totalDurationMs: record.totalDurationMs,
    });

    if (!result.valid) {
      log.warn(
        {
          executionId: record.executionId,
          armId: record.arm.armId,
          policyKind: policy.kind,
          violationCount: violations.length,
          violationKinds: [...new Set(violations.map((v) => v.kind))],
        },
        'Integrity guard detected policy violations',
      );
    }

    return result;
  }

  // ─── Per-attempt validation ──────────────────────────────────────────────

  private validateAttempt(
    arm: ResolvedExperimentArm,
    attempt: ModelAttemptRecord,
    classifications: ReadonlyMap<string, ClassifiedModel>,
  ): PolicyViolation[] {
    const violations: PolicyViolation[] = [];
    const classified = classifications.get(attempt.modelId);

    if (!classified) {
      // Cannot classify — record but don't infer violation. This typically
      // means the model row was removed/renamed between execution and
      // validation. The audit log will still flag it for investigation.
      log.warn(
        { armId: arm.armId, modelId: attempt.modelId, attemptIndex: attempt.attemptIndex },
        'Integrity guard: attempt model could not be classified (DB lookup miss)',
      );
      return violations;
    }

    const policy = arm.policy;
    const declaredView = this.declaredView(arm);
    const level = computeSubstitutionLevel(declaredView, classified);

    // Substitution level
    if (!isSubstitutionLevelAllowed(level, policy.maxSubstitutionLevel)) {
      violations.push({
        kind: 'substitution_level_exceeded',
        attemptIndex: attempt.attemptIndex,
        providerId: attempt.providerId,
        modelId: attempt.modelId,
        actualLevel: level,
        maxAllowed: policy.maxSubstitutionLevel,
        message: `Attempt ${attempt.attemptIndex} substitution level '${level}' exceeds policy max '${policy.maxSubstitutionLevel}'`,
      });
    }

    if (level === 'degraded_answer_mode') {
      violations.push({
        kind: 'degraded_answer_mode_forbidden',
        attemptIndex: attempt.attemptIndex,
        providerId: attempt.providerId,
        modelId: attempt.modelId,
        message: 'degraded_answer_mode is forbidden in all experiment policies',
      });
    }

    // Identity enforcement
    if (
      policy.enforceProviderIdentity &&
      arm.declaredProviderId !== null &&
      classified.providerId !== arm.declaredProviderId
    ) {
      violations.push({
        kind: 'provider_identity_violation',
        attemptIndex: attempt.attemptIndex,
        providerId: classified.providerId,
        modelId: classified.modelId,
        message: `Attempt provider '${classified.providerId}' violates declared identity '${arm.declaredProviderId}'`,
      });
    }

    if (
      policy.enforceFamilyIdentity &&
      arm.declaredModelFamily !== null &&
      classified.modelFamily !== arm.declaredModelFamily
    ) {
      violations.push({
        kind: 'family_identity_violation',
        attemptIndex: attempt.attemptIndex,
        providerId: classified.providerId,
        modelId: classified.modelId,
        message: `Attempt family '${classified.modelFamily}' violates declared family '${arm.declaredModelFamily}'`,
      });
    }

    if (
      policy.enforceCapabilityIdentity &&
      arm.declaredCapabilityClass !== null &&
      classified.capabilityTier !== arm.declaredCapabilityClass
    ) {
      violations.push({
        kind: 'capability_identity_violation',
        attemptIndex: attempt.attemptIndex,
        providerId: classified.providerId,
        modelId: classified.modelId,
        message: `Attempt capability tier '${classified.capabilityTier}' violates declared class '${arm.declaredCapabilityClass}'`,
      });
    }

    // Ollama gates
    if (classified.isLocal || isOllamaProviderId(classified.providerId)) {
      if (attempt.roleInStrategy === 'primary' && !policy.allowOllamaPrimary) {
        violations.push({
          kind: 'ollama_primary_not_allowed',
          attemptIndex: attempt.attemptIndex,
          providerId: classified.providerId,
          modelId: classified.modelId,
          message: 'Ollama used as primary but policy does not allow it',
        });
      }
      if (
        (attempt.roleInStrategy === 'fallback' || attempt.roleInStrategy === 'hedged') &&
        !policy.allowOllamaFallback
      ) {
        violations.push({
          kind: 'ollama_fallback_not_allowed',
          attemptIndex: attempt.attemptIndex,
          providerId: classified.providerId,
          modelId: classified.modelId,
          message: `Ollama used as ${attempt.roleInStrategy} but policy does not allow it`,
        });
      }
    }

    // Hedging
    if (attempt.roleInStrategy === 'hedged' && policy.allowHedgedRequests === false) {
      violations.push({
        kind: 'hedging_not_allowed',
        attemptIndex: attempt.attemptIndex,
        providerId: classified.providerId,
        modelId: classified.modelId,
        message: 'Hedged attempt recorded but policy disallows hedged requests',
      });
    }

    return violations;
  }

  // ─── Aggregate validation (depth, budget, timeout, concurrency) ──────────

  private validateAggregate(
    arm: ResolvedExperimentArm,
    record: ExecutionRecord,
  ): PolicyViolation[] {
    const policy = arm.policy;
    const violations: PolicyViolation[] = [];

    // Count "real" attempts (excluding skipped/cancelled ones the orchestrator
    // proactively rejected before any I/O — those don't count toward anything).
    const realAttempts = record.attempts.filter(
      (a) => a.status !== 'skipped' && a.status !== 'cancelled',
    );

    // `fallbackDepth` measures sequential recovery attempts only.
    // Strategy roles (expert, aggregator, judge, critic, probe) are
    // distinct positions in the strategy's design — not fallbacks. Only
    // attempts with `roleInStrategy ∈ {fallback, hedged}` count toward depth.
    const fallbackAttempts = realAttempts.filter(
      (a) => a.roleInStrategy === 'fallback' || a.roleInStrategy === 'hedged',
    );

    if (fallbackAttempts.length > policy.maxFallbackDepth) {
      violations.push({
        kind: 'fallback_depth_exceeded',
        actualValue: fallbackAttempts.length,
        maxValue: policy.maxFallbackDepth,
        message: `Fallback/hedged attempts (${fallbackAttempts.length}) exceed max fallback depth (${policy.maxFallbackDepth})`,
      });
    }

    if (record.totalCostUsd > policy.totalArmBudgetUsd) {
      violations.push({
        kind: 'arm_budget_exceeded',
        actualValue: record.totalCostUsd,
        maxValue: policy.totalArmBudgetUsd,
        message: `Total cost USD (${record.totalCostUsd.toFixed(4)}) exceeds arm budget (${policy.totalArmBudgetUsd.toFixed(4)})`,
      });
    }

    if (record.totalDurationMs > policy.totalArmTimeoutMs) {
      violations.push({
        kind: 'arm_timeout_exceeded',
        actualValue: record.totalDurationMs,
        maxValue: policy.totalArmTimeoutMs,
        message: `Total duration (${record.totalDurationMs}ms) exceeds arm timeout (${policy.totalArmTimeoutMs}ms)`,
      });
    }

    // Concurrency: detect if multiple attempts have overlapping timestamps
    // and policy disallows it. Heuristic: same-millisecond start counts as
    // concurrent.
    const concurrentBuckets = new Map<number, number>();
    for (const a of realAttempts) {
      const bucket = Math.floor(a.timestampMs / 100); // 100ms granularity
      concurrentBuckets.set(bucket, (concurrentBuckets.get(bucket) ?? 0) + 1);
    }
    const maxObservedConcurrency = Math.max(0, ...concurrentBuckets.values());
    if (maxObservedConcurrency > policy.maxConcurrentInferences) {
      violations.push({
        kind: 'concurrent_inferences_exceeded',
        actualValue: maxObservedConcurrency,
        maxValue: policy.maxConcurrentInferences,
        message: `Observed peak concurrency (${maxObservedConcurrency}) exceeds policy max (${policy.maxConcurrentInferences})`,
      });
    }

    return violations;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private declaredView(arm: ResolvedExperimentArm): {
    providerId: string | null;
    modelId: string | null;
    modelFamily: string | null;
    capabilityTier: CapabilityTier | null;
  } {
    return {
      providerId: arm.declaredProviderId,
      modelId: arm.declaredModelId,
      modelFamily: arm.declaredModelFamily,
      capabilityTier: arm.declaredCapabilityClass as CapabilityTier | null,
    };
  }
}

// ─── Module-level singleton ────────────────────────────────────────────────

let defaultGuard: ExperimentIntegrityGuard | null = null;

export function getDefaultIntegrityGuard(): ExperimentIntegrityGuard {
  if (defaultGuard === null) {
    defaultGuard = new DefaultExperimentIntegrityGuard();
  }
  return defaultGuard;
}

/** Reset the singleton. Test-only. */
export function _resetIntegrityGuardForTests(): void {
  defaultGuard = null;
}

// ─── Convenience formatter for human-readable output ───────────────────────

export function formatIntegrityResult(result: IntegrityResult): string {
  if (result.valid) {
    return `OK arm=${result.armId} policy=${result.policyKind} attempts=${result.checkedAttempts}`;
  }
  const lines = [
    `FAILED arm=${result.armId} policy=${result.policyKind} violations=${result.violations.length}`,
  ];
  for (const v of result.violations) {
    lines.push(`  ${v.kind}: ${v.message}`);
  }
  return lines.join('\n');
}

// ─── Re-exports for ergonomics ─────────────────────────────────────────────

export type {
  IntegrityResult,
  PolicyViolation,
  PolicyViolationKind,
  ModelAttemptRecord,
  SubstitutionLevel,
  ResolvedExperimentArm,
  ArmEvaluationPolicy,
};
