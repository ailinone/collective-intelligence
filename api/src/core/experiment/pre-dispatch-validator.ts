// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pre-Dispatch Execution Validator
 *
 * Checks whether a strategy execution should proceed BEFORE making any
 * API calls. Prevents the 156 "requires at least N models" errors observed
 * in the C3 pilot by catching predictable failures early.
 *
 * When validation fails, the execution is recorded as SKIPPED (not ERROR),
 * and the experiment runner can:
 *   1. Try the degradation chain (if configured)
 *   2. Record the skip reason for analytics
 *   3. Move to the next arm without wasting time/budget
 *
 * This replaces the pattern where strategies throw hard on minModels,
 * consuming a slot in the experiment with an unhelpful error message.
 */

import { logger } from '@/utils/logger';
import { getProviderOperabilityHub } from '@/core/provider-operability-hub';

const log = logger.child({ component: 'pre-dispatch-validator' });

// ─── Types ──────────────────────────────────────────────────────────────

export type SkipReason =
  | 'pool_too_small'
  | 'budget_exceeded'
  | 'no_eligible_providers'
  | 'all_providers_no_credits'
  | 'all_providers_rate_limited'
  | 'strategy_disabled'
  | 'timeout_budget_exceeded'
  | 'pool_low_diversity'
  | 'cost_estimate_exceeds_arm_budget'
  | 'strategy_tier_blocked'
  | 'structural_failure';

export interface PreDispatchResult {
  canProceed: boolean;
  skipReason?: SkipReason;
  skipDetail?: string;
  eligibleModelCount: number;
  eligibleProviderCount: number;
  usableProviders: string[];
  noCreditsProviders: string[];
  estimatedCostUsd?: number;
}

export interface PreDispatchContext {
  strategyName: string;
  strategyMinModels: number;
  strategyTimeoutMs: number;
  taskType?: string;
  complexity?: string;
  remainingBudgetUsd?: number;
  estimatedCostPerExecUsd?: number;
  chatEligiblePoolSize: number;
  requiredCapabilities?: string[];
}

// ─── Validator ──────────────────────────────────────────────────────────

/**
 * Validate whether an execution should proceed.
 *
 * This is a FAST check (no I/O, no API calls) that uses cached state
 * from the ProviderOperabilityHub. Designed to be called for every
 * execution dispatch — must be <1ms.
 */
export function validatePreDispatch(ctx: PreDispatchContext): PreDispatchResult {
  const hub = getProviderOperabilityHub();
  const summary = hub.getSummary();

  // Count usable providers (healthy + recovering + degraded + unknown)
  const usableProviders = [
    ...summary.healthy,
    ...summary.recovering,
    ...summary.degraded,
    ...summary.unknown,
  ].filter(p => !hub.isSelfHostedProvider(p)); // exclude self-hosted from primary check

  const noCreditsProviders = summary.no_credits;

  // Check 1: Pool size vs strategy minimum
  if (ctx.chatEligiblePoolSize < ctx.strategyMinModels) {
    const detail = `Pool has ${ctx.chatEligiblePoolSize} chat-eligible models, strategy "${ctx.strategyName}" requires ${ctx.strategyMinModels}`;
    log.warn({ strategy: ctx.strategyName, poolSize: ctx.chatEligiblePoolSize, minModels: ctx.strategyMinModels }, detail);
    return {
      canProceed: false,
      skipReason: 'pool_too_small',
      skipDetail: detail,
      eligibleModelCount: ctx.chatEligiblePoolSize,
      eligibleProviderCount: usableProviders.length,
      usableProviders,
      noCreditsProviders,
    };
  }

  // Check 2: Any usable external providers?
  if (usableProviders.length === 0) {
    // Check if ALL are no-credits vs some other failure
    const allExternal = [...summary.healthy, ...summary.recovering, ...summary.degraded,
      ...summary.unknown, ...summary.no_credits, ...summary.rate_limited,
      ...summary.auth_failed, ...summary.temporarily_unavailable]
      .filter(p => !hub.isSelfHostedProvider(p));

    if (noCreditsProviders.length > 0 && noCreditsProviders.length >= allExternal.length * 0.8) {
      return {
        canProceed: false,
        skipReason: 'all_providers_no_credits',
        skipDetail: `${noCreditsProviders.length} providers have no credits, ${usableProviders.length} usable`,
        eligibleModelCount: ctx.chatEligiblePoolSize,
        eligibleProviderCount: 0,
        usableProviders: [],
        noCreditsProviders,
      };
    }

    return {
      canProceed: false,
      skipReason: 'no_eligible_providers',
      skipDetail: `No usable external providers found. Summary: ${JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.length])))}`,
      eligibleModelCount: ctx.chatEligiblePoolSize,
      eligibleProviderCount: 0,
      usableProviders: [],
      noCreditsProviders,
    };
  }

  // Check 3: Budget
  if (ctx.remainingBudgetUsd !== undefined && ctx.estimatedCostPerExecUsd !== undefined) {
    if (ctx.estimatedCostPerExecUsd > ctx.remainingBudgetUsd) {
      return {
        canProceed: false,
        skipReason: 'budget_exceeded',
        skipDetail: `Estimated cost $${ctx.estimatedCostPerExecUsd.toFixed(4)} exceeds remaining budget $${ctx.remainingBudgetUsd.toFixed(4)}`,
        eligibleModelCount: ctx.chatEligiblePoolSize,
        eligibleProviderCount: usableProviders.length,
        usableProviders,
        noCreditsProviders,
      };
    }
  }

  // All checks pass
  return {
    canProceed: true,
    eligibleModelCount: ctx.chatEligiblePoolSize,
    eligibleProviderCount: usableProviders.length,
    usableProviders,
    noCreditsProviders,
  };
}

/**
 * Enhanced validation using PoolResult from the PoolBuilder.
 * Provides richer diagnostics including stage-level drop reasons.
 */
export function validatePreDispatchWithPool(
  ctx: PreDispatchContext,
  poolResult: import('@/core/pool/pool-types').PoolResult,
): PreDispatchResult {
  // Delegate to base validator with pool size from PoolResult
  const baseResult = validatePreDispatch({
    ...ctx,
    chatEligiblePoolSize: poolResult.poolSize,
  });

  if (!baseResult.canProceed) {
    // Enrich with pool stage details
    const stageDetail = poolResult.stages
      .filter(s => s.outputCount < s.inputCount)
      .map(s => {
        const topReasons = Object.entries(s.droppedReasons)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .map(([reason, count]) => `${reason}(${count})`)
          .join(', ');
        return `${s.name}: -${s.inputCount - s.outputCount} [${topReasons}]`;
      })
      .join('; ');

    baseResult.skipDetail = `${baseResult.skipDetail ?? ''}. Pool stages: ${stageDetail}`;
    return baseResult;
  }

  // Additional checks available with PoolResult:

  // Diversity check: if all models come from one provider, flag it
  if (poolResult.providerDiversity <= 1 && poolResult.poolSize >= 2) {
    // Only warn, don't block — single-provider is better than nothing
    log.warn({
      strategy: ctx.strategyName,
      poolSize: poolResult.poolSize,
      providers: poolResult.providerDiversity,
    }, 'Pool has low provider diversity — all models from single provider');
  }

  return baseResult;
}

/**
 * Quick check: is the ecosystem in a state where ANY execution can proceed?
 * Used by the experiment runner to decide whether to pause the entire experiment.
 */
export function isEcosystemOperational(): { operational: boolean; reason?: string } {
  const hub = getProviderOperabilityHub();
  const summary = hub.getSummary();

  const usable = [...summary.healthy, ...summary.recovering, ...summary.degraded, ...summary.unknown]
    .filter(p => !hub.isSelfHostedProvider(p));

  if (usable.length === 0) {
    return {
      operational: false,
      reason: `No usable external providers. healthy=${summary.healthy.length}, no_credits=${summary.no_credits.length}, rate_limited=${summary.rate_limited.length}, auth_failed=${summary.auth_failed.length}`,
    };
  }

  return { operational: true };
}
