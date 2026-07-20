// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Service-token verifier — trusts machine-to-machine (M2M) tokens minted by
 * the ailin id OIDC provider for INTERNAL service-to-service calls.
 *
 * This is intentionally a SEPARATE path from the user-token verification in
 * `auth-service.ts`. A client_credentials / token-exchange token's subject is
 * the *client* (e.g. `ailin-dev-server`), NOT an end user — it carries no
 * `userId`/`organizationId`/`email`, so the user-token claim parser would
 * reject it. Here we verify the signature with id's JWKS (the SAME RSA keypair
 * that signs user OIDC tokens) and then enforce M2M-specific claims:
 *
 *   1. RS256 signature, verifiable against id's published JWKS.
 *   2. issuer === SERVICE_AUTH_ISSUER (default https://ailin.id).
 *   3. audience === SERVICE_AUTH_AUDIENCE (default ailin-ci).
 *   4. token_type ∈ { "service", "exchanged" } — distinguishes M2M tokens from
 *      user access/refresh/id tokens (id sets this; see id/api oidc_provider).
 *   5. the calling client_id is in SERVICE_AUTH_ALLOWED_CLIENTS.
 *
 * The caller (a route preHandler) then enforces the per-operation scope and
 * resolves the acting user. For a `service` token the acting user travels
 * out-of-band in the `X-Acting-User` header (trusted ONLY because 1–5 prove
 * the caller is our own M2M client holding an `:on_behalf` scope). For an
 * `exchanged` token the acting user is the token `sub` and the actor is in the
 * `act` claim — a cryptographically bound, header-free alternative.
 */

import { createPublicKey } from 'crypto';
import jwt, { type Algorithm, type Secret } from 'jsonwebtoken';
import { config } from '@/config';
import { logger } from '@/utils/logger';
import { narrowAs } from '@/utils/type-guards';

export type ServiceTokenReason =
  | 'service_auth_disabled'
  | 'missing_token'
  | 'malformed_token'
  | 'unsupported_algorithm'
  | 'jwks_unavailable'
  | 'unknown_signing_key'
  | 'invalid_signature'
  | 'invalid_claims'
  | 'wrong_token_type'
  | 'client_not_allowed';

export class ServiceTokenError extends Error {
  readonly reason: ServiceTokenReason;
  constructor(reason: ServiceTokenReason, message: string) {
    super(message);
    this.name = 'ServiceTokenError';
    this.reason = reason;
  }
}

export interface ServiceTokenContext {
  /** The M2M client that minted the token (e.g. `ailin-dev-server`). */
  clientId: string;
  /** `service` (client_credentials) or `exchanged` (RFC 8693 token-exchange). */
  tokenType: 'service' | 'exchanged';
  /** Granted scopes, e.g. ["apikeys:write:on_behalf"]. */
  scopes: string[];
  /** Acting user id — present only for `exchanged` tokens (the token `sub`). */
  subject?: string;
  /** Acting user email — present only for `exchanged` tokens. */
  email?: string;
  /** Acting user tenant/org id — present only for `exchanged` tokens. */
  tenantId?: string;
}

// Only asymmetric RSA algorithms are accepted — a service token MUST be
// verifiable via the public JWKS, never an HS256 shared secret.
const ALLOWED_ALGORITHMS: ReadonlySet<string> = new Set(['RS256', 'RS384', 'RS512']);

interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

interface JwksCache {
  keys: Jwk[];
  expiresAt: number;
}

let jwksCache: JwksCache | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function fetchJwks(force = false): Promise<Jwk[] | null> {
  const sa = config.security.serviceAuth;
  const now = Date.now();
  if (!force && jwksCache && jwksCache.expiresAt > now) {
    return jwksCache.keys;
  }

  try {
    const response = await fetch(sa.jwksUri, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, jwksUri: sa.jwksUri }, 'service-token JWKS fetch failed');
      return null;
    }
    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) {
      logger.warn({ jwksUri: sa.jwksUri }, 'service-token JWKS response has no keys[]');
      return null;
    }
    const keys = body.keys.filter((key): key is Jwk => isRecord(key) && typeof key.kty === 'string');
    jwksCache = { keys, expiresAt: now + sa.jwksCacheTtlSeconds * 1000 };
    return keys;
  } catch (error) {
    logger.warn({ error, jwksUri: sa.jwksUri }, 'service-token JWKS fetch threw');
    return null;
  }
}

function selectJwk(keys: Jwk[], kid: string | undefined, alg: string): Jwk | null {
  if (kid) {
    const byKid = keys.find((key) => key.kid === kid);
    if (byKid) {
      return byKid;
    }
  }
  const byAlg = keys.find((key) => (!key.alg || key.alg === alg) && (!key.use || key.use === 'sig'));
  if (byAlg) {
    return byAlg;
  }
  return keys.length === 1 ? keys[0] : null;
}

function toPublicKey(jwk: Jwk): Secret {
  const jwkInput: import('crypto').JsonWebKey = {
    kty: jwk.kty,
    ...(jwk.kid !== undefined ? { kid: jwk.kid } : {}),
    ...(jwk.use !== undefined ? { use: jwk.use } : {}),
    ...(jwk.alg !== undefined ? { alg: jwk.alg } : {}),
    ...(jwk.n !== undefined ? { n: jwk.n } : {}),
    ...(jwk.e !== undefined ? { e: jwk.e } : {}),
    ...(jwk.x !== undefined ? { x: jwk.x } : {}),
    ...(jwk.y !== undefined ? { y: jwk.y } : {}),
    ...(jwk.crv !== undefined ? { crv: jwk.crv } : {}),
  };
  // createPublicKey returns a KeyObject, which jsonwebtoken accepts as a Secret
  // at runtime but its @types narrow Secret too tightly; narrowAs is the
  // sanctioned single-point cast (no raw `as unknown as`).
  return narrowAs<Secret>(createPublicKey({ key: jwkInput, format: 'jwk' }));
}

function parseScopes(raw: unknown): string[] {
  if (typeof raw === 'string') {
    return raw.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.filter((scope): scope is string => typeof scope === 'string');
  }
  return [];
}

/**
 * Verifies a bearer service token end-to-end. Throws {@link ServiceTokenError}
 * with a machine-readable `reason` on any failure. Returns the verified
 * context (client + scopes + optional acting-user claims) on success.
 */
export async function verifyServiceToken(token: string): Promise<ServiceTokenContext> {
  const sa = config.security.serviceAuth;
  if (!sa.enabled) {
    throw new ServiceTokenError('service_auth_disabled', 'internal service auth is disabled');
  }
  if (!token) {
    throw new ServiceTokenError('missing_token', 'no service token presented');
  }

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded !== 'object' || !isRecord(decoded.header)) {
    throw new ServiceTokenError('malformed_token', 'service token is not a well-formed JWT');
  }

  const alg = typeof decoded.header.alg === 'string' ? decoded.header.alg : null;
  const kid = typeof decoded.header.kid === 'string' ? decoded.header.kid : undefined;
  if (!alg || !ALLOWED_ALGORITHMS.has(alg)) {
    throw new ServiceTokenError('unsupported_algorithm', `unsupported service-token alg: ${alg ?? 'none'}`);
  }

  let keys = await fetchJwks();
  if (!keys) {
    throw new ServiceTokenError('jwks_unavailable', 'could not fetch id JWKS to verify service token');
  }
  let jwk = selectJwk(keys, kid, alg);
  if (!jwk) {
    // Refresh once in case id rotated keys after our cache was populated.
    keys = await fetchJwks(true);
    if (keys) {
      jwk = selectJwk(keys, kid, alg);
    }
  }
  if (!jwk) {
    throw new ServiceTokenError('unknown_signing_key', `no JWKS key matches kid=${kid ?? 'none'}`);
  }

  let payload: unknown;
  try {
    payload = jwt.verify(token, toPublicKey(jwk), {
      issuer: sa.issuer,
      audience: sa.audience,
      algorithms: [alg as Algorithm],
      clockTolerance: sa.clockToleranceSeconds,
    });
  } catch (error) {
    throw new ServiceTokenError(
      'invalid_signature',
      `service token failed verification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(payload)) {
    throw new ServiceTokenError('invalid_claims', 'service token payload is not an object');
  }

  const tokenType = typeof payload.token_type === 'string' ? payload.token_type : null;
  if (tokenType !== 'service' && tokenType !== 'exchanged') {
    throw new ServiceTokenError('wrong_token_type', `expected a service/exchanged token, got: ${tokenType ?? 'none'}`);
  }

  // Resolve the calling client id: for a service token it is `client_id`
  // (falling back to `sub`, which id sets to the client); for an exchanged
  // token the actor lives in the `act` claim.
  let clientId: string | null = null;
  if (tokenType === 'service') {
    clientId =
      typeof payload.client_id === 'string'
        ? payload.client_id
        : typeof payload.sub === 'string'
          ? payload.sub
          : null;
  } else {
    const act = isRecord(payload.act) ? payload.act : null;
    clientId =
      act && typeof act.client_id === 'string'
        ? act.client_id
        : act && typeof act.sub === 'string'
          ? act.sub
          : null;
  }

  if (!clientId || !sa.allowedClients.includes(clientId)) {
    throw new ServiceTokenError('client_not_allowed', `client not allowed for internal calls: ${clientId ?? 'none'}`);
  }

  const context: ServiceTokenContext = {
    clientId,
    tokenType,
    scopes: parseScopes(payload.scope ?? payload.scopes),
  };

  if (tokenType === 'exchanged') {
    if (typeof payload.sub === 'string') {
      context.subject = payload.sub;
    }
    if (typeof payload.email === 'string') {
      context.email = payload.email;
    }
    if (typeof payload.tenant_id === 'string') {
      context.tenantId = payload.tenant_id;
    }
  }

  return context;
}

/** Test-only: clears the in-memory JWKS cache. */
export function __resetServiceTokenVerifierForTests(): void {
  jwksCache = null;
}

/** Test-only: seeds the JWKS cache so verification runs without a network fetch. */
export function __primeJwksForTests(keys: Jwk[], ttlMs = 300_000): void {
  jwksCache = { keys, expiresAt: Date.now() + ttlMs };
}
