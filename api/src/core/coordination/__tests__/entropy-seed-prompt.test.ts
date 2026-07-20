// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests — EntropySeed anti-herding primitive (F1.1)
 *
 * Validates that the optional `entropySeedEnabled` flag on
 * `buildCoordinationSystemPrompt` is purely additive:
 *   - When disabled (default): output identical to legacy callers.
 *   - When enabled: prepended instruction tells the agent to emit a
 *     16-char random string before reasoning, with the string itself
 *     NOT appearing in the structured JSON output.
 *
 * The test does not require a model; it verifies the prompt text only.
 */

import { describe, it, expect } from 'vitest';
import { buildCoordinationSystemPrompt } from '../sensitivity-prompt-adapter';
import { createInitialState } from '../sensitivity-aggregator';
import type { CoordinationLimits } from '../coordination-types';

function defaultLimits(): CoordinationLimits {
  return {
    maxRounds: 3,
    minConvergenceScore: 0.82,
    maxDecisionFlipRate: 0.15,
    maxDissent: 0.35,
    stopOnCriticalRisk: true,
    minValidSignalsPerRound: 2,
    detectStagnation: true,
  };
}

describe('buildCoordinationSystemPrompt — EntropySeed (F1.1)', () => {
  it('default behavior: no entropy-seed preamble (backward compat)', () => {
    const prompt = buildCoordinationSystemPrompt('analyst', 1, undefined);
    expect(prompt).not.toMatch(/16-character random string/i);
    expect(prompt).toContain('You are participating');
    expect(prompt).toContain('"decision"');
    expect(prompt).toContain('"sensitivities"');
  });

  it('entropySeedEnabled=false produces identical output to omitting options', () => {
    const a = buildCoordinationSystemPrompt('analyst', 1, undefined);
    const b = buildCoordinationSystemPrompt('analyst', 1, undefined, { entropySeedEnabled: false });
    expect(a).toBe(b);
  });

  it('entropySeedEnabled=true prepends the EntropySeed instruction', () => {
    const prompt = buildCoordinationSystemPrompt(undefined, 1, undefined, {
      entropySeedEnabled: true,
    });
    expect(prompt).toMatch(/16-character random string/i);
    expect(prompt).toMatch(/diversity seed/i);
    // The instruction must explicitly tell the model NOT to include the
    // seed in the JSON, otherwise the parser would fail.
    expect(prompt).toMatch(/Do not include the random string/i);
  });

  it('EntropySeed appears BEFORE the JSON schema instructions', () => {
    const prompt = buildCoordinationSystemPrompt(undefined, 1, undefined, {
      entropySeedEnabled: true,
    });
    const seedIdx = prompt.search(/16-character random string/i);
    const schemaIdx = prompt.indexOf('"decision"');
    expect(seedIdx).toBeGreaterThan(0);
    expect(schemaIdx).toBeGreaterThan(seedIdx);
  });

  it('preserves round-info section in round 2+', () => {
    const prompt = buildCoordinationSystemPrompt('expert', 2, undefined, {
      entropySeedEnabled: true,
    });
    expect(prompt).toMatch(/round 2/i);
    expect(prompt).toMatch(/16-character random string/i);
  });

  it('preserves coordination-state section when state is supplied', () => {
    const state = createInitialState('run-1', 'sensitivity-consensus', defaultLimits());
    state.round = 1;
    state.variables = {
      test_coverage: {
        value: 0.85,
        confidence: 0.9,
        updatedBy: ['agent-a'],
        rationale: 'historical baseline',
        stability: 0.95,
      },
    };

    const prompt = buildCoordinationSystemPrompt('expert', 2, state, {
      entropySeedEnabled: true,
    });
    expect(prompt).toContain('Established variables');
    expect(prompt).toContain('test_coverage');
    expect(prompt).toMatch(/16-character random string/i);
  });

  it('does not add the EntropySeed when explicitly disabled, even with state', () => {
    const state = createInitialState('run-1', 'sensitivity-consensus', defaultLimits());
    state.round = 2;
    const prompt = buildCoordinationSystemPrompt('expert', 3, state, {
      entropySeedEnabled: false,
    });
    expect(prompt).not.toMatch(/random string/i);
  });
});
