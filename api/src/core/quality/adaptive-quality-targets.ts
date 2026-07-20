// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Adaptive Quality Targets (OI-08)
 *
 * Dynamically adjusts quality targets based on historical performance data
 * per (taskType, complexity) niche instead of using a static 0.85 default.
 *
 * Background:
 * - Static quality targets cause two problems:
 *   1. Over-provisioning: easy tasks get the same 0.85 target as hard ones,
 *      wasting compute on strategies/retries that aren't needed
 *   2. Under-provisioning: hard tasks with 0.85 target produce mediocre results
 *      when they actually need 0.92+ with multi-model strategies
 * - Compute-allocation principle: allocate compute proportional to difficulty —
 *   this module determines what "difficulty" means empirically
 *
 * Data sources:
 * - Benchmark results (high confidence — controlled environment)
 * - Production learning data (high volume — real-world distribution)
 * - Configuration archive (which strategies achieve what quality per niche)
 *
 * Integration:
 * - Called from orchestration-engine during context building
 * - Replaces hardcoded `context.qualityTarget ?? 0.85`
 */

import { prisma } from '@/database/client';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'adaptive-quality-targets' });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QualityTargetRecommendation {
  target: number;                     // 0.6-0.98
  confidence: number;                 // 0-1, how confident we are in this target
  source: 'learned' | 'heuristic' | 'default';
  reasoning: string;
  historicalAvg: number | null;       // What quality is typically achieved
  historicalP90: number | null;       // 90th percentile achievable quality
  suggestedMinIterations: number;     // How many feedback iterations to allow
}

interface NicheProfile {
  taskType: string;
  complexity: string;
  avgQuality: number;
  p90Quality: number;
  avgSuccessRate: number;
  sampleCount: number;
  bestStrategy: string | null;
  bestStrategyQuality: number;
  lastUpdated: number;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  // Minimum samples to trust a niche profile
  minSamplesForLearned: 15,
  // Cache TTL for niche profiles (5 minutes)
  cacheTtlMs: 300_000,
  // Default target when no data exists
  defaultTarget: 0.85,
  // Floor and ceiling for adaptive targets
  minTarget: 0.65,
  maxTarget: 0.96,
  // Quality headroom: how much above historical average to set the target
  headroomFactor: 0.08,
  // Confidence multiplier for feedback iteration recommendation
  iterationThresholds: {
    easy: 1,    // Single pass usually sufficient
    medium: 1,  // One pass, confidence gate may trigger refinement
    hard: 2,    // Allow 2 iterations
    veryHard: 3, // Full feedback loop
  } as Record<string, number>,
};

// ─── Cache ──────────────────────────────────────────────────────────────────

const profileCache = new Map<string, { profile: NicheProfile; expiresAt: number }>();

function cacheKey(taskType: string, complexity: string): string {
  return `${taskType}|${complexity}`;
}

// ─── Implementation ─────────────────────────────────────────────────────────

/**
 * Get an adaptive quality target for a given (taskType, complexity) niche.
 *
 * Priority:
 * 1. Learned from production data (strategy_weights + learning_data)
 * 2. Heuristic based on complexity level
 * 3. Default (0.85)
 */
export async function getAdaptiveQualityTarget(
  taskType: string,
  complexity: string,
  userExplicitTarget?: number,
): Promise<QualityTargetRecommendation> {
  // If user explicitly set a target, respect it (but still return metadata)
  if (userExplicitTarget !== undefined) {
    return {
      target: Math.max(CONFIG.minTarget, Math.min(CONFIG.maxTarget, userExplicitTarget)),
      confidence: 1.0,
      source: 'default',
      reasoning: 'User-specified quality target',
      historicalAvg: null,
      historicalP90: null,
      suggestedMinIterations: userExplicitTarget >= 0.92 ? 2 : 1,
    };
  }

  // Try cached profile first
  const key = cacheKey(taskType, complexity);
  const cached = profileCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return profileToRecommendation(cached.profile);
  }

  // Try loading from DB
  try {
    const profile = await loadNicheProfile(taskType, complexity);
    if (profile && profile.sampleCount >= CONFIG.minSamplesForLearned) {
      profileCache.set(key, { profile, expiresAt: Date.now() + CONFIG.cacheTtlMs });
      return profileToRecommendation(profile);
    }
  } catch (err) {
    log.warn({ error: String(err), taskType, complexity },
      'Failed to load niche profile for adaptive quality target');
  }

  // Heuristic fallback
  return heuristicTarget(taskType, complexity);
}

/**
 * Convert a niche profile to a quality target recommendation.
 */
function profileToRecommendation(profile: NicheProfile): QualityTargetRecommendation {
  // Target = historical P90 + headroom, clamped to [min, max]
  // This means: "aim for what the best runs achieved, plus a bit more"
  const rawTarget = profile.p90Quality + CONFIG.headroomFactor;
  const target = Math.max(CONFIG.minTarget, Math.min(CONFIG.maxTarget, rawTarget));

  // Confidence based on sample count (saturates at ~100 samples)
  const confidence = Math.min(1.0, profile.sampleCount / 100);

  // Determine difficulty tier for iteration recommendation
  const difficultyTier = inferDifficultyTier(profile);

  return {
    target,
    confidence,
    source: 'learned',
    reasoning: `Based on ${profile.sampleCount} observations: avg quality ${profile.avgQuality.toFixed(3)}, ` +
      `P90 ${profile.p90Quality.toFixed(3)}, best strategy "${profile.bestStrategy}" at ${profile.bestStrategyQuality.toFixed(3)}`,
    historicalAvg: profile.avgQuality,
    historicalP90: profile.p90Quality,
    suggestedMinIterations: CONFIG.iterationThresholds[difficultyTier] ?? 1,
  };
}

/**
 * Infer a difficulty tier from the niche profile.
 * Lower historical quality + lower success rate = harder task.
 */
function inferDifficultyTier(profile: NicheProfile): string {
  const qualityDifficulty = 1 - profile.avgQuality; // Higher = harder
  const successDifficulty = 1 - profile.avgSuccessRate;
  const combined = qualityDifficulty * 0.6 + successDifficulty * 0.4;

  if (combined < 0.15) return 'easy';
  if (combined < 0.30) return 'medium';
  if (combined < 0.50) return 'hard';
  return 'veryHard';
}

/**
 * Heuristic quality target when no historical data is available.
 */
function heuristicTarget(taskType: string, complexity: string): QualityTargetRecommendation {
  // Base targets by complexity
  const complexityTargets: Record<string, number> = {
    'low': 0.80,
    'simple': 0.80,
    'medium': 0.85,
    'moderate': 0.85,
    'high': 0.90,
    'complex': 0.90,
  };

  // Task type adjustments — some tasks inherently need higher quality
  const taskTypeBonus: Record<string, number> = {
    'code-generation': 0.02,     // Code needs correctness
    'code-review': 0.03,         // Security-critical
    'debugging': 0.02,           // Must find actual bug
    'analysis': 0.0,             // Flexible
    'documentation': -0.02,      // Lower bar acceptable
    'testing': 0.01,             // Tests need correctness
    'refactoring': 0.02,         // Must preserve behavior
    'qa': 0.0,                   // Standard
    'general': 0.0,              // Default
  };

  const baseTarget = complexityTargets[complexity] ?? 0.85;
  const bonus = taskTypeBonus[taskType] ?? 0;
  const target = Math.max(CONFIG.minTarget, Math.min(CONFIG.maxTarget, baseTarget + bonus));

  const iterations = complexity === 'high' || complexity === 'complex' ? 2 : 1;

  return {
    target,
    confidence: 0.4,
    source: 'heuristic',
    reasoning: `No historical data — using heuristic for ${taskType}/${complexity}`,
    historicalAvg: null,
    historicalP90: null,
    suggestedMinIterations: iterations,
  };
}

/**
 * Load niche profile from DB by aggregating strategy_weights + learning_data.
 */
async function loadNicheProfile(
  taskType: string,
  complexity: string,
): Promise<NicheProfile | null> {
  // Get strategy weights for this niche
  const weights = await prisma.strategyWeight.findMany({
    where: { taskType, complexity, sampleCount: { gte: 3 } },
    orderBy: { avgQuality: 'desc' },
  });

  if (weights.length === 0) return null;

  // Compute aggregate metrics
  let totalQuality = 0;
  let totalSuccess = 0;
  let totalSamples = 0;
  const qualityScores: number[] = [];

  for (const w of weights) {
    const q = Number(w.avgQuality);
    const s = Number(w.successRate);
    const n = w.sampleCount;
    totalQuality += q * n;
    totalSuccess += s * n;
    totalSamples += n;
    // Store per-strategy quality for P90 estimation
    qualityScores.push(q);
  }

  const avgQuality = totalSamples > 0 ? totalQuality / totalSamples : 0;
  const avgSuccessRate = totalSamples > 0 ? totalSuccess / totalSamples : 0;

  // P90 estimation from per-strategy averages (approximate)
  qualityScores.sort((a, b) => a - b);
  const p90Index = Math.floor(qualityScores.length * 0.9);
  const p90Quality = qualityScores[Math.min(p90Index, qualityScores.length - 1)] ?? avgQuality;

  // Best strategy
  const best = weights[0]; // Already sorted by avgQuality desc

  return {
    taskType,
    complexity,
    avgQuality,
    p90Quality,
    avgSuccessRate,
    sampleCount: totalSamples,
    bestStrategy: best?.strategy ?? null,
    bestStrategyQuality: Number(best?.avgQuality ?? 0),
    lastUpdated: Date.now(),
  };
}

/**
 * Bulk refresh all niche profiles (call periodically or after benchmark run).
 */
export async function refreshAllProfiles(): Promise<number> {
  try {
    // Get all distinct (taskType, complexity) pairs
    const niches = await prisma.strategyWeight.findMany({
      select: { taskType: true, complexity: true },
      distinct: ['taskType', 'complexity'],
    });

    let refreshed = 0;
    for (const niche of niches) {
      const profile = await loadNicheProfile(niche.taskType, niche.complexity);
      if (profile && profile.sampleCount >= CONFIG.minSamplesForLearned) {
        profileCache.set(
          cacheKey(niche.taskType, niche.complexity),
          { profile, expiresAt: Date.now() + CONFIG.cacheTtlMs * 2 }, // Longer TTL for bulk refresh
        );
        refreshed++;
      }
    }

    log.info({ refreshed, total: niches.length }, 'Adaptive quality target profiles refreshed');
    return refreshed;
  } catch (err) {
    log.warn({ error: String(err) }, 'Failed to refresh quality target profiles');
    return 0;
  }
}

/**
 * Get all cached profiles for admin inspection.
 */
export function getCachedProfiles(): Array<NicheProfile & { targetRecommendation: QualityTargetRecommendation }> {
  const results: Array<NicheProfile & { targetRecommendation: QualityTargetRecommendation }> = [];

  for (const entry of profileCache.values()) {
    if (entry.expiresAt > Date.now()) {
      results.push({
        ...entry.profile,
        targetRecommendation: profileToRecommendation(entry.profile),
      });
    }
  }

  return results.sort((a, b) => b.sampleCount - a.sampleCount);
}
