// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for ProviderOperabilityHub bootstrap from catalog.
 *
 * The fix (2026-05-11): the hub used to be empty at boot because it
 * only tracked runtime events. Pre-dispatch validators saw the empty
 * summary and mis-classified it as "no_eligible_providers" — a permanent
 * verdict that blocked every C3 execution before any provider call.
 *
 * After the fix, the hub has a `bootstrapKnownProviders()` method that
 * seeds catalog providers as `unknown` so `getSummary()` reports a
 * baseline state even when no runtime calls have fired.
 */

import { describe, it, expect, beforeEach } from 'vitest';

describe('ProviderOperabilityHub.bootstrapKnownProviders', () => {
  // Re-import to get a fresh-ish instance state per test. The hub is a
  // module-level singleton, so we work with what we have and assert
  // about *deltas*, not absolute counts.
  beforeEach(async () => {
    // No-op — singleton state carries across tests intentionally.
  });

  it('adds providers as unknown so getSummary() is non-empty', async () => {
    const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
    const hub = getProviderOperabilityHub();
    const before = hub.getKnownProviderCount();

    const result = hub.bootstrapKnownProviders(
      ['test-provider-bootstrap-1', 'test-provider-bootstrap-2'],
      'unit_test',
    );

    expect(result.added).toBeGreaterThanOrEqual(0); // could be 0 if already seeded
    expect(result.total).toBeGreaterThanOrEqual(2);

    const summary = hub.getSummary();
    const known = [...summary.healthy, ...summary.unknown, ...summary.degraded,
      ...summary.recovering, ...summary.no_credits, ...summary.rate_limited,
      ...summary.auth_failed, ...summary.temporarily_unavailable];
    expect(known).toContain('test-provider-bootstrap-1');
    expect(known).toContain('test-provider-bootstrap-2');
    // Both should be in `unknown` because no runtime events have fired.
    expect(summary.unknown).toContain('test-provider-bootstrap-1');
    expect(summary.unknown).toContain('test-provider-bootstrap-2');

    expect(hub.getKnownProviderCount()).toBeGreaterThan(before);
  });

  it('is idempotent — re-bootstrap reports alreadyKnown, no double-counting', async () => {
    const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
    const hub = getProviderOperabilityHub();

    hub.bootstrapKnownProviders(['test-idempotent-1'], 'unit_test');
    const after1 = hub.getKnownProviderCount();
    const result2 = hub.bootstrapKnownProviders(['test-idempotent-1'], 'unit_test');
    const after2 = hub.getKnownProviderCount();

    expect(result2.added).toBe(0);
    expect(result2.alreadyKnown).toBe(1);
    expect(after2).toBe(after1);
  });

  it('case-insensitive: TEST-Foo and test-foo are the same provider', async () => {
    const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
    const hub = getProviderOperabilityHub();
    const before = hub.getKnownProviderCount();

    hub.bootstrapKnownProviders(['Test-Case-Provider'], 'unit_test');
    const result = hub.bootstrapKnownProviders(['TEST-CASE-PROVIDER'], 'unit_test');

    expect(result.alreadyKnown).toBe(1);
    expect(hub.getKnownProviderCount() - before).toBe(1);
  });

  it('getKnownProviderSources reports provenance', async () => {
    const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
    const hub = getProviderOperabilityHub();

    hub.bootstrapKnownProviders(['test-source-provider'], 'unit_test_source');
    const sources = hub.getKnownProviderSources();
    expect(sources['test-source-provider']).toBeDefined();
    expect(sources['test-source-provider'].source).toBe('unit_test_source');
    expect(typeof sources['test-source-provider'].addedAt).toBe('number');
  });

  it('runtime event WINS over bootstrap unknown (runtime is observation, bootstrap is floor)', async () => {
    const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
    const hub = getProviderOperabilityHub();

    hub.bootstrapKnownProviders(['test-precedence-provider'], 'unit_test');
    // Without runtime events, should be 'unknown'.
    expect(hub.getProviderState('test-precedence-provider').operabilityState).toBe('unknown');

    // Record a successful execution. Now state should be 'healthy'.
    hub.recordExecution('test-precedence-provider', true);
    expect(hub.getProviderState('test-precedence-provider').operabilityState).toBe('healthy');

    // Bootstrap should be a no-op now — already known.
    const result = hub.bootstrapKnownProviders(['test-precedence-provider'], 'unit_test');
    expect(result.added).toBe(0);
    // State stays healthy — bootstrap doesn't override observations.
    expect(hub.getProviderState('test-precedence-provider').operabilityState).toBe('healthy');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Pre-dispatch validator: differentiates empty hub vs all-fatal hub.
// ──────────────────────────────────────────────────────────────────────

describe('pre-dispatch validator vs hub state', () => {
  it('seeded providers in unknown bucket pass pre-dispatch (usable)', async () => {
    const { getProviderOperabilityHub } = await import('@/core/provider-operability-hub');
    const { validatePreDispatch } = await import('@/core/experiment/pre-dispatch-validator');

    const hub = getProviderOperabilityHub();
    hub.bootstrapKnownProviders(['test-validator-provider'], 'unit_test');

    const result = validatePreDispatch({
      strategyName: 'single',
      strategyMinModels: 1,
      strategyTimeoutMs: 60_000,
      chatEligiblePoolSize: 100,
    });

    expect(result.canProceed).toBe(true);
    expect(result.usableProviders.length).toBeGreaterThanOrEqual(1);
  });
});
