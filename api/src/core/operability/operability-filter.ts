// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Shared provider-operability filter for ANY model-selection layer.
 *
 * Background (2026-05-11 c3-pilot-ramp stop):
 *   The c3-resolver was patched to consult `ProviderOperabilityHub` and
 *   `EXPERIMENT_BLOCKED_PROVIDERS` when picking C3 pins. That fix carried
 *   the canary from 54.5% → 88.5%. But the collective strategies
 *   (consensus, sensitivity-consensus, parallel, critique-repair) do
 *   their own internal model fan-out via `base-strategy.getEligibleModels`,
 *   which read the raw catalog WITHOUT the same filter. Result:
 *   c3-pilot-ramp stopped at 66.7% — failures concentrated in those four
 *   strategies because their sub-calls hit no_credits/auth_failed
 *   providers the hub already knew were bad.
 *
 *   This module centralizes the filter so the resolver, base-strategy,
 *   PoolBuilder, and any future selector all reach the SAME verdict
 *   about a given provider. No more "the system knew but the selector
 *   didn't check".
 */

import { logger } from '@/utils/logger';

const log = logger.child({ component: 'operability-filter' });

// ─── Public types ────────────────────────────────────────────────────────

export type OperabilityBlockReason =
  | 'provider_auth_failed'
  | 'provider_no_credits'
  | 'provider_rate_limited'
  | 'provider_temporarily_unavailable'
  | 'provider_blocklisted'
  | 'provider_permanently_unavailable'
  | 'unknown_provider_id'
  | 'self_hosted_excluded';

export interface OperabilityFilterOptions {
  /** Allow `unknown` state (no runtime feedback yet). Default true. */
  allowUnknown?: boolean;
  /** Allow `degraded` state. Default true. */
  allowDegraded?: boolean;
  /** Allow `recovering` state. Default true. */
  allowRecovering?: boolean;
  /** Drop self-hosted providers (matches PoolBuilder.excludeSelfHosted). Default false. */
  excludeSelfHosted?: boolean;
  /** Honor `EXPERIMENT_BLOCKED_PROVIDERS` env. Default true. */
  respectEnvBlocklist?: boolean;
  /** Free-form tag included in log lines for cross-layer attribution. */
  reasonPrefix?: string;
}

export interface OperabilityBlockedEntry<T> {
  model: T;
  providerId: string | null;
  modelId: string | null;
  reason: OperabilityBlockReason;
  hubState?: string;
}

export interface OperabilityFilterResult<T> {
  eligible: T[];
  blocked: OperabilityBlockedEntry<T>[];
  summary: {
    before: number;
    after: number;
    blocked: number;
    byReason: Record<OperabilityBlockReason | 'unspecified', number>;
  };
}

/**
 * Loose model shape every layer in this codebase can satisfy. We accept
 * `provider` (camelCase used by the orchestration `Model` type),
 * `providerId` (used by candidate/pool types), and an explicit
 * `__providerForOperability` override.
 */
export interface ModelForOperability {
  provider?: string;
  providerId?: string;
  id?: string;
  modelId?: string;
  __providerForOperability?: string;
}

// ─── Implementation ─────────────────────────────────────────────────────

const SELF_HOSTED_PREFIXES = ['ollama', 'local-', 'self-hosted', 'vllm', 'lm-studio'];

function isSelfHosted(providerId: string): boolean {
  const id = providerId.toLowerCase();
  return SELF_HOSTED_PREFIXES.some((p) => id === p || id.startsWith(p));
}

function extractProviderId(model: ModelForOperability): string | null {
  return (
    model.__providerForOperability
    ?? model.providerId
    ?? model.provider
    ?? null
  );
}

function extractModelId(model: ModelForOperability): string | null {
  return model.modelId ?? model.id ?? null;
}

/**
 * Lazy-load + cache the hub summary for a single filter call. Each call
 * reads ONE snapshot; no callbacks or change listeners inside the filter.
 * Cheaper than re-querying for every model in the array.
 */
async function loadHubBuckets(): Promise<{
  authFailed: Set<string>;
  noCredits: Set<string>;
  rateLimited: Set<string>;
  temporarilyUnavailable: Set<string>;
  permanentlyUnavailable: Set<string>;
  healthy: Set<string>;
  degraded: Set<string>;
  recovering: Set<string>;
  unknown: Set<string>;
} | null> {
  try {
    const mod = await import('@/core/provider-operability-hub');
    const summary = mod.getProviderOperabilityHub().getSummary() as Record<string, string[]>;
    const toSet = (ids: string[] | undefined): Set<string> => {
      const s = new Set<string>();
      for (const id of ids ?? []) {
        const base = id.includes(':') ? id.split(':')[0]! : id;
        s.add(base.toLowerCase());
      }
      return s;
    };
    return {
      authFailed: toSet(summary.auth_failed),
      noCredits: toSet(summary.no_credits),
      rateLimited: toSet(summary.rate_limited),
      temporarilyUnavailable: toSet(summary.temporarily_unavailable),
      permanentlyUnavailable: toSet((summary as { permanently_unavailable?: string[] }).permanently_unavailable),
      healthy: toSet(summary.healthy),
      degraded: toSet(summary.degraded),
      recovering: toSet(summary.recovering),
      unknown: toSet(summary.unknown),
    };
  } catch {
    return null;
  }
}

function readEnvBlocklist(): Set<string> {
  return new Set(
    (process.env.EXPERIMENT_BLOCKED_PROVIDERS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The single function every model-selector layer should call.
 *
 *   const result = await filterModelsByProviderOperability(candidates, {
 *     allowUnknown: true,
 *     respectEnvBlocklist: true,
 *     reasonPrefix: 'consensus_strategy',
 *   });
 *   return rank(result.eligible);
 *
 * The function never throws; on hub error it falls back to optimistic
 * (returns all candidates, marks summary.byReason.unspecified += 0).
 */
export async function filterModelsByProviderOperability<T extends ModelForOperability>(
  models: readonly T[],
  options: OperabilityFilterOptions = {},
): Promise<OperabilityFilterResult<T>> {
  const allowUnknown = options.allowUnknown ?? true;
  const allowDegraded = options.allowDegraded ?? true;
  const allowRecovering = options.allowRecovering ?? true;
  const excludeSelfHosted = options.excludeSelfHosted ?? false;
  const respectEnvBlocklist = options.respectEnvBlocklist ?? true;

  const buckets = await loadHubBuckets();
  const envBlocklist = respectEnvBlocklist ? readEnvBlocklist() : new Set<string>();

  const eligible: T[] = [];
  const blocked: OperabilityBlockedEntry<T>[] = [];
  const byReason: Record<string, number> = {};

  for (const m of models) {
    const rawProviderId = extractProviderId(m);
    const providerId = rawProviderId ? rawProviderId.toLowerCase() : null;
    const modelId = extractModelId(m);

    if (!providerId) {
      blocked.push({ model: m, providerId: null, modelId, reason: 'unknown_provider_id' });
      byReason['unknown_provider_id'] = (byReason['unknown_provider_id'] ?? 0) + 1;
      continue;
    }

    if (excludeSelfHosted && isSelfHosted(providerId)) {
      blocked.push({ model: m, providerId, modelId, reason: 'self_hosted_excluded' });
      byReason['self_hosted_excluded'] = (byReason['self_hosted_excluded'] ?? 0) + 1;
      continue;
    }

    if (envBlocklist.has(providerId)) {
      blocked.push({ model: m, providerId, modelId, reason: 'provider_blocklisted' });
      byReason['provider_blocklisted'] = (byReason['provider_blocklisted'] ?? 0) + 1;
      continue;
    }

    if (buckets) {
      let blockedHere: OperabilityBlockReason | null = null;
      let hubState: string | undefined;
      if (buckets.authFailed.has(providerId)) { blockedHere = 'provider_auth_failed'; hubState = 'auth_failed'; }
      else if (buckets.noCredits.has(providerId)) { blockedHere = 'provider_no_credits'; hubState = 'no_credits'; }
      else if (buckets.rateLimited.has(providerId)) { blockedHere = 'provider_rate_limited'; hubState = 'rate_limited'; }
      else if (buckets.temporarilyUnavailable.has(providerId)) { blockedHere = 'provider_temporarily_unavailable'; hubState = 'temporarily_unavailable'; }
      else if (buckets.permanentlyUnavailable.has(providerId)) { blockedHere = 'provider_permanently_unavailable'; hubState = 'permanently_unavailable'; }
      else if (!allowUnknown && buckets.unknown.has(providerId)) { blockedHere = 'provider_temporarily_unavailable'; hubState = 'unknown_not_allowed'; }
      else if (!allowDegraded && buckets.degraded.has(providerId)) { blockedHere = 'provider_temporarily_unavailable'; hubState = 'degraded_not_allowed'; }
      else if (!allowRecovering && buckets.recovering.has(providerId)) { blockedHere = 'provider_temporarily_unavailable'; hubState = 'recovering_not_allowed'; }

      if (blockedHere) {
        blocked.push({ model: m, providerId, modelId, reason: blockedHere, hubState });
        byReason[blockedHere] = (byReason[blockedHere] ?? 0) + 1;
        continue;
      }
    }

    eligible.push(m);
  }

  if (blocked.length > 0) {
    log.debug({
      prefix: options.reasonPrefix,
      before: models.length,
      after: eligible.length,
      blocked: blocked.length,
      byReason,
    }, 'Operability filter applied');
  }

  return {
    eligible,
    blocked,
    summary: {
      before: models.length,
      after: eligible.length,
      blocked: blocked.length,
      byReason: byReason as Record<OperabilityBlockReason | 'unspecified', number>,
    },
  };
}

/**
 * Sync variant — same logic but accepts an already-loaded buckets snapshot.
 * Useful inside tight loops or sync code paths that already have hub state.
 */
export function filterModelsByProviderOperabilitySync<T extends ModelForOperability>(
  models: readonly T[],
  buckets: NonNullable<Awaited<ReturnType<typeof loadHubBuckets>>>,
  envBlocklist: Set<string>,
  options: OperabilityFilterOptions = {},
): OperabilityFilterResult<T> {
  const allowUnknown = options.allowUnknown ?? true;
  const allowDegraded = options.allowDegraded ?? true;
  const allowRecovering = options.allowRecovering ?? true;
  const excludeSelfHosted = options.excludeSelfHosted ?? false;

  const eligible: T[] = [];
  const blocked: OperabilityBlockedEntry<T>[] = [];
  const byReason: Record<string, number> = {};

  for (const m of models) {
    const rawProviderId = extractProviderId(m);
    const providerId = rawProviderId ? rawProviderId.toLowerCase() : null;
    const modelId = extractModelId(m);

    if (!providerId) {
      blocked.push({ model: m, providerId: null, modelId, reason: 'unknown_provider_id' });
      byReason['unknown_provider_id'] = (byReason['unknown_provider_id'] ?? 0) + 1;
      continue;
    }
    if (excludeSelfHosted && isSelfHosted(providerId)) {
      blocked.push({ model: m, providerId, modelId, reason: 'self_hosted_excluded' });
      byReason['self_hosted_excluded'] = (byReason['self_hosted_excluded'] ?? 0) + 1;
      continue;
    }
    if (envBlocklist.has(providerId)) {
      blocked.push({ model: m, providerId, modelId, reason: 'provider_blocklisted' });
      byReason['provider_blocklisted'] = (byReason['provider_blocklisted'] ?? 0) + 1;
      continue;
    }

    let blockedHere: OperabilityBlockReason | null = null;
    let hubState: string | undefined;
    if (buckets.authFailed.has(providerId)) { blockedHere = 'provider_auth_failed'; hubState = 'auth_failed'; }
    else if (buckets.noCredits.has(providerId)) { blockedHere = 'provider_no_credits'; hubState = 'no_credits'; }
    else if (buckets.rateLimited.has(providerId)) { blockedHere = 'provider_rate_limited'; hubState = 'rate_limited'; }
    else if (buckets.temporarilyUnavailable.has(providerId)) { blockedHere = 'provider_temporarily_unavailable'; hubState = 'temporarily_unavailable'; }
    else if (buckets.permanentlyUnavailable.has(providerId)) { blockedHere = 'provider_permanently_unavailable'; hubState = 'permanently_unavailable'; }
    else if (!allowUnknown && buckets.unknown.has(providerId)) { blockedHere = 'provider_temporarily_unavailable'; hubState = 'unknown_not_allowed'; }
    else if (!allowDegraded && buckets.degraded.has(providerId)) { blockedHere = 'provider_temporarily_unavailable'; hubState = 'degraded_not_allowed'; }
    else if (!allowRecovering && buckets.recovering.has(providerId)) { blockedHere = 'provider_temporarily_unavailable'; hubState = 'recovering_not_allowed'; }

    if (blockedHere) {
      blocked.push({ model: m, providerId, modelId, reason: blockedHere, hubState });
      byReason[blockedHere] = (byReason[blockedHere] ?? 0) + 1;
      continue;
    }
    eligible.push(m);
  }

  return {
    eligible,
    blocked,
    summary: {
      before: models.length,
      after: eligible.length,
      blocked: blocked.length,
      byReason: byReason as Record<OperabilityBlockReason | 'unspecified', number>,
    },
  };
}

/** Re-export internal helpers for the integration test. */
export const __forTesting = { loadHubBuckets, readEnvBlocklist };
