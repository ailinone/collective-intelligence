// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Session affinity write hook — "never keep retrying a dead pin" (LOTE AW).
 *
 * `pickSessionAffinityExecution` is the pure decision extracted from
 * `OrchestrationEngine.recordSessionAffinityOutcome()`, unit-tested here in
 * isolation (instantiating the full engine is expensive and unrelated to
 * this decision). This is the regression guard the design calls out
 * alongside `critique-repair-non-regressive.test.ts` — the only other test
 * touching `executeModelWithRetry()`'s fallback-resolved-winner contract —
 * confirming that when a strategy falls over to a DIFFERENT model mid-turn,
 * the write hook records the model that actually won, never the original
 * (possibly dead) candidate blindly at `modelsUsed[0]`.
 */
import { describe, it, expect } from 'vitest';
import { pickSessionAffinityExecution } from '../orchestration-engine';
import type { ModelExecution } from '@/types';

function exec(overrides: Partial<ModelExecution>): ModelExecution {
  return {
    modelId: 'x',
    modelName: 'x',
    role: 'primary',
    request: {} as ModelExecution['request'],
    response: {} as ModelExecution['response'],
    cost: 0,
    durationMs: 0,
    success: true,
    ...overrides,
  };
}

describe('pickSessionAffinityExecution', () => {
  it('picks the FIRST candidate when it succeeded (the common case)', () => {
    const modelsUsed = [
      exec({ modelId: 'winner', provider: 'anthropic', success: true }),
    ];
    expect(pickSessionAffinityExecution(modelsUsed)?.modelId).toBe('winner');
  });

  it('BUG THIS PREVENTS: a dead FIRST candidate must never be the one recorded', () => {
    // executeModelWithRetry() fell over from a dead primary to a working
    // fallback mid-turn. modelsUsed[0] blindly would record the DEAD model
    // as the new pin — poisoning the next turn's session-affinity read to
    // propose the same dead model again. The fix: pick the SUCCESSFUL one.
    const modelsUsed = [
      exec({ modelId: 'dead-provider-model', success: false, error: 'HTTP 503' }),
      exec({ modelId: 'fallback-winner', provider: 'openai', success: true }),
    ];
    const picked = pickSessionAffinityExecution(modelsUsed);
    expect(picked?.modelId).toBe('fallback-winner');
    expect(picked?.modelId).not.toBe('dead-provider-model');
  });

  it('falls back to the first entry with a modelId when NOTHING succeeded (never throws, never silently invents one)', () => {
    const modelsUsed = [
      exec({ modelId: 'attempt-1', success: false }),
      exec({ modelId: 'attempt-2', success: false }),
    ];
    expect(pickSessionAffinityExecution(modelsUsed)?.modelId).toBe('attempt-1');
  });

  it('returns undefined for an empty or missing modelsUsed (write hook then no-ops)', () => {
    expect(pickSessionAffinityExecution([])).toBeUndefined();
    expect(pickSessionAffinityExecution(undefined)).toBeUndefined();
  });

  it('skips an entry with success:true but no modelId', () => {
    const modelsUsed = [
      exec({ modelId: '', success: true }),
      exec({ modelId: 'real-model', success: true }),
    ];
    expect(pickSessionAffinityExecution(modelsUsed)?.modelId).toBe('real-model');
  });
});
