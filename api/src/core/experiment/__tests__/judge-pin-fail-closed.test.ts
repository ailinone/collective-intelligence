// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Pinned-judge fail-closed guard.
 *
 * The judge dispatches through the /v1/chat/completions router with the
 * pinned id as a SOFT `model` hint. When the pinned model isn't in the
 * operational pool, SingleModelStrategy silently falls through to
 * DynamicModelSelector and a DIFFERENT model answers — DB forensics found
 * meta-llama/Llama-3.3-70B grading ~74% of a run whose pin was
 * qwen/qwen3.6-plus:free. A substituted judge is a different scoring
 * instrument, so `judgeModelMatchesPin` gates the score: only when the
 * responder canonically equals the pin is the verdict trusted; otherwise
 * the row is voided (judgeResponse breaks to its failure path).
 *
 * This tests the pure identity comparator that backs the guard.
 */
import { describe, it, expect } from 'vitest';
import { judgeModelMatchesPin } from '../experiment-runner';

describe('judgeModelMatchesPin', () => {
  it('matches an exact id', () => {
    expect(judgeModelMatchesPin('qwen/qwen3.6-plus', 'qwen/qwen3.6-plus')).toBe(true);
  });

  it('matches when the hub echoes a :free variant tag the pin omitted', () => {
    expect(judgeModelMatchesPin('qwen/qwen3.6-plus:free', 'qwen/qwen3.6-plus')).toBe(true);
    expect(judgeModelMatchesPin('qwen/qwen3.6-plus', 'qwen/qwen3.6-plus:free')).toBe(true);
  });

  it('matches when one side carries a provider prefix and the other does not', () => {
    expect(judgeModelMatchesPin('qwen3.6-plus', 'qwen/qwen3.6-plus')).toBe(true);
    expect(judgeModelMatchesPin('provider-x/qwen3.6-plus', 'qwen3.6-plus')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(judgeModelMatchesPin('QWEN/Qwen3.6-Plus', 'qwen/qwen3.6-plus')).toBe(true);
  });

  it('REJECTS a genuinely different model (the substitution bug)', () => {
    // The exact production substitution: pin was qwen, but Llama answered.
    expect(judgeModelMatchesPin('meta-llama/Llama-3.3-70B-Instruct', 'qwen/qwen3.6-plus:free')).toBe(false);
    expect(judgeModelMatchesPin('zai-org/GLM-5.2', 'qwen/qwen3.6-plus:free')).toBe(false);
    expect(judgeModelMatchesPin('google/gemma-4-31B-it', 'qwen/qwen3.6-plus:free')).toBe(false);
  });

  it('fails closed when the responder is unverifiable (no model echoed)', () => {
    expect(judgeModelMatchesPin(undefined, 'qwen/qwen3.6-plus:free')).toBe(false);
    expect(judgeModelMatchesPin('', 'qwen/qwen3.6-plus:free')).toBe(false);
  });

  it('does not confuse two different models that share a provider', () => {
    expect(judgeModelMatchesPin('qwen/qwen2.5-72b', 'qwen/qwen3.6-plus')).toBe(false);
  });
});
