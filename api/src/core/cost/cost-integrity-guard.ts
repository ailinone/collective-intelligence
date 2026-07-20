// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cost Integrity Guard
 *
 * Defense-in-depth against negative or otherwise invalid cost values that
 * propagate through the orchestration → aggregation → metadata pipeline and
 * corrupt benchmark reports + investor-facing claims (see incident
 * `eval-baseline-metrics.json` 2026-02-20 where debate strategy aggregated
 * `avgCostPerRequest: -2786 USD`).
 *
 * This module is intentionally minimal. The contract is:
 *
 *   guardCost(rawCost, context) → CostGuardResult
 *
 * Callers MUST run cost values through this guard before:
 *   1. Persisting to `execution.cost` (BaseStrategy.createModelExecution)
 *   2. Aggregating into `result.totalCost` (each Strategy.execute)
 *   3. Emitting on `ailin_metadata.cost_usd` (ChatRequestProcessor)
 *   4. Reporting in benchmark metrics (enterprise-eval-shared)
 *
 * The policy on what to do when the guard finds a violation is a runtime
 * decision (see CostIntegrityPolicy below).
 */

import { logger } from '@/utils/logger';

// ─── Public Types ─────────────────────────────────────────────────────────

/**
 * Possible policies for handling cost integrity violations.
 *
 * [USER_DECISION_REQUIRED] — see chooseCostIntegrityPolicy() at end of file.
 *
 * Trade-offs:
 *
 *   silent-zero    — Replace bad values with 0 silently. Hides bugs but
 *                    keeps production running smoothly. NOT recommended for
 *                    a system whose Principle #9 is "Honesty about
 *                    validation is a feature".
 *
 *   warn-and-null  — Replace bad values with `null` and emit a structured
 *                    warning to logger + Prometheus counter. Downstream
 *                    code must already handle `null` (the metadata schema
 *                    already allows `cost_usd: number | null`, so this is
 *                    a clean choice). Strong default for production.
 *
 *   warn-and-zero  — Replace bad values with 0 AND emit warning. Continues
 *                    to corrupt analytics (because 0 is averaged into
 *                    metrics) but at least surfaces the bug. NOT
 *                    recommended.
 *
 *   strict-throw   — Throw a CostIntegrityError. Loudest signal. Will
 *                    break production responses if a regression
 *                    introduces a negative cost path. Right for eval and
 *                    pre-production gating; risky for live serving.
 *
 *   env-dependent  — Use 'warn-and-null' in NODE_ENV=production and
 *                    'strict-throw' otherwise (eval, test, dev). Best of
 *                    both worlds — Recommended default.
 */
export type CostIntegrityPolicy =
  | 'silent-zero'
  | 'warn-and-null'
  | 'warn-and-zero'
  | 'strict-throw'
  | 'env-dependent';

export interface CostGuardContext {
  /** Where the cost is being validated (e.g. 'base-strategy.createModelExecution') */
  callSite: string;
  /** Optional strategy identifier (for telemetry attribution) */
  strategy?: string;
  /** Optional provider/adapter name (for telemetry attribution) */
  provider?: string;
  /** Optional model id (for telemetry attribution) */
  modelId?: string;
}

export interface CostGuardResult {
  /** The cost value after the guard runs. `null` means "unknown/invalid". */
  cost: number | null;
  /** Whether the input was valid (non-negative, finite). */
  ok: boolean;
  /** If !ok, why it was flagged. */
  reason?:
    | 'negative'
    | 'not-a-number'
    | 'infinite'
    | 'undefined-or-null';
}

export class CostIntegrityError extends Error {
  constructor(
    public readonly rawCost: unknown,
    public readonly context: CostGuardContext,
    public readonly reason: NonNullable<CostGuardResult['reason']>,
  ) {
    super(
      `Cost integrity violation [${reason}]: rawCost=${String(rawCost)} ` +
        `at ${context.callSite} (strategy=${context.strategy ?? 'n/a'}, ` +
        `provider=${context.provider ?? 'n/a'}, model=${context.modelId ?? 'n/a'})`,
    );
    this.name = 'CostIntegrityError';
  }
}

// ─── Internals ─────────────────────────────────────────────────────────────

const log = logger.child({ component: 'cost-integrity-guard' });

/**
 * Classify a raw cost value. Pure function, no side effects.
 */
function classify(rawCost: unknown): CostGuardResult {
  if (rawCost === null || rawCost === undefined) {
    return { cost: null, ok: false, reason: 'undefined-or-null' };
  }
  if (typeof rawCost !== 'number') {
    return { cost: null, ok: false, reason: 'not-a-number' };
  }
  if (!Number.isFinite(rawCost)) {
    return { cost: null, ok: false, reason: 'infinite' };
  }
  if (rawCost < 0) {
    return { cost: null, ok: false, reason: 'negative' };
  }
  return { cost: rawCost, ok: true };
}

/**
 * Resolve the active policy. Reads CI_COST_INTEGRITY_POLICY env if set,
 * otherwise falls back to chooseCostIntegrityPolicy() (the user-chosen
 * default at the bottom of this file).
 */
function resolvePolicy(): CostIntegrityPolicy {
  const env = process.env.CI_COST_INTEGRITY_POLICY;
  if (
    env === 'silent-zero' ||
    env === 'warn-and-null' ||
    env === 'warn-and-zero' ||
    env === 'strict-throw' ||
    env === 'env-dependent'
  ) {
    return env;
  }
  return chooseCostIntegrityPolicy();
}

/**
 * Resolve 'env-dependent' policy at call time.
 */
function resolveEnvDependent(): 'warn-and-null' | 'strict-throw' {
  return process.env.NODE_ENV === 'production' ? 'warn-and-null' : 'strict-throw';
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Run a raw cost value through the integrity guard.
 *
 * On invalid input, the behavior is determined by the active policy:
 *   - 'silent-zero'   → returns 0, no log
 *   - 'warn-and-null' → returns null, emits warn log + Prometheus counter
 *   - 'warn-and-zero' → returns 0, emits warn log + Prometheus counter
 *   - 'strict-throw'  → throws CostIntegrityError
 *   - 'env-dependent' → delegates to 'warn-and-null' or 'strict-throw'
 *
 * @param rawCost - The cost value to validate
 * @param context - Where the cost is coming from (for telemetry + error)
 * @returns CostGuardResult — always returns a result (unless policy throws)
 */
export function guardCost(
  rawCost: unknown,
  context: CostGuardContext,
): CostGuardResult {
  const classification = classify(rawCost);
  if (classification.ok) return classification;

  let policy = resolvePolicy();
  if (policy === 'env-dependent') policy = resolveEnvDependent();

  // Telemetry: every violation increments a Prometheus counter (lazy import
  // to avoid circular dep with ci-metrics).
  emitViolationMetric(classification.reason!, context);

  switch (policy) {
    case 'silent-zero':
      return { cost: 0, ok: false, reason: classification.reason };

    case 'warn-and-zero':
      log.warn(
        {
          rawCost,
          reason: classification.reason,
          callSite: context.callSite,
          strategy: context.strategy,
          provider: context.provider,
          modelId: context.modelId,
        },
        'cost integrity violation — flooring to 0',
      );
      return { cost: 0, ok: false, reason: classification.reason };

    case 'warn-and-null':
      log.warn(
        {
          rawCost,
          reason: classification.reason,
          callSite: context.callSite,
          strategy: context.strategy,
          provider: context.provider,
          modelId: context.modelId,
        },
        'cost integrity violation — recording as null/unknown',
      );
      return { cost: null, ok: false, reason: classification.reason };

    case 'strict-throw':
      throw new CostIntegrityError(rawCost, context, classification.reason!);
  }
}

/**
 * Convenience: filter an array of cost values to those that pass the
 * non-negative finite check. Used by aggregators (average, sum) that
 * must NOT propagate bad values.
 *
 * Returns:
 *   { valid: number[]; rejected: number; rejectionReasons: Map<reason, count> }
 *
 * Callers can compute averages, sums, p95s etc on `valid` and report
 * `rejected` count alongside (so consumers see how many points were
 * dropped from the metric).
 */
export function filterValidCosts(
  costs: ReadonlyArray<unknown>,
  context: CostGuardContext,
): {
  valid: number[];
  rejected: number;
  rejectionReasons: Map<NonNullable<CostGuardResult['reason']>, number>;
} {
  const valid: number[] = [];
  let rejected = 0;
  const rejectionReasons = new Map<
    NonNullable<CostGuardResult['reason']>,
    number
  >();

  for (const raw of costs) {
    const c = classify(raw);
    if (c.ok && c.cost !== null) {
      valid.push(c.cost);
    } else {
      rejected += 1;
      if (c.reason) {
        rejectionReasons.set(c.reason, (rejectionReasons.get(c.reason) ?? 0) + 1);
      }
    }
  }

  if (rejected > 0) {
    log.warn(
      {
        callSite: context.callSite,
        rejected,
        rejectionReasons: Object.fromEntries(rejectionReasons),
      },
      'cost integrity: aggregator filtered invalid cost samples',
    );
  }

  return { valid, rejected, rejectionReasons };
}

// ─── Prometheus telemetry (lazy + best-effort) ────────────────────────────

let metricEmitter: ((reason: string, ctx: CostGuardContext) => void) | null = null;

function emitViolationMetric(
  reason: NonNullable<CostGuardResult['reason']>,
  context: CostGuardContext,
): void {
  if (metricEmitter === null) {
    try {
      // Lazy import to avoid circular dep on ci-metrics.
      // ci-metrics may not be available in some test contexts.
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy require avoids the ci-metrics circular dependency
      const ciMetrics = require('@/observability/ci-metrics') as {
        costIntegrityViolationsTotal?: {
          inc: (labels: Record<string, string>) => void;
        };
      };
      if (ciMetrics?.costIntegrityViolationsTotal) {
        metricEmitter = (r, c) =>
          ciMetrics.costIntegrityViolationsTotal!.inc({
            reason: r,
            call_site: c.callSite,
            strategy: c.strategy ?? 'unknown',
          });
      } else {
        // Counter not registered yet — gracefully no-op.
        metricEmitter = () => {};
      }
    } catch {
      metricEmitter = () => {};
    }
  }
  metricEmitter(reason, context);
}

// ─── [USER_DECISION_REQUIRED] ─────────────────────────────────────────────

/**
 * Default policy when CI_COST_INTEGRITY_POLICY env var is not set.
 *
 * TODO: Pick ONE of the policies described in CostIntegrityPolicy above.
 *
 * Recommended: 'env-dependent' — strict-throw in tests/eval/dev (so bugs
 * surface immediately during benchmark runs), warn-and-null in production
 * (so live serving doesn't crash on a transient regression while still
 * emitting telemetry).
 *
 * Alternative recommendations by risk profile:
 *   - "We are pre-revenue, transparency is paramount"      → 'strict-throw'
 *   - "We have live customers, can't crash on regressions" → 'warn-and-null'
 *   - "We need full backward-compat with old fixtures"     → 'silent-zero'  (NOT recommended)
 *
 * @returns The default policy to apply when env var is unset.
 */
export function chooseCostIntegrityPolicy(): CostIntegrityPolicy {
  // ⬇⬇⬇ USER DECISION ⬇⬇⬇
  return 'env-dependent';
  // ⬆⬆⬆ USER DECISION ⬆⬆⬆
}
