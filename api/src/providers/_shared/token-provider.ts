// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * TokenProvider — shared contract for short-lived bearer tokens.
 *
 * Providers that use non-Bearer-static auth (JWT key-pair, OAuth2 client
 * credentials, IAM exchange, etc.) implement this to give adapters a uniform
 * `getToken()` surface. The adapter stays focused on wire shape; token
 * lifecycle (sign / fetch / cache / refresh) lives in the provider.
 *
 * Design notes:
 *   - `getToken()` is async and idempotent: repeated calls return the cached
 *     value until near-expiry, then trigger a refresh.
 *   - `headerName` defaults to 'Authorization' but some providers use
 *     vendor-specific names (e.g. Snowflake uses Authorization but with
 *     `KEYPAIR_JWT` scheme, not `Bearer`). The provider controls header
 *     composition via `buildAuthHeader()`.
 *   - Errors during refresh must propagate — swallowing them causes adapters
 *     to ship stale tokens that the wire will reject with 401.
 */

export interface TokenProvider {
  /** Returns a live bearer-shaped value. Cached until near-expiry. */
  getToken(): Promise<string>;

  /**
   * Returns the header object for the authorization line. Typically
   * `{ Authorization: '<scheme> <token>' }`, but providers may need a
   * different header name or scheme.
   */
  buildAuthHeader(): Promise<Record<string, string>>;

  /** Forces a refresh on next call — useful on observed 401 responses. */
  invalidate(): void;
}

/**
 * Caching wrapper for `fetchFn`-backed token providers. Shared between OAuth2
 * client_credentials and IAM-exchange flows. The signing-based providers
 * (Snowflake JWT) don't need caching — signing is free — but still implement
 * the same interface so adapters treat them uniformly.
 */
export class CachedTokenProvider implements TokenProvider {
  private cached: { value: string; expiresAt: number } | null = null;
  private pending: Promise<{ value: string; expiresAt: number }> | null = null;

  constructor(
    private readonly fetchFn: () => Promise<{ value: string; expiresAt: number }>,
    private readonly options: {
      /** Refresh ahead of expiry by this many ms. Defaults to 60s. */
      refreshSkewMs?: number;
      /** Header name for the authorization line. Defaults to 'Authorization'. */
      headerName?: string;
      /** Scheme prefix. Defaults to 'Bearer'. Pass '' for no scheme. */
      headerScheme?: string;
    } = {},
  ) {}

  async getToken(): Promise<string> {
    const now = Date.now();
    const skew = this.options.refreshSkewMs ?? 60_000;
    if (this.cached && this.cached.expiresAt - skew > now) {
      return this.cached.value;
    }
    // Deduplicate concurrent refreshes — multiple callers should share one
    // fetchFn() call, not stampede the auth endpoint.
    if (!this.pending) {
      this.pending = this.fetchFn()
        .then((result) => {
          this.cached = result;
          return result;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    const refreshed = await this.pending;
    return refreshed.value;
  }

  async buildAuthHeader(): Promise<Record<string, string>> {
    const token = await this.getToken();
    const name = this.options.headerName ?? 'Authorization';
    const scheme = this.options.headerScheme ?? 'Bearer';
    return { [name]: scheme ? `${scheme} ${token}` : token };
  }

  invalidate(): void {
    this.cached = null;
  }
}
