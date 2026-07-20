// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Freshness scorer tests
 *
 * The c3-pilot-ramp-final pinned `kimi-k2-0905-preview` (Sept 2024 preview)
 * instead of the current `kimi-k2.6` because the resolver sorted only by
 * `contextWindow desc`. These tests pin the contract that, within a
 * family, the freshness comparator orders newer generations ahead of
 * older ones — independent of context window.
 */

import { describe, it, expect } from 'vitest';
import { scoreModelFreshness, compareFreshness, detectFamily } from '../model-freshness';

describe('detectFamily', () => {
  it.each([
    ['gpt-5.5', 'gpt'],
    ['openai/gpt-5.5', 'gpt'],
    ['claude-opus-4-7', 'claude'],
    ['anthropic/claude-3-haiku', 'claude'],
    ['gemini-3.1-pro-preview', 'gemini'],
    ['xai/grok-4-fast-reasoning', 'grok'],
    ['kimi-k2.6', 'kimi'],
    ['kimi-k2-0905-preview', 'kimi'],
    ['k2-0905', 'kimi'],
    ['deepseek-v4-pro', 'deepseek'],
    ['deepseek-r1', 'deepseek'],
    ['mistral-large-latest', 'mistral'],
    ['qwen-3-coder', 'qwen'],
    ['llama-4-405b-instruct', 'llama'],
    ['command-a-reasoning-08-2025', 'command'],
    ['some/random-model', null],
  ])('detects family for %s → %s', (id, expected) => {
    expect(detectFamily(id)).toBe(expected);
  });
});

describe('scoreModelFreshness — within-family ordering', () => {
  it('kimi-k2.6 > kimi-k2-0905-preview (the regression that motivated this)', () => {
    const fresh = scoreModelFreshness('kimi-k2.6');
    const stale = scoreModelFreshness('kimi-k2-0905-preview');
    expect(compareFreshness(fresh, stale)).toBeLessThan(0); // fresh sorts first
  });

  it('kimi-k2.6 stable beats kimi-k2.6-preview at same generation', () => {
    const stable = scoreModelFreshness('kimi-k2.6');
    const preview = scoreModelFreshness('kimi-k2.6-preview');
    expect(stable.generationScore).toBe(preview.generationScore);
    expect(compareFreshness(stable, preview)).toBeLessThan(0);
  });

  it('gpt-5.5 > gpt-4-turbo > gpt-3.5', () => {
    const v55 = scoreModelFreshness('gpt-5.5');
    const v4t = scoreModelFreshness('gpt-4-turbo');
    const v35 = scoreModelFreshness('gpt-3.5-turbo');
    expect(v55.generationScore).toBeGreaterThan(v4t.generationScore);
    expect(v4t.generationScore).toBeGreaterThan(v35.generationScore);
    expect(v35.isDeprecated).toBe(true); // gpt-3.5 is on the deprecated list
  });

  it('claude-opus-4-7 > claude-3-5-sonnet > claude-2', () => {
    const v47 = scoreModelFreshness('claude-opus-4-7');
    const v35 = scoreModelFreshness('claude-3-5-sonnet');
    const v2 = scoreModelFreshness('claude-2.1');
    expect(v47.generationScore).toBeGreaterThan(v35.generationScore);
    expect(v35.generationScore).toBeGreaterThan(v2.generationScore);
    expect(v2.isDeprecated).toBe(true);
  });

  it('deepseek-v4 > deepseek-v3', () => {
    const v4 = scoreModelFreshness('deepseek-v4-pro');
    const v3 = scoreModelFreshness('deepseek-v3');
    expect(v4.generationScore).toBeGreaterThan(v3.generationScore);
  });

  it('cross-family returns 0 (defer to caller secondary sort)', () => {
    const a = scoreModelFreshness('gpt-5.5');
    const b = scoreModelFreshness('claude-opus-4-7');
    expect(compareFreshness(a, b)).toBe(0);
  });

  it('unknown family returns score 0 and degrades gracefully', () => {
    const sig = scoreModelFreshness('some/random-model');
    expect(sig.family).toBe('unknown');
    expect(sig.generationScore).toBe(0);
  });
});

describe('community-fork defenses (regression bugs found in c3-pilot audit)', () => {
  it('Shahradmz/llama8b_SEND_1B-legalbench-3 does NOT score as v8 (8b is parameter count)', () => {
    const sig = scoreModelFreshness('Shahradmz/llama8b_SEND_1B-legalbench-3');
    // "llama8b" with no dash and "b" suffix is parameter count, not version.
    // The required-dash family pattern means this id doesn't even register as llama family.
    expect(sig.family).toBe('unknown');
    expect(sig.generationScore).toBe(0);
  });

  it('Shahradmz/llama8b_SEND_1B-codesearchnet-5 does NOT score as v5 (-5 is iteration number)', () => {
    const sig = scoreModelFreshness('Shahradmz/llama8b_SEND_1B-codesearchnet-5');
    expect(sig.family).toBe('unknown');
    expect(sig.generationScore).toBe(0);
  });

  it('ZMC2019/Qwen7B-Roll-L28E3 does NOT score as v7 (7B is parameter count)', () => {
    const sig = scoreModelFreshness('ZMC2019/Qwen7B-Roll-L28E3');
    expect(sig.family).toBe('unknown');
    expect(sig.generationScore).toBe(0);
  });

  it('deepseek-coder-6.7b-instruct does NOT score as v6.7 (6.7b is parameter count)', () => {
    const sig = scoreModelFreshness('deepseek-coder-6.7b-instruct');
    // Known family deepseek; its specific parser requires v/r prefix.
    // No match → no generic fallback (would otherwise catch "6.7") → score 0.
    expect(sig.family).toBe('deepseek');
    expect(sig.generationScore).toBe(0);
  });

  it('deepseek-v4-pro scores 4 (canonical v-prefix)', () => {
    const sig = scoreModelFreshness('deepseek-v4-pro');
    expect(sig.family).toBe('deepseek');
    expect(sig.generationScore).toBe(4);
  });

  it('anish12/llama-1681_A does NOT score as v1681', () => {
    const sig = scoreModelFreshness('anish12/llama-1681_A');
    // The "1681" must NOT be read as a major version. After-slash strip
    // gives "llama-1681_a"; the parser's single-digit guard rejects
    // matching "-1681-" so generationScore is 0 (or family undetected).
    expect(sig.generationScore).toBeLessThan(10);
  });

  it('meta-llama/Llama-3.3-70B-Instruct scores 3.3', () => {
    const sig = scoreModelFreshness('meta-llama/Llama-3.3-70B-Instruct');
    expect(sig.family).toBe('llama');
    expect(sig.generationScore).toBeCloseTo(3.3, 1);
  });

  it('llama-4-scout-17b-16e-instruct scores 4 (canonical Meta release)', () => {
    const sig = scoreModelFreshness('llama-4-scout-17b-16e-instruct');
    expect(sig.family).toBe('llama');
    expect(sig.generationScore).toBe(4);
  });

  it('llama-4 beats llama-1681 community fork in compare order', () => {
    const v4 = scoreModelFreshness('llama-4-scout');
    const vFork = scoreModelFreshness('anish12/llama-1681_A');
    expect(compareFreshness(v4, vFork)).toBeLessThan(0);
  });
});

describe('date and sequence-token defenses (regression bugs found in ramp-final audit)', () => {
  it('YYYY-MM-DD suffix is NOT read as version 2025', () => {
    const sig = scoreModelFreshness('gpt-4o-mini-tts-2025-03-20');
    // Should score as v4 (single-digit major), not 2025.
    expect(sig.generationScore).toBe(4);
    expect(sig.generationScore).toBeLessThan(100); // sanity
  });

  it('gpt-5.2-pro-2025-12-11 scores 5.2, beats gpt-4o-mini-tts-2025-03-20 (4.0)', () => {
    const v52 = scoreModelFreshness('gpt-5.2-pro-2025-12-11');
    const v4 = scoreModelFreshness('gpt-4o-mini-tts-2025-03-20');
    expect(v52.generationScore).toBe(5.2);
    expect(v4.generationScore).toBe(4);
    expect(compareFreshness(v52, v4)).toBeLessThan(0); // 5.2 sorts first
  });

  it('grok-41-fast (ambiguous "41" sequence) does NOT outscore grok-4.20-non-reasoning', () => {
    const v420 = scoreModelFreshness('grok-4.20-non-reasoning');
    const v41 = scoreModelFreshness('grok-41-fast');
    // Either v41 is treated as unknown (score 0) OR it scores at most ≤ 4.
    expect(v41.generationScore).toBeLessThanOrEqual(v420.generationScore);
  });

  it('kimi-k2-0905-preview "0905" sequence is NOT read as minor version 905', () => {
    const v26 = scoreModelFreshness('kimi-k2.6');
    const v0905 = scoreModelFreshness('kimi-k2-0905-preview');
    // k2-0905 should NOT outrank k2.6 numerically.
    expect(v26.generationScore).toBeGreaterThanOrEqual(v0905.generationScore);
  });
});

describe('preview / deprecated detection', () => {
  it('kimi-k2-0905-preview is flagged as both preview and deprecated', () => {
    const sig = scoreModelFreshness('kimi-k2-0905-preview');
    expect(sig.isPreview).toBe(true);
    expect(sig.isDeprecated).toBe(true);
  });

  it('gpt-4-1106 (legacy snapshot) is flagged deprecated', () => {
    const sig = scoreModelFreshness('gpt-4-1106');
    expect(sig.isDeprecated).toBe(true);
  });

  it('gemini-3.1-pro-preview is preview but not deprecated', () => {
    const sig = scoreModelFreshness('gemini-3.1-pro-preview');
    expect(sig.isPreview).toBe(true);
    expect(sig.isDeprecated).toBe(false);
  });
});
