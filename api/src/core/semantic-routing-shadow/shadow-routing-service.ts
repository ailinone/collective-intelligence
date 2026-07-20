// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-service.ts — MVP 8C.0
 *
 * Orchestrator that combines: config → sampling → timeout → error
 * isolation → Pareto-compute (injectable) → redaction → logger →
 * metrics. The actual Pareto computation is INJECTED via the
 * `paretoComputer` dep — in MVP 8C.0 the default is a stub that
 * returns `skippedReason='pareto_compute_not_yet_wired'`. Future
 * MVPs swap in the real computer.
 *
 * Invariants:
 *   - Flag default OFF — when disabled, `run()` returns immediately.
 *   - Sample rate default 0 — when 0, `run()` returns immediately.
 *   - Decision mode is ALWAYS `legacy` for this MVP; if config says
 *     anything else, the service refuses to run (logs once, returns
 *     skip).
 *   - The service NEVER throws. Errors are captured and surfaced as
 *     `skippedReason='shadow_error'`.
 *   - The service NEVER blocks beyond `maxLatencyMs`. Overruns return
 *     `skippedReason='shadow_timeout'`.
 *   - All log payloads run through `redactPayload`.
 */

import { performance } from 'node:perf_hooks';
import {
  DEFAULT_SHADOW_CONFIG,
  type ShadowRoutingConfig,
} from './shadow-routing-config';
import {
  noopShadowLogger,
  SHADOW_DECISION_EVENT,
  type ShadowRoutingLogger,
} from './shadow-routing-logger';
import {
  noopShadowMetrics,
  SHADOW_METRIC_NAMES,
  type ShadowRoutingMetrics,
} from './shadow-routing-metrics';
import { hashIdentifier, redactPayload } from './shadow-routing-redaction';
import { shouldSample } from './shadow-routing-sampling';
import type {
  ShadowParetoPlanSummary,
  ShadowRoutingInput,
  ShadowRoutingResult,
  ShadowRoutingService,
  ShadowSkipReason,
  ShadowTaskProfileSummary,
} from './shadow-routing-types';

// ─── Pareto computer contract ──────────────────────────────────────────

export interface ShadowParetoComputeResult {
  readonly taskProfile?: ShadowTaskProfileSummary;
  readonly paretoPlan?: ShadowParetoPlanSummary;
  /** When set, the computer asked to be skipped (e.g. taskType not supported). */
  readonly skippedReason?: ShadowSkipReason;
}

export interface ShadowParetoComputer {
  compute(
    input: ShadowRoutingInput,
    signal: { aborted: boolean },
  ): Promise<ShadowParetoComputeResult>;
}

/**
 * Default Pareto computer used in MVP 8C.0 — explicitly NOT yet wired
 * to the offline Pareto pipeline. Returns a deterministic stub so the
 * integration shape is exercised end-to-end without running any real
 * compute. Future MVPs replace this with the actual optimizer.
 */
export const DEFERRED_PARETO_COMPUTER: ShadowParetoComputer = Object.freeze({
  async compute(): Promise<ShadowParetoComputeResult> {
    return Object.freeze({
      skippedReason: 'pareto_compute_not_yet_wired',
    });
  },
});

// ─── Service options ───────────────────────────────────────────────────

export interface ShadowRoutingServiceOptions {
  readonly config?: ShadowRoutingConfig;
  readonly logger?: ShadowRoutingLogger;
  readonly metrics?: ShadowRoutingMetrics;
  readonly paretoComputer?: ShadowParetoComputer;
  /** Injected clock — defaults to `performance.now()`. */
  readonly now?: () => number;
}

// ─── Service implementation ────────────────────────────────────────────

export class DefaultShadowRoutingService implements ShadowRoutingService {
  private readonly config: ShadowRoutingConfig;
  private readonly logger: ShadowRoutingLogger;
  private readonly metrics: ShadowRoutingMetrics;
  private readonly paretoComputer: ShadowParetoComputer;
  private readonly now: () => number;

  constructor(options: ShadowRoutingServiceOptions = {}) {
    this.config = options.config ?? DEFAULT_SHADOW_CONFIG;
    this.logger = options.logger ?? noopShadowLogger;
    this.metrics = options.metrics ?? noopShadowMetrics;
    this.paretoComputer = options.paretoComputer ?? DEFERRED_PARETO_COMPUTER;
    this.now = options.now ?? (() => performance.now());
  }

  isEnabled(): boolean {
    return (
      this.config.enabled === true &&
      this.config.decisionMode === 'legacy' &&
      this.config.sampleRate > 0
    );
  }

  async run(input: ShadowRoutingInput): Promise<ShadowRoutingResult> {
    const t0 = this.now();
    this.metrics.increment(SHADOW_METRIC_NAMES.REQUESTS_TOTAL);

    // 1. Flag gates.
    if (!this.config.enabled) {
      return this.skip('flag_disabled', t0);
    }
    if (this.config.decisionMode !== 'legacy') {
      // Defensive — we never want decision mode != legacy in 8C.0.
      return this.skip('invalid_input', t0);
    }
    if (this.config.sampleRate <= 0) {
      return this.skip('sample_rate_zero', t0);
    }
    if (!shouldSample(input.requestId, this.config.sampleRate)) {
      return this.skip('sample_skipped', t0);
    }

    // 2. Task type gate.
    const taskTypeHint =
      input.profilerInput.taskTypeHint ?? input.routeContext.actualStrategy ?? '';
    if (
      this.config.taskTypes.length > 0 &&
      taskTypeHint.length > 0 &&
      !this.taskTypeAllowed(taskTypeHint)
    ) {
      return this.skip('task_type_not_approved', t0, taskTypeHint);
    }

    // 3. Compute Pareto (with timeout + error isolation).
    try {
      const result = await this.runWithinTimeout(input);
      const latency = this.elapsed(t0);
      const diff = buildDiff(result.paretoPlan, input);
      const payload: ShadowRoutingResult = Object.freeze({
        executed: true,
        latencyMs: latency,
        taskProfile: result.taskProfile,
        paretoPlan: result.paretoPlan,
        diff,
        skippedReason: result.skippedReason,
      });
      this.metrics.observe(SHADOW_METRIC_NAMES.LATENCY_MS, latency);
      if (result.skippedReason) {
        this.metrics.increment(SHADOW_METRIC_NAMES.SKIPPED_TOTAL, {
          reason: result.skippedReason,
        });
      } else {
        this.metrics.increment(SHADOW_METRIC_NAMES.EXECUTED_TOTAL);
      }
      this.emitLog(input, payload);
      return payload;
    } catch (err) {
      const isTimeout = err instanceof ShadowTimeoutError;
      const reason: ShadowSkipReason = isTimeout ? 'shadow_timeout' : 'shadow_error';
      if (isTimeout) this.metrics.increment(SHADOW_METRIC_NAMES.TIMEOUT_TOTAL);
      else this.metrics.increment(SHADOW_METRIC_NAMES.ERROR_TOTAL);
      const skip = this.skip(reason, t0);
      this.emitLog(input, skip);
      return skip;
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private skip(
    reason: ShadowSkipReason,
    t0: number,
    taskTypeForLog?: string,
  ): ShadowRoutingResult {
    const latency = this.elapsed(t0);
    this.metrics.observe(SHADOW_METRIC_NAMES.LATENCY_MS, latency, {
      outcome: 'skipped',
    });
    this.metrics.increment(SHADOW_METRIC_NAMES.SKIPPED_TOTAL, { reason });
    const result: ShadowRoutingResult = Object.freeze({
      executed: false,
      skippedReason: reason,
      latencyMs: latency,
      taskProfile: taskTypeForLog
        ? Object.freeze({ taskType: taskTypeForLog })
        : undefined,
    });
    return result;
  }

  private taskTypeAllowed(taskType: string): boolean {
    for (const allowed of this.config.taskTypes) {
      if (allowed === taskType) return true;
    }
    return false;
  }

  private async runWithinTimeout(
    input: ShadowRoutingInput,
  ): Promise<ShadowParetoComputeResult> {
    const budget = this.config.maxLatencyMs;
    const signal = { aborted: false };
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = globalThis.setTimeout(() => {
        signal.aborted = true;
        reject(new ShadowTimeoutError(budget));
      }, budget);
    });
    try {
      const compute = this.paretoComputer.compute(input, signal);
      return await Promise.race([compute, timeoutPromise]);
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  }

  private elapsed(t0: number): number {
    return Math.max(0, this.now() - t0);
  }

  private emitLog(input: ShadowRoutingInput, result: ShadowRoutingResult): void {
    if (this.config.writeMode === 'metrics_only') return;
    if (this.config.logLevel === 'off') return;
    const rawPayload: Record<string, unknown> = {
      requestId: input.requestId,
      timestamp: input.metadata?.timestamp,
      source: input.metadata?.source ?? 'unknown',
      shadowExecuted: result.executed,
      skippedReason: result.skippedReason,
      latencyMs: result.latencyMs,
      taskType: result.taskProfile?.taskType,
      complexity: result.taskProfile?.complexity,
      riskLevel: result.taskProfile?.riskLevel,
      privacyMode: result.taskProfile?.privacyMode,
      actualModelHash: hashIdentifier(input.routeContext.actualModel),
      actualProviderHash: hashIdentifier(input.routeContext.actualProvider),
      actualStrategy: input.routeContext.actualStrategy,
      paretoStrategy: result.paretoPlan?.strategy,
      paretoSelectedRouteIdsHash: hashIdsArray(result.paretoPlan?.selectedRouteIds),
      paretoSelectedModelIdsHash: hashIdsArray(result.paretoPlan?.selectedModelIds),
      paretoStatus: result.paretoPlan?.paretoStatus,
      expectedJudge: result.paretoPlan?.expectedJudge,
      expectedCostUsd: result.paretoPlan?.expectedCostUsd,
      peerLift: result.paretoPlan?.peerLift,
      fallbackReason: result.paretoPlan?.fallbackReason,
      sameModelAsActual: result.diff?.sameModelAsActual,
      sameProviderAsActual: result.diff?.sameProviderAsActual,
      sameStrategyAsActual: result.diff?.sameStrategyAsActual,
      estimatedCostDeltaUsd: result.diff?.estimatedCostDeltaUsd,
    };
    // Redaction is mandatory — even though we built the payload safely,
    // any nested user-supplied field gets scrubbed here.
    const safe = redactPayload(rawPayload) as Record<string, unknown>;
    this.logger.log(SHADOW_DECISION_EVENT, safe);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

class ShadowTimeoutError extends Error {
  constructor(budgetMs: number) {
    super(`shadow_routing_timeout:${budgetMs}ms`);
    this.name = 'ShadowTimeoutError';
  }
}

function hashIdsArray(ids: readonly string[] | undefined): string | undefined {
  if (!ids || ids.length === 0) return undefined;
  // Concat all ids and hash once — gives a stable signature for the
  // full ensemble, not the individual ids.
  return hashIdentifier(ids.slice().sort().join('|'));
}

function buildDiff(
  pareto: ShadowParetoPlanSummary | undefined,
  input: ShadowRoutingInput,
): ShadowRoutingResult['diff'] {
  if (!pareto) return undefined;
  const actualModel = input.routeContext.actualModel;
  const actualProvider = input.routeContext.actualProvider;
  const actualStrategy = input.routeContext.actualStrategy;
  return Object.freeze({
    sameModelAsActual: actualModel
      ? pareto.selectedModelIds.length === 1 &&
        pareto.selectedModelIds[0] === actualModel
      : undefined,
    sameProviderAsActual: actualProvider ? undefined : undefined,
    sameStrategyAsActual: actualStrategy
      ? pareto.strategy === actualStrategy
      : undefined,
    estimatedCostDeltaUsd: undefined,
  });
}

// ─── Factory ────────────────────────────────────────────────────────────

export function createShadowRoutingService(
  options: ShadowRoutingServiceOptions = {},
): ShadowRoutingService {
  return new DefaultShadowRoutingService(options);
}
