// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Integration: end-to-end flow showing the near-zero skip eliminates
 * HTTP attempts to known-bad providers.
 *
 * Scenario: provider X fails with 401 once → registry records auth_failed.
 * Subsequent requests to X are skipped near-zero (no HTTP call). Only after
 * the cooldown elapses (or a successful execution flips state) does X
 * receive HTTP traffic again.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyProviderError } from '../error-classification';
import {
  getProviderHealthRegistry,
  resetProviderHealthRegistryForTesting,
} from '../provider-health-registry';
import { shouldSkipNearZero, recordDeadProviderHttpAttempt } from '../skip-near-zero';
import {
  resetMetricCountersForTesting,
  getCounterValueForTesting,
  METRIC_NAMES,
} from '../metrics';

describe('integration: near-zero skip flow', () => {
  beforeEach(() => {
    resetProviderHealthRegistryForTesting();
    resetMetricCountersForTesting();
  });

  it('first failure → registry records → second attempt is skipped without HTTP', () => {
    const reg = getProviderHealthRegistry();
    const httpAttempts: string[] = [];

    // Simulated execution loop: pretend to call HTTP unless skipped.
    function executeOrSkip(providerId: string, modelId: string): 'http' | 'skipped' {
      const skip = shouldSkipNearZero({ providerId, modelId });
      if (skip.skip) {
        return 'skipped';
      }
      httpAttempts.push(`${providerId}:${modelId}`);
      return 'http';
    }

    // First call: no health record yet → HTTP attempted (and fails)
    expect(executeOrSkip('aihubmix', 'gpt-4o-mini')).toBe('http');
    // Record the failure
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
      latencyMs: 250,
    });

    // Subsequent calls: skipped near-zero
    for (let i = 0; i < 50; i++) {
      expect(executeOrSkip('aihubmix', 'gpt-4o-mini')).toBe('skipped');
      expect(executeOrSkip('aihubmix', 'claude-haiku-4-5')).toBe('skipped');
    }

    // Only the original 1 HTTP call happened
    expect(httpAttempts).toHaveLength(1);
    // skip counter incremented exactly 100 times (50 * 2 keys)
    const skipCount = getCounterValueForTesting(METRIC_NAMES.KNOWN_BAD_SKIP_TOTAL, {
      providerId: 'aihubmix',
      reason: 'auth_failed',
    });
    expect(skipCount).toBe(100);
  });

  it('model_not_found on (X, modelA) does NOT poison (X, modelB)', () => {
    const reg = getProviderHealthRegistry();

    // Model A fails with model_not_found
    reg.recordExecution({
      key: { providerId: 'aihubmix', modelId: 'gpt-4o-mini' },
      success: false,
      classification: classifyProviderError(new Error("Model 'gpt-4o-mini' not found")),
    });

    // Model A is skipped
    expect(shouldSkipNearZero({ providerId: 'aihubmix', modelId: 'gpt-4o-mini' }).skip).toBe(true);
    // Model B on same provider is allowed
    expect(shouldSkipNearZero({ providerId: 'aihubmix', modelId: 'claude-haiku-4-5' }).skip).toBe(false);
  });

  it('successful execution flips degraded → healthy after 3 successes', () => {
    const reg = getProviderHealthRegistry();

    // Provider degraded
    reg.recordExecution({
      key: { providerId: 'openai' },
      success: false,
      classification: classifyProviderError({ status: 503 }),
    });
    expect(reg.lookupExact({ providerId: 'openai' })?.state).toBe('degraded');

    // 3 successes → recovered
    reg.recordExecution({ key: { providerId: 'openai' }, success: true, latencyMs: 100 });
    reg.recordExecution({ key: { providerId: 'openai' }, success: true, latencyMs: 100 });
    reg.recordExecution({ key: { providerId: 'openai' }, success: true, latencyMs: 100 });

    expect(reg.lookupExact({ providerId: 'openai' })?.state).toBe('healthy');
    expect(shouldSkipNearZero({ providerId: 'openai' }).skip).toBe(false);
  });

  it('dead_provider_http_attempt counter triggers when skip is bypassed', () => {
    // Hypothetical: a code path forgot to call shouldSkipNearZero. We can
    // detect that by emitting `recordDeadProviderHttpAttempt` post-hoc — the
    // counter staying at zero in steady state is the SLO.
    recordDeadProviderHttpAttempt({ providerId: 'oops', modelId: 'x' }, 'auth_failed');
    const counter = getCounterValueForTesting(METRIC_NAMES.DEAD_PROVIDER_HTTP_ATTEMPT_TOTAL, {
      providerId: 'oops',
      modelId: 'x',
      reason: 'auth_failed',
    });
    expect(counter).toBe(1);
  });

  it('serial fallback chain across 3 known-bad providers stays under 5ms total', () => {
    const reg = getProviderHealthRegistry();
    // Mark 3 providers as known-bad
    for (const p of ['hub-a', 'hub-b', 'hub-c']) {
      reg.recordExecution({
        key: { providerId: p },
        success: false,
        classification: classifyProviderError({ status: 402 }),
      });
    }

    const t0 = performance.now();
    for (const p of ['hub-a', 'hub-b', 'hub-c']) {
      const decision = shouldSkipNearZero({ providerId: p, modelId: 'any-model' });
      expect(decision.skip).toBe(true);
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(5);
  });
});
