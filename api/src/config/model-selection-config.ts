// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Configuration for Dynamic Model Selection
 *
 * This file provides the default configuration for the DynamicModelSelector.
 * In production, these values should be loaded from environment variables
 * or a configuration management system.
 */

import type { DynamicModelSelectorConfig } from '../core/selection/dynamic-model-selector';

const _createConfig = (): DynamicModelSelectorConfig => ({
  cacheExpiryMs: 300000, // 5 minutes
  maxCacheSize: 20,
  limits: {
    maxModelsPerSelection: 9,
    maxModelsPerStage: 50,
    maxModelsQuery: 2000,
    maxModelsPerTaskPreference: 9,
    maxModelsPerTaskFallback: 6,
    minModelsForSelection: 20,
  },
  costEstimation: {
    defaultOutputTokens: 1000,
  },
  latencyReference: {
    fastMs: 500,
    slowMs: 5000,
  },
  neutralBonuses: {
    noBudget: 0.05,
    noQualityTarget: 0.05,
  },
  scoringWeights: {
    realTime: {
      successRate: 0.25, // 25% weight on real-time success rate
      qualityScore: 0.2, // 20% weight on real-time quality
      reliability: 0.1, // 10% weight on real-time reliability
      costEfficiency: 0.05, // 5% weight on real-time cost efficiency
    },
    historical: {
      successRate: 0.15, // 15% weight on historical success
      quality: 0.15, // 15% weight on historical quality
      costEfficiency: 0.1, // 10% weight on historical cost efficiency
      recentTrend: 0.1, // 10% weight on recent performance trends
    },
    fallback: {
      intrinsicQuality: 0.15, // proven-first (2026-06-29): halved — don't over-trust ASSUMED quality of no-history models (was 0.3 → picked obscure fine-tunes over measured-good)
      noHistoryQuality: 0.2, // 20% weight when no historical data
    },
    taskFit: 0.2, // 20% weight on task-model fit
    capabilityFit: 0.1, // 10% weight on capability requirements
    costFit: 0.1, // 10% weight on cost constraints
    qualityFit: 0.1, // 10% weight on quality targets
  },
  qualityDefaults: {
    fallbackScore: 0.3, // proven-first (2026-06-29): unknown models start LOW, not neutral (was 0.5 — let obscure no-history models tie measured-good ones)
    minimumThreshold: 0.3, // Minimum score to be considered
  },
  performanceTracking: {
    minimumSamples: 3, // Minimum samples for reliability
    ttlDays: 30, // How long to keep performance data
    windowSize: 1000, // Moving average window size
  },
});

export const defaultModelSelectionConfig: DynamicModelSelectorConfig = _createConfig();

/**
 * Environment variable mappings
 */
export const envVarMappings = {
  // Cache settings
  MODEL_CACHE_EXPIRY_MS: 'cacheExpiryMs',
  MAX_MODEL_CACHE_SIZE: 'maxCacheSize',

  // Real-time scoring weights
  SCORING_WEIGHT_SUCCESS_RATE: 'scoringWeights.realTime.successRate',
  SCORING_WEIGHT_QUALITY: 'scoringWeights.realTime.qualityScore',
  SCORING_WEIGHT_RELIABILITY: 'scoringWeights.realTime.reliability',
  SCORING_WEIGHT_COST: 'scoringWeights.realTime.costEfficiency',

  // Historical scoring weights
  SCORING_WEIGHT_HISTORICAL_SUCCESS: 'scoringWeights.historical.successRate',
  SCORING_WEIGHT_HISTORICAL_QUALITY: 'scoringWeights.historical.quality',
  SCORING_WEIGHT_HISTORICAL_COST: 'scoringWeights.historical.costEfficiency',
  SCORING_WEIGHT_RECENT_TREND: 'scoringWeights.historical.recentTrend',

  // Fallback weights
  SCORING_WEIGHT_INTRINSIC: 'scoringWeights.fallback.intrinsicQuality',
  SCORING_WEIGHT_NO_HISTORY: 'scoringWeights.fallback.noHistoryQuality',

  // Other weights
  SCORING_WEIGHT_TASK_FIT: 'scoringWeights.taskFit',
  SCORING_WEIGHT_CAPABILITY: 'scoringWeights.capabilityFit',
  SCORING_WEIGHT_COST_FIT: 'scoringWeights.costFit',
  SCORING_WEIGHT_QUALITY_FIT: 'scoringWeights.qualityFit',

  // Quality defaults
  DEFAULT_QUALITY_SCORE: 'qualityDefaults.fallbackScore',
  MINIMUM_QUALITY_THRESHOLD: 'qualityDefaults.minimumThreshold',

  // Performance tracking
  MINIMUM_PERFORMANCE_SAMPLES: 'performanceTracking.minimumSamples',
  PERFORMANCE_TTL_DAYS: 'performanceTracking.ttlDays',
  PERFORMANCE_WINDOW_SIZE: 'performanceTracking.windowSize',
} as const;

/**
 * Load configuration from environment variables
 */
export function loadModelSelectionConfigFromEnv(): Partial<DynamicModelSelectorConfig> {
  const config: Partial<DynamicModelSelectorConfig> = {};

  // Keys that could be used to pollute Object.prototype via a deep assignment
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  // Helper to get nested config
  const setNestedValue = (path: string, value: unknown): void => {
    const keys = path.split('.');
    if (keys.some((key) => UNSAFE_KEYS.has(key))) {
      return;
    }
    let current: Record<string, unknown> = config as Record<string, unknown>;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!current[key] || typeof current[key] !== 'object' || current[key] === null) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    const lastKey = keys[keys.length - 1];
    current[lastKey] = value;
  };

  // Load all environment variables
  Object.entries(envVarMappings).forEach(([envVar, configPath]) => {
    const envValue = process.env[envVar];
    if (envValue) {
      const parsedValue = isNaN(Number(envValue)) ? envValue : Number(envValue);
      setNestedValue(configPath, parsedValue);
    }
  });

  return config;
}

/**
 * Create complete configuration by merging defaults with environment overrides
 */
export function createModelSelectionConfig(
  overrides?: Partial<DynamicModelSelectorConfig>
): DynamicModelSelectorConfig {
  const envConfig = loadModelSelectionConfigFromEnv();

  return {
    ...defaultModelSelectionConfig,
    ...envConfig,
    ...overrides,
    limits: {
      ...defaultModelSelectionConfig.limits,
      ...envConfig.limits,
      ...overrides?.limits,
    },
    costEstimation: {
      ...defaultModelSelectionConfig.costEstimation,
      ...envConfig.costEstimation,
      ...overrides?.costEstimation,
    },
    latencyReference: {
      ...defaultModelSelectionConfig.latencyReference,
      ...envConfig.latencyReference,
      ...overrides?.latencyReference,
    },
    neutralBonuses: {
      ...defaultModelSelectionConfig.neutralBonuses,
      ...envConfig.neutralBonuses,
      ...overrides?.neutralBonuses,
    },
    scoringWeights: {
      ...defaultModelSelectionConfig.scoringWeights,
      ...envConfig.scoringWeights,
      ...overrides?.scoringWeights,
      realTime: {
        ...defaultModelSelectionConfig.scoringWeights.realTime,
        ...envConfig.scoringWeights?.realTime,
        ...overrides?.scoringWeights?.realTime,
      },
      historical: {
        ...defaultModelSelectionConfig.scoringWeights.historical,
        ...envConfig.scoringWeights?.historical,
        ...overrides?.scoringWeights?.historical,
      },
      fallback: {
        ...defaultModelSelectionConfig.scoringWeights.fallback,
        ...envConfig.scoringWeights?.fallback,
        ...overrides?.scoringWeights?.fallback,
      },
    },
    qualityDefaults: {
      ...defaultModelSelectionConfig.qualityDefaults,
      ...envConfig.qualityDefaults,
      ...overrides?.qualityDefaults,
    },
    performanceTracking: {
      ...defaultModelSelectionConfig.performanceTracking,
      ...envConfig.performanceTracking,
      ...overrides?.performanceTracking,
    },
  };
}
