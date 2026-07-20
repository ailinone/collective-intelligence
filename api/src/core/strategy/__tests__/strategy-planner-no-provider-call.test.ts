// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * strategy-planner-no-provider-call.test.ts — MVP 5B
 *
 * Installs a global fetch spy that THROWS. Then runs the planner.
 * If the planner tried to hit any external service the test would
 * fail synchronously.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planStrategy } from '../strategy-planner';
import {
  CHEAP_CONTEXT,
  HIGH_RISK_CONTEXT,
  STANDARD_CONTEXT,
  makeResult,
} from './fixtures/strategy-fixtures';

let originalFetch: typeof globalThis.fetch | undefined;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = vi.fn(
    () => {
      fetchCalls += 1;
      throw new Error('planner MUST NOT call fetch');
    },
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) {
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
  }
  vi.restoreAllMocks();
});

describe('planStrategy — does NOT call fetch / DB / TEI / HNSW / Redis', () => {
  it('default single_best path never calls fetch', () => {
    planStrategy({
      candidates: [makeResult({ routeId: 'r-1' })],
      context: STANDARD_CONTEXT,
    });
    expect(fetchCalls).toBe(0);
  });

  it('consensus collective path never calls fetch', () => {
    planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1' }),
        makeResult({ routeId: 'r-2' }),
        makeResult({ routeId: 'r-3' }),
      ],
      context: HIGH_RISK_CONTEXT,
    });
    expect(fetchCalls).toBe(0);
  });

  it('cost_cascade path never calls fetch', () => {
    planStrategy({
      candidates: [
        makeResult({ routeId: 'r-1' }),
        makeResult({ routeId: 'r-2' }),
      ],
      context: CHEAP_CONTEXT,
    });
    expect(fetchCalls).toBe(0);
  });

  it('1000 invocations stay fetch-free', () => {
    for (let i = 0; i < 1000; i += 1) {
      planStrategy({
        candidates: [makeResult({ routeId: 'r-1' })],
        context: STANDARD_CONTEXT,
      });
    }
    expect(fetchCalls).toBe(0);
  });
});

describe('strategy module-load safety', () => {
  it('importing strategy-planner.ts does not call fetch', async () => {
    vi.resetModules();
    await import('../strategy-planner');
    expect(fetchCalls).toBe(0);
  });

  it('importing strategy-policy.ts does not call fetch', async () => {
    vi.resetModules();
    await import('../strategy-policy');
    expect(fetchCalls).toBe(0);
  });

  it('importing strategy-plan-validator.ts does not call fetch', async () => {
    vi.resetModules();
    await import('../strategy-plan-validator');
    expect(fetchCalls).toBe(0);
  });

  it('importing strategy-decision-trace.ts does not call fetch', async () => {
    vi.resetModules();
    await import('../strategy-decision-trace');
    expect(fetchCalls).toBe(0);
  });
});
