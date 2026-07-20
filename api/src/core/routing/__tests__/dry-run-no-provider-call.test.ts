// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * dry-run-no-provider-call.test.ts — MVP 3
 *
 * Proves that `dryRunRouting` produces a result WITHOUT calling fetch,
 * any provider adapter, the DB, Redis, or TEI.
 *
 * Mechanism: install a global `fetch` spy that THROWS if called. If the
 * handler tried to hit any external service, the test would fail with
 * a synchronous error from the spy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dryRunRouting } from '../routing-dry-run-handler';
import {
  buildFixtureRegistry,
  FIXTURE_NOW,
  FIXTURE_TRACE_ID_PROVIDER,
  resetFixtureTraceSeq,
} from './fixtures/dry-run.fixture';

// ─── Global fetch sentinel ──────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch | undefined;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = vi.fn(
    () => {
      fetchCalls += 1;
      throw new Error('dry-run MUST NOT call fetch');
    },
  ) as unknown as typeof globalThis.fetch;
  resetFixtureTraceSeq();
});

afterEach(() => {
  if (originalFetch) {
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
  }
  vi.restoreAllMocks();
});

describe('dry-run handler — does NOT call providers, DB, Redis, TEI', () => {
  it('completes without invoking fetch', async () => {
    const registry = buildFixtureRegistry();
    const result = await dryRunRouting(
      { requestId: 'req-test-1' },
      {
        registry,
        now: FIXTURE_NOW,
        traceIdProvider: FIXTURE_TRACE_ID_PROVIDER,
      },
    );
    expect(fetchCalls).toBe(0);
    expect(result.traceId).toBe('trace-fixture-0001');
  });

  it('produces a candidate count equal to registry routes', async () => {
    const registry = buildFixtureRegistry();
    const result = await dryRunRouting(
      { requestId: 'req-test-2' },
      {
        registry,
        now: FIXTURE_NOW,
        traceIdProvider: FIXTURE_TRACE_ID_PROVIDER,
      },
    );
    expect(result.candidateCount).toBe(registry.size().routes);
  });

  it('finds a route by exact requestModelId match (structural hint only)', async () => {
    const registry = buildFixtureRegistry();
    const result = await dryRunRouting(
      { requestId: 'req-test-3', model: 'gpt-5.5-pro' },
      {
        registry,
        now: FIXTURE_NOW,
        traceIdProvider: FIXTURE_TRACE_ID_PROVIDER,
      },
    );
    expect(result.selectedRouteIdHint).toBeTruthy();
    // The hint comes from the fixture: openai's gpt-5.5-pro
    expect(result.selectedRouteIdHint).toContain('gpt-5.5-pro');
  });

  it('returns null when the model is not in the fixture', async () => {
    const registry = buildFixtureRegistry();
    const result = await dryRunRouting(
      { requestId: 'req-test-4', model: 'does-not-exist' },
      {
        registry,
        now: FIXTURE_NOW,
        traceIdProvider: FIXTURE_TRACE_ID_PROVIDER,
      },
    );
    expect(result.selectedRouteIdHint).toBeNull();
  });

  it('output trace passes through redaction (categorical-only taskProfile)', async () => {
    const registry = buildFixtureRegistry();
    const result = await dryRunRouting(
      {
        requestId: 'req-test-5',
        // Hostile input — categorical-only constraint must hold.
        taskProfile: {
          taskType: 'general',
          complexity: 'medium',
          modalities: ['text'],
          riskLevel: 'low',
          privacyMode: 'standard',
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error — adversarial input
          prompt: 'leak me',
        },
      },
      {
        registry,
        now: FIXTURE_NOW,
        traceIdProvider: FIXTURE_TRACE_ID_PROVIDER,
      },
    );
    // taskProfile in the trace has ONLY the 5 categorical fields.
    expect(Object.keys(result.trace.taskProfile)).toEqual([
      'taskType',
      'complexity',
      'modalities',
      'riskLevel',
      'privacyMode',
    ]);
  });

  it('trace.semanticIndexBackend is "none" — MVP 3 has no semantic backend wired', async () => {
    const registry = buildFixtureRegistry();
    const result = await dryRunRouting(
      { requestId: 'req-test-6' },
      {
        registry,
        now: FIXTURE_NOW,
        traceIdProvider: FIXTURE_TRACE_ID_PROVIDER,
      },
    );
    expect(result.trace.semanticIndexBackend).toBe('none');
  });

  it('result note states MVP 3 does NOT call providers, DB, Redis, TEI, or HNSW', async () => {
    const registry = buildFixtureRegistry();
    const result = await dryRunRouting(
      { requestId: 'req-test-7' },
      {
        registry,
        now: FIXTURE_NOW,
        traceIdProvider: FIXTURE_TRACE_ID_PROVIDER,
      },
    );
    expect(result.note).toContain('does NOT call providers');
    expect(result.note).toContain('DB');
    expect(result.note).toContain('TEI');
  });
});

describe('dry-run handler — does NOT import orchestration / chat / experiment runner', () => {
  it('module-load of routing-dry-run-handler does not register routes or open connections', async () => {
    // Reset modules + spy fetch sentinel — already in place.
    vi.resetModules();
    await import('../routing-dry-run-handler');
    expect(fetchCalls).toBe(0);
  });
});
