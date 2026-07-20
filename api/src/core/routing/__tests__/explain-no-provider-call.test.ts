// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * explain-no-provider-call.test.ts — MVP 3
 *
 * Same invariant as `dry-run-no-provider-call.test.ts` but for the
 * `explainRouting` handler. Asserts:
 *   - No fetch.
 *   - Pure registry-driven resolution.
 *   - Correct structural lookup for canonical / offering / route paths.
 *   - `not_found` when id is absent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { explainRouting } from '../routing-explain-handler';
import { buildFixtureRegistry } from './fixtures/dry-run.fixture';

let originalFetch: typeof globalThis.fetch | undefined;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = vi.fn(
    () => {
      fetchCalls += 1;
      throw new Error('explain MUST NOT call fetch');
    },
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) {
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
  }
  vi.restoreAllMocks();
});

describe('explain handler — does NOT call providers, DB, Redis, TEI', () => {
  it('resolves a canonical model by id without fetch', async () => {
    const registry = buildFixtureRegistry();
    const result = await explainRouting(
      { canonicalModelId: 'anthropic:claude-opus-4-7' },
      { registry },
    );
    expect(fetchCalls).toBe(0);
    expect(result.resolvedKind).toBe('canonical');
    expect(result.canonical?.canonicalModelId).toBe('anthropic:claude-opus-4-7');
    expect(result.offerings.length).toBeGreaterThan(0);
    expect(result.routes.length).toBeGreaterThan(0);
  });

  it('resolves an offering by id', async () => {
    const registry = buildFixtureRegistry();
    const result = await explainRouting(
      { offeringId: 'uid-anthropic-claude-opus-4-7' },
      { registry },
    );
    expect(result.resolvedKind).toBe('offering');
    expect(result.canonical?.canonicalModelId).toBe('anthropic:claude-opus-4-7');
    expect(result.routes.length).toBe(1); // 1 route per offering in MVP 2
  });

  it('resolves a route by id', async () => {
    const registry = buildFixtureRegistry();
    const routeId = 'uid-anthropic-claude-opus-4-7::anthropic';
    const result = await explainRouting({ routeId }, { registry });
    expect(result.resolvedKind).toBe('route');
    expect(result.canonical?.canonicalModelId).toBe('anthropic:claude-opus-4-7');
  });

  it('returns not_found for unknown ids', async () => {
    const registry = buildFixtureRegistry();
    const result = await explainRouting(
      { canonicalModelId: 'does-not-exist' },
      { registry },
    );
    expect(result.resolvedKind).toBe('not_found');
    expect(result.canonical).toBeNull();
    expect(result.offerings).toEqual([]);
    expect(result.routes).toEqual([]);
  });

  it('returns not_found when NO id is provided', async () => {
    const registry = buildFixtureRegistry();
    const result = await explainRouting({}, { registry });
    expect(result.resolvedKind).toBe('not_found');
  });

  it('resolves by priority: routeId > offeringId > canonicalModelId', async () => {
    const registry = buildFixtureRegistry();
    const routeId = 'uid-anthropic-claude-opus-4-7::anthropic';
    const result = await explainRouting(
      {
        routeId,
        offeringId: 'uid-anthropic-claude-opus-4-7',
        canonicalModelId: 'anthropic:claude-opus-4-7',
      },
      { registry },
    );
    // When all three are provided, routeId resolves first.
    expect(result.resolvedKind).toBe('route');
  });

  it('returns the same canonical for an offering and its parent canonical', async () => {
    const registry = buildFixtureRegistry();
    const offeringResult = await explainRouting(
      { offeringId: 'uid-anthropic-claude-opus-4-7' },
      { registry },
    );
    const canonicalResult = await explainRouting(
      { canonicalModelId: 'anthropic:claude-opus-4-7' },
      { registry },
    );
    expect(offeringResult.canonical?.canonicalModelId).toBe(
      canonicalResult.canonical?.canonicalModelId,
    );
  });

  it('note explicitly states MVP 3 structural-only', async () => {
    const registry = buildFixtureRegistry();
    const result = await explainRouting(
      { canonicalModelId: 'anthropic:claude-opus-4-7' },
      { registry },
    );
    expect(result.note).toContain('MVP 3');
    expect(result.note.toLowerCase()).toContain('structural');
  });
});

describe('explain handler — module-load safety', () => {
  it('importing routing-explain-handler does not call fetch', async () => {
    vi.resetModules();
    await import('../routing-explain-handler');
    expect(fetchCalls).toBe(0);
  });

  it('importing routing-admin-routes does not register anything (factory only)', async () => {
    vi.resetModules();
    const mod = await import('../../../routes/admin/routing-admin-routes');
    // Module exports ONLY the factory — no runtime router, no side effects.
    const keys = Object.keys(mod).sort();
    expect(keys).toEqual(['createRoutingAdminRoutes']);
    expect(fetchCalls).toBe(0);
  });
});
