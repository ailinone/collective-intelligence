// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * RuntimeModelRegistry — in-memory skeleton (MVP 1)
 *
 * MVP 1 scope (this file):
 *   - Constructor that accepts a snapshot via injection.
 *   - Map-based lookups for canonical, offering and route by id.
 *   - Built indices: routesByCanonical, offeringsByCanonical, routesByOffering.
 *   - `size()`, `getVersion()`, `getBuiltAt()` — diagnostic primitives.
 *
 * MVP 1 NON-SCOPE (intentionally absent):
 *   - No DB load. No Prisma. No Postgres query.
 *   - No discovery integration. No DiscoveryScheduler hookup.
 *   - No ProviderOperabilityHub coupling.
 *   - No SemanticIndex / embeddings.
 *   - No scoring, filtering, retrieval.
 *   - No global singleton. The class is instantiable for tests; the
 *     production singleton will be introduced in MVP 2 behind the
 *     `RuntimeRoutingConfigProvider` mode gate.
 *
 * Side-effect invariant: importing this module must NOT initialise any
 * external resource. `module-load-safety.test.ts` enforces.
 */

import type { CanonicalModel } from './canonical-model';
import type { ModelProviderOffering } from './model-offering';
import type { ProviderModelRoute } from './model-route';
import type { LegacyModelSnapshot } from './legacy-model-snapshot';

// ─── Snapshot shape ─────────────────────────────────────────────────────

/**
 * The data the registry is built from. Provided by fixture in MVP 1
 * and by a pure builder in MVP 2; by a real DB-snapshot loader in
 * later MVPs.
 *
 * `legacyModels` carries the EXACT sequence of legacy `Model` rows
 * that fed the build. Stored verbatim so `getModelSnapshots()` can
 * return them preserving identity AND order — the registry_cache
 * equivalence invariant (MVP 2).
 */
export interface RuntimeModelRegistrySnapshot {
  readonly canonicalModels: ReadonlyArray<CanonicalModel>;
  readonly offerings: ReadonlyArray<ModelProviderOffering>;
  readonly routes: ReadonlyArray<ProviderModelRoute>;
  /** Optional — the legacy rows that produced the snapshot. Order preserved. */
  readonly legacyModels?: ReadonlyArray<LegacyModelSnapshot>;
  /** Wall-clock when the snapshot was built. Defaults to construction time. */
  readonly builtAt?: number;
  /** Monotonic version used for cache invalidation. Defaults to 1. */
  readonly version?: number;
}

export interface RuntimeModelRegistrySize {
  readonly canonical: number;
  readonly offerings: number;
  readonly routes: number;
}

// ─── Registry ───────────────────────────────────────────────────────────

/**
 * In-memory model registry. Read-only after construction. Atomic swap of
 * an entire instance is the intended update model — there are no
 * mutating methods.
 */
export class RuntimeModelRegistry {
  private readonly canonicalModels: ReadonlyMap<string, CanonicalModel>;
  private readonly offerings: ReadonlyMap<string, ModelProviderOffering>;
  private readonly routes: ReadonlyMap<string, ProviderModelRoute>;

  // Derived indices — built once in constructor.
  private readonly offeringsByCanonical: ReadonlyMap<string, ReadonlyArray<string>>;
  private readonly routesByCanonical: ReadonlyMap<string, ReadonlyArray<string>>;
  private readonly routesByOffering: ReadonlyMap<string, ReadonlyArray<string>>;

  // Verbatim legacy snapshots (MVP 2 — registry_cache equivalence).
  private readonly legacyModels: ReadonlyArray<LegacyModelSnapshot>;

  private readonly _builtAt: number;
  private readonly _version: number;

  constructor(
    snapshot: RuntimeModelRegistrySnapshot = {
      canonicalModels: [],
      offerings: [],
      routes: [],
    },
  ) {
    this.canonicalModels = freezeMap(
      snapshot.canonicalModels.map((c) => [c.canonicalModelId, c] as const),
    );
    this.offerings = freezeMap(
      snapshot.offerings.map((o) => [o.offeringId, o] as const),
    );
    this.routes = freezeMap(
      snapshot.routes.map((r) => [r.routeId, r] as const),
    );

    this.offeringsByCanonical = buildMultiIndex(
      snapshot.offerings,
      (o) => o.canonicalModelId,
      (o) => o.offeringId,
    );
    this.routesByCanonical = buildMultiIndex(
      snapshot.routes,
      (r) => r.canonicalModelId,
      (r) => r.routeId,
    );
    this.routesByOffering = buildMultiIndex(
      snapshot.routes,
      (r) => r.offeringId,
      (r) => r.routeId,
    );

    // MVP 2: freeze the legacy snapshot sequence VERBATIM so callers
    // get back exactly what was fed in. No sorting, no filtering, no
    // dedup, no normalization. The registry_cache invariant depends on
    // this — see registry-cache-equivalence.test.ts.
    this.legacyModels = Object.freeze(
      (snapshot.legacyModels ?? []).slice(),
    );

    this._builtAt = snapshot.builtAt ?? Date.now();
    this._version = snapshot.version ?? 1;
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────

  size(): RuntimeModelRegistrySize {
    return {
      canonical: this.canonicalModels.size,
      offerings: this.offerings.size,
      routes: this.routes.size,
    };
  }

  getVersion(): number {
    return this._version;
  }

  getBuiltAt(): number {
    return this._builtAt;
  }

  // ─── Point lookups (Map-backed, O(1)) ─────────────────────────────────

  lookupRoute(routeId: string): ProviderModelRoute | undefined {
    return this.routes.get(routeId);
  }

  lookupCanonicalModel(canonicalModelId: string): CanonicalModel | undefined {
    return this.canonicalModels.get(canonicalModelId);
  }

  lookupOffering(offeringId: string): ModelProviderOffering | undefined {
    return this.offerings.get(offeringId);
  }

  // ─── Index-backed range lookups ───────────────────────────────────────

  /**
   * All Routes associated with a CanonicalModel — across providers.
   * Returns an empty array when the canonical id is absent.
   */
  routesForCanonical(canonicalModelId: string): ReadonlyArray<ProviderModelRoute> {
    const ids = this.routesByCanonical.get(canonicalModelId);
    if (!ids || ids.length === 0) return [];
    const out: ProviderModelRoute[] = [];
    for (const id of ids) {
      const route = this.routes.get(id);
      if (route) out.push(route);
    }
    return out;
  }

  /**
   * All Offerings of a CanonicalModel.
   */
  offeringsForCanonical(canonicalModelId: string): ReadonlyArray<ModelProviderOffering> {
    const ids = this.offeringsByCanonical.get(canonicalModelId);
    if (!ids || ids.length === 0) return [];
    const out: ModelProviderOffering[] = [];
    for (const id of ids) {
      const offering = this.offerings.get(id);
      if (offering) out.push(offering);
    }
    return out;
  }

  /**
   * All Routes for a specific Offering.
   */
  routesForOffering(offeringId: string): ReadonlyArray<ProviderModelRoute> {
    const ids = this.routesByOffering.get(offeringId);
    if (!ids || ids.length === 0) return [];
    const out: ProviderModelRoute[] = [];
    for (const id of ids) {
      const route = this.routes.get(id);
      if (route) out.push(route);
    }
    return out;
  }

  // ─── Legacy-equivalence accessor (MVP 2) ───────────────────────────────

  /**
   * Returns the legacy `Model` snapshots in their INPUT ORDER.
   *
   * This is the heart of the `registry_cache` mode: the registry caches
   * the legacy rows in memory and returns them verbatim, eliminating
   * per-request DB lookups. The caller's filter/sort/scoring pipeline
   * (legacy `PoolBuilder` etc.) operates on this array exactly as it
   * would on `getChatEligibleModels()` output from the DB.
   *
   * MVP 2 contract: the registry does NOT reorder, filter, dedupe, or
   * mutate the legacy rows. Tests `registry-cache-equivalence.test.ts`
   * and `registry-cache-no-reordering.test.ts` enforce.
   */
  getModelSnapshots(): ReadonlyArray<LegacyModelSnapshot> {
    return this.legacyModels;
  }
}

// ─── Helpers (pure, no I/O) ─────────────────────────────────────────────

function freezeMap<K, V>(entries: ReadonlyArray<readonly [K, V]>): ReadonlyMap<K, V> {
  const m = new Map<K, V>();
  for (const [k, v] of entries) m.set(k, v);
  return m;
}

function buildMultiIndex<T, K>(
  items: ReadonlyArray<T>,
  keyFn: (item: T) => K,
  valueFn: (item: T) => string,
): ReadonlyMap<K, ReadonlyArray<string>> {
  const m = new Map<K, string[]>();
  for (const item of items) {
    const k = keyFn(item);
    let bucket = m.get(k);
    if (!bucket) {
      bucket = [];
      m.set(k, bucket);
    }
    bucket.push(valueFn(item));
  }
  const out = new Map<K, ReadonlyArray<string>>();
  for (const [k, v] of m) out.set(k, Object.freeze(v.slice()));
  return out;
}
