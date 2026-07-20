// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy Degradation Chain
 *
 * When a strategy cannot execute (pool too small, budget exceeded, etc.),
 * instead of failing hard, walk a degradation chain to find a simpler
 * strategy that CAN execute with the available resources.
 *
 * Design principles:
 * - Preserve the INTENT of the original strategy as much as possible
 * - Each step in the chain is strictly simpler (fewer models, fewer phases)
 * - Degradation only triggers on PRE-DISPATCH failures (not runtime errors)
 * - Every degradation is recorded with full traceability
 * - No strategy is removed — degradation is a runtime adaptation, not pruning
 *
 * Example: double-diamond (needs 3+ models) → research-synthesize (2+) → parallel (2) → single (1)
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'strategy-degradation' });

// ─── Types ──────────────────────────────────────────────────────────────

export interface DegradationResult {
  originalStrategy: string;
  executedStrategy: string;
  degradationPath: string[];       // chain of strategies tried
  degradationReason: string;       // why original couldn't run
  degradationDepth: number;        // 0 = no degradation, 1+ = degraded
  isDegraded: boolean;
}

export type DegradationTrigger = 'pre_dispatch' | 'runtime';

export type InfraFailureType =
  | 'timeout'
  | 'credit_exhaustion'
  | 'rate_limit'
  | 'provider_unavailable'
  | 'connection_error'
  | 'pool_contraction';

export interface RuntimeDegradationContext {
  trigger: 'runtime';
  failureType: InfraFailureType;
  error: Error;
  currentPoolSize: number;
  strategy: string;
}

// ─── Degradation Chains ─────────────────────────────────────────────────

/**
 * Degradation chains: strategy → [simpler alternatives, in order of preference].
 *
 * Each chain preserves the original strategy's intent:
 * - Multi-model debate → parallel execution → single model
 * - Multi-pass refinement → sequential → single
 * - Research + synthesize → parallel research → single
 *
 * The chain ENDS at 'single' which requires only 1 model.
 * If even 'single' can't run, the execution truly fails.
 */
const DEGRADATION_CHAINS: Record<string, string[]> = {
  // Complex multi-phase strategies (4+ phases)
  'double-diamond': ['research-synthesize', 'parallel', 'sequential', 'single'],
  'persona-exploration': ['collaborative', 'parallel', 'single'],

  // Debate/consensus family (need 3+ models for theoretical correctness)
  'consensus': ['blind-debate', 'parallel', 'single'],
  'blind-debate': ['parallel', 'single'],
  'debate': ['blind-debate', 'parallel', 'single'],
  'devil-advocate-consensus': ['blind-debate', 'parallel', 'single'],

  // Multi-model collaboration
  'war-room': ['collaborative', 'parallel', 'single'],
  'expert-panel': ['collaborative', 'parallel', 'single'],
  'collaborative': ['parallel', 'single'],
  'competitive': ['parallel', 'single'],
  'massive-parallel': ['parallel', 'single'],
  'diversity-ensemble': ['parallel', 'single'],

  // Sequential/cascade family
  'cost-cascade': ['sequential', 'single'],
  'quality-multipass': ['sequential', 'single'],
  'quality_multipass': ['sequential', 'single'],  // both naming variants
  'research-synthesize': ['parallel', 'sequential', 'single'],
  'clarification-first': ['sequential', 'single'],
  'critique-repair': ['sequential', 'single'],
  'multi-hop-qa': ['sequential', 'single'],
  'stigmergic-refinement': ['sequential', 'single'],

  // Exploration/learning
  'swarm-explore': ['massive-parallel', 'parallel', 'single'],
  'agentic': ['hybrid', 'sequential', 'single'],

  // Simple strategies (minimal or no degradation)
  'hybrid': ['parallel', 'single'],
  'parallel': ['single'],
  'sequential': ['single'],
  'hierarchical': ['sequential', 'single'],
  'reinforcement': ['single'],
  'contextual': ['single'],
  'adaptive': ['parallel', 'single'],
  'safety-quorum': ['parallel', 'single'],

  // Terminal
  'single': [],
};

// ─── Strategy minModels (from strategy metadata or code inspection) ─────

const STRATEGY_MIN_MODELS: Record<string, number> = {
  'single': 1,
  'sequential': 2,
  'parallel': 2,
  'hybrid': 2,
  'collaborative': 2,
  'competitive': 2,
  'cost-cascade': 2,
  'quality-multipass': 2,
  'quality_multipass': 2,
  'critique-repair': 2,
  'multi-hop-qa': 2,
  'clarification-first': 2,
  'reinforcement': 1,
  'contextual': 1,
  'adaptive': 1,
  'hierarchical': 2,
  'stigmergic-refinement': 2,
  'agentic': 1,
  'safety-quorum': 3,
  'consensus': 3,
  'blind-debate': 3,
  'debate': 3,
  'devil-advocate-consensus': 3,
  'expert-panel': 3,
  'war-room': 3,
  'massive-parallel': 3,
  'diversity-ensemble': 3,
  'double-diamond': 3,
  'persona-exploration': 3,
  'swarm-explore': 3,
  'research-synthesize': 2,
};

// ─── Resolver ───────────────────────────────────────────────────────────

/**
 * Resolve the best strategy that can actually run with the given pool size.
 *
 * @param requestedStrategy - The originally requested strategy name
 * @param availableModelCount - How many models are currently eligible
 * @param reason - Why degradation is being attempted
 * @returns DegradationResult with the strategy to actually execute
 */
export function resolveWithDegradation(
  requestedStrategy: string,
  availableModelCount: number,
  reason: string,
): DegradationResult {
  const normalizedName = requestedStrategy.toLowerCase();
  const minModels = getMinModels(normalizedName);

  // No degradation needed — original strategy can run
  if (availableModelCount >= minModels) {
    return {
      originalStrategy: requestedStrategy,
      executedStrategy: requestedStrategy,
      degradationPath: [],
      degradationReason: '',
      degradationDepth: 0,
      isDegraded: false,
    };
  }

  // Walk the degradation chain
  const chain = DEGRADATION_CHAINS[normalizedName] || [];
  const path: string[] = [normalizedName];

  for (const candidate of chain) {
    const candidateMin = getMinModels(candidate);
    path.push(candidate);

    if (availableModelCount >= candidateMin) {
      log.info({
        original: requestedStrategy,
        degradedTo: candidate,
        reason,
        availableModels: availableModelCount,
        originalMinModels: minModels,
        degradedMinModels: candidateMin,
        depth: path.length - 1,
      }, 'Strategy degraded to simpler variant');

      return {
        originalStrategy: requestedStrategy,
        executedStrategy: candidate,
        degradationPath: path,
        degradationReason: reason,
        degradationDepth: path.length - 1,
        isDegraded: true,
      };
    }
  }

  // Even 'single' can't run (0 models available)
  log.warn({
    original: requestedStrategy,
    reason,
    availableModels: availableModelCount,
    chainExhausted: path,
  }, 'Degradation chain exhausted — no strategy can run with 0 models');

  return {
    originalStrategy: requestedStrategy,
    executedStrategy: requestedStrategy, // keep original for error reporting
    degradationPath: path,
    degradationReason: `${reason} — degradation chain exhausted (0 eligible models)`,
    degradationDepth: path.length,
    isDegraded: false, // false because we didn't actually find a runnable degradation
  };
}

/**
 * Get the minimum models required for a strategy.
 */
export function getMinModels(strategy: string): number {
  return STRATEGY_MIN_MODELS[strategy.toLowerCase()] ?? 2; // default: 2 for unknown strategies
}

/**
 * Get the degradation chain for a strategy.
 */
export function getDegradationChain(strategy: string): string[] {
  return DEGRADATION_CHAINS[strategy.toLowerCase()] || [];
}

/**
 * Check if a strategy name has a known degradation chain.
 */
export function hasDegradationChain(strategy: string): boolean {
  const chain = DEGRADATION_CHAINS[strategy.toLowerCase()];
  return !!chain && chain.length > 0;
}

// ─── Runtime Degradation ────────────────────────────────────────────────

/**
 * Classify whether an error is an infrastructure failure (eligible for
 * runtime degradation) or a code/logic bug (must bubble up as-is).
 *
 * ONLY infra failures trigger runtime degradation. Bugs must remain visible
 * so they can be fixed — masking them with degradation would hide real issues.
 *
 * Infrastructure failures:
 *   - timeout, ECONNRESET, ECONNREFUSED
 *   - 402 (credit), 429 (rate limit), 503 (unavailable)
 *   - Pool contraction (provider went down mid-execution)
 *
 * NOT infrastructure (bugs that must NOT be degraded):
 *   - TypeError, ReferenceError, SyntaxError
 *   - Assertion failures
 *   - JSON parse errors from strategy logic
 *   - Validation errors from strategy code
 */
export function isInfraFailure(error: unknown): { isInfra: boolean; failureType: InfraFailureType | null } {
  // Code bugs — never degrade
  if (error instanceof TypeError) return { isInfra: false, failureType: null };
  if (error instanceof ReferenceError) return { isInfra: false, failureType: null };
  if (error instanceof SyntaxError) return { isInfra: false, failureType: null };
  if (error instanceof RangeError) return { isInfra: false, failureType: null };

  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  // Timeout
  if (msg.includes('timeout') || msg.includes('aborted') || msg.includes('etimedout') || msg.includes('deadline')) {
    return { isInfra: true, failureType: 'timeout' };
  }

  // Connection errors
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('epipe') ||
      msg.includes('enotfound') || msg.includes('fetch failed') || msg.includes('network error')) {
    return { isInfra: true, failureType: 'connection_error' };
  }

  // Credit/balance
  if (msg.includes('insufficient') || msg.includes('402') || msg.includes('quota') ||
      msg.includes('credit') || msg.includes('balance') || msg.includes('funds')) {
    return { isInfra: true, failureType: 'credit_exhaustion' };
  }

  // Rate limiting
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit') ||
      msg.includes('too many requests')) {
    return { isInfra: true, failureType: 'rate_limit' };
  }

  // Service unavailable
  if (msg.includes('503') || msg.includes('502') || msg.includes('service unavailable') ||
      msg.includes('bad gateway') || msg.includes('server error')) {
    return { isInfra: true, failureType: 'provider_unavailable' };
  }

  // Pool contraction
  if (msg.includes('pool') || msg.includes('no eligible') || msg.includes('no models') ||
      msg.includes('requires at least')) {
    return { isInfra: true, failureType: 'pool_contraction' };
  }

  // Unknown — don't degrade (conservative)
  return { isInfra: false, failureType: null };
}

/**
 * Resolve a runtime degradation when a strategy fails mid-execution
 * due to an infrastructure issue.
 *
 * Unlike pre-dispatch degradation (which checks pool size), runtime
 * degradation handles failures that happen DURING strategy execution:
 *   - Provider timeout during a debate round
 *   - Credit exhaustion during war-room specialist phase
 *   - Rate limiting during consensus voting
 *
 * Returns a DegradationResult. The caller should:
 *   1. Instantiate the degraded strategy
 *   2. Execute it with the same request and remaining context
 *   3. Record the degradation trace in metadata
 */
export function resolveRuntimeDegradation(
  ctx: RuntimeDegradationContext,
): DegradationResult {
  const reason = `runtime_${ctx.failureType}: ${ctx.error.message.substring(0, 200)}`;

  log.warn({
    strategy: ctx.strategy,
    failureType: ctx.failureType,
    currentPoolSize: ctx.currentPoolSize,
    error: ctx.error.message.substring(0, 200),
  }, 'Attempting runtime degradation');

  return resolveWithDegradation(ctx.strategy, ctx.currentPoolSize, reason);
}
