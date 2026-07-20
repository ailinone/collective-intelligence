// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Module-level singleton for CapabilitySearchService (ADR-022, Sprint 3).
 *
 * Why a singleton:
 *   - Multiple call sites need the SAME service instance: HTTP routes
 *     (`capabilities-search-routes.ts`), the dynamic-model-selector hot
 *     path (when an operator enables RRF-based candidate generation),
 *     and any future scheduled jobs that warm the embedder cache.
 *   - The service holds an embedder reference and a connection-pool
 *     reference. Spinning up multiple instances multiplies network
 *     warm-up cost on every cold call site (each lazy-loads the embedder).
 *   - Tests can stub the getter via `setCapabilitySearchServiceForTests`
 *     to inject a mock without monkey-patching the constructor.
 *
 * Why module-level (not DI-container):
 *   - Mirrors the existing `getCapabilityPool()` pattern in
 *     `src/capability/db/capability-pool.ts`. The HCRA layer is a flat
 *     module graph by design — no awilix bindings, no per-request
 *     scope. Adding a DI registration here would create a special-case
 *     for one service while neighbours stay flat.
 *
 * Lifecycle:
 *   - First `getCapabilitySearchService()` lazily constructs the service
 *     using the shared `getCapabilityPool()` (pg.Pool).
 *   - `resetCapabilitySearchService()` is for tests; production code
 *     never calls it. The pool itself is owned by capability-pool.ts.
 */

import { CapabilitySearchService } from './capability-search-service';
import { getCapabilityPool } from '@/capability/db/capability-pool';

let instance: CapabilitySearchService | null = null;

/**
 * Returns the shared CapabilitySearchService instance.
 *
 * Constructs it lazily on first call. All subsequent calls return the
 * same instance. The service holds a reference to the shared
 * `getCapabilityPool()` pg.Pool — no extra connection budget is
 * consumed per call site.
 */
export function getCapabilitySearchService(): CapabilitySearchService {
  if (!instance) {
    instance = new CapabilitySearchService(getCapabilityPool());
  }
  return instance;
}

/**
 * Test-only helper: replace the singleton instance with a stub.
 *
 * Production code should never call this. The expected pattern in
 * tests is:
 *
 *   import { setCapabilitySearchServiceForTests, resetCapabilitySearchService }
 *     from '@/capability/search/capability-search-singleton';
 *
 *   beforeEach(() => setCapabilitySearchServiceForTests(mockService));
 *   afterEach(() => resetCapabilitySearchService());
 */
export function setCapabilitySearchServiceForTests(
  stub: CapabilitySearchService,
): void {
  instance = stub;
}

/**
 * Test-only helper: clear the cached instance so the next `get` call
 * lazy-constructs again (e.g. after a pool reset between test files).
 */
export function resetCapabilitySearchService(): void {
  instance = null;
}
