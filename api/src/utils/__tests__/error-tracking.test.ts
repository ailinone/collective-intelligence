// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the Sentry event-scrubbing helpers in error-tracking.ts.
 *
 * This is an LLM router: provider adapters occasionally embed raw
 * request/response body text (prompts, completions, echoed provider error
 * bodies) directly into thrown Error messages — see the "Data-leakage
 * scrubbing" comment above scrubString()/scrubValueDeep() in
 * error-tracking.ts for concrete examples (e.g. client/adapters/openai-adapter.ts
 * "Invalid JSON from OpenAI: <content>"). These helpers are the last line of
 * defense before such text reaches the beforeSend hook and gets shipped to
 * Sentry, so they're tested directly rather than only indirectly through a
 * full Sentry.init() + captureException() round-trip (which would require a
 * live/mocked Sentry client and is exercised only at a higher level, if at
 * all, elsewhere).
 */

import { describe, expect, it } from 'vitest';
import { scrubString, scrubValueDeep } from '../error-tracking';

describe('scrubString', () => {
  it('leaves short, ordinary messages untouched', () => {
    expect(scrubString('Failed to connect to database')).toBe('Failed to connect to database');
  });

  it('redacts sk-... style API keys', () => {
    const input = 'Provider rejected key sk-abc123DEF456_ghi as invalid';
    expect(scrubString(input)).toBe('Provider rejected key sk-*** as invalid');
  });

  it('redacts Bearer ... tokens', () => {
    const input = 'Upstream returned 401 for Bearer abcDEF123.456-_xyz';
    expect(scrubString(input)).toBe('Upstream returned 401 for Bearer ***');
  });

  it('truncates strings longer than the cap and appends a truncation notice', () => {
    const longValue = 'x'.repeat(10_000);
    const result = scrubString(longValue);

    expect(result.length).toBeLessThan(longValue.length);
    expect(result.startsWith('x'.repeat(500))).toBe(true);
    expect(result).toContain('truncated');
  });

  it('simulates a leaked model completion embedded in an error message and confirms it gets capped', () => {
    // Mirrors client/adapters/openai-adapter.ts:
    //   throw new Error(`Invalid JSON from OpenAI: ${content}`)
    // where `content` is the raw model completion text.
    const fakeCompletion = 'Sure, here is the analysis of your proprietary business data: '.repeat(
      50
    );
    const message = `Invalid JSON from OpenAI: ${fakeCompletion}`;

    const scrubbed = scrubString(message);

    expect(scrubbed.length).toBeLessThanOrEqual(600); // 500 cap + truncation notice
    expect(scrubbed.length).toBeLessThan(message.length);
  });
});

describe('scrubValueDeep', () => {
  it('passes through primitives, null, and undefined unchanged (except strings)', () => {
    expect(scrubValueDeep(42)).toBe(42);
    expect(scrubValueDeep(true)).toBe(true);
    expect(scrubValueDeep(null)).toBe(null);
    expect(scrubValueDeep(undefined)).toBe(undefined);
  });

  it('scrubs string leaves inside a nested object', () => {
    const input = {
      requestId: 'req-123',
      nested: {
        note: 'contains sk-verysecretkey123 inline',
      },
    };

    const result = scrubValueDeep(input) as typeof input;

    expect(result.requestId).toBe('req-123');
    expect(result.nested.note).toBe('contains sk-*** inline');
  });

  it('scrubs string entries inside arrays', () => {
    const input = ['fine', 'token Bearer abc123.def456'];
    const result = scrubValueDeep(input) as string[];

    expect(result[0]).toBe('fine');
    expect(result[1]).toBe('token Bearer ***');
  });

  it('does not infinitely recurse or blow the stack on deeply nested objects', () => {
    let deep: Record<string, unknown> = { leaf: 'sk-deepsecretvalue' };
    for (let i = 0; i < 20; i++) {
      deep = { child: deep };
    }

    expect(() => scrubValueDeep(deep)).not.toThrow();
  });
});
