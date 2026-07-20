// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Dead-provider HTTP attempt audit — Strategy C (TIME-WINDOW).
 *
 * Symmetry contract: the audit's bypass detection MUST mirror what
 * `shouldSkipNearZero` would have decided at `attemptedAt`. False
 * positives on legitimate post-cooldown reprobes are forbidden.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyProviderError } from '../error-classification';
import {
  getProviderHealthRegistry,
  resetProviderHealthRegistryForTesting,
} from '../provider-health-registry';
import { resetHealthSyncBusForTesting } from '../health-sync-bus';
import {
  detectBypassForTesting,
  recordHttpOutcome,
  explainHealthState,
  getFatalStatesForTesting,
  getTransientSkipStatesForTesting,
} from '../dead-provider-audit';
import {
  resetMetricCountersForTesting,
  getCounterValueForTesting,
  METRIC_NAMES,
} from '../metrics';

describe('detectBypass — Strategy C (TIME-WINDOW)', () => {
  beforeEach(() => {
    resetProviderHealthRegistryForTesting();
    resetHealthSyncBusForTesting();
    resetMetricCountersForTesting();
  });

  it('returns no_prior_state when registry has no record', () => {
    const result = detectBypassForTesting({
      key: { providerId: 'never-seen' },
      attemptedAt: Date.now(),
      success: false,
    });
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('no_prior_state');
  });

  it('returns state_not_skippable for healthy/degraded states', () => {
    const reg = getProviderHealthRegistry();
    reg.recordProbe({ key: { providerId: 'foo' }, state: 'healthy' });

    const result = detectBypassForTesting({
      key: { providerId: 'foo' },
      attemptedAt: Date.now(),
      success: true,
    });
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('state_not_skippable');
    expect(result.stateAtAttempt).toBe('healthy');
  });

  it('detects bypass when state=auth_failed AND attemptedAt < nextProbeAfter', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });

    // Same instant — well within the 6h auth_failed cooldown
    const result = detectBypassForTesting({
      key: { providerId: 'aihubmix' },
      attemptedAt: Date.now(),
      success: false,
    });
    expect(result.detected).toBe(true);
    expect(result.reason).toBe('bypass_within_cooldown:auth_failed');
    expect(result.stateAtAttempt).toBe('auth_failed');
  });

  it('detects bypass for insufficient_credit within cooldown', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 402 }),
    });

    const result = detectBypassForTesting({
      key: { providerId: 'aihubmix' },
      attemptedAt: Date.now(),
      success: false,
    });
    expect(result.detected).toBe(true);
    expect(result.stateAtAttempt).toBe('insufficient_credit');
  });

  it('detects bypass for transient skip states (rate_limited)', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'openai' },
      success: false,
      classification: classifyProviderError({
        status: 429,
        response: { headers: { 'retry-after': '30' } },
      }),
    });

    const result = detectBypassForTesting({
      key: { providerId: 'openai' },
      attemptedAt: Date.now(),
      success: false,
    });
    expect(result.detected).toBe(true);
    expect(result.stateAtAttempt).toBe('rate_limited');
  });

  it('does NOT flag a legitimate post-cooldown reprobe', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });

    // Simulate attempt 24h later (well past 6h auth_failed cooldown)
    const future = Date.now() + 24 * 60 * 60 * 1000;
    const result = detectBypassForTesting({
      key: { providerId: 'aihubmix' },
      attemptedAt: future,
      success: false,
    });
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('cooldown_elapsed');
    expect(result.stateAtAttempt).toBe('auth_failed');
  });

  it('does NOT flag an attempt against a different model on the same provider', () => {
    const reg = getProviderHealthRegistry();
    // Mark only (aihubmix, gpt-4o-mini) — not the whole provider
    reg.recordExecution({
      key: { providerId: 'aihubmix', modelId: 'gpt-4o-mini' },
      success: false,
      classification: classifyProviderError(new Error('Model not found')),
    });

    // Attempt against (aihubmix, claude-haiku-4-5) — different model
    const result = detectBypassForTesting({
      key: { providerId: 'aihubmix', modelId: 'claude-haiku-4-5' },
      attemptedAt: Date.now(),
      success: false,
    });
    // The registry's lookup falls back to provider-level; provider-level
    // doesn't exist → no_prior_state.
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('no_prior_state');
  });

  it('flags when provider-level state is fatal even for unrelated model lookups', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix' }, // provider-level
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });

    // Lookup for (aihubmix, gpt-4o-mini) falls back to provider-level
    const result = detectBypassForTesting({
      key: { providerId: 'aihubmix', modelId: 'gpt-4o-mini' },
      attemptedAt: Date.now(),
      success: false,
    });
    expect(result.detected).toBe(true);
    expect(result.stateAtAttempt).toBe('auth_failed');
  });
});

describe('recordHttpOutcome — telemetry side effects', () => {
  beforeEach(() => {
    resetProviderHealthRegistryForTesting();
    resetHealthSyncBusForTesting();
    resetMetricCountersForTesting();
  });

  it('increments dead_provider_http_attempt_total when bypass is detected', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });

    recordHttpOutcome({
      key: { providerId: 'aihubmix' },
      attemptedAt: Date.now(),
      success: false,
      source: 'orchestrator_primary',
    });

    // Counter labels include the reason string from the detector,
    // which embeds the state for diagnostic clarity.
    const counter = getCounterValueForTesting(
      METRIC_NAMES.DEAD_PROVIDER_HTTP_ATTEMPT_TOTAL,
      { providerId: 'aihubmix', modelId: '', reason: 'bypass_within_cooldown:auth_failed' },
    );
    expect(counter).toBe(1);
  });

  it('does NOT increment when state is healthy', () => {
    const reg = getProviderHealthRegistry();
    reg.recordProbe({ key: { providerId: 'foo' }, state: 'healthy' });

    recordHttpOutcome({
      key: { providerId: 'foo' },
      attemptedAt: Date.now(),
      success: true,
    });

    // Healthy state never triggers the audit increment, regardless of
    // which reason label we look up — count any (foo, *) entry.
    const all = getCounterValueForTesting(
      METRIC_NAMES.DEAD_PROVIDER_HTTP_ATTEMPT_TOTAL,
      { providerId: 'foo', modelId: '', reason: 'bypass_within_cooldown:auth_failed' },
    );
    expect(all).toBe(0);
  });

  it('never throws — caller failures must not propagate', () => {
    expect(() => {
      recordHttpOutcome({
        key: { providerId: 'whatever' },
        attemptedAt: Date.now(),
        success: false,
      });
    }).not.toThrow();
  });
});

describe('explainHealthState — diagnostic helper', () => {
  beforeEach(() => {
    resetProviderHealthRegistryForTesting();
    resetHealthSyncBusForTesting();
  });

  it('returns unknown when no record exists', () => {
    const e = explainHealthState({ providerId: 'never-seen' });
    expect(e.state).toBe('unknown');
    expect(e.isFatal).toBe(false);
    expect(e.isTransientSkip).toBe(false);
  });

  it('returns state + cooldown remaining for fatal records', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });

    const e = explainHealthState({ providerId: 'aihubmix' });
    expect(e.state).toBe('auth_failed');
    expect(e.isFatal).toBe(true);
    expect(e.isTransientSkip).toBe(false);
    expect(e.cooldownRemainingMs).toBeGreaterThan(60 * 60 * 1000); // > 1h
  });

  it('returns cooldownRemainingMs=0 for elapsed cooldowns', () => {
    const reg = getProviderHealthRegistry();
    reg.recordProbe({
      key: { providerId: 'past-cooldown' },
      state: 'rate_limited',
    });
    // Advance the next-probe-after marker by overwriting
    const record = reg.lookupExact({ providerId: 'past-cooldown' });
    expect(record).toBeDefined();
    if (!record) return;
    record.nextProbeAfter = new Date(Date.now() - 1_000).toISOString();

    const e = explainHealthState({ providerId: 'past-cooldown' });
    expect(e.cooldownRemainingMs).toBe(0);
  });
});

describe('FATAL_STATES + TRANSIENT_SKIP_STATES symmetry with skip-near-zero', () => {
  it('FATAL_STATES contains exactly the auth/credit/notfound/disabled states', () => {
    const fatal = getFatalStatesForTesting();
    expect(fatal.has('auth_failed')).toBe(true);
    expect(fatal.has('insufficient_credit')).toBe(true);
    expect(fatal.has('endpoint_not_found')).toBe(true);
    expect(fatal.has('model_not_found')).toBe(true);
    expect(fatal.has('permanently_disabled')).toBe(true);
    // Healthy and probing are NOT fatal
    expect(fatal.has('healthy')).toBe(false);
    expect(fatal.has('probing')).toBe(false);
  });

  it('TRANSIENT_SKIP_STATES contains rate_limited / timeout_suspected / temporarily_disabled', () => {
    const transient = getTransientSkipStatesForTesting();
    expect(transient.has('rate_limited')).toBe(true);
    expect(transient.has('timeout_suspected')).toBe(true);
    expect(transient.has('temporarily_disabled')).toBe(true);
    // Fatal states are NOT in transient
    expect(transient.has('auth_failed')).toBe(false);
  });
});
