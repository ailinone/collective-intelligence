// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * SnowflakeJwtSigner — key parsing, fingerprint derivation, JWT shape.
 *
 * We generate a throwaway RSA keypair in-memory for each test to avoid any
 * reliance on filesystem fixtures. The fingerprint test is the critical
 * one: if it regresses, Snowflake returns a cryptic 401 and operators have
 * no diagnostic path.
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createPublicKey, createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import {
  SnowflakeJwtSigner,
  computeSnowflakeFingerprint,
} from '../snowflake-jwt-signer';

function makePemKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

describe('computeSnowflakeFingerprint', () => {
  it('matches SHA256 of the DER-encoded SPKI public key', () => {
    const { privateKeyPem, publicKeyPem } = makePemKeyPair();
    const fingerprint = computeSnowflakeFingerprint(privateKeyPem);
    const pub = createPublicKey(publicKeyPem);
    const der = pub.export({ type: 'spki', format: 'der' });
    const expected = `SHA256:${createHash('sha256').update(der).digest('base64')}`;
    expect(fingerprint).toBe(expected);
  });

  it('starts with the SHA256: scheme prefix', () => {
    const { privateKeyPem } = makePemKeyPair();
    expect(computeSnowflakeFingerprint(privateKeyPem)).toMatch(/^SHA256:/);
  });
});

describe('SnowflakeJwtSigner', () => {
  const keys = makePemKeyPair();

  it('throws when required fields are missing', () => {
    expect(() => new SnowflakeJwtSigner({ account: '', user: 'u', privateKeyPem: keys.privateKeyPem })).toThrow(/account/);
    expect(() => new SnowflakeJwtSigner({ account: 'a', user: '', privateKeyPem: keys.privateKeyPem })).toThrow(/user/);
    expect(() => new SnowflakeJwtSigner({ account: 'a', user: 'u', privateKeyPem: '' })).toThrow(/privateKeyPem/);
  });

  it('uppercases account + user in the issuer', () => {
    const s = new SnowflakeJwtSigner({
      account: 'myorg-myacc',
      user: 'svc_user',
      privateKeyPem: keys.privateKeyPem,
    });
    const iss = s.getIssuer();
    expect(iss).toContain('MYORG-MYACC');
    expect(iss).toContain('SVC_USER');
    // shape: <ACCT>.<USER>.<FP>
    expect(iss).toMatch(/^MYORG-MYACC\.SVC_USER\.SHA256:/);
  });

  it('signs a JWT that verifies against the registered public key', async () => {
    const s = new SnowflakeJwtSigner({
      account: 'acct',
      user: 'user',
      privateKeyPem: keys.privateKeyPem,
      lifetimeSeconds: 600,
    });
    const token = await s.getToken();
    const decoded = jwt.verify(token, keys.publicKeyPem, { algorithms: ['RS256'] }) as {
      iss: string;
      sub: string;
      iat: number;
      exp: number;
    };
    expect(decoded.iss).toBe(s.getIssuer());
    expect(decoded.sub).toBe('ACCT.USER');
    expect(decoded.exp - decoded.iat).toBe(600);
  });

  it('caches tokens until near-expiry', async () => {
    let now = 1_700_000_000_000; // fixed epoch ms
    const s = new SnowflakeJwtSigner({
      account: 'a',
      user: 'u',
      privateKeyPem: keys.privateKeyPem,
      lifetimeSeconds: 3600,
      now: () => now,
    });
    const t1 = await s.getToken();
    const t2 = await s.getToken();
    expect(t1).toBe(t2); // same token — cached

    // Advance 58 minutes — well within the 59m (3540s) refresh threshold.
    now += 58 * 60 * 1000;
    const t3 = await s.getToken();
    expect(t3).toBe(t1);

    // Advance another 90 seconds, crossing the 60s skew into the refresh window.
    now += 90 * 1000;
    const t4 = await s.getToken();
    expect(t4).not.toBe(t1);
  });

  it('emits Authorization + X-Snowflake-Authorization-Token-Type headers', async () => {
    const s = new SnowflakeJwtSigner({
      account: 'a',
      user: 'u',
      privateKeyPem: keys.privateKeyPem,
    });
    const headers = await s.buildAuthHeader();
    expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(headers['X-Snowflake-Authorization-Token-Type']).toBe('KEYPAIR_JWT');
  });

  it('caps lifetime at 3600s (Snowflake hard limit)', async () => {
    const s = new SnowflakeJwtSigner({
      account: 'a',
      user: 'u',
      privateKeyPem: keys.privateKeyPem,
      lifetimeSeconds: 99_999, // request way too long
    });
    const token = await s.getToken();
    const decoded = jwt.decode(token) as { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBe(3600);
  });

  it('floors lifetime at 60s to avoid useless tokens', async () => {
    const s = new SnowflakeJwtSigner({
      account: 'a',
      user: 'u',
      privateKeyPem: keys.privateKeyPem,
      lifetimeSeconds: 5, // request too short
    });
    const token = await s.getToken();
    const decoded = jwt.decode(token) as { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBe(60);
  });
});
