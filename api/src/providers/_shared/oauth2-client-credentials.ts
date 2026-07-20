// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * OAuth2 Client Credentials — RFC 6749 §4.4 token provider.
 *
 * For server-to-server flows where a service holds `client_id` + `client_secret`
 * and trades them at a token endpoint for a short-lived bearer. Used by:
 *
 *   - SAP Generative AI Hub (XSUAA tenant token endpoint)
 *   - Azure AD service principals (with tenant + resource in the body)
 *   - Cognito app clients
 *   - Generic OAuth2 providers that speak the standard
 *
 * ### Wire contract
 *
 *   POST ${authUrl}
 *   Content-Type: application/x-www-form-urlencoded
 *   Authorization: Basic <base64(client_id:client_secret)>   -- OR --
 *   Body:
 *     grant_type=client_credentials
 *     client_id=<id>            (if not in Basic header)
 *     client_secret=<secret>    (if not in Basic header)
 *     scope=<optional>
 *
 * ### Response
 *
 *   { access_token: string, token_type: 'Bearer', expires_in: number (sec) }
 *
 * We cache until `expires_in - refreshSkew` seconds before expiry to absorb
 * clock skew + network latency, and deduplicate concurrent refreshes so N
 * parallel callers cause ONE token exchange.
 */

import { CachedTokenProvider, type TokenProvider } from './token-provider';

export interface OAuth2ClientCredentialsOptions {
  authUrl: string;
  clientId: string;
  clientSecret: string;
  /** Optional OAuth2 scope. */
  scope?: string;
  /** Additional body params — e.g. Azure AD `resource`, SAP `grant_type` overrides. */
  extraBodyParams?: Record<string, string>;
  /** Auth style for the client credentials. Defaults to `basic`. */
  authStyle?: 'basic' | 'body';
  /** Header name for the outgoing auth. Defaults to 'Authorization'. */
  headerName?: string;
  /** Scheme prefix. Defaults to 'Bearer'. */
  headerScheme?: string;
  /** Refresh ahead of expiry by this many ms. Defaults to 60s. */
  refreshSkewMs?: number;
  /** Timeout for the token exchange request. Defaults to 10s. */
  timeoutMs?: number;
  /** Fetch override for tests. */
  fetchImpl?: typeof fetch;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

export function createOAuth2ClientCredentialsProvider(
  opts: OAuth2ClientCredentialsOptions,
): TokenProvider {
  if (!opts.authUrl) throw new Error('OAuth2: authUrl is required');
  if (!opts.clientId) throw new Error('OAuth2: clientId is required');
  if (!opts.clientSecret) throw new Error('OAuth2: clientSecret is required');

  const style = opts.authStyle ?? 'basic';
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const fetchFn = async (): Promise<{ value: string; expiresAt: number }> => {
    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    if (opts.scope) body.set('scope', opts.scope);
    if (style === 'body') {
      body.set('client_id', opts.clientId);
      body.set('client_secret', opts.clientSecret);
    }
    if (opts.extraBodyParams) {
      for (const [k, v] of Object.entries(opts.extraBodyParams)) {
        body.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (style === 'basic') {
      const creds = Buffer.from(`${opts.clientId}:${opts.clientSecret}`, 'utf8').toString('base64');
      headers.Authorization = `Basic ${creds}`;
    }

    const res = await fetchImpl(opts.authUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '<unreadable>');
      throw new Error(
        `OAuth2 token exchange failed: HTTP ${res.status} at ${opts.authUrl} — ${text.slice(0, 400)}`,
      );
    }

    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      throw new Error('OAuth2 token exchange: response missing access_token');
    }

    // `expires_in` is seconds; default to 1h if the IdP omits it.
    const expiresInMs = (json.expires_in ?? 3600) * 1000;
    return {
      value: json.access_token,
      expiresAt: Date.now() + expiresInMs,
    };
  };

  return new CachedTokenProvider(fetchFn, {
    refreshSkewMs: opts.refreshSkewMs,
    headerName: opts.headerName,
    headerScheme: opts.headerScheme,
  });
}
