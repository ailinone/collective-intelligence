// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Snowflake JWT Signer — key-pair auth for Cortex REST API.
 *
 * Snowflake's REST API auth flow for programmatic clients is **key-pair
 * JWT**: the client signs a short-lived JWT locally with an RSA private key
 * whose public half is registered on the user via
 * `ALTER USER <u> SET RSA_PUBLIC_KEY = '...'`. Snowflake validates the
 * signature and the `iss` / `sub` claims against the registered key and
 * issues no additional token — the JWT IS the bearer.
 *
 * Docs: https://docs.snowflake.com/en/user-guide/key-pair-auth
 *
 * ### Claim shape (mandatory)
 *
 *   iss: "<ACCOUNT>.<USER>.SHA256:<base64(sha256(der_pubkey))>"
 *   sub: "<ACCOUNT>.<USER>"
 *   iat: <unix-seconds now>
 *   exp: <iat + 3600>  -- Snowflake caps at 1 hour
 *
 * The `iss` fingerprint is the critical piece: it must be derived from the
 * DER-encoded SubjectPublicKeyInfo of the registered public key, SHA256'd,
 * and base64-encoded. Getting this wrong returns a cryptic 401 from
 * Snowflake with no diagnostic. This signer computes it from the PEM input.
 *
 * ### Why sign locally instead of exchanging for a bearer
 *
 * Snowflake's REST API accepts the signed JWT directly in the Authorization
 * header with scheme `KEYPAIR_JWT`. There's no separate `/oauth/token`
 * exchange, which makes this simpler than SAP / Azure AD but means every
 * request carries a signed JWT. Signing is ~1ms via `crypto.sign`, so
 * caching the JWT until near-expiry (55 minutes) is worth it.
 */

import { createPrivateKey, createPublicKey, createHash, type KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import { type TokenProvider } from './token-provider';

export interface SnowflakeJwtSignerOptions {
  /** Snowflake account identifier, e.g. `orgname-accountname`. Uppercased. */
  account: string;
  /** Snowflake username. Uppercased. */
  user: string;
  /** RSA private key, PEM-encoded. Optionally wrapped with `privateKeyPassphrase`. */
  privateKeyPem: string;
  /** Passphrase for encrypted private keys. */
  privateKeyPassphrase?: string;
  /**
   * Lifetime in seconds. Snowflake caps at 3600 (1h); anything larger is
   * rejected. Default: 3540 (59 minutes) to leave clock-skew room.
   */
  lifetimeSeconds?: number;
  /** Clock source for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Computes Snowflake's public-key fingerprint: `SHA256:<base64(sha256(der))>`.
 *
 * The input can be a PRIVATE key PEM — we derive the public half and encode
 * it as DER SubjectPublicKeyInfo, then SHA256 + base64. This matches the
 * fingerprint that Snowflake stores when the user runs `DESCRIBE USER`.
 */
export function computeSnowflakeFingerprint(pem: string, passphrase?: string): string {
  const privateKey = createPrivateKey({ key: pem, passphrase });
  const publicKey = createPublicKey(privateKey);
  const derBuffer = publicKey.export({ type: 'spki', format: 'der' });
  const hash = createHash('sha256').update(derBuffer).digest('base64');
  return `SHA256:${hash}`;
}

export class SnowflakeJwtSigner implements TokenProvider {
  private readonly account: string;
  private readonly user: string;
  private readonly privateKey: KeyObject;
  private readonly fingerprint: string;
  private readonly lifetimeSeconds: number;
  private readonly nowFn: () => number;
  private cached: { value: string; expiresAt: number } | null = null;

  constructor(opts: SnowflakeJwtSignerOptions) {
    if (!opts.account?.trim()) throw new Error('SnowflakeJwtSigner: account is required');
    if (!opts.user?.trim()) throw new Error('SnowflakeJwtSigner: user is required');
    if (!opts.privateKeyPem?.trim()) throw new Error('SnowflakeJwtSigner: privateKeyPem is required');

    this.account = opts.account.toUpperCase();
    this.user = opts.user.toUpperCase();
    this.lifetimeSeconds = Math.min(Math.max(opts.lifetimeSeconds ?? 3540, 60), 3600);
    this.nowFn = opts.now ?? Date.now;

    // Eagerly parse the key — fail fast on bad PEM rather than at first
    // token mint (where the error surfaces inside a chat request).
    try {
      this.privateKey = createPrivateKey({
        key: opts.privateKeyPem,
        passphrase: opts.privateKeyPassphrase,
      });
    } catch (err) {
      throw new Error(
        `SnowflakeJwtSigner: failed to parse private key — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.fingerprint = computeSnowflakeFingerprint(opts.privateKeyPem, opts.privateKeyPassphrase);
  }

  /** Exposed for tests + diagnostics. */
  getFingerprint(): string {
    return this.fingerprint;
  }

  /** Exposed for tests — what Snowflake sees in the `iss` claim. */
  getIssuer(): string {
    return `${this.account}.${this.user}.${this.fingerprint}`;
  }

  async getToken(): Promise<string> {
    const now = this.nowFn();
    // Refresh 60 seconds before expiry to absorb clock skew + network latency.
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return this.cached.value;
    }
    const iat = Math.floor(now / 1000);
    const exp = iat + this.lifetimeSeconds;
    const payload = {
      iss: this.getIssuer(),
      sub: `${this.account}.${this.user}`,
      iat,
      exp,
    };
    const token = jwt.sign(payload, this.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      algorithm: 'RS256',
    });
    this.cached = { value: token, expiresAt: exp * 1000 };
    return token;
  }

  async buildAuthHeader(): Promise<Record<string, string>> {
    const token = await this.getToken();
    // Snowflake expects the `KEYPAIR_JWT` scheme — NOT `Bearer`.
    return {
      Authorization: `Bearer ${token}`,
      'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
    };
  }

  invalidate(): void {
    this.cached = null;
  }
}
