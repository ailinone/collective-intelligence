// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler-determinism.test.ts — MVP 6A
 *
 * Same input ⇒ same output. No clock / random dependency.
 */

import { describe, expect, it, vi } from 'vitest';
import { profileTask } from '../task-profiler';

describe('profileTask — determinism', () => {
  it('1000 iterations of the same input yield byte-identical output', () => {
    const input = {
      requestId: 'r-1',
      text: 'analyze this legal contract for liability',
      approximateInputTokens: 5_000,
      attachments: [{ kind: 'document' as const, approximateTokens: 2_000 }],
    };
    const first = JSON.stringify(profileTask(input));
    for (let i = 0; i < 1000; i += 1) {
      const next = JSON.stringify(profileTask(input));
      if (next !== first) throw new Error(`non-deterministic at iter ${i}`);
    }
    expect(first.length).toBeGreaterThan(0);
  });
});

describe('profileTask — no Date.now / Math.random dependency', () => {
  it('output is identical with different Date.now stubs', () => {
    const input = { requestId: 'r-1', text: 'analyze this' };
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000_000;
      const a = JSON.stringify(profileTask(input));
      Date.now = () => 9_999_999_999;
      const b = JSON.stringify(profileTask(input));
      expect(a).toBe(b);
    } finally {
      Date.now = realNow;
    }
  });

  it('output is identical with different Math.random stubs', () => {
    const input = { requestId: 'r-1', text: 'summarize this' };
    const spy1 = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const a = JSON.stringify(profileTask(input));
    spy1.mockRestore();
    const spy2 = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const b = JSON.stringify(profileTask(input));
    spy2.mockRestore();
    expect(a).toBe(b);
  });
});

describe('profileTask — input is not mutated', () => {
  it('input object is unchanged after profiling', () => {
    const input = {
      requestId: 'r-1',
      text: 'analyze legal contract',
      attachments: [{ kind: 'document' as const, approximateTokens: 100 }],
    };
    const before = JSON.stringify(input);
    profileTask(input);
    const after = JSON.stringify(input);
    expect(after).toBe(before);
  });

  it('policy override is unchanged after profiling', () => {
    const policy = { tokenThresholds: { low: 100, medium: 1_000, high: 10_000, longContext: 5_000 } };
    const before = JSON.stringify(policy);
    profileTask({ requestId: 'r-1', text: 'hi' }, policy);
    const after = JSON.stringify(policy);
    expect(after).toBe(before);
  });
});

describe('profileTask — result arrays are frozen', () => {
  it('requiredCapabilities cannot be mutated', () => {
    const { profile } = profileTask({ requestId: 'r-1', text: 'hi' });
    // requiredCapabilities is frozen — attempting to push throws in strict mode.
    expect(() => {
      (profile.requiredCapabilities as string[]).push('hack');
    }).toThrow();
  });
});
