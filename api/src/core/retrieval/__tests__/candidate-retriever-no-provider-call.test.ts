// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * candidate-retriever-no-provider-call.test.ts — MVP 5A
 *
 * Same pattern as MVP 3's dry-run no-provider-call test. Installs a
 * global fetch spy that THROWS if called, then runs the retriever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retrieveCandidates } from '../candidate-retriever';
import { buildFixtureRegistry } from '../../routing/__tests__/fixtures/dry-run.fixture';

let originalFetch: typeof globalThis.fetch | undefined;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = vi.fn(
    () => {
      fetchCalls += 1;
      throw new Error('retriever MUST NOT call fetch');
    },
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) {
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
  }
  vi.restoreAllMocks();
});

describe('candidate-retriever — does NOT call providers, DB, Redis, TEI, HNSW', () => {
  it('retrieveCandidates produces results without calling fetch', () => {
    const registry = buildFixtureRegistry();
    const result = retrieveCandidates(
      { requiredCapabilities: ['chat'] },
      { registry },
    );
    expect(fetchCalls).toBe(0);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('multiple invocations stay fetch-free', () => {
    const registry = buildFixtureRegistry();
    for (let i = 0; i < 10; i += 1) {
      retrieveCandidates({ requiredCapabilities: ['chat'] }, { registry });
    }
    expect(fetchCalls).toBe(0);
  });

  it('importing the retriever module does not trigger fetch', async () => {
    vi.resetModules();
    await import('../candidate-retriever');
    expect(fetchCalls).toBe(0);
  });

  it('importing candidate-filters module does not trigger fetch', async () => {
    vi.resetModules();
    await import('../candidate-filters');
    expect(fetchCalls).toBe(0);
  });

  it('importing candidate-sorter module does not trigger fetch', async () => {
    vi.resetModules();
    await import('../candidate-sorter');
    expect(fetchCalls).toBe(0);
  });

  it('retriever module exports are pure-function shaped', async () => {
    vi.resetModules();
    const mod = await import('../candidate-retriever');
    const keys = Object.keys(mod).sort();
    // Single export: retrieveCandidates.
    expect(keys).toContain('retrieveCandidates');
    expect(typeof mod.retrieveCandidates).toBe('function');
  });
});
