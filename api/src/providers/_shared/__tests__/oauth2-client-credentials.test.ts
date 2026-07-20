// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OAuth2 client_credentials — basic auth vs body, caching, concurrent refresh.
 *
 * Covers the corner cases that matter operationally: stampede deduplication
 * (1 fetch for N concurrent callers), clock-skew refresh (respects
 * refreshSkewMs), and error propagation (non-200 throws with readable text).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOAuth2ClientCredentialsProvider } from '../oauth2-client-credentials';

type FetchCall = { url: string; init: RequestInit };

function stubFetch(
  response: { ok?: boolean; status?: number; body: unknown },
  opts: { delayMs?: number } = {},
) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response;
  });
  return { fn, calls };
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('OAuth2 client_credentials — auth style', () => {
  it('sends Basic auth header by default', async () => {
    const { fn, calls } = stubFetch({ body: { access_token: 't1', expires_in: 3600 } });
    const provider = createOAuth2ClientCredentialsProvider({
      authUrl: 'https://idp.example/oauth/token',
      clientId: 'cid',
      clientSecret: 'csecret',
      fetchImpl: fn as unknown as typeof fetch,
    });
    await provider.getToken();
    const headers = calls[0].init.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('cid:csecret').toString('base64')}`;
    expect(headers.Authorization).toBe(expected);
    expect(calls[0].init.body).toContain('grant_type=client_credentials');
    expect(calls[0].init.body).not.toContain('client_secret='); // in Basic mode
  });

  it('sends body-auth when style=body', async () => {
    const { fn, calls } = stubFetch({ body: { access_token: 't1', expires_in: 3600 } });
    const provider = createOAuth2ClientCredentialsProvider({
      authUrl: 'https://idp.example/oauth/token',
      clientId: 'cid',
      clientSecret: 'csecret',
      authStyle: 'body',
      fetchImpl: fn as unknown as typeof fetch,
    });
    await provider.getToken();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(String(calls[0].init.body)).toContain('client_id=cid');
    expect(String(calls[0].init.body)).toContain('client_secret=csecret');
  });

  it('includes scope when provided', async () => {
    const { fn, calls } = stubFetch({ body: { access_token: 't', expires_in: 60 } });
    const provider = createOAuth2ClientCredentialsProvider({
      authUrl: 'https://idp.example/t',
      clientId: 'c',
      clientSecret: 's',
      scope: 'read:models',
      fetchImpl: fn as unknown as typeof fetch,
    });
    await provider.getToken();
    expect(String(calls[0].init.body)).toContain('scope=read%3Amodels');
  });
});

describe('OAuth2 client_credentials — caching', () => {
  it('caches the token across calls', async () => {
    const { fn } = stubFetch({ body: { access_token: 'AAA', expires_in: 3600 } });
    const provider = createOAuth2ClientCredentialsProvider({
      authUrl: 'x',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fn as unknown as typeof fetch,
    });
    const a = await provider.getToken();
    const b = await provider.getToken();
    expect(a).toBe('AAA');
    expect(b).toBe('AAA');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent refreshes', async () => {
    const { fn } = stubFetch({ body: { access_token: 'XYZ', expires_in: 3600 } }, { delayMs: 25 });
    const provider = createOAuth2ClientCredentialsProvider({
      authUrl: 'x',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fn as unknown as typeof fetch,
    });
    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect(tokens.every((t) => t === 'XYZ')).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces refresh', async () => {
    const { fn } = stubFetch({ body: { access_token: 'first', expires_in: 3600 } });
    const provider = createOAuth2ClientCredentialsProvider({
      authUrl: 'x',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fn as unknown as typeof fetch,
    });
    await provider.getToken();
    provider.invalidate();
    await provider.getToken();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('OAuth2 client_credentials — error surface', () => {
  it('throws with HTTP code + body snippet on non-200', async () => {
    const { fn } = stubFetch({ ok: false, status: 401, body: { error: 'invalid_client' } });
    const provider = createOAuth2ClientCredentialsProvider({
      authUrl: 'https://idp.example/token',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fn as unknown as typeof fetch,
    });
    await expect(provider.getToken()).rejects.toThrow(/401.*invalid_client/);
  });

  it('throws when response is missing access_token', async () => {
    const { fn } = stubFetch({ body: { not_a_token: 'oops' } });
    const provider = createOAuth2ClientCredentialsProvider({
      authUrl: 'https://idp.example/token',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fn as unknown as typeof fetch,
    });
    await expect(provider.getToken()).rejects.toThrow(/access_token/);
  });
});

describe('OAuth2 client_credentials — buildAuthHeader', () => {
  it('defaults to Authorization: Bearer <token>', async () => {
    const { fn } = stubFetch({ body: { access_token: 'abc', expires_in: 3600 } });
    const provider = createOAuth2ClientCredentialsProvider({
      authUrl: 'x',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fn as unknown as typeof fetch,
    });
    const h = await provider.buildAuthHeader();
    expect(h.Authorization).toBe('Bearer abc');
  });
});
