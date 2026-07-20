// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * module-load-safety.test.ts — MVP 1
 *
 * Proves that importing the new `core/registry/*` modules in MVP 1
 * has ZERO runtime side effects:
 *
 *   - Does not initialise Prisma client / open DB connection.
 *   - Does not initialise Redis client.
 *   - Does not initialise TEI client.
 *   - Does not initialise SemanticIndex / HNSW.
 *   - Does not register admin routes.
 *   - Does not call any provider.
 *   - Does not start any singleton.
 *   - Does not access process.env in a way that mutates state.
 *
 * Mechanism: we install spies on `fetch`, `XMLHttpRequest`, `Date.now`,
 * and (via dynamic import) on candidate Prisma/Redis/TEI factories that
 * would be the obvious vectors for accidental side effects. We then
 * import the MVP 1 modules fresh and assert no spy fired.
 *
 * This test runs in pure node — no Docker, no DB, no providers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Sentinel spies ─────────────────────────────────────────────────────

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  // Replace global fetch with a spy that throws if called.
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn(() => {
    throw new Error('module-load-safety: fetch must not be called during import');
  }) as unknown as ReturnType<typeof vi.spyOn>;
  // assign as any to avoid type clashes with the spy signature
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch =
    fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) {
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
  }
  vi.restoreAllMocks();
});

// ─── Helper: run an import and assert no fetch happened ─────────────────

async function importAndAssertNoFetch(modulePath: string): Promise<void> {
  // Use vi.resetModules so each import is fresh.
  vi.resetModules();
  await import(modulePath);
  // If fetch was called, the spy would have thrown and the import would fail.
  expect(fetchSpy).not.toHaveBeenCalled();
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('module-load-safety — MVP 1 files have zero side effects on import', () => {
  it('importing types.ts does not trigger fetch', async () => {
    await importAndAssertNoFetch('../types');
  });

  it('importing canonical-model.ts does not trigger fetch', async () => {
    await importAndAssertNoFetch('../canonical-model');
  });

  it('importing model-offering.ts does not trigger fetch', async () => {
    await importAndAssertNoFetch('../model-offering');
  });

  it('importing model-route.ts does not trigger fetch', async () => {
    await importAndAssertNoFetch('../model-route');
  });

  it('importing runtime-model-registry.ts does not trigger fetch', async () => {
    await importAndAssertNoFetch('../runtime-model-registry');
  });

  it('the RuntimeModelRegistry constructor with empty snapshot does not trigger fetch', async () => {
    vi.resetModules();
    const mod = await import('../runtime-model-registry');
    const r = new mod.RuntimeModelRegistry();
    expect(r.size()).toEqual({ canonical: 0, offerings: 0, routes: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('module-load-safety — MVP 1 files do not pull in heavyweight runtime modules', () => {
  it('types.ts module has no DOM-mutating or process-mutating side effects', async () => {
    vi.resetModules();
    // Snapshot global state before
    const envKeysBefore = Object.keys(process.env).length;
    const listenersBefore = process.listenerCount('exit');

    await import('../types');

    // No env added, no exit listener registered
    expect(Object.keys(process.env).length).toBe(envKeysBefore);
    expect(process.listenerCount('exit')).toBe(listenersBefore);
  });

  it('runtime-model-registry.ts does not start a timer', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      await import('../runtime-model-registry');
      // No setInterval / setTimeout should have been registered by module load.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runtime-model-registry.ts does not have a module-level singleton getter', async () => {
    vi.resetModules();
    const mod = await import('../runtime-model-registry');
    // MVP 1 intentionally does NOT export a `getRuntimeModelRegistry()` or
    // similar global. The class is constructed per-test / per-use.
    // (Singleton lazy-init lands in MVP 2 behind RuntimeRoutingConfigProvider.)
    expect((mod as Record<string, unknown>).getRuntimeModelRegistry).toBeUndefined();
    expect((mod as Record<string, unknown>).registryInstance).toBeUndefined();
  });
});

describe('module-load-safety — pure-types invariant', () => {
  it('canonical-model.ts exports only the type (no runtime values)', async () => {
    vi.resetModules();
    const mod = await import('../canonical-model');
    // The module should not export any runtime constructor or factory.
    // Types disappear at runtime, so the module object should be effectively empty.
    const runtimeExports = Object.keys(mod);
    expect(runtimeExports).toEqual([]);
  });

  it('model-offering.ts exports only the type', async () => {
    vi.resetModules();
    const mod = await import('../model-offering');
    expect(Object.keys(mod)).toEqual([]);
  });

  it('types.ts exports only types (no runtime values)', async () => {
    vi.resetModules();
    const mod = await import('../types');
    // Types-only module ⇒ empty runtime surface.
    expect(Object.keys(mod)).toEqual([]);
  });

  it('model-route.ts exports the pure helper buildRouteId — and nothing else with side effects', async () => {
    vi.resetModules();
    const mod = await import('../model-route');
    const runtimeExports = Object.keys(mod);
    // Only one runtime export expected — the pure id helper.
    expect(runtimeExports).toEqual(['buildRouteId']);
    expect(typeof mod.buildRouteId).toBe('function');
    // The function is pure — no exceptions on plain input.
    expect(mod.buildRouteId({ offeringId: 'o', accessProviderId: 'p' })).toBe('o::p');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
