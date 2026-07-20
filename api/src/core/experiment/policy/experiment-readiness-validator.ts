// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Readiness Validator — pre-flight validation per arm and per
 * experiment goal.
 *
 * Replaces the ingenuous canary "first arm passes" gate by a goal-aware
 * decision engine that:
 *
 *   1. Probes each declared (providerId) silo in parallel with bounded
 *      concurrency. Skipped if no probe surface available (returns
 *      'unknown' health).
 *   2. Decides per arm what `decision` it should receive based on the arm's
 *      ArmEvaluationPolicy (strict baseline → skip vs degraded; family →
 *      reroute vs skip; dynamic → proceed_with_health_filtered_pool).
 *   3. Aggregates per-goal: `top_tier_comparison` aborts if zero strict
 *      baselines healthy; `resilience_eval` proceeds with degraded
 *      providers.
 *
 * Models are NEVER hardcoded. The validator works on whatever
 * `ResolvedExperimentArm[]` it receives and whatever provider state the
 * registry reports.
 */

import { logger } from '@/utils/logger';
import { getCreditMonitorService } from '@/services/credit-monitor-service';
import { getProviderRegistry } from '@/providers/provider-registry';
import {
  type ResolvedExperimentArm,
  type ArmEvaluationPolicy,
} from './arm-evaluation-policy';
import { resolveProviderFamily, classifyModelById } from './model-classification';

const log = logger.child({ component: 'experiment-readiness-validator' });

// ─── Types ─────────────────────────────────────────────────────────────────

/** Goal of the experiment run. Drives readiness decisions. */
export type ExperimentGoal =
  | 'top_tier_comparison'        // foco em strict baselines frontier
  | 'family_comparison'          // foco em famílias semânticas
  | 'dynamic_routing_eval'       // foco em router
  | 'resilience_eval'            // foco em recuperação (degradação esperada)
  | 'ollama_local_eval'          // foco em local
  | 'mixed_full_comparison'      // C3 main: todos os grupos
  | 'ci_smoke';                  // regressão barata

/** Decision an arm receives from the readiness validator. */
export type ArmReadinessDecision =
  | 'ready'
  | 'skip_unavailable'
  | 'reroute_within_family'
  | 'proceed_with_health_filtered_pool'
  | 'degrade_strategy'
  | 'proceed_with_observed_degradation';

/** Decision the entire experiment receives. */
export type ExperimentReadinessDecision =
  | 'proceed'
  | 'proceed_with_skips'
  | 'proceed_degraded'
  | 'abort';

/** Per-provider health snapshot in the readiness window. */
export interface ProviderHealthSnapshot {
  readonly providerId: string;
  readonly state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  readonly hasCredits: boolean;
  readonly adapterRegistered: boolean;
  readonly probeLatencyMs?: number;
  readonly reason?: string;
}

/** Per-arm readiness result. */
export interface ArmReadinessReport {
  readonly armId: string;
  readonly role: ResolvedExperimentArm['role'];
  readonly policyKind: ArmEvaluationPolicy['kind'];
  readonly declaredProviderId: string | null;
  readonly declaredModelId: string | null;
  readonly declaredModelFamily: string | null;
  readonly decision: ArmReadinessDecision;
  readonly candidatePoolBefore: number;
  readonly candidatePoolAfter: number;
  readonly reason?: string;
  readonly skippedProviders?: ReadonlyArray<string>;
}

/** Per-family coverage. */
export interface FamilyCoverage {
  readonly modelFamily: string;
  readonly healthyProviderIds: ReadonlyArray<string>;
  readonly degradedProviderIds: ReadonlyArray<string>;
  readonly unhealthyProviderIds: ReadonlyArray<string>;
}

/** Full readiness matrix. */
export interface ReadinessMatrix {
  readonly experimentId: string;
  readonly experimentGoal: ExperimentGoal;
  readonly generatedAt: string;
  readonly durationMs: number;

  readonly global: {
    readonly totalProviders: number;
    readonly healthyProviders: number;
    readonly degradedProviders: number;
    readonly unhealthyProviders: number;
    readonly ollamaAvailable: boolean;
    readonly runnerHealthy: boolean;
  };

  readonly providerHealth: ReadonlyArray<ProviderHealthSnapshot>;
  readonly armReadiness: ReadonlyArray<ArmReadinessReport>;
  readonly familyCoverage: ReadonlyArray<FamilyCoverage>;

  readonly summary: {
    readonly totalArms: number;
    readonly readyArms: number;
    readonly skippedArms: number;
    readonly degradedArms: number;
    readonly readyRatio: number;
    readonly distinctHealthyProviders: number;
    readonly coverageGaps: ReadonlyArray<string>;
  };

  readonly decision: ExperimentReadinessDecision;
  readonly rationale: string;
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface ExperimentReadinessValidator {
  validate(input: {
    experimentId: string;
    experimentGoal: ExperimentGoal;
    arms: ReadonlyArray<ResolvedExperimentArm>;
  }): Promise<ReadinessMatrix>;
}

// ─── Implementation ────────────────────────────────────────────────────────

export class DefaultExperimentReadinessValidator implements ExperimentReadinessValidator {
  async validate(input: {
    experimentId: string;
    experimentGoal: ExperimentGoal;
    arms: ReadonlyArray<ResolvedExperimentArm>;
  }): Promise<ReadinessMatrix> {
    const startMs = Date.now();

    // 1. Collect distinct providers referenced by arms (declared + needed for
    //    each family). We probe everything at once and let the per-arm
    //    decision filter.
    const distinctProviders = collectDistinctProviders(input.arms);

    // 2. Probe each provider in parallel
    const providerHealth = await probeProvidersHealth(distinctProviders);

    // 3. Per-arm decision
    const armReadiness: ArmReadinessReport[] = await Promise.all(
      input.arms.map((arm) => decidePerArm(arm, providerHealth)),
    );

    // 4. Family coverage (semantic)
    const familyCoverage = computeFamilyCoverage(providerHealth);

    // 5. Global stats
    const ollamaSnapshot = providerHealth.find((p) => p.providerId.startsWith('ollama'));
    const global = {
      totalProviders: providerHealth.length,
      healthyProviders: providerHealth.filter((p) => p.state === 'healthy').length,
      degradedProviders: providerHealth.filter((p) => p.state === 'degraded').length,
      unhealthyProviders: providerHealth.filter((p) => p.state === 'unhealthy').length,
      ollamaAvailable: ollamaSnapshot?.state === 'healthy' || ollamaSnapshot?.state === 'degraded',
      runnerHealthy: true, // caller is responsible for asserting this — we ran, so we're alive
    };

    // 6. Summary
    const summary = {
      totalArms: armReadiness.length,
      readyArms: armReadiness.filter((a) => a.decision === 'ready' || a.decision === 'proceed_with_health_filtered_pool' || a.decision === 'reroute_within_family').length,
      skippedArms: armReadiness.filter((a) => a.decision === 'skip_unavailable').length,
      degradedArms: armReadiness.filter((a) => a.decision === 'degrade_strategy' || a.decision === 'proceed_with_observed_degradation').length,
      readyRatio: armReadiness.length === 0
        ? 0
        : armReadiness.filter((a) => a.decision !== 'skip_unavailable').length / armReadiness.length,
      distinctHealthyProviders: new Set(
        providerHealth.filter((p) => p.state === 'healthy').map((p) => p.providerId),
      ).size,
      coverageGaps: familyCoverage
        .filter((f) => f.healthyProviderIds.length === 0)
        .map((f) => f.modelFamily),
    };

    // 7. Goal-aware decision
    const decision = decideExperimentReadiness(global, summary, input.experimentGoal);
    const rationale = renderRationale(decision, input.experimentGoal, summary);

    const matrix: ReadinessMatrix = Object.freeze({
      experimentId: input.experimentId,
      experimentGoal: input.experimentGoal,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      global,
      providerHealth,
      armReadiness,
      familyCoverage,
      summary,
      decision,
      rationale,
    });

    log.info(
      {
        experimentId: input.experimentId,
        goal: input.experimentGoal,
        decision,
        readyArms: summary.readyArms,
        skippedArms: summary.skippedArms,
        durationMs: matrix.durationMs,
      },
      `Readiness validation complete: ${decision}`,
    );

    return matrix;
  }
}

// ─── Provider collection ───────────────────────────────────────────────────

function collectDistinctProviders(arms: ReadonlyArray<ResolvedExperimentArm>): string[] {
  // Start with declared providers from strict baseline arms
  const declared = new Set<string>();
  for (const arm of arms) {
    if (arm.declaredProviderId !== null) {
      declared.add(arm.declaredProviderId);
    }
  }

  // Add all registered providers (the validator probes EVERY adapter so the
  // dynamic_router pool can be populated honestly).
  let registered: string[] = [];
  try {
    const registry = getProviderRegistry();
    registered = registry.getProviderNames();
  } catch (err) {
    log.warn({ error: err instanceof Error ? err.message : String(err) }, 'Provider registry unavailable');
  }

  const all = new Set<string>([...declared, ...registered]);
  return [...all].sort();
}

// ─── Probing ───────────────────────────────────────────────────────────────

async function probeProvidersHealth(
  providerIds: ReadonlyArray<string>,
): Promise<ProviderHealthSnapshot[]> {
  type Registry = ReturnType<typeof getProviderRegistry>;
  type Monitor = ReturnType<typeof getCreditMonitorService>;

  let registry: Registry | null = null;
  try {
    registry = getProviderRegistry();
  } catch {
    /* swallow */
  }

  let creditMonitor: Monitor | null = null;
  try {
    creditMonitor = getCreditMonitorService();
  } catch {
    /* swallow */
  }

  const snapshots = await Promise.all(
    providerIds.map(async (providerId): Promise<ProviderHealthSnapshot> => {
      const adapterRegistered = registry?.get(providerId) !== undefined;
      const hasCredits = creditMonitor?.hasCredits(providerId) ?? true; // optimistic default

      // Without a probe surface we can't tell more. Most adapters expose
      // checkBalance() but that's not part of the standard interface — we
      // only attempt it if the registry has a callable shape. We avoid
      // expensive listModels() probes here; those happen elsewhere.
      let state: ProviderHealthSnapshot['state'] = 'unknown';
      let reason: string | undefined;

      if (!adapterRegistered) {
        state = 'unhealthy';
        reason = 'adapter_not_registered';
      } else if (!hasCredits) {
        state = 'unhealthy';
        reason = 'insufficient_credit';
      } else if (creditMonitor) {
        // Credit monitor reported "has credits" — we treat as healthy.
        // True freshness check requires an actual probe; we leave that to
        // the orchestrator's per-request retry logic.
        state = 'healthy';
      }

      return {
        providerId,
        state,
        hasCredits,
        adapterRegistered,
        reason,
      };
    }),
  );

  return snapshots;
}

// ─── Per-arm decision ──────────────────────────────────────────────────────

async function decidePerArm(
  arm: ResolvedExperimentArm,
  providerHealth: ReadonlyArray<ProviderHealthSnapshot>,
): Promise<ArmReadinessReport> {
  const policy = arm.policy;
  const candidatePoolBefore = providerHealth.length;
  const healthyCount = providerHealth.filter((p) => p.state === 'healthy').length;

  // strict_baseline_identity / local_baseline → exact match
  if (policy.kind === 'strict_baseline_identity') {
    if (arm.declaredProviderId !== null) {
      const declared = providerHealth.find((p) => p.providerId === arm.declaredProviderId);
      if (declared === undefined || declared.state === 'unhealthy' || declared.state === 'unknown') {
        return {
          armId: arm.armId,
          role: arm.role,
          policyKind: policy.kind,
          declaredProviderId: arm.declaredProviderId,
          declaredModelId: arm.declaredModelId,
          declaredModelFamily: arm.declaredModelFamily,
          decision: 'skip_unavailable',
          candidatePoolBefore,
          candidatePoolAfter: 0,
          reason: declared?.reason ?? 'declared_provider_unhealthy_or_unknown',
        };
      }
      // declared provider is healthy/degraded — proceed
      return {
        armId: arm.armId,
        role: arm.role,
        policyKind: policy.kind,
        declaredProviderId: arm.declaredProviderId,
        declaredModelId: arm.declaredModelId,
        declaredModelFamily: arm.declaredModelFamily,
        decision: 'ready',
        candidatePoolBefore,
        candidatePoolAfter: 1,
      };
    }

    // strict baseline without declared provider — try classifying the
    // declared model and find which provider serves it
    if (arm.declaredModelId !== null) {
      const classified = await classifyModelById(arm.declaredModelId);
      if (!classified) {
        return makeSkipReport(arm, candidatePoolBefore, 'declared_model_not_in_db');
      }
      const provHealth = providerHealth.find((p) => p.providerId === classified.providerId);
      if (provHealth === undefined || provHealth.state === 'unhealthy') {
        return makeSkipReport(arm, candidatePoolBefore, 'inferred_provider_unhealthy');
      }
      return {
        armId: arm.armId,
        role: arm.role,
        policyKind: policy.kind,
        declaredProviderId: classified.providerId,
        declaredModelId: arm.declaredModelId,
        declaredModelFamily: classified.modelFamily,
        decision: 'ready',
        candidatePoolBefore,
        candidatePoolAfter: 1,
      };
    }

    return makeSkipReport(arm, candidatePoolBefore, 'strict_baseline_no_declared_identity');
  }

  // family_baseline_identity → any silo in same family
  if (policy.kind === 'family_baseline_identity') {
    const family = arm.declaredModelFamily;
    if (family === null) {
      return makeSkipReport(arm, candidatePoolBefore, 'family_baseline_no_family_declared');
    }

    // Find healthy providers serving this family. Look up via catalog
    const familySilos = providerHealth.filter((p) => {
      const f = resolveProviderFamily(p.providerId);
      return f === family;
    });

    const healthyInFamily = familySilos.filter((p) => p.state === 'healthy');

    if (healthyInFamily.length === 0) {
      return {
        armId: arm.armId,
        role: arm.role,
        policyKind: policy.kind,
        declaredProviderId: null,
        declaredModelId: arm.declaredModelId,
        declaredModelFamily: family,
        decision: 'skip_unavailable',
        candidatePoolBefore,
        candidatePoolAfter: 0,
        reason: 'no_healthy_silo_in_family',
        skippedProviders: familySilos.filter((p) => p.state !== 'healthy').map((p) => p.providerId),
      };
    }

    return {
      armId: arm.armId,
      role: arm.role,
      policyKind: policy.kind,
      declaredProviderId: null,
      declaredModelId: arm.declaredModelId,
      declaredModelFamily: family,
      decision: 'reroute_within_family',
      candidatePoolBefore,
      candidatePoolAfter: healthyInFamily.length,
    };
  }

  // dynamic_router → proceed with health-filtered pool
  if (policy.kind === 'dynamic_router') {
    const healthyPool = providerHealth.filter((p) => p.state === 'healthy');
    const ollamaUp = providerHealth.some(
      (p) => p.providerId.startsWith('ollama') && p.state === 'healthy',
    );

    if (healthyPool.length === 0 && !ollamaUp) {
      return makeSkipReport(arm, candidatePoolBefore, 'no_provider_healthy_for_dynamic');
    }

    return {
      armId: arm.armId,
      role: arm.role,
      policyKind: policy.kind,
      declaredProviderId: null,
      declaredModelId: null,
      declaredModelFamily: null,
      decision: 'proceed_with_health_filtered_pool',
      candidatePoolBefore,
      candidatePoolAfter: healthyPool.length + (ollamaUp ? 1 : 0),
    };
  }

  // collective_strategy → check if required roles can be filled
  if (policy.kind === 'collective_strategy') {
    const requiredRoleCount = arm.requiredRoles.length;
    const healthyPool = providerHealth.filter((p) => p.state === 'healthy');

    if (healthyPool.length === 0) {
      return makeSkipReport(arm, candidatePoolBefore, 'no_healthy_providers_for_collective');
    }

    // If we have fewer healthy providers than required roles, decide based
    // on policy/arm config
    if (healthyPool.length < requiredRoleCount) {
      if (arm.allowDegradation) {
        return {
          armId: arm.armId,
          role: arm.role,
          policyKind: policy.kind,
          declaredProviderId: null,
          declaredModelId: null,
          declaredModelFamily: null,
          decision: 'degrade_strategy',
          candidatePoolBefore,
          candidatePoolAfter: healthyPool.length,
          reason: `insufficient_roles: ${healthyPool.length}/${requiredRoleCount}`,
        };
      }
      return makeSkipReport(arm, candidatePoolBefore, `insufficient_roles_${healthyPool.length}_of_${requiredRoleCount}`);
    }

    return {
      armId: arm.armId,
      role: arm.role,
      policyKind: policy.kind,
      declaredProviderId: null,
      declaredModelId: null,
      declaredModelFamily: null,
      decision: 'ready',
      candidatePoolBefore,
      candidatePoolAfter: healthyPool.length,
    };
  }

  // resilience_strategy → never skip on dead providers (it's the scenario)
  if (policy.kind === 'resilience_strategy') {
    return {
      armId: arm.armId,
      role: arm.role,
      policyKind: policy.kind,
      declaredProviderId: null,
      declaredModelId: null,
      declaredModelFamily: null,
      decision: 'proceed_with_observed_degradation',
      candidatePoolBefore,
      candidatePoolAfter: healthyCount,
    };
  }

  // Defensive default
  return makeSkipReport(arm, candidatePoolBefore, 'unknown_policy_kind');
}

function makeSkipReport(
  arm: ResolvedExperimentArm,
  candidatePoolBefore: number,
  reason: string,
): ArmReadinessReport {
  return {
    armId: arm.armId,
    role: arm.role,
    policyKind: arm.policy.kind,
    declaredProviderId: arm.declaredProviderId,
    declaredModelId: arm.declaredModelId,
    declaredModelFamily: arm.declaredModelFamily,
    decision: 'skip_unavailable',
    candidatePoolBefore,
    candidatePoolAfter: 0,
    reason,
  };
}

// ─── Family coverage ───────────────────────────────────────────────────────

function computeFamilyCoverage(
  providerHealth: ReadonlyArray<ProviderHealthSnapshot>,
): FamilyCoverage[] {
  const byFamily = new Map<string, { healthy: string[]; degraded: string[]; unhealthy: string[] }>();

  for (const ph of providerHealth) {
    const family = resolveProviderFamily(ph.providerId);
    if (family === null) continue;

    const bucket = byFamily.get(family) ?? { healthy: [], degraded: [], unhealthy: [] };
    if (ph.state === 'healthy') bucket.healthy.push(ph.providerId);
    else if (ph.state === 'degraded') bucket.degraded.push(ph.providerId);
    else if (ph.state === 'unhealthy') bucket.unhealthy.push(ph.providerId);
    byFamily.set(family, bucket);
  }

  return [...byFamily.entries()].map(([family, bucket]) => ({
    modelFamily: family,
    healthyProviderIds: Object.freeze(bucket.healthy),
    degradedProviderIds: Object.freeze(bucket.degraded),
    unhealthyProviderIds: Object.freeze(bucket.unhealthy),
  }));
}

// ─── Goal-aware experiment decision ────────────────────────────────────────

function decideExperimentReadiness(
  global: ReadinessMatrix['global'],
  summary: ReadinessMatrix['summary'],
  goal: ExperimentGoal,
): ExperimentReadinessDecision {
  switch (goal) {
    case 'top_tier_comparison':
      // Aborts if zero strict baselines healthy (caller passes only strict
      // baselines as arms; readyRatio ≥ 0.5 → proceed)
      if (summary.readyArms === 0) return 'abort';
      if (summary.readyRatio >= 0.8) return 'proceed';
      if (summary.readyRatio >= 0.5) return 'proceed_with_skips';
      return 'proceed_degraded';

    case 'family_comparison':
      // Aborts if no family has ≥1 healthy silo
      if (summary.coverageGaps.length === summary.totalArms) return 'abort';
      if (summary.readyRatio >= 0.5) return 'proceed_with_skips';
      return 'proceed_degraded';

    case 'dynamic_routing_eval':
      // Doesn't abort on dead baselines — dynamic is the focus
      if (global.healthyProviders === 0 && !global.ollamaAvailable) return 'abort';
      return 'proceed';

    case 'resilience_eval':
      // Dead providers are the SCENARIO — proceed unless infrastructure dead
      if (!global.runnerHealthy) return 'abort';
      return 'proceed';

    case 'ollama_local_eval':
      if (!global.ollamaAvailable) return 'abort';
      return 'proceed';

    case 'mixed_full_comparison': {
      // C3 main — proceed if ≥3 distinct healthy providers
      if (summary.distinctHealthyProviders === 0 && !global.ollamaAvailable) return 'abort';
      if (summary.distinctHealthyProviders < 3) return 'proceed_degraded';
      if (summary.readyRatio < 0.5) return 'proceed_with_skips';
      return 'proceed';
    }

    case 'ci_smoke':
      return global.runnerHealthy ? 'proceed' : 'abort';

    default: {
      const _exhaustive: never = goal;
      return _exhaustive;
    }
  }
}

function renderRationale(
  decision: ExperimentReadinessDecision,
  goal: ExperimentGoal,
  summary: ReadinessMatrix['summary'],
): string {
  return `goal=${goal} decision=${decision} ready=${summary.readyArms}/${summary.totalArms} skipped=${summary.skippedArms} healthyProviders=${summary.distinctHealthyProviders} coverageGaps=${summary.coverageGaps.length}`;
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let defaultValidator: ExperimentReadinessValidator | null = null;

export function getDefaultReadinessValidator(): ExperimentReadinessValidator {
  if (defaultValidator === null) {
    defaultValidator = new DefaultExperimentReadinessValidator();
  }
  return defaultValidator;
}

/** Test-only reset. */
export function _resetReadinessValidatorForTests(): void {
  defaultValidator = null;
}
