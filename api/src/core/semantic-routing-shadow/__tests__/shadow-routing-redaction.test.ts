// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-redaction.test.ts — MVP 8C.0
 */

import { describe, expect, it } from 'vitest';
import {
  __forTesting,
  hashIdentifier,
  redactPayload,
  scrubString,
} from '../shadow-routing-redaction';

describe('scrubString', () => {
  it('redacts email patterns', () => {
    expect(scrubString('user@example.com')).toBe('[REDACTED]');
    expect(scrubString('contact me at hello@foo.co.uk please')).toBe(
      'contact me at [REDACTED] please',
    );
  });

  it('redacts phone-number digit body when there are >= 9 digits', () => {
    // The regex may leave a country-code prefix or formatting, but
    // the actual phone digit body must be replaced.
    expect(scrubString('+55 11 91234-5678')).not.toContain('91234');
    expect(scrubString('(415) 555-0123')).not.toContain('5550123');
    expect(scrubString('(415) 555-0123')).not.toContain('555-0123');
  });

  it('leaves short numeric tokens intact (route ids, percentiles)', () => {
    expect(scrubString('p99 latency 42')).toBe('p99 latency 42');
  });

  it('handles empty string', () => {
    expect(scrubString('')).toBe('');
  });
});

describe('hashIdentifier', () => {
  it('returns deterministic 8-char hex', () => {
    const a = hashIdentifier('my-secret-model-id');
    const b = hashIdentifier('my-secret-model-id');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces different hashes for different inputs', () => {
    const a = hashIdentifier('claude-opus-4');
    const b = hashIdentifier('gpt-5');
    expect(a).not.toBe(b);
  });

  it('returns undefined for empty/undefined input', () => {
    expect(hashIdentifier('')).toBeUndefined();
    expect(hashIdentifier(undefined)).toBeUndefined();
  });
});

describe('redactPayload', () => {
  it('strips forbidden top-level keys', () => {
    const r = redactPayload({
      requestId: 'r1',
      prompt: 'SECRET',
      messages: ['SECRET'],
      rawContext: 'SECRET',
      attachments: [],
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('"prompt"');
    expect(json).not.toContain('"messages"');
    expect(json).not.toContain('"rawContext"');
    expect(json).not.toContain('"attachments"');
  });

  it('strips forbidden keys at nested levels', () => {
    const r = redactPayload({
      requestId: 'r1',
      meta: { prompt: 'SECRET', otherField: 'safe' },
    });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(JSON.stringify(r)).toContain('safe');
  });

  it('scrubs email patterns inside string leaves', () => {
    const r = redactPayload({ note: 'send to user@example.com' });
    expect(JSON.stringify(r)).not.toContain('user@example.com');
  });

  it('preserves numbers and booleans', () => {
    const r = redactPayload({ latencyMs: 12, success: true });
    expect((r as { latencyMs: number }).latencyMs).toBe(12);
    expect((r as { success: boolean }).success).toBe(true);
  });

  it('handles arrays of strings', () => {
    const r = redactPayload({
      ids: ['route-a', 'route-b', 'user@example.com'],
    });
    expect(Array.isArray((r as { ids: unknown[] }).ids)).toBe(true);
    expect((r as { ids: string[] }).ids[2]).not.toContain('@');
  });

  it('exports the forbidden-keys set for verification', () => {
    expect(__forTesting.FORBIDDEN_KEYS.has('prompt')).toBe(true);
    expect(__forTesting.FORBIDDEN_KEYS.has('messages')).toBe(true);
    expect(__forTesting.FORBIDDEN_KEYS.has('apiKey')).toBe(true);
    expect(__forTesting.FORBIDDEN_KEYS.has('authorization')).toBe(true);
  });
});
