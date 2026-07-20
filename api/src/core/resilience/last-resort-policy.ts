// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Self-Hosted Last-Resort Fallback Policy
 *
 * Defines when and how the system should fall back to self-hosted/local models.
 *
 * Key rules (non-negotiable):
 *   1. Self-hosted models are NEVER in the normal execution pool
 *   2. Self-hosted only activates when ALL external providers are exhausted
 *   3. Every fallback execution is explicitly tagged in metadata
 *   4. Fallback executions are EXCLUDED from primary benchmark metrics
 *   5. The system never hides that degradation occurred
 *
 * External exhaustion means:
 *   - All external routes have no credits, OR
 *   - All external routes are rate-limited, OR
 *   - All external routes have auth failure, OR
 *   - All external routes are temporarily unavailable
 */

import { logger } from '@/utils/logger';
import type { Model } from '@/types';
import { getProviderOperabilityHub } from '../provider-operability-hub';

const log = logger.child({ component: 'last-resort-policy' });

// ─── Types ──────────────────────────────────────────────────────────────

export interface LastResortDecision {
  /** Whether self-hosted fallback was activated */
  activated: boolean;
  /** Why it was or wasn't activated */
  reason: string;
  /** Whether all external providers are truly exhausted */
  externalPoolExhausted: boolean;
  /** Whether self-hosted models are available */
  selfHostedAvailable: boolean;
  /** Models available for last-resort fallback */
  fallbackModels: Model[];
}

export interface LastResortMetadata {
  execution_mode: 'last_resort_self_hosted';
  degraded: true;
  external_pool_exhausted: true;
  excluded_from_benchmark: true;
  fallback_reason: string;
  self_hosted_model: string;
  self_hosted_provider: string;
}

// ─── Policy ─────────────────────────────────────────────────────────────

/**
 * Evaluate whether self-hosted fallback should activate.
 *
 * @param eligibleExternalCount - Number of external models still eligible
 * @param allModels - All models in the registry (including self-hosted)
 */
export function evaluateLastResort(
  eligibleExternalCount: number,
  allModels: Model[],
): LastResortDecision {
  const hub = getProviderOperabilityHub();
  const selfHostedModels = allModels.filter(m => {
    const provider = (m.provider ?? '').toLowerCase();
    return hub.isSelfHostedProvider(provider) && m.status === 'active';
  });

  // Self-hosted never activates while external providers exist
  if (eligibleExternalCount > 0) {
    return {
      activated: false,
      reason: `${eligibleExternalCount} external models still eligible — self-hosted not needed`,
      externalPoolExhausted: false,
      selfHostedAvailable: selfHostedModels.length > 0,
      fallbackModels: [],
    };
  }

  // All external exhausted — check if self-hosted is available
  if (selfHostedModels.length === 0) {
    return {
      activated: false,
      reason: 'All external providers exhausted AND no self-hosted models available — true failure',
      externalPoolExhausted: true,
      selfHostedAvailable: false,
      fallbackModels: [],
    };
  }

  // Activate self-hosted fallback
  log.warn({
    selfHostedCount: selfHostedModels.length,
    models: selfHostedModels.map(m => m.id).slice(0, 5),
  }, 'Activating self-hosted last-resort fallback — all external providers exhausted');

  return {
    activated: true,
    reason: 'All external providers exhausted — falling back to self-hosted models',
    externalPoolExhausted: true,
    selfHostedAvailable: true,
    fallbackModels: selfHostedModels,
  };
}

/**
 * Build metadata tags for a last-resort execution.
 * These tags ensure the execution is:
 *   - Clearly marked as degraded
 *   - Excluded from benchmark primary metrics
 *   - Auditable with full reasoning
 */
export function buildLastResortMetadata(
  model: Model,
  reason: string,
): LastResortMetadata {
  return {
    execution_mode: 'last_resort_self_hosted',
    degraded: true,
    external_pool_exhausted: true,
    excluded_from_benchmark: true,
    fallback_reason: reason,
    self_hosted_model: model.id,
    self_hosted_provider: model.provider ?? 'unknown',
  };
}

/**
 * Filter self-hosted models out of a model list (for normal pool building).
 * Returns { external, selfHosted } split.
 */
export function splitBySelfHosted(models: Model[]): {
  external: Model[];
  selfHosted: Model[];
} {
  const hub = getProviderOperabilityHub();
  const external: Model[] = [];
  const selfHosted: Model[] = [];

  for (const m of models) {
    const provider = (m.provider ?? '').toLowerCase();
    if (hub.isSelfHostedProvider(provider)) {
      selfHosted.push(m);
    } else {
      external.push(m);
    }
  }

  return { external, selfHosted };
}
