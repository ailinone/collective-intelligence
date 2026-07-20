// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Authentication Service
 * Enterprise-grade authentication with bcrypt + JWT and email-code flows
 */

import { createPublicKey, randomInt } from 'crypto';
import bcrypt from 'bcrypt';
import jwt, { type Algorithm, type Secret, type SignOptions, type VerifyOptions } from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { config } from '@/config';
import { Prisma, prisma } from '@/database/client';
import { logger } from '@/utils/logger';
import type { AuthMode } from '@/types';
import { getEmailService } from './email-service';
import { assignRoleToUser, getUserRoles } from '@/services/rbac-service';
import { recordSecurityEvent } from '@/services/security-audit-service';
import { toInputJson } from '@/utils/json';
import { organizationSettingsService } from '@/services/organization-settings-service';
import { isUniqueConstraintError, getUniqueConstraintFields } from '@/utils/prisma-error-helpers';
import { normalizeFederatedRole } from '@/services/auth-role-mapping';

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_USE = 'access';
const REFRESH_TOKEN_USE = 'refresh';

// Email-code authentication policy (enterprise-safe defaults)
const EMAIL_CODE_EXPIRES_MS = 10 * 60 * 1000; // 10 minutes
const EMAIL_CODE_COOLDOWN_MS = 60 * 1000; // 1 minute
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function mergeJsonMetadata(
  existing: unknown,
  extra: Record<string, unknown>
): Prisma.InputJsonValue {
  const normalizedExisting = toInputJson(existing);
  const base: Record<string, Prisma.InputJsonValue> =
    normalizedExisting &&
    typeof normalizedExisting === 'object' &&
    !Array.isArray(normalizedExisting)
      ? { ...(normalizedExisting as Record<string, Prisma.InputJsonValue>) }
      : {};

  for (const [key, value] of Object.entries(extra)) {
    base[key] = toInputJson(value);
  }

  return base;
}

function computeAdvisoryLockHash(input: string): bigint {
  // PostgreSQL advisory locks accept bigint. We generate a deterministic positive bigint hash.
  let hash = 0n;
  const mod = 9223372036854775807n; // 2^63 - 1
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31n + BigInt(input.charCodeAt(i))) % mod;
  }
  return hash;
}

/**
 * JWT Payload
 */
export interface JWTPayload {
  userId: string;
  organizationId: string;
  email: string;
  roles: string[];
  token_use?: 'access' | 'refresh';
  jti?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
  apiKeyId?: string;
  apiKeyPermissions?: Record<string, unknown> | null;
}

interface FederatedTokenPayload {
  userId: string;
  organizationId: string;
  email: string;
  roles: string[];
  token_use?: 'access' | 'refresh';
  jti?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
}

interface FederatedJwk {
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

interface FederatedJwksCache {
  expiresAt: number;
  keys: FederatedJwk[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFederatedJwk(value: unknown): value is FederatedJwk {
  return isRecord(value) && typeof value.kty === 'string';
}

function extractStringClaim(claims: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = claims[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function extractFederatedRoles(claims: Record<string, unknown>, audience: string): string[] {
  const roles = new Set<string>();

  for (const role of extractStringArray(claims.roles)) {
    roles.add(role);
  }

  const realmAccess = claims.realm_access;
  if (isRecord(realmAccess)) {
    for (const role of extractStringArray(realmAccess.roles)) {
      roles.add(role);
    }
  }

  const resourceAccess = claims.resource_access;
  if (isRecord(resourceAccess)) {
    const preferredClients = [audience, String(claims.azp ?? ''), 'account'].filter(
      (value) => value.length > 0
    );
    for (const client of preferredClients) {
      const entry = resourceAccess[client];
      if (!isRecord(entry)) {
        continue;
      }
      for (const role of extractStringArray(entry.roles)) {
        roles.add(role);
      }
    }

    for (const entry of Object.values(resourceAccess)) {
      if (!isRecord(entry)) {
        continue;
      }
      for (const role of extractStringArray(entry.roles)) {
        roles.add(role);
      }
    }
  }

  return Array.from(roles);
}

function parseFederatedTokenPayload(
  value: unknown,
  audience: string
): FederatedTokenPayload | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;

  const userId = extractStringClaim(candidate, ['userId', 'user_id', 'sub']);
  const organizationId = extractStringClaim(candidate, [
    'organizationId',
    'organization_id',
    'org_id',
    'tenant_id',
    'tid',
  ]);
  const email = extractStringClaim(candidate, ['email', 'upn', 'preferred_username']);

  if (!userId || !organizationId || !email || !email.includes('@')) {
    return null;
  }

  const tokenUseClaim = extractStringClaim(candidate, ['token_use']);
  if (
    tokenUseClaim !== null &&
    tokenUseClaim !== ACCESS_TOKEN_USE &&
    tokenUseClaim !== REFRESH_TOKEN_USE
  ) {
    return null;
  }

  const iat = typeof candidate.iat === 'number' ? candidate.iat : undefined;
  const exp = typeof candidate.exp === 'number' ? candidate.exp : undefined;
  const nbf = typeof candidate.nbf === 'number' ? candidate.nbf : undefined;
  const jti = extractStringClaim(candidate, ['jti']) ?? undefined;

  return {
    userId,
    organizationId,
    email: email.toLowerCase(),
    roles: extractFederatedRoles(candidate, audience),
    token_use: tokenUseClaim ?? undefined,
    jti,
    iat,
    exp,
    nbf,
  };
}

function hasRequiredFederatedTemporalClaims(payload: FederatedTokenPayload): boolean {
  return typeof payload.iat === 'number' && typeof payload.exp === 'number';
}

function isJwtPayloadLike(value: unknown): value is JWTPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.userId !== 'string' ||
    typeof candidate.organizationId !== 'string' ||
    typeof candidate.email !== 'string' ||
    !Array.isArray(candidate.roles)
  ) {
    return false;
  }

  if (!candidate.roles.every((role) => typeof role === 'string')) {
    return false;
  }

  if (
    candidate.token_use !== undefined &&
    candidate.token_use !== ACCESS_TOKEN_USE &&
    candidate.token_use !== REFRESH_TOKEN_USE
  ) {
    return false;
  }

  if (candidate.jti !== undefined && typeof candidate.jti !== 'string') {
    return false;
  }

  return true;
}

function hasRequiredTemporalClaims(payload: JWTPayload): boolean {
  return (
    typeof payload.iat === 'number' &&
    typeof payload.exp === 'number' &&
    typeof payload.nbf === 'number' &&
    typeof payload.jti === 'string' &&
    payload.jti.length > 0
  );
}

export interface AuthResult {
  success: boolean;
  loginMode: AuthMode;
  user?: {
    id: string;
    email: string;
    name: string;
    organizationId: string;
    roles: string[];
  };
  tokens?: {
    accessToken: string;
    refreshToken: string;
    expiresIn?: string;
  };
  error?: string;
  message?: string;
}

export interface AuthChallengeResult {
  success: boolean;
  loginMode?: AuthMode;
  challengeId?: string;
  expiresAt?: Date;
  cooldownExpiresAt?: Date;
  statusCode?: number;
  error?: string;
  message?: string;
}

/**
 * Authentication Service
 */
export class AuthService {
  private log = logger.child({ service: 'auth' })
  private emailService = getEmailService();
  private federatedJwksCache: FederatedJwksCache | null = null;

  private getLocalJwtVerifyOptions(): VerifyOptions {
    return {
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
      algorithms: config.security.jwtAlgorithms as Algorithm[],
      clockTolerance: config.security.jwtClockToleranceSeconds,
    };
  }

  private getFederationJwtVerifyOptions(): VerifyOptions {
    return {
      issuer: [config.security.federation.issuer],
      audience: config.security.federation.audience,
      algorithms: config.security.federation.algorithms as Algorithm[],
      clockTolerance: config.security.federation.clockToleranceSeconds,
    };
  }

  private async fetchFederatedJwks(): Promise<FederatedJwk[] | null> {
    const jwksUri = config.security.federation.jwksUri;
    if (!jwksUri) {
      return null;
    }

    const now = Date.now();
    if (this.federatedJwksCache && this.federatedJwksCache.expiresAt > now) {
      return this.federatedJwksCache.keys;
    }

    const response = await fetch(jwksUri, {
      headers: {
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`federation_jwks_fetch_failed:${response.status}`);
    }

    const body = await response.json();
    if (!isRecord(body) || !Array.isArray(body.keys)) {
      throw new Error('federation_jwks_invalid_response');
    }

    const keys = body.keys.filter(isFederatedJwk);
    if (keys.length === 0) {
      throw new Error('federation_jwks_empty');
    }

    this.federatedJwksCache = {
      keys,
      expiresAt: now + config.security.federation.jwksCacheTtlSeconds * 1000,
    };

    return keys;
  }

  private selectFederatedJwk(keys: FederatedJwk[], kid: string | undefined, alg: string): FederatedJwk | null {
    if (kid) {
      const byKid = keys.find((key) => key.kid === kid && (!key.alg || key.alg === alg));
      if (byKid) {
        return byKid;
      }
    }

    const byAlg = keys.find((key) => !key.alg || key.alg === alg);
    if (byAlg) {
      return byAlg;
    }

    return keys.length === 1 ? keys[0] : null;
  }

  private async verifyFederatedTokenWithJwks(token: string): Promise<unknown | null> {
    const federation = config.security.federation;
    if (!federation.jwksUri) {
      return null;
    }

    const decoded = jwt.decode(token, { complete: true });
    if (!isRecord(decoded) || !isRecord(decoded.header)) {
      return null;
    }

    const header = decoded.header;
    const alg = typeof header.alg === 'string' ? header.alg : null;
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    if (!alg) {
      return null;
    }

    const allowedAsymmetricAlgorithms = federation.algorithms.filter(
      (algorithm) => !algorithm.startsWith('HS')
    );
    if (!allowedAsymmetricAlgorithms.includes(alg)) {
      return null;
    }

    let keys = await this.fetchFederatedJwks();
    if (!keys) {
      return null;
    }

    let jwk = this.selectFederatedJwk(keys, kid, alg);
    if (!jwk) {
      // Refresh once in case the issuer rotated keys after cache population.
      this.federatedJwksCache = null;
      keys = await this.fetchFederatedJwks();
      if (!keys) {
        return null;
      }
      jwk = this.selectFederatedJwk(keys, kid, alg);
    }
    if (!jwk) {
      return null;
    }

    // `createPublicKey` expects a `JsonWebKey` (structurally identical to our
    // `FederatedJwk`, but defined in `node:crypto`). Building the object
    // explicitly here lets us drop the `as unknown as Record<string, string>`
    // cast — the previous code laundered the type through `unknown`, which
    // hides any real shape mismatch instead of catching it. With this shape,
    // tsc validates each field; if `FederatedJwk` ever drifts from the JWK
    // contract, the compiler tells us at the site instead of at runtime.
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
    const publicKey = createPublicKey({
      key: jwkInput,
      format: 'jwk',
    });

    return jwt.verify(token, publicKey as Secret, {
      ...this.getFederationJwtVerifyOptions(),
      algorithms: [alg as Algorithm],
    });
  }

  private verifyFederatedTokenWithSharedSecret(token: string): unknown | null {
    const federation = config.security.federation;
    if (!federation.sharedSecret) {
      return null;
    }

    const allowedHsAlgorithms = federation.algorithms.filter((algorithm) =>
      algorithm.startsWith('HS')
    );
    if (allowedHsAlgorithms.length === 0) {
      return null;
    }

    return jwt.verify(token, federation.sharedSecret, {
      ...this.getFederationJwtVerifyOptions(),
      algorithms: allowedHsAlgorithms as Algorithm[],
    });
  }

  private shouldEnforceStrictClaims(): boolean {
    return config.featureFlags.authStrictClaims;
  }

  private hasExpectedTokenUse(payload: JWTPayload, expected: 'access' | 'refresh'): boolean {
    if (!this.shouldEnforceStrictClaims()) {
      return payload.token_use === undefined || payload.token_use === expected;
    }
    return payload.token_use === expected;
  }

  /**
   * Register new user
   */
  async register(data: {
    email: string;
    password: string;
    name: string;
    organizationId?: string;
  }): Promise<AuthResult> {
    try {
      const normalizedEmail = data.email.trim().toLowerCase();

      // Check if user already exists (optimistic check)
      const existingUser = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });

      if (existingUser) {
        const authSettings = await this.resolveAuthSettings(existingUser.organizationId);
        return {
          success: false,
          loginMode: authSettings.mode,
          error: 'User already exists with this email',
        };
      }

      const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

      // Use safe upsert for organization creation (handles race conditions)
      let organizationId = data.organizationId;
      if (!organizationId) {
        try {
          const org = await prisma.organization.create({
            data: {
              name: `${data.name}'s Organization`,
              tier: 'free',
              status: 'active',
            },
          });
          organizationId = org.id;
        } catch (error: unknown) {
          // Handle unique constraint if organization creation fails
          // This should rarely happen, but handle gracefully
          if (
            isUniqueConstraintError(error)
          ) {
            this.log.warn({ email: normalizedEmail }, 'Organization creation failed due to unique constraint, retrying');
            // Organization might have been created by another request, continue with user creation
            // This is an edge case that should be handled by proper transaction management in the future
            throw new Error('Failed to create organization due to concurrent request');
          }
          throw error;
        }
      }

      // Sanitize user input to prevent XSS attacks
      const { sanitizeHTML } = await import('@/utils/sanitizers');
      const sanitizedName = sanitizeHTML(data.name);

      // Create user with error handling for race conditions
      let user;
      try {
        user = await prisma.user.create({
          data: {
            email: normalizedEmail,
            passwordHash,
            name: sanitizedName,
            organizationId,
            status: 'active',
          },
        });
      } catch (error: unknown) {
        // Handle unique constraint violation (race condition where user was created between check and create)
        if (
          isUniqueConstraintError(error)
        ) {
          // After isUniqueConstraintError guard, we can safely access meta property
          // Use helper function to extract constraint fields
          const constraintFields = getUniqueConstraintFields(error);
          
          if (constraintFields?.includes('email')) {
            this.log.warn({ email: normalizedEmail }, 'User creation failed due to email unique constraint, user likely created by concurrent request');
            const authSettings = await this.resolveAuthSettings(data.organizationId);
            return {
              success: false,
              loginMode: authSettings.mode,
              error: 'User already exists with this email',
            };
          }
        }
        // Re-throw other errors
        throw error;
      }

      const orgId = organizationId!;
      const roles = await assignRoleToUser(user.id, orgId, 'owner');

      const tokens = await this.generateTokens({
        userId: user.id,
        organizationId: orgId,
        email: user.email,
        roles,
      });

      this.log.info({ userId: user.id, email: user.email }, 'User registered successfully');

      await recordSecurityEvent({
        eventType: 'user_registered',
        severity: 'info',
        message: 'New user registered',
        userId: user.id,
        organizationId,
        metadata: { roles },
      });

      const authUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        organizationId,
        roles,
      };

      return this.buildSuccessResult(authUser, tokens, 'password');
    } catch (error) {
      this.log.error({ error, email: data.email }, 'Failed to register user');
      const authSettings = await this.resolveAuthSettings();
      return {
        success: false,
        loginMode: authSettings.mode,
        error: 'Registration failed',
      };
    }
  }

  /**
   * Login user with password
   */
  async login(email: string, password: string): Promise<AuthResult> {
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });

      if (!user) {
        const authSettings = await this.resolveAuthSettings();
        return {
          success: false,
          loginMode: authSettings.mode,
          error: 'Invalid email or password',
        };
      }

      const authSettings = await this.resolveAuthSettings(user.organizationId);
      const loginMode = authSettings.mode;

      if (loginMode === 'sso') {
        return {
          success: false,
          loginMode,
          error: 'Password authentication is disabled for this organization',
          message: 'Please use SSO authentication',
        };
      }

      if (loginMode === 'email_code' && !authSettings.allowPasswordFallback) {
        return {
          success: false,
          loginMode,
          error: 'Password authentication is disabled for this organization',
          message: 'Please use email code authentication',
        };
      }

      const isValidPassword = await bcrypt.compare(password, user.passwordHash);
      if (!isValidPassword) {
        return {
          success: false,
          loginMode,
          error: 'Invalid email or password',
        };
      }

      // Check if user is active
      if (user.status !== 'active') {
        return {
          success: false,
          loginMode,
          error: 'User account is not active',
        };
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const roles = await getUserRoles(user.id, user.organizationId);

      const tokens = await this.generateTokens({
        userId: user.id,
        organizationId: user.organizationId,
        email: user.email,
        roles,
      });

      this.log.info({ userId: user.id, email: user.email }, 'User logged in successfully');

      const authUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        organizationId: user.organizationId,
        roles,
      };

      return this.buildSuccessResult(authUser, tokens, loginMode);
    } catch (error) {
      this.log.error({ error, email }, 'Failed to login user');
      const authSettings = await this.resolveAuthSettings();
      return {
        success: false,
        loginMode: authSettings.mode,
        error: 'Login failed',
      };
    }
  }

  /**
   * Request email verification code
   */
  async requestEmailCode(email: string, organizationId?: string): Promise<AuthChallengeResult> {
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const now = new Date();

      const code = randomInt(100000, 999999).toString();
      const expiresAt = new Date(now.getTime() + EMAIL_CODE_EXPIRES_MS);
      const cooldownWindowStart = new Date(now.getTime() - EMAIL_CODE_COOLDOWN_MS);
      const cooldownExpiresAt = new Date(now.getTime() + EMAIL_CODE_COOLDOWN_MS);

      // Concurrency-safe rate limit + challenge creation (atomic per email) using advisory locks.
      const lockHash = computeAdvisoryLockHash(`email_code:${normalizedEmail}`);

      const createResult = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockHash})`;

        const recentChallenge = await tx.authLoginChallenge.findFirst({
          where: {
            email: normalizedEmail,
            status: 'pending',
            createdAt: { gt: cooldownWindowStart },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (recentChallenge) {
          const base = recentChallenge.lastSentAt ?? recentChallenge.createdAt;
          return {
            kind: 'rate_limited' as const,
            cooldownExpiresAt: new Date(base.getTime() + EMAIL_CODE_COOLDOWN_MS),
          };
        }

        const user = await tx.user.findUnique({
          where: { email: normalizedEmail },
        });

        const challenge = await tx.authLoginChallenge.create({
          data: {
            email: normalizedEmail,
            organizationId: user?.organizationId || organizationId || null,
            codeHash: await bcrypt.hash(code, 10),
            expiresAt,
            status: 'pending',
            lastSentAt: now,
            metadata: user
              ? mergeJsonMetadata({}, { userId: user.id, userExists: true })
              : mergeJsonMetadata({}, { userExists: false }),
          },
        });

        return {
          kind: 'created' as const,
          userExists: Boolean(user),
          challengeId: challenge.id,
        };
      });

      if (createResult.kind === 'rate_limited') {
        return {
          success: false,
          loginMode: 'email_code',
          statusCode: 429,
          cooldownExpiresAt: createResult.cooldownExpiresAt,
          error: 'Rate limited. Please wait before requesting another code.',
        };
      }

      if (!createResult.userExists) {
        return {
          success: true,
          loginMode: 'email_code',
          challengeId: `chlg_${nanoid(24)}`,
          expiresAt,
          cooldownExpiresAt,
          message: 'If the email exists, a login code was sent.',
        };
      }

      try {
        await this.emailService.sendLoginCode(normalizedEmail, code, expiresAt);
      } catch (sendError) {
        const useBestEffortEmailMode =
          process.env.NODE_ENV === 'test' ||
          (process.env.AUTH_EMAIL_PROVIDER || '').toLowerCase().trim() === 'console';

        if (!useBestEffortEmailMode) {
          throw sendError;
        }

        this.log.warn(
          { email: normalizedEmail, error: sendError },
          'Email send failed in test/console mode; continuing with challenge'
        );
      }

      return {
        success: true,
        loginMode: 'email_code',
        challengeId: createResult.challengeId,
        expiresAt,
        cooldownExpiresAt,
      };
    } catch (error) {
      this.log.error({ error, email }, 'Failed to request email code');
      return {
        success: false,
        loginMode: 'email_code',
        statusCode: 500,
        error: 'Failed to send email code',
      };
    }
  }

  /**
   * Verify email code and login
   * Supports both email+code and challengeId+code
   */
  async verifyEmailCode(emailOrChallengeId: string, code: string): Promise<AuthResult> {
    // Validate code format: must be 6 digits
    if (!/^\d{6}$/.test(code)) {
      const authSettings = await this.resolveAuthSettings();
      return {
        success: false,
        loginMode: authSettings.mode,
        error: 'Invalid code format. Code must be 6 digits.',
      };
    }

    // If it looks like an email, use email-based verification
    if (emailOrChallengeId.includes('@')) {
      return this.verifyEmailCodeByEmail(emailOrChallengeId, code);
    }

    // Otherwise, treat as challengeId
    return this.verifyEmailCodeByChallengeId(emailOrChallengeId, code);
  }

  /**
   * Verify email code by email address
   */
  private async verifyEmailCodeByEmail(email: string, code: string): Promise<AuthResult> {
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
    });

      if (!user) {
        const authSettings = await this.resolveAuthSettings();
      return {
        success: false,
          loginMode: authSettings.mode,
          error: 'Invalid email or code',
      };
    }

      const challenges = await prisma.authLoginChallenge.findMany({
        where: {
          email: normalizedEmail,
          status: 'pending',
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });

      if (challenges.length === 0) {
        const authSettings = await this.resolveAuthSettings(user.organizationId);
      return {
        success: false,
          loginMode: authSettings.mode,
          error: 'Invalid or expired code',
        };
      }

      const challenge = challenges[0];
      const isValidCode = await bcrypt.compare(code, challenge.codeHash);

      if (!isValidCode) {
        const authSettings = await this.resolveAuthSettings(user.organizationId);
        return {
          success: false,
          loginMode: authSettings.mode,
          error: 'Invalid or expired code',
      };
    }

      // Delete used challenge
      await prisma.authLoginChallenge.delete({
        where: { id: challenge.id },
      });

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

    const roles = await getUserRoles(user.id, user.organizationId);

    const tokens = await this.generateTokens({
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      roles,
    });

      this.log.info({ userId: user.id, email: user.email }, 'User logged in with email code');

    const authUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      organizationId: user.organizationId,
      roles,
    };

      const authSettings = await this.resolveAuthSettings(user.organizationId);
      return this.buildSuccessResult(authUser, tokens, authSettings.mode);
    } catch (error) {
      this.log.error({ error, email }, 'Failed to verify email code');
      const authSettings = await this.resolveAuthSettings();
      return {
        success: false,
        loginMode: authSettings.mode,
        error: 'Verification failed',
      };
    }
  }

  /**
   * Verify email code by challengeId
   */
  private async verifyEmailCodeByChallengeId(challengeId: string, code: string): Promise<AuthResult> {
    try {
      const lockHash = computeAdvisoryLockHash(`email_challenge:${challengeId}`);

      const verification = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockHash})`;

        const challenge = await tx.authLoginChallenge.findUnique({
          where: { id: challengeId },
        });

        if (!challenge) {
          return {
            status: 'invalid_challenge' as const,
          };
        }

        if (challenge.status === 'locked' || challenge.attemptCount >= EMAIL_CODE_MAX_ATTEMPTS) {
          if (challenge.status !== 'locked') {
            await tx.authLoginChallenge
              .update({
                where: { id: challengeId },
                data: { status: 'locked' },
              })
              .catch(() => undefined);
          }

          return {
            status: 'locked' as const,
            organizationId: challenge.organizationId || undefined,
          };
        }

        if (challenge.expiresAt < new Date()) {
          return {
            status: 'expired' as const,
            organizationId: challenge.organizationId || undefined,
          };
        }

        if (challenge.status !== 'pending') {
          return {
            status: challenge.status === 'locked' ? ('locked' as const) : ('used' as const),
            organizationId: challenge.organizationId || undefined,
          };
        }

        const isValidCode = await bcrypt.compare(code, challenge.codeHash);

        if (!isValidCode) {
          const nextAttemptCount = challenge.attemptCount + 1;
          const shouldLock = nextAttemptCount >= EMAIL_CODE_MAX_ATTEMPTS;

          await tx.authLoginChallenge.update({
            where: { id: challengeId },
            data: {
              attemptCount: nextAttemptCount,
              ...(shouldLock ? { status: 'locked' } : {}),
            },
          });

          return {
            status: shouldLock ? ('locked' as const) : ('invalid_code' as const),
            organizationId: challenge.organizationId || undefined,
          };
        }

        const normalizedChallengeEmail = challenge.email.trim().toLowerCase();
        const user = await tx.user.findUnique({
          where: { email: normalizedChallengeEmail },
        });

        if (!user) {
          return {
            status: 'user_not_found' as const,
            organizationId: challenge.organizationId || undefined,
          };
        }

        if (challenge.organizationId && user.organizationId !== challenge.organizationId) {
          return {
            status: 'invalid_challenge' as const,
            organizationId: challenge.organizationId || undefined,
          };
        }

        await tx.authLoginChallenge.update({
          where: { id: challengeId },
          data: {
            status: 'verified',
            verifiedAt: new Date(),
          },
        });

        await tx.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        return {
          status: 'verified' as const,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            organizationId: user.organizationId,
          },
        };
      });

      if (verification.status === 'invalid_challenge') {
        const authSettings = await this.resolveAuthSettings();
        return {
          success: false,
          loginMode: authSettings.mode,
          error: 'Invalid challenge ID',
        };
      }

      if (verification.status === 'locked') {
        const authSettings = await this.resolveAuthSettings(verification.organizationId);
        return {
          success: false,
          loginMode: authSettings.mode,
          error: 'Challenge locked due to too many attempts',
        };
      }

      if (verification.status === 'expired') {
        const authSettings = await this.resolveAuthSettings(verification.organizationId);
        return {
          success: false,
          loginMode: authSettings.mode,
          error: 'Challenge expired',
        };
      }

      if (verification.status === 'used') {
        const authSettings = await this.resolveAuthSettings(verification.organizationId);
        return {
          success: false,
          loginMode: authSettings.mode,
          error: 'Challenge already used',
        };
      }

      if (verification.status === 'invalid_code') {
        const authSettings = await this.resolveAuthSettings(verification.organizationId);
        return {
          success: false,
          loginMode: authSettings.mode,
          error: 'Invalid code',
        };
      }

      if (verification.status === 'user_not_found') {
        const authSettings = await this.resolveAuthSettings(verification.organizationId);
        return {
          success: false,
          loginMode: authSettings.mode,
          error: 'User not found',
        };
      }

      if (verification.status !== 'verified' || !verification.user) {
        if (!verification.user) {
          this.log.error(
            { challengeId, status: verification.status },
            'Email challenge verified without user payload'
          );
        }
        const authSettings = await this.resolveAuthSettings(
          'organizationId' in verification ? verification.organizationId : undefined
        );
        return {
          success: false,
          loginMode: authSettings.mode,
          error: 'Verification failed',
        };
      }

      const user = verification.user;
      const roles = await getUserRoles(user.id, user.organizationId);
      const tokens = await this.generateTokens({
        userId: user.id,
        organizationId: user.organizationId,
        email: user.email,
        roles,
      });

      this.log.info({ userId: user.id, email: user.email }, 'User logged in with email code via challengeId');

      return this.buildSuccessResult(
        {
          id: user.id,
          email: user.email,
          name: user.name,
          organizationId: user.organizationId,
          roles,
        },
        tokens,
        'email_code'
      );
    } catch (error) {
      this.log.error({ error, challengeId }, 'Failed to verify email code by challengeId');
      const authSettings = await this.resolveAuthSettings();
      return {
        success: false,
        loginMode: authSettings.mode,
        error: 'Verification failed',
      };
    }
  }

  /**
   * Verify JWT token
   */
  async verifyToken(token: string): Promise<JWTPayload | null> {
    const localPayload = await this.verifyLocalToken(token);
    if (localPayload) {
      return localPayload;
    }

    return this.verifyFederatedToken(token);
  }

  private async verifyLocalToken(token: string): Promise<JWTPayload | null> {
    let decoded: unknown = null;
    try {
      decoded = jwt.verify(token, config.security.jwtSecret, this.getLocalJwtVerifyOptions());
    } catch (error) {
      // Invalid/expired local token => unauthenticated (not internal error)
      this.log.debug({ error }, 'Local JWT verification failed');
      return null;
    }

    if (!isJwtPayloadLike(decoded)) {
      return null;
    }

    const payload: JWTPayload = decoded;
    if (!this.hasExpectedTokenUse(payload, ACCESS_TOKEN_USE)) {
      return null;
    }

    if (this.shouldEnforceStrictClaims() && !hasRequiredTemporalClaims(payload)) {
      return null;
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
      });

      if (!user || user.status !== 'active') {
        return null;
      }

      const org = await prisma.organization.findUnique({
        where: { id: payload.organizationId },
      });

      if (!org || org.status !== 'active') {
        return null;
      }

      const roles = await getUserRoles(user.id, user.organizationId);

      return {
        userId: user.id,
        organizationId: user.organizationId,
        email: user.email,
        roles,
        token_use: ACCESS_TOKEN_USE,
        jti: payload.jti,
      };
    } catch (error) {
      // Database errors MUST bubble up so middleware returns 500 (not 401).
      this.log.error({ error }, 'Failed to verify local token against database');
      throw error;
    }
  }

  private async verifyFederatedToken(token: string): Promise<JWTPayload | null> {
    const federation = config.security.federation;
    if (!federation.enabled) {
      return null;
    }

    let decoded: unknown = null;
    try {
      decoded = await this.verifyFederatedTokenWithJwks(token);
      if (decoded === null && federation.allowSharedSecretFallback) {
        decoded = this.verifyFederatedTokenWithSharedSecret(token);
      }
      if (decoded === null) {
        return null;
      }
    } catch (error) {
      this.log.debug({ error }, 'Federated JWT verification failed');
      return null;
    }

    const parsedPayload = parseFederatedTokenPayload(decoded, federation.audience);
    if (!parsedPayload) {
      return null;
    }

    const normalizedRoles = Array.from(
      new Set(parsedPayload.roles.map((role) => normalizeFederatedRole(role)))
    );
    const payload: FederatedTokenPayload = {
      ...parsedPayload,
      roles: normalizedRoles.length > 0 ? normalizedRoles : ['viewer'],
      token_use: parsedPayload.token_use ?? ACCESS_TOKEN_USE,
    };

    if (!this.hasExpectedTokenUse(payload, ACCESS_TOKEN_USE)) {
      return null;
    }

    if (this.shouldEnforceStrictClaims() && !hasRequiredFederatedTemporalClaims(payload)) {
      return null;
    }

    try {
      // WHY: Ensure federated identities are persisted locally so downstream
      // domain/services that rely on local User/Organization records remain compatible.
      await this.ensureFederatedPrincipal(payload);
      return payload;
    } catch (error) {
      this.log.warn(
        {
          error,
          userId: payload.userId,
          organizationId: payload.organizationId,
          email: payload.email,
        },
        'Federated JWT rejected during principal synchronization'
      );
      return null;
    }
  }

  private async ensureFederatedPrincipal(payload: FederatedTokenPayload): Promise<void> {
    if (!isUuidLike(payload.userId) || !isUuidLike(payload.organizationId)) {
      throw new Error('federated_invalid_uuid_claims');
    }

    const federation = config.security.federation;
    const org = await prisma.organization.findUnique({
      where: { id: payload.organizationId },
    });

    if (!org) {
      if (!federation.autoProvisionOrganizations) {
        throw new Error('federated_organization_not_found');
      }

      await prisma.organization.create({
        data: {
          id: payload.organizationId,
          name: `Federated Organization ${payload.organizationId.slice(0, 8)}`,
          tier: 'enterprise',
          status: 'active',
          settings: {
            identityProvider: 'ailin-accounts',
            provisioningSource: 'federated-token',
          },
        },
      });
    } else if (org.status !== 'active') {
      throw new Error('federated_organization_inactive');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (user) {
      if (user.status !== 'active') {
        throw new Error('federated_user_inactive');
      }
      if (user.organizationId !== payload.organizationId) {
        throw new Error('federated_user_org_mismatch');
      }
      if (user.email.toLowerCase() !== payload.email) {
        throw new Error('federated_user_email_mismatch');
      }
      await this.syncFederatedRoles(user.id, payload.organizationId, payload.roles);
      return;
    }

    const emailCollision = await prisma.user.findUnique({
      where: { email: payload.email },
    });
    if (emailCollision) {
      throw new Error('federated_email_collision');
    }

    if (!federation.autoProvisionUsers) {
      throw new Error('federated_user_not_found');
    }

    const passwordHash = await bcrypt.hash(`federated-${nanoid(48)}`, SALT_ROUNDS);
    await prisma.user.create({
      data: {
        id: payload.userId,
        email: payload.email,
        name: payload.email.split('@')[0] || 'Federated User',
        passwordHash,
        organizationId: payload.organizationId,
        role: payload.roles[0] || config.security.rbac.defaultRole,
        status: 'active',
      },
    });
    await this.syncFederatedRoles(payload.userId, payload.organizationId, payload.roles);
  }

  /**
   * Public, on-behalf provisioning for the trusted internal (`/v1/internal/*`)
   * surface. Unlike the federated user-JWT path (verifyFederatedToken →
   * ensureFederatedPrincipal), the service-token middleware authenticates a
   * first-party M2M client and resolves the acting user from a header without
   * ever running principal synchronization — so a user who only ever reaches
   * ci through the on-behalf BFF is never materialized (→ 409
   * acting_user_not_provisioned). This reuses the EXACT ensureFederatedPrincipal
   * logic (org/user creation, status/email/org invariants, auto-provision flags,
   * role sync) so both entrypoints share one provisioning path and the
   * invariants `User.id == id-sub` / `organizationId == id-tenant_id` hold
   * identically. email/tenant are asserted by the trusted BFF; the service
   * token is the trust boundary (see internal-service-auth-middleware.ts).
   */
  public async ensureProvisionedOnBehalf(input: {
    userId: string;
    organizationId: string;
    email: string;
    roles?: string[];
  }): Promise<void> {
    await this.ensureFederatedPrincipal({
      userId: input.userId,
      organizationId: input.organizationId,
      email: input.email.trim().toLowerCase(),
      roles: input.roles ?? [],
    });
  }

  private async syncFederatedRoles(
    userId: string,
    organizationId: string,
    roles: string[]
  ): Promise<void> {
    const normalizedRoles = Array.from(new Set(roles.map((role) => normalizeFederatedRole(role))));
    let assignedRoles = 0;

    for (const role of normalizedRoles) {
      try {
        await assignRoleToUser(userId, organizationId, role);
        assignedRoles += 1;
      } catch (error) {
        this.log.warn({ error, userId, organizationId, role }, 'Failed to assign federated role');
      }
    }

    if (assignedRoles > 0) {
      return;
    }

    try {
      await assignRoleToUser(userId, organizationId, config.security.rbac.defaultRole);
    } catch (error) {
      this.log.error(
        { error, userId, organizationId, defaultRole: config.security.rbac.defaultRole },
        'Failed to assign fallback federated role'
      );
      throw error;
    }
  }

  /**
   * Verify API key
   */
  async verifyApiKey(apiKey: string): Promise<JWTPayload | null> {
    try {
      // Use quickHash for efficient lookup (same as api-key-rotation service)
      const { quickHash } = await import('@/services/api-key-rotation.js');
      const keyQuickHash = quickHash(apiKey);
      const keyPrefix = apiKey.substring(0, 15);

      const keys = await prisma.apiKey.findMany({
        where: {
          status: 'active',
          OR: [
            { quickHash: keyQuickHash },
            { keyPrefix },
          ],
        },
        include: {
          user: true,
        },
      });

      for (const key of keys) {
        const isValid = await bcrypt.compare(apiKey, key.keyHash);
        if (isValid) {
          // Scale-to-100k Phase 4 (issue #149): lastUsedAt is a
          // display/analytics field, not something that needs per-request
          // precision. Writing it on EVERY authenticated request made
          // api_keys a hot-row contention point at scale
          // (docs/audit/15-capacity-100k-assessment.md, Postgres axis).
          // Debounce — skip the write entirely if this key was already
          // marked used within API_KEY_LAST_USED_DEBOUNCE_MS — cuts write
          // volume on a hot key from ~1/request to ~1/debounce-window.
          // Still awaited (not fire-and-forget): callers may rely on
          // lastUsedAt being persisted by the time verifyApiKey resolves.
          const debounceMs = Number(process.env.API_KEY_LAST_USED_DEBOUNCE_MS) || 60_000;
          const staleEnough = !key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > debounceMs;
          if (staleEnough) {
            await prisma.apiKey.update({
              where: { id: key.id },
              data: { lastUsedAt: new Date() },
            });
          }

          const rolesFromMetadata = (() => {
            const metadata = key.metadata;
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
              return null;
            }

            const obj = metadata as Record<string, unknown>;
            const rolesValue = obj.roles;
            if (
              Array.isArray(rolesValue) &&
              rolesValue.length > 0 &&
              rolesValue.every((value) => typeof value === 'string')
            ) {
              return rolesValue;
            }

            const roleValue = obj.role;
            if (typeof roleValue === 'string' && roleValue.length > 0) {
              return [roleValue];
            }

            return null;
          })();

          // Security: API keys should NOT automatically gain privileges when a user's roles change.
          // We treat roles as a snapshot stored on the API key metadata; if missing, we backfill
          // once (based on current assignments) and then keep using the snapshot.
          let roles: string[] = [];
          if (rolesFromMetadata) {
            roles = rolesFromMetadata;
          } else {
            try {
              roles = await getUserRoles(key.userId, key.organizationId);
              
              // Backfill metadata with roles for future use
              if (roles.length > 0) {
                await prisma.apiKey
                  .update({
                    where: { id: key.id },
                    data: {
                      metadata: mergeJsonMetadata(key.metadata, {
                        roles,
                        rolesUpdatedAt: new Date().toISOString(),
                      }),
                    },
                  })
                  .catch(() => {
                    // Best-effort backfill; do not fail auth if metadata update fails.
                  });
              }
            } catch (error: unknown) {
              // If getUserRoles fails, try to get role from user.role field as fallback
              // This can happen when RBAC cache is stale or roles haven't been assigned yet
              const errorMessage = error instanceof Error ? error.message : String(error);
              this.log.warn({ error: errorMessage, userId: key.userId, organizationId: key.organizationId }, 'Failed to get user roles, using user.role as fallback');
              
              // Fallback to user.role field
              if (key.user && typeof key.user === 'object' && 'role' in key.user && typeof key.user.role === 'string') {
                roles = [key.user.role];
              } else {
                // Last resort: use default role
                roles = [config.security.rbac.defaultRole || 'viewer'];
              }
            }
          }

          return {
            userId: key.userId,
            organizationId: key.organizationId,
            email: key.user.email,
            roles,
            apiKeyId: key.id,
            apiKeyPermissions: (key.permissions && typeof key.permissions === 'object') 
              ? (key.permissions as Record<string, unknown>)
              : null,
          };
        }
      }

      return null;
    } catch (error) {
      this.log.error({ error }, 'Failed to verify API key');
      // Don't throw - return null to allow middleware to return 401 instead of 500
      // This ensures authentication failures return 401 (Unauthorized) instead of 500 (Internal Server Error)
      return null;
    }
  }

  /**
   * Revoke API key
   */
  async revokeApiKey(keyId: string, userId: string): Promise<boolean> {
    try {
      const key = await prisma.apiKey.findUnique({
        where: { id: keyId },
      });

      if (!key || key.userId !== userId) {
        return false;
      }

      await prisma.apiKey.update({
        where: { id: keyId },
        data: { status: 'revoked' },
      });
      // Best-effort: shrink the auth-cache staleness window below its TTL bound.
      // Dynamic import avoids a circular import (that middleware imports this service).
      const { invalidateApiKeyAuthCache } = await import('@/api/middleware/api-key-auth-middleware');
      invalidateApiKeyAuthCache(key.quickHash);

      return true;
    } catch (error) {
      this.log.error({ error }, 'Failed to revoke API key');
      return false;
    }
  }

  /**
   * Generate JWT tokens
   * SECURITY: Includes iss, aud, nbf, and jti (JWT ID) for validation and revocation
   * - issuer/audience: loaded from central typed config
   * - token_use: explicit claim separation between access and refresh tokens
   * - notBefore: current time (prevents replay with future-dated tokens)
   * - jti: unique token id per token (enables per-token revocation and replay detection)
   */
  async generateTokens(payload: {
    userId: string;
    organizationId: string;
    email: string;
    roles: string[];
  }): Promise<{ accessToken: string; refreshToken: string; expiresIn: string }> {
    const signingAlgorithm = config.security.jwtAlgorithms[0] as Algorithm;
    const baseSignOptions = {
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
      algorithm: signingAlgorithm,
      notBefore: 0,
    };
    const accessTokenOptions = {
      ...baseSignOptions,
      expiresIn: config.security.jwtExpiresIn,
    };

    const refreshTokenOptions = {
      ...baseSignOptions,
      expiresIn: config.security.jwtRefreshExpiresIn,
    };

    const accessPayload = { ...payload, jti: `at_${nanoid(24)}`, token_use: ACCESS_TOKEN_USE };
    const refreshPayload = { ...payload, jti: `rt_${nanoid(24)}`, token_use: REFRESH_TOKEN_USE };

    const accessToken = jwt.sign(accessPayload, config.security.jwtSecret as Secret, accessTokenOptions as SignOptions);
    const refreshToken = jwt.sign(refreshPayload, config.security.jwtSecret as Secret, refreshTokenOptions as SignOptions);

    return {
      accessToken,
      refreshToken,
      expiresIn: config.security.jwtExpiresIn,
    };
  }

  /**
   * Generate a short-lived internal access token (server-side use only).
   *
   * Used by the realtime WebSocket handler to authenticate internal HTTP
   * loopback calls (AilinRealtimeClient → /v1/chat/completions) on behalf of
   * a session-token-authenticated connection. This lets the WebSocket layer
   * operate without ever persisting or re-exposing the caller's long-lived
   * credential. The token must never be returned to a client.
   */
  async generateEphemeralAccessToken(
    payload: { userId: string; organizationId: string; email: string; roles: string[] },
    ttlSeconds = 300
  ): Promise<string> {
    const signingAlgorithm = config.security.jwtAlgorithms[0] as Algorithm;
    const signOptions = {
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
      algorithm: signingAlgorithm,
      notBefore: 0,
      expiresIn: ttlSeconds,
    };
    return jwt.sign(
      { ...payload, jti: `at_${nanoid(24)}`, token_use: ACCESS_TOKEN_USE },
      config.security.jwtSecret as Secret,
      signOptions as SignOptions
    );
  }

  /**
   * Build success result
   */
  private buildSuccessResult(
    user: { id: string; email: string; name: string; organizationId: string; roles: string[] },
    tokens: { accessToken: string; refreshToken: string; expiresIn: string },
    loginMode: AuthMode
  ): AuthResult {
    return {
      success: true,
      loginMode,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        organizationId: user.organizationId,
        roles: user.roles,
      },
      tokens,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(refreshToken: string): Promise<AuthResult> {
    const invalidToken = async (): Promise<AuthResult> => {
      const authSettings = await this.resolveAuthSettings();
      return {
        success: false,
        loginMode: authSettings.mode,
        error: 'Invalid or expired refresh token',
      };
    };

    try {
      const decoded = jwt.verify(
        refreshToken,
        config.security.jwtSecret,
        this.getLocalJwtVerifyOptions()
      );

      if (!isJwtPayloadLike(decoded)) {
        return invalidToken();
      }

      const payload: JWTPayload = decoded;
      if (!this.hasExpectedTokenUse(payload, REFRESH_TOKEN_USE)) {
        return invalidToken();
      }

      if (this.shouldEnforceStrictClaims() && !hasRequiredTemporalClaims(payload)) {
        return invalidToken();
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
      });

      if (!user || user.status !== 'active') {
        return invalidToken();
      }

      const org = await prisma.organization.findUnique({
        where: { id: payload.organizationId },
      });

      if (!org || org.status !== 'active') {
        return invalidToken();
      }

      const roles = await getUserRoles(user.id, user.organizationId);
      const tokens = await this.generateTokens({
        userId: user.id,
        organizationId: user.organizationId,
        email: user.email,
        roles,
      });

      const authSettings = await this.resolveAuthSettings(user.organizationId);
      const authUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        organizationId: user.organizationId,
        roles,
      };

      return this.buildSuccessResult(authUser, tokens, authSettings.mode);
    } catch (error) {
      this.log.debug({ error }, 'Refresh token verification failed');
      return invalidToken();
    }
  }

  /**
   * Generate API key for user.
   *
   * `expiresAt` is optional: omitting it produces a non-expiring key (matching
   * GitHub's "no expiration" classic-PAT path). The DB column is nullable.
   * Caller is responsible for surface-level validation (date is in the future,
   * within max-allowed window for the org's policy, etc.) — this method only
   * forwards the value.
   */
  async generateApiKey(
    userId: string,
    name: string,
    expiresAt?: Date | null,
  ): Promise<string | null> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        this.log.error({ userId }, 'User not found for API key generation');
        return null;
      }

      const { createApiKey } = await import('@/services/api-key-rotation.js');
      const { apiKey, plainKey } = await createApiKey({
        userId: user.id,
        organizationId: user.organizationId,
        name,
        ...(expiresAt ? { expiresAt } : {}),
      });

      this.log.info(
        { apiKeyId: apiKey.id, userId: user.id, expiresAt: expiresAt?.toISOString() ?? null },
        'API key generated',
      );
      return plainKey;
    } catch (error) {
      this.log.error({ error, userId }, 'Failed to generate API key');
      return null;
    }
  }

  /**
   * Change user password
   */
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<boolean> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        this.log.error({ userId }, 'User not found for password change');
        return false;
      }

      const isValidPassword = await bcrypt.compare(oldPassword, user.passwordHash);
      if (!isValidPassword) {
        this.log.warn({ userId }, 'Invalid old password provided');
        return false;
      }

      const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash: newPasswordHash },
      });

      await recordSecurityEvent({
        eventType: 'password_changed',
        severity: 'info',
        message: 'User password changed',
        userId: user.id,
        organizationId: user.organizationId,
      });

      this.log.info({ userId: user.id }, 'Password changed successfully');
      return true;
    } catch (error) {
      this.log.error({ error, userId }, 'Failed to change password');
      return false;
    }
  }

  /**
   * Resolve auth settings for organization
   */
  private async resolveAuthSettings(
    organizationId?: string
  ): Promise<{ mode: AuthMode; allowPasswordFallback: boolean }> {
    if (!organizationId) {
      return {
        mode: config.auth.defaultMode,
        allowPasswordFallback: config.auth.allowPasswordFallback,
      };
    }

    try {
      const settings = await organizationSettingsService.getSettings(organizationId);
      const authMode = (settings.auth?.defaultMode as AuthMode) || config.auth.defaultMode;
      const allowPasswordFallback =
        settings.auth?.allowPasswordFallback ?? config.auth.allowPasswordFallback;
      return { mode: authMode, allowPasswordFallback };
    } catch (error) {
      this.log.debug({ error, organizationId }, 'Failed to resolve auth settings, using default');
      return {
        mode: config.auth.defaultMode,
        allowPasswordFallback: config.auth.allowPasswordFallback,
      };
    }
  }
}

let authServiceInstance: AuthService | null = null;

export function getAuthService(): AuthService {
  // In tests, avoid leaking spies/mocks/state across suites by returning
  // a fresh service instance for each call.
  if (process.env.NODE_ENV === 'test') {
    return new AuthService();
  }

  if (!authServiceInstance) {
    authServiceInstance = new AuthService();
  }
  return authServiceInstance;
}
