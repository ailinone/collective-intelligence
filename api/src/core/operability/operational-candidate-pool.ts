// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OperationalCandidatePool — the single source of truth for "which
 * (provider, model) tuples are eligible for execution right now".
 *
 * Phase 3 (2026-05-08): builds a pool from the cross-product of:
 *   - DiscoverySnapshot.results (what providers/models exist + are available)
 *   - ProviderHealthRegistry (current operational state per tuple)
 *
 * The pool is rebuilt:
 *   - on each successful discovery run (full rebuild)
 *   - lazily when consumers ask for a fresh view (re-applies health)
 *
 * Hot-path consumers (orchestrator, ranking, fallback) should consume
 * this pool — not the raw catalog. The pool is what separates
 * "configured" from "operational".
 *
 * Design notes:
 *   - The pool is a Map<key, OperationalCandidate>. Frozen on each
 *     rebuild. Atomic swap via `instance = newInstance` (no readers
 *     observe a partial update — JS single-threaded).
 *   - Health checks are read at READ TIME (lookup), not at build time.
 *     This keeps the pool fresh without needing to rebuild on every
 *     health change. The pool stores discovery facts; health is layered
 *     on top per query.
 *   - Tier classification (`native | edge | aggregator | local | observer`)
 *     is derived from probe-strategy + integration class. This is what
 *     enables Phase 4+ "native-first" routing.
 */

import { logger } from '@/utils/logger';
import type {
  ProviderDiscoverySnapshot,
  ProviderHealthState,
  DiscoveredModel,
} from './types';
import { getProviderHealthRegistry } from './provider-health-registry';

const log = logger.child({ component: 'operational-candidate-pool' });

// ─── Provider tier ────────────────────────────────────────────────────────

export type ProviderTier = 'native' | 'edge' | 'aggregator' | 'local' | 'observer';

/**
 * Heuristic classification — placeholder until per-provider metadata
 * carries an explicit `providerTier`. The Phase 4 RFC will move this
 * to the catalog row so it's data-driven, not heuristic.
 */
function classifyProviderTier(
  providerId: string,
  integrationClass: string | undefined,
): ProviderTier {
  const id = providerId.toLowerCase();
  const cls = (integrationClass ?? '').toLowerCase();

  if (cls === 'self-hosted-oai-compat' || id.startsWith('ollama') || id === 'self-hosted' || id.includes('local')) {
    return 'local';
  }
  if (cls === 'aggregator-with-billing' || isKnownAggregator(id)) {
    return 'aggregator';
  }
  if (cls.startsWith('native-')) {
    return 'native';
  }
  if (id.includes('cloudflare') || id.includes('workers-ai') || id.includes('edge')) {
    return 'edge';
  }
  // Default: treat oai-compat-pure (non-aggregator) as native-equivalent
  return 'native';
}

const KNOWN_AGGREGATORS = new Set([
  'aihubmix', 'cometapi', 'openrouter', 'aiml', 'nanogpt', 'edenai',
  'novita', 'routeway', 'requesty', 'helicone', 'heliconeai', 'poe',
  'ai302', '302ai', 'imagerouter',
]);

function isKnownAggregator(id: string): boolean {
  return KNOWN_AGGREGATORS.has(id);
}

// ─── Candidate type ───────────────────────────────────────────────────────

export interface OperationalCandidate {
  providerId: string;
  modelId: string;
  modelFamily?: string;
  providerTier: ProviderTier;
  contextWindow?: number;
  capabilities?: readonly string[];
  /** Reason the candidate was added (e.g., 'discovery_listed' | 'configured_alias'). */
  source: 'discovery_listed' | 'configured_alias' | 'inferred';
  /** ISO timestamp set when the candidate joined the pool. */
  addedAt: string;
}

export interface CandidateFilter {
  providerId?: string;
  modelId?: string;
  modelFamily?: string;
  providerTier?: ProviderTier;
  /** When true, exclude candidates whose health record is in a fatal state. */
  healthyOnly?: boolean;
  /** When true, exclude candidates whose `nextProbeAfter` has not elapsed. */
  excludeWithinCooldown?: boolean;
}

// ─── Pool ─────────────────────────────────────────────────────────────────

class OperationalCandidatePool {
  private candidates: ReadonlyMap<string, OperationalCandidate> = new Map();
  private byProvider: ReadonlyMap<string, readonly OperationalCandidate[]> = new Map();
  private byTier: ReadonlyMap<ProviderTier, readonly OperationalCandidate[]> = new Map();
  private builtAt: number = 0;

  /**
   * Rebuild the pool from a discovery snapshot. The snapshot's results
   * are flattened into (providerId, modelId) tuples; for providers where
   * `models[]` is empty (e.g., native-anthropic that doesn't enumerate),
   * the pool stays empty for that provider — consumers add candidates
   * via `addCandidatesByProvider` if a separate catalog source provides
   * the model list.
   */
  rebuild(input: {
    snapshot: ProviderDiscoverySnapshot;
    /** Optional: integrationClass per provider (used for tier classification). */
    integrationClassByProvider?: Readonly<Record<string, string>>;
    /**
     * Optional: when discovery doesn't enumerate (e.g., native-anthropic),
     * the operator can pre-feed a list of (providerId, modelId) tuples
     * here. Models for providers already populated by discovery are
     * ignored (no overwrite).
     */
    fallbackModelsByProvider?: Readonly<Record<string, readonly DiscoveredModel[]>>;
  }): void {
    const next = new Map<string, OperationalCandidate>();
    const integrationClassByProvider = input.integrationClassByProvider ?? {};
    const fallback = input.fallbackModelsByProvider ?? {};
    const now = new Date().toISOString();

    for (const [providerId, result] of input.snapshot.results) {
      if (!result.includeInOperationalPool) continue;
      const tier = classifyProviderTier(providerId, integrationClassByProvider[providerId]);
      const modelsToInsert = result.models.length > 0
        ? result.models
        : (fallback[providerId] ?? []);
      for (const model of modelsToInsert) {
        const key = candidateKey(providerId, model.modelId);
        if (next.has(key)) continue; // discovery wins over fallback
        next.set(key, {
          providerId,
          modelId: model.modelId,
          modelFamily: model.family,
          providerTier: tier,
          contextWindow: model.contextWindow,
          capabilities: model.capabilities,
          source: result.models.length > 0 ? 'discovery_listed' : 'configured_alias',
          addedAt: now,
        });
      }
    }

    this.candidates = next;
    this.rebuildIndices();
    this.builtAt = Date.now();
    log.info(
      {
        candidateCount: next.size,
        providerCount: this.byProvider.size,
        builtAt: this.builtAt,
      },
      'OperationalCandidatePool rebuilt',
    );
  }

  /**
   * Add candidates for a single provider without rebuilding the whole
   * pool. Useful when the catalog detects a new model (e.g., native
   * provider's lazy discovery).
   */
  addCandidatesByProvider(
    providerId: string,
    models: readonly DiscoveredModel[],
    integrationClass?: string,
  ): void {
    const next = new Map(this.candidates);
    const tier = classifyProviderTier(providerId, integrationClass);
    const now = new Date().toISOString();
    for (const model of models) {
      const key = candidateKey(providerId, model.modelId);
      if (next.has(key)) continue;
      next.set(key, {
        providerId,
        modelId: model.modelId,
        modelFamily: model.family,
        providerTier: tier,
        contextWindow: model.contextWindow,
        capabilities: model.capabilities,
        source: 'configured_alias',
        addedAt: now,
      });
    }
    this.candidates = next;
    this.rebuildIndices();
  }

  /**
   * Hot-path read: return candidates matching the filter. By default,
   * applies `healthyOnly=true` + `excludeWithinCooldown=true` — i.e.
   * the consumer gets only candidates that aren't currently in a
   * fatal/cooldown state.
   *
   * Optional filter overrides allow inspection of unhealthy entries
   * (diagnostic endpoints, dashboards).
   */
  query(filter: CandidateFilter = {}): readonly OperationalCandidate[] {
    const healthyOnly = filter.healthyOnly !== false;
    const excludeCooldown = filter.excludeWithinCooldown !== false;
    const registry = getProviderHealthRegistry();
    const now = Date.now();

    const candidates = filter.providerId
      ? this.byProvider.get(filter.providerId) ?? []
      : filter.providerTier
        ? this.byTier.get(filter.providerTier) ?? []
        : Array.from(this.candidates.values());

    const result: OperationalCandidate[] = [];
    for (const c of candidates) {
      if (filter.modelId && c.modelId !== filter.modelId) continue;
      if (filter.modelFamily && c.modelFamily !== filter.modelFamily) continue;

      if (healthyOnly || excludeCooldown) {
        const health = registry.lookup({ providerId: c.providerId, modelId: c.modelId });
        if (health) {
          if (healthyOnly && isUnhealthyState(health.state)) {
            if (excludeCooldown) {
              // Within cooldown? Skip. After cooldown? Keep (allow reprobe).
              const probeAfter = health.nextProbeAfter ? Date.parse(health.nextProbeAfter) : 0;
              if (probeAfter > now) continue;
            } else {
              continue;
            }
          }
        }
      }
      result.push(c);
    }
    return result;
  }

  /**
   * Get a single candidate by exact key.
   */
  get(providerId: string, modelId: string): OperationalCandidate | undefined {
    return this.candidates.get(candidateKey(providerId, modelId));
  }

  size(): number {
    return this.candidates.size;
  }

  builtAtMs(): number {
    return this.builtAt;
  }

  /**
   * Snapshot of the entire pool (read-only). Used by diagnostic
   * endpoints. Hot path should prefer `query()`.
   */
  snapshot(): readonly OperationalCandidate[] {
    return Array.from(this.candidates.values());
  }

  resetForTesting(): void {
    this.candidates = new Map();
    this.byProvider = new Map();
    this.byTier = new Map();
    this.builtAt = 0;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private rebuildIndices(): void {
    const byProvider = new Map<string, OperationalCandidate[]>();
    const byTier = new Map<ProviderTier, OperationalCandidate[]>();
    for (const c of this.candidates.values()) {
      const arr = byProvider.get(c.providerId) ?? [];
      arr.push(c);
      byProvider.set(c.providerId, arr);

      const tierArr = byTier.get(c.providerTier) ?? [];
      tierArr.push(c);
      byTier.set(c.providerTier, tierArr);
    }
    this.byProvider = freezeMap(byProvider);
    this.byTier = freezeMap(byTier);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function candidateKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function freezeMap<K, V>(m: Map<K, V[]>): ReadonlyMap<K, readonly V[]> {
  const out = new Map<K, readonly V[]>();
  for (const [k, v] of m) {
    out.set(k, Object.freeze(v.slice()));
  }
  return out;
}

const UNHEALTHY_STATES: ReadonlySet<ProviderHealthState> = new Set([
  'auth_failed',
  'insufficient_credit',
  'endpoint_not_found',
  'model_not_found',
  'permanently_disabled',
  'rate_limited',
  'temporarily_disabled',
  'timeout_suspected',
] as ProviderHealthState[]);

function isUnhealthyState(state: ProviderHealthState): boolean {
  return UNHEALTHY_STATES.has(state);
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: OperationalCandidatePool | null = null;

export function getOperationalCandidatePool(): OperationalCandidatePool {
  if (!instance) {
    instance = new OperationalCandidatePool();
  }
  return instance;
}

export function resetOperationalCandidatePoolForTesting(): void {
  instance = null;
}

export type { OperationalCandidatePool };
