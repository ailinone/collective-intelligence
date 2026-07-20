// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Strategy 01C.0.3 — structured provider failures.
 *
 * Pins the contract in `provider-failure.ts`:
 *   - buildProviderFailureFromString classifies common error patterns
 *   - source='parsed_string_fallback' when classification came from a string
 *   - source='structured_provider_error' when adapter passed a typed code
 *   - sanitizeErrorString redacts API keys
 */
import { describe, it, expect } from 'vitest';
import {
  buildProviderFailureFromStructured,
  buildProviderFailureFromString,
} from '../../failures/provider-failure';
import { sanitizeErrorString } from '../../failures/provider-failure-code';

describe('buildProviderFailureFromString', () => {
  it('parses 402 → no_credits, retryable=false', () => {
    const f = buildProviderFailureFromString({ raw: 'HTTP 402 Payment Required' });
    expect(f.code).toBe('no_credits');
    expect(f.source).toBe('parsed_string_fallback');
    expect(f.retryable).toBe(false);
  });

  it('parses 401 → auth_failed, retryable=false', () => {
    const f = buildProviderFailureFromString({ raw: 'HTTP 401 Unauthorized' });
    expect(f.code).toBe('auth_failed');
    expect(f.retryable).toBe(false);
  });

  it('parses 429 → rate_limited, retryable=true', () => {
    const f = buildProviderFailureFromString({ raw: 'HTTP 429 Too Many Requests' });
    expect(f.code).toBe('rate_limited');
    expect(f.retryable).toBe(true);
  });

  it('parses timeout → timeout, retryable=true', () => {
    const f = buildProviderFailureFromString({ raw: 'request timed out after 30s' });
    expect(f.code).toBe('timeout');
    expect(f.retryable).toBe(true);
  });

  it('empty string → code=unknown, source=unknown', () => {
    const f = buildProviderFailureFromString({ raw: '' });
    expect(f.code).toBe('unknown');
    expect(f.source).toBe('unknown');
  });

  it('unrecognized string → code=provider_error', () => {
    const f = buildProviderFailureFromString({ raw: 'gateway unstable' });
    expect(f.code).toBe('provider_error');
    expect(f.source).toBe('parsed_string_fallback');
  });

  it('observedAt is an ISO string', () => {
    const f = buildProviderFailureFromString({ raw: 'something' });
    expect(() => new Date(f.observedAt).toISOString()).not.toThrow();
  });
});

describe('buildProviderFailureFromStructured', () => {
  it('preserves the structured code and marks source as structured_provider_error', () => {
    const f = buildProviderFailureFromStructured({
      code: 'no_credits',
      providerId: 'p-a',
      modelId: 'm-1',
      message: 'balance exhausted',
    });
    expect(f.code).toBe('no_credits');
    expect(f.source).toBe('structured_provider_error');
    expect(f.providerId).toBe('p-a');
    expect(f.modelId).toBe('m-1');
  });
});

describe('sanitizeErrorString', () => {
  it('redacts Bearer tokens', () => {
    expect(sanitizeErrorString('Authorization: Bearer sk-abc123XYZ')).toContain('Bearer [redacted]');
  });

  it('redacts api_key=', () => {
    expect(sanitizeErrorString('error with api_key=sk-abc123')).toContain('api_key=[redacted]');
  });

  it('redacts sk-XXX patterns', () => {
    expect(sanitizeErrorString('failed for sk-abc123def456ghi789')).toContain('sk-[redacted]');
  });

  it('caps length at 200', () => {
    expect((sanitizeErrorString('x'.repeat(500)) ?? '').length).toBe(200);
  });

  it('returns undefined for undefined/empty', () => {
    expect(sanitizeErrorString(undefined)).toBeUndefined();
    expect(sanitizeErrorString('')).toBeUndefined();
  });
});
