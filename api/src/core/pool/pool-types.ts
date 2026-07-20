// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pool Builder Types
 *
 * Structured types for the execution pool pipeline that replaces the misleading
 * "606 models available" with a visible, auditable reduction chain.
 */

import type { Model } from '@/types';

// ─── Pool Stage ─────────────────────────────────────────────────────────

export interface PoolStage {
  /** Stage name (e.g., "modality_filter", "operability_filter") */
  name: string;
  /** Models entering this stage */
  inputCount: number;
  /** Models passing this stage */
  outputCount: number;
  /** Count of models dropped, grouped by reason */
  droppedReasons: Record<string, number>;
}

// ─── Pool Result ────────────────────────────────────────────────────────

export interface PoolResult {
  /** Models that passed all filters — the real execution pool */
  models: Model[];
  /** Convenience: models.length */
  poolSize: number;
  /** Every filtering stage with drop counts and reasons */
  stages: PoolStage[];
  /** Self-hosted models available as last resort (NOT in primary pool) */
  selfHostedAvailable: number;
  /** Provider diversity: unique execution providers in pool */
  providerDiversity: number;
  /** Model family diversity: unique families in pool */
  familyDiversity: number;
  /** Human-readable summary string for logging */
  summary: string;
}

// ─── Pool Request ───────────────────────────────────────────────────────

export interface PoolRequest {
  modality?: 'chat' | 'tool' | 'reasoning' | 'code' | 'vision' | 'embedding';
  requiredCapabilities?: string[];
  minQualityThreshold?: number;
  maxCostPer1k?: number;
  excludeSelfHosted?: boolean;
  excludeNoCredits?: boolean;
  excludeRateLimited?: boolean;
  excludeAuthFailed?: boolean;
  strategyMinModels?: number;
  /** If true, only include models from diverse providers */
  requireProviderDiversity?: boolean;
}
