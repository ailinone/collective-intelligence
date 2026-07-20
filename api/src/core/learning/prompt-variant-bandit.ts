// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Prompt Variant Bandit — LinUCB contextual selection over prompt catalog variants.
 *
 * Reuses the same LinUCB algorithm and feature encoding as the Contextual Provider
 * Bandit (L10), but the arm key is `${promptKey}|${variantId}` instead of
 * `${equivalenceGroup}|${providerId}`. The reward signal is the execution
 * `qualityScore` from the feedback collector.
 *
 * This lets the system LEARN which prompt variant works best for which
 * (taskType, complexity, promptLength) context — rather than always using the
 * canonical prompt or randomly picking. After ~200 observations per arm, LinUCB
 * converges to the best variant for each context. Below 50 observations, arms
 * use uniform random selection (uninformative exploration).
 *
 * Feature flag: `ENABLE_PROMPT_VARIANT_BANDIT=true` (default false).
 */

import { logger } from '@/utils/logger';
import { incrementPromptMetric } from '@/core/orchestration/prompts/prompt-metrics';
import type { PromptVariant } from '@/core/orchestration/prompts/sota-system-prompts';

const log = logger.child({ component: 'prompt-variant-bandit' });

// ─── Config ─────────────────────────────────────────────────────────────

const MIN_OBSERVATIONS = 50;
const ALPHA_UCB = 1.0;
const FEATURE_DIM = 12;

// ─── Types ──────────────────────────────────────────────────────────────

export interface VariantBanditContext {
  taskType: string;
  complexity: string;
  promptLength: 'short' | 'medium' | 'long';
}

interface LinUCBArm {
  A: number[][];
  b: number[];
  observations: number;
}

export interface VariantSelectionResult {
  variant: PromptVariant;
  sampledScore: number;
  decisionReason: string;
}

// ─── Feature Encoding (shared with contextual-provider-bandit) ──────────

const TASK_TYPES = ['coding', 'analysis', 'creative', 'debugging', 'general', 'other'];
const COMPLEXITIES = ['low', 'medium', 'high'];
const PROMPT_LENGTHS: readonly string[] = ['short', 'medium', 'long'];

function encodeContext(ctx: VariantBanditContext): number[] {
  const features = new Array<number>(FEATURE_DIM).fill(0);
  const taskIdx = TASK_TYPES.indexOf(ctx.taskType);
  features[taskIdx >= 0 && taskIdx < 6 ? taskIdx : 5] = 1;
  const compIdx = COMPLEXITIES.indexOf(ctx.complexity);
  if (compIdx >= 0) features[6 + compIdx] = 1;
  const lenIdx = PROMPT_LENGTHS.indexOf(ctx.promptLength);
  if (lenIdx >= 0) features[9 + lenIdx] = 1;
  return features;
}

// ─── Matrix Operations ─────────────────────────────────────────────────

function identityMatrix(d: number): number[][] {
  return Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => (i === j ? 1 : 0)),
  );
}

function addOuterProduct(A: number[][], x: number[]): void {
  for (let i = 0; i < x.length; i++)
    for (let j = 0; j < x.length; j++)
      A[i][j] += x[i] * x[j];
}

function addScaledVector(b: number[], x: number[], scalar: number): void {
  for (let i = 0; i < x.length; i++) b[i] += scalar * x[i];
}

function solveLinear(A: number[][], b: number[]): number[] {
  const d = b.length;
  const aug = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < d; col++) {
    let maxRow = col;
    for (let row = col + 1; row < d; row++)
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-10) continue;
    for (let row = col + 1; row < d; row++) {
      const factor = aug[row][col] / pivot;
      for (let j = col; j <= d; j++) aug[row][j] -= factor * aug[col][j];
    }
  }
  const theta = new Array<number>(d).fill(0);
  for (let row = d - 1; row >= 0; row--) {
    let sum = aug[row][d];
    for (let col = row + 1; col < d; col++) sum -= aug[row][col] * theta[col];
    theta[row] = Math.abs(aug[row][row]) > 1e-10 ? sum / aug[row][row] : 0;
  }
  return theta;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: PromptVariantBandit | null = null;

export function getPromptVariantBandit(): PromptVariantBandit {
  if (!instance) {
    instance = new PromptVariantBandit();
    // F3-BANDIT: trigger async Redis load on first access. Non-blocking —
    // the bandit is usable immediately (cold start = random exploration).
    // Redis state overwrites in-memory arms as it loads.
    instance.loadFromRedis().catch(() => {
      // Already logged inside loadFromRedis
    });
  }
  return instance;
}

/** Check whether the feature flag is enabled. */
export function isPromptVariantBanditEnabled(): boolean {
  return process.env.ENABLE_PROMPT_VARIANT_BANDIT === 'true';
}

// ─── Service ────────────────────────────────────────────────────────────

export class PromptVariantBandit {
  private arms = new Map<string, LinUCBArm>();

  /**
   * Select the best prompt variant for the given context.
   * Returns null if no variants are registered or the feature flag is off.
   */
  selectVariant(
    promptKey: string,
    variants: PromptVariant[],
    context: VariantBanditContext,
  ): VariantSelectionResult | null {
    if (!variants.length) return null;

    const x = encodeContext(context);

    const scored = variants.map((variant) => {
      // F3-VERSION: include contentHash in arm key so editing a variant's
      // text automatically resets its learning history.
      const hashSuffix = variant.contentHash ? `|${variant.contentHash}` : '';
      const key = `${promptKey}|${variant.id}${hashSuffix}`;
      const arm = this.arms.get(key) ?? this.createArm();

      if (arm.observations < MIN_OBSERVATIONS) {
        // Uniform random exploration during cold start
        return { variant, sampledScore: Math.random(), reason: 'exploration' };
      }

      const theta = solveLinear(arm.A, arm.b);
      const predicted = dot(theta, x);
      const confidence = ALPHA_UCB / Math.sqrt(arm.observations);
      const ucb = predicted + confidence;

      return {
        variant,
        sampledScore: Math.max(0, Math.min(1, ucb)),
        reason: `LinUCB (pred=${predicted.toFixed(3)}, obs=${arm.observations})`,
      };
    });

    scored.sort((a, b) => b.sampledScore - a.sampledScore);
    const winner = scored[0];

    log.debug(
      {
        promptKey,
        selected: winner.variant.id,
        score: winner.sampledScore.toFixed(3),
        candidates: scored.length,
        context: `${context.taskType}/${context.complexity}`,
      },
      'Prompt variant selected',
    );

    incrementPromptMetric('ailin_prompt_variant_selected_total', {
      promptKey,
      variantId: winner.variant.id,
      reason: winner.reason,
    });

    return {
      variant: winner.variant,
      sampledScore: winner.sampledScore,
      decisionReason: `PromptVariantBandit: ${winner.reason}`,
    };
  }

  /**
   * Update arm with observed reward (qualityScore from execution feedback).
   */
  update(params: {
    promptKey: string;
    variantId: string;
    contentHash?: string;
    context: VariantBanditContext;
    reward: number;
  }): void {
    // F3-VERSION: arm key includes contentHash when available.
    const hashSuffix = params.contentHash ? `|${params.contentHash}` : '';
    const key = `${params.promptKey}|${params.variantId}${hashSuffix}`;
    const arm = this.arms.get(key) ?? this.createArm();

    const x = encodeContext(params.context);
    addOuterProduct(arm.A, x);
    addScaledVector(arm.b, x, params.reward);
    arm.observations++;

    this.arms.set(key, arm);

    // F3-BANDIT: async persist after update (fire-and-forget, non-blocking).
    this.persistArmAsync(key, arm);
  }

  getStats(): { totalArms: number; armsWithLinUCB: number } {
    let withLinUCB = 0;
    for (const arm of this.arms.values()) {
      if (arm.observations >= MIN_OBSERVATIONS) withLinUCB++;
    }
    return { totalArms: this.arms.size, armsWithLinUCB: withLinUCB };
  }

  // ── F3-BANDIT: Redis persistence ─────────────────────────────────────

  private static readonly REDIS_KEY_PREFIX = 'ailin:prompt-variant-bandit:';

  /**
   * Load all arm state from Redis on init. Graceful: if Redis is
   * unavailable, the bandit starts cold (uniform random exploration) and
   * logs the fallback.
   */
  async loadFromRedis(): Promise<void> {
    try {
      const { getRedisClient } = await import('@/cache/redis-client');
      const redis = getRedisClient();
      if (!redis) {
        incrementPromptMetric('ailin_prompt_variant_bandit_persistence_total', { event: 'redis-unavailable' });
        log.warn('Prompt variant bandit: Redis unavailable — starting with empty state');
        return;
      }

      const keys = await redis.keys(`${PromptVariantBandit.REDIS_KEY_PREFIX}*`);
      let loaded = 0;
      for (const redisKey of keys) {
        try {
          const raw = await redis.get(redisKey);
          if (!raw) continue;
          const arm = JSON.parse(raw) as LinUCBArm;
          // Validate shape minimally
          if (Array.isArray(arm.A) && Array.isArray(arm.b) && typeof arm.observations === 'number') {
            const armKey = redisKey.slice(PromptVariantBandit.REDIS_KEY_PREFIX.length);
            this.arms.set(armKey, arm);
            loaded++;
          }
        } catch {
          // Individual arm parse failure — skip, don't crash
        }
      }
      incrementPromptMetric('ailin_prompt_variant_bandit_persistence_total', {
        event: 'loaded',
        count: loaded,
      });
      log.info({ loaded, totalKeys: keys.length }, 'Prompt variant bandit: loaded arm state from Redis');
    } catch (err) {
      incrementPromptMetric('ailin_prompt_variant_bandit_persistence_total', { event: 'load-failed' });
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Prompt variant bandit: Redis load failed — starting cold',
      );
    }
  }

  /**
   * Persist one arm to Redis (fire-and-forget). Failures are logged but
   * never block the update path.
   */
  private persistArmAsync(armKey: string, arm: LinUCBArm): void {
    // Only persist if the feature is on AND Redis is likely available.
    if (!isPromptVariantBanditEnabled()) return;

    (async () => {
      try {
        const { getRedisClient } = await import('@/cache/redis-client');
        const redis = getRedisClient();
        if (!redis) return;
        const redisKey = `${PromptVariantBandit.REDIS_KEY_PREFIX}${armKey}`;
        // TTL 30 days — arms not updated in a month are stale.
        await redis.set(redisKey, JSON.stringify(arm), 'EX', 30 * 24 * 60 * 60);
      } catch {
        // Non-critical: next update will retry.
      }
    })().catch(() => {});
  }

  private createArm(): LinUCBArm {
    return {
      A: identityMatrix(FEATURE_DIM),
      b: new Array<number>(FEATURE_DIM).fill(0),
      observations: 0,
    };
  }
}
