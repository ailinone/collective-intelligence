// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Adapter Factory Registry — catalog ↔ dedicated adapter dispatch.
 *
 * The catalog entry declares `adapterClass?: string`. Until this registry was
 * added, that field was descriptive-only — the bridge constructed
 * `OpenAICompatibleHubAdapter` unconditionally. That produced the
 * "hub-wrapper-with-a-fancy-name" anti-pattern the anti-hardcode test
 * explicitly warns against.
 *
 * ### What this file is
 *
 * A small runtime registry keyed by the catalog's `adapterClass` string. Each
 * entry is a factory that takes a resolved runtime configuration and returns a
 * concrete {@link ProviderAdapter}. The catalog plugin (`CatalogProviderPlugin`)
 * consults this registry; if a factory is registered for the entry's declared
 * `adapterClass`, that factory is invoked. Otherwise the bridge falls back to
 * the default hub adapter (the existing behavior — no regression for entries
 * that don't declare `adapterClass`).
 *
 * ### What this file is NOT
 *
 * - It is NOT a "choose-your-adapter" layer. The choice is declared in the
 *   catalog row; this registry only resolves the name to a constructor.
 * - It is NOT where you put per-provider business logic. Put it in the
 *   adapter class itself. Keep this file to a flat registration table.
 * - It is NOT a dependency-injection container. It's a Map<string, fn>.
 *
 * ### Contract
 *
 * A factory receives an already-resolved configuration: the provider's api
 * key (or empty string when `apiKeyOptional: true`), the base URL with env
 * overrides applied, the catalog entry itself (so adapters can consult any
 * field without re-reading the catalog), and a `hubFallback` factory used
 * by dedicated adapters that extend the hub adapter (they still need to
 * construct the hub config envelope).
 *
 * ### Registration ordering
 *
 * Factories register at module import time via side-effect `register()`
 * calls. Import order matters only in that `registerDefaultAdapterFactories()`
 * must be called once before the catalog loader runs. The catalog loader
 * in `catalog-loader.ts` invokes it during `loadProviderCatalog()` and is
 * idempotent — duplicate registrations are logged and ignored.
 */

import { logger } from '@/utils/logger';
import type { ProviderAdapter } from '../base/provider-adapter';
import type { ProviderCatalogEntry } from './provider-catalog.types';

const log = logger.child({ component: 'adapter-factory-registry' });

/**
 * Runtime config passed into a factory. This is the product of
 * (catalog entry × resolved env × plugin-manager config), so every factory
 * starts from the same resolved view.
 */
export interface AdapterFactoryContext {
  /** The full catalog row. Factories can consult any field. */
  readonly entry: ProviderCatalogEntry;
  /** Resolved API key after env-override chain. Empty string when optional. */
  readonly apiKey: string;
  /** Resolved base URL after env-override chain. */
  readonly baseUrl: string;
  /** Extra headers merged from catalog + adapter-specific additions. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

/**
 * A factory returns a concrete adapter. The factory is synchronous — any async
 * initialization (IAM token exchange, OAuth2 dance) must happen lazily inside
 * the adapter's first real call, not at construction time, so that
 * `CatalogProviderPlugin.initialize()` stays synchronous and testable.
 */
export type AdapterFactory = (ctx: AdapterFactoryContext) => ProviderAdapter;

const factories = new Map<string, AdapterFactory>();

/**
 * Register a named factory. Duplicate registrations are logged and ignored
 * (the first registration wins) — this keeps the catalog loader deterministic
 * even if `registerDefaultAdapterFactories()` is called more than once in a
 * test scenario.
 */
export function registerAdapterFactory(
  adapterClass: string,
  factory: AdapterFactory,
): void {
  if (factories.has(adapterClass)) {
    log.debug({ adapterClass }, 'adapter factory already registered — skipping duplicate');
    return;
  }
  factories.set(adapterClass, factory);
  log.debug({ adapterClass }, 'adapter factory registered');
}

/**
 * Resolve a catalog `adapterClass` to its factory. Returns undefined when no
 * factory is registered — the bridge uses this absence as the signal to fall
 * back to the default hub adapter.
 */
export function resolveAdapterFactory(
  adapterClass: string | undefined,
): AdapterFactory | undefined {
  if (!adapterClass) return undefined;
  return factories.get(adapterClass);
}

/**
 * For tests: returns the list of registered names. Never used in production.
 */
export function getRegisteredAdapterClassesForTests(): readonly string[] {
  return [...factories.keys()].sort();
}

/**
 * For tests: clears the registry. Paired with a fresh
 * `registerDefaultAdapterFactories()` call in `beforeEach`.
 */
export function resetAdapterFactoryRegistryForTests(): void {
  factories.clear();
}
