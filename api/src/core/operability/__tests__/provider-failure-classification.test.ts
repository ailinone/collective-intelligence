// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Workstream F (2026-08-17) — typed provider failure classification.
 * Pins the HTTP/codec → state mapping, the quarantine set membership, and
 * the Google credential-type helpers. All fixtures are sanitized shapes,
 * never real credentials.
 */
import { describe, expect, it } from 'vitest';
import {
  QUARANTINE_STATES,
  classifyGoogleCredentialShape,
  classifyProviderFailure,
  extractHttpStatusFromMessage,
} from '../provider-failure-classification';

describe('classifyProviderFailure', () => {
  it('401 → AUTH_INVALID (quarantine)', () => {
    const c = classifyProviderFailure({ httpStatus: 401, message: 'Unauthorized' });
    expect(c.state).toBe('AUTH_INVALID');
    expect(c.quarantine).toBe(true);
  });

  it('401 ACCESS_TOKEN_TYPE_UNSUPPORTED → AUTH_INVALID with credential-type reason', () => {
    const c = classifyProviderFailure({
      httpStatus: 401,
      errorCode: 'ACCESS_TOKEN_TYPE_UNSUPPORTED',
      message: 'Error fetching from https://generativelanguage.googleapis.com/...: [401] Access token type unsupported',
    });
    expect(c.state).toBe('AUTH_INVALID');
    expect(c.reason).toBe('credential_type_mismatch');
    expect(c.quarantine).toBe(true);
  });

  it('missing/not-configured key wording → AUTH_MISSING', () => {
    const c = classifyProviderFailure({ message: 'API key not configured for provider' });
    expect(c.state).toBe('AUTH_MISSING');
    expect(c.quarantine).toBe(true);
  });

  it('402 and credit wording on any status → BILLING_EXHAUSTED', () => {
    expect(classifyProviderFailure({ httpStatus: 402 }).state).toBe('BILLING_EXHAUSTED');
    expect(
      classifyProviderFailure({ httpStatus: 429, message: 'You exceeded your current quota, please check your plan and billing details' }).state
    ).toBe('BILLING_EXHAUSTED');
    expect(
      classifyProviderFailure({ message: 'insufficient credits — please top up' }).state
    ).toBe('BILLING_EXHAUSTED');
  });

  it('helicone-style 429 insufficient credits → BILLING_EXHAUSTED (not rate limit)', () => {
    const c = classifyProviderFailure({
      httpStatus: 429,
      message: '429 insufficient credits',
    });
    expect(c.state).toBe('BILLING_EXHAUSTED');
  });

  it('plain 429 → RATE_LIMITED (not quarantined)', () => {
    const c = classifyProviderFailure({ httpStatus: 429, message: 'Too many requests' });
    expect(c.state).toBe('RATE_LIMITED');
    expect(c.quarantine).toBe(false);
  });

  it('403 suspension / permission denied → ACCOUNT_RESTRICTED', () => {
    expect(
      classifyProviderFailure({ httpStatus: 403, message: 'API key has been suspended, CONSUMER_SUSPENDED' }).state
    ).toBe('ACCOUNT_RESTRICTED');
    expect(classifyProviderFailure({ httpStatus: 403, message: 'permission denied' }).state).toBe(
      'ACCOUNT_RESTRICTED'
    );
  });

  it('bare 403 (no credit wording) → ACCOUNT_RESTRICTED (auth-ish, quarantined)', () => {
    const c = classifyProviderFailure({ httpStatus: 403 });
    expect(c.state).toBe('ACCOUNT_RESTRICTED');
    expect(c.quarantine).toBe(true);
  });

  it('404/410 → PROVIDER_DEAD (quarantined)', () => {
    expect(classifyProviderFailure({ httpStatus: 404, message: 'model not found' }).state).toBe(
      'PROVIDER_DEAD'
    );
    expect(classifyProviderFailure({ httpStatus: 410 }).state).toBe('PROVIDER_DEAD');
  });

  it('400 "model ... not supported" → PROVIDER_DEAD (inworld shape, 2026-08-21)', () => {
    const r = classifyProviderFailure({
      httpStatus: 400,
      message:
        "rpc error: code = InvalidArgument desc = The requested model 'claude-3-5-sonnet' is currently not supported. Please reach out to support@inworld.ai.",
    });
    expect(r.state).toBe('PROVIDER_DEAD');
    expect(r.quarantine).toBe(true);
    // Feature-level wording must NOT be classified dead
    expect(
      classifyProviderFailure({ httpStatus: 400, message: 'streaming is not supported for this endpoint' }).state
    ).not.toBe('PROVIDER_DEAD');
  });

  it('timeouts, network errors, 5xx, 424 → TRANSIENT_FAILURE (not quarantined)', () => {
    for (const signals of [
      { message: 'request timed out after 25000ms' },
      { message: 'fetch failed: ECONNRESET' },
      { httpStatus: 503 },
      { httpStatus: 424, message: 'upstream vendor failed' },
    ]) {
      const c = classifyProviderFailure(signals);
      expect(c.state).toBe('TRANSIENT_FAILURE');
      expect(c.quarantine).toBe(false);
    }
  });

  it('circuit OPEN → CIRCUIT_OPEN (not quarantined)', () => {
    const c = classifyProviderFailure({ circuitState: 'OPEN' });
    expect(c.state).toBe('CIRCUIT_OPEN');
    expect(c.quarantine).toBe(false);
  });

  it('no signals → UNKNOWN', () => {
    expect(classifyProviderFailure({}).state).toBe('UNKNOWN');
  });

  it('QUARANTINE_STATES contains exactly the hard-failure states', () => {
    expect([...QUARANTINE_STATES].sort()).toEqual(
      ['ACCOUNT_RESTRICTED', 'AUTH_INVALID', 'AUTH_MISSING', 'BILLING_EXHAUSTED', 'PROVIDER_DEAD'].sort()
    );
  });
});

describe('extractHttpStatusFromMessage', () => {
  it('extracts "HTTP 401" (hub adapters)', () => {
    expect(extractHttpStatusFromMessage('provider failed: HTTP 401 unauthorized')).toBe(401);
  });
  it('extracts "[401]" (@google/generative-ai SDK bracket shape)', () => {
    expect(extractHttpStatusFromMessage('Error fetching from https://...: [401] API key not valid')).toBe(401);
  });
  it('extracts "status=403"', () => {
    expect(extractHttpStatusFromMessage('request failed status=403')).toBe(403);
  });
  it('returns undefined when no status present', () => {
    expect(extractHttpStatusFromMessage('something broke')).toBeUndefined();
  });
});

describe('classifyGoogleCredentialShape', () => {
  it('classifies shapes without exposing values', () => {
    expect(classifyGoogleCredentialShape('')).toBe('empty');
    expect(classifyGoogleCredentialShape('AIzaSyAAAABBBBBCCCC')).toBe('api_key');
    expect(classifyGoogleCredentialShape('ya29.a0ARrdaM-fake-token')).toBe('oauth_access_token');
    expect(classifyGoogleCredentialShape('eyJhbGciOi.payload.sig')).toBe('jwt');
    expect(
      classifyGoogleCredentialShape(JSON.stringify({ client_email: 'x@y.iam', private_key: 'k' }))
    ).toBe('service_account_json');
    expect(classifyGoogleCredentialShape('random-string')).toBe('unknown');
  });
});
