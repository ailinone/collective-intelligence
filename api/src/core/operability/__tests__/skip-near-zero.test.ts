// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shouldSkipNearZero — hot-path predicate.
 *
 * Performance contract: skip decision under 5ms even with 1000 records
 * in the registry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyProviderError } from '../error-classification';
import {
  getProviderHealthRegistry,
  resetProviderHealthRegistryForTesting,
} from '../provider-health-registry';
import { shouldSkipNearZero } from '../skip-near-zero';

describe('shouldSkipNearZero', () => {
  beforeEach(() => {
    resetProviderHealthRegistryForTesting();
  });

  it('returns skip=false for unknown providers', () => {
    const decision = shouldSkipNearZero({ providerId: 'never-seen' });
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('unknown_health');
  });

  it('returns skip=false for healthy providers', () => {
    const reg = getProviderHealthRegistry();
    reg.recordProbe({ key: { providerId: 'openai' }, state: 'healthy' });
    const decision = shouldSkipNearZero({ providerId: 'openai' });
    expect(decision.skip).toBe(false);
  });

  it('returns skip=true for auth_failed within TTL', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });
    const decision = shouldSkipNearZero({ providerId: 'aihubmix' });
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('auth_failed');
    expect(decision.nextProbeAfter).toBeDefined();
  });

  it('returns skip=true for insufficient_credit within TTL', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 402 }),
    });
    const decision = shouldSkipNearZero({ providerId: 'aihubmix' });
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('insufficient_credit');
  });

  it('model_not_found marks ONLY the (provider, model) tuple', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix', modelId: 'gpt-4o-mini' },
      success: false,
      classification: classifyProviderError(new Error('Model not found')),
    });
    // Same provider, different model → NOT skipped
    const otherModel = shouldSkipNearZero({
      providerId: 'aihubmix',
      modelId: 'claude-haiku-4-5',
    });
    expect(otherModel.skip).toBe(false);
    // Same provider, same model → SKIPPED
    const sameModel = shouldSkipNearZero({
      providerId: 'aihubmix',
      modelId: 'gpt-4o-mini',
    });
    expect(sameModel.skip).toBe(true);
  });

  it('returns skip=false after cooldown elapses', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'openai' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });
    // Move clock past cooldown
    const future = Date.now() + 24 * 60 * 60 * 1000; // +24h (auth_failed cooldown is 6h)
    const decision = shouldSkipNearZero({ providerId: 'openai' }, { now: future });
    expect(decision.skip).toBe(false);
    expect(decision.reason).toContain('cooldown_elapsed');
  });

  it('rate_limited respects retry-after window', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'openai' },
      success: false,
      classification: classifyProviderError({
        status: 429,
        response: { headers: { 'retry-after': '30' } },
      }),
    });
    // Within window → skip
    expect(shouldSkipNearZero({ providerId: 'openai' }).skip).toBe(true);
    // After window → allow
    const after = Date.now() + 31_000;
    expect(shouldSkipNearZero({ providerId: 'openai' }, { now: after }).skip).toBe(false);
  });

  it('context_exceeded does NOT cause skip on provider', () => {
    const reg = getProviderHealthRegistry();
    // context_exceeded has scope=request and shouldRemoveFromCandidatePool=false.
    // Even if recorded with the classification, the registry still records the
    // execution outcome but the resulting state stays healthy.
    reg.recordExecution({
      key: { providerId: 'openai' },
      success: false,
      classification: classifyProviderError(
        new Error('context_length_exceeded'),
      ),
    });
    const decision = shouldSkipNearZero({ providerId: 'openai' });
    expect(decision.skip).toBe(false);
  });

  it('returns skip decision in under 5ms for fatal state', () => {
    const reg = getProviderHealthRegistry();
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });
    // Warm up
    for (let i = 0; i < 10; i++) shouldSkipNearZero({ providerId: 'aihubmix' });
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      shouldSkipNearZero({ providerId: 'aihubmix' });
    }
    const elapsed = performance.now() - t0;
    const perCall = elapsed / 100;
    // Per-call must stay well under 5ms in steady state
    expect(perCall).toBeLessThan(5);
  });

  it('falls back from (providerId, modelId) lookup to provider-level state', () => {
    const reg = getProviderHealthRegistry();
    // Provider-level auth failure
    reg.recordExecution({
      key: { providerId: 'aihubmix' },
      success: false,
      classification: classifyProviderError({ status: 401 }),
    });
    // Lookup with modelId — falls back to provider-level
    const decision = shouldSkipNearZero({
      providerId: 'aihubmix',
      modelId: 'any-model',
    });
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('auth_failed');
  });
});
