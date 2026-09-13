// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Regression guard: unauthenticated cross-tenant privilege escalation via
 * POST /v1/auth/register.
 *
 * The vulnerable chain this suite pins shut (all of it was live in main):
 *
 *   1. `POST /v1/auth/register` is registered with NO preHandler, so it is
 *      reachable by anyone on the internet.
 *   2. It forwarded a caller-supplied `organizationId` straight into
 *      RegisterUserHandler.
 *   3. RegisterUserHandler joined that organization with no member check, no
 *      invite and no token — only an existence check.
 *   4. The new user was created with a hardcoded `UserRole.ADMIN` ("first user
 *      in org is admin"), which nothing verified, and no `user_roles` row.
 *   5. The route minted a JWT with a literal `roles: ['admin']` claim, plus an
 *      `|| ['admin']` fallback on the response.
 *   6. `POST /v1/auth/login` minted its roles claim from the legacy `users.role`
 *      column (via LoginUserHandler), so an account carrying the fingerprint of
 *      step 4 — `users.role='admin'` with zero `user_roles` rows — could still
 *      draw a signed admin token by logging in once, even after steps 1-5 were
 *      closed.
 *
 * Net: knowing an organization's UUID was enough to obtain an admin account
 * inside that tenant AND a signed token asserting admin. The token claim is
 * independent of the database, so it stayed valid for the token's lifetime
 * regardless of what the RBAC tables said.
 *
 * These tests are hermetic (no DB): the repositories, the RBAC data layer and
 * the Prisma client are mocked. The JWT is signed for real and decoded, so the
 * roles claim is asserted on the actual token bytes rather than on an
 * intermediate object.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'reflect-metadata';
import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Hermetic seams
// ---------------------------------------------------------------------------

const { getUserRolesMock, assignRoleToUserMock, ensureBaselineRoleMock, prismaUserFindUniqueMock } =
  vi.hoisted(() => ({
    getUserRolesMock: vi.fn<(userId: string, organizationId: string) => Promise<string[]>>(),
    assignRoleToUserMock:
      vi.fn<(userId: string, organizationId: string, roleName: string) => Promise<string[]>>(),
    ensureBaselineRoleMock:
      vi.fn<(userId: string, organizationId: string, reason: string) => Promise<string[]>>(),
    prismaUserFindUniqueMock: vi.fn(),
  }));

vi.mock('@/services/rbac-service', () => ({
  getUserRoles: getUserRolesMock,
  assignRoleToUser: assignRoleToUserMock,
  ensureBaselineRole: ensureBaselineRoleMock,
}));

vi.mock('@/database/client', () => ({
  prisma: {
    user: { findUnique: prismaUserFindUniqueMock },
  },
}));

vi.mock('@/di/container', () => ({
  initializeDIContainer: vi.fn(),
  getDIContainer: vi.fn(),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { container } from 'tsyringe';
import { config } from '@/config';
import { RegisterUserHandler } from '@/application/handlers/register-user.handler';
import { RegisterUserCommand } from '@/application/commands/register-user.command';
import { LoginUserHandler } from '@/application/handlers/login-user.handler';
import { RequestEmailChallengeHandler } from '@/application/handlers/request-email-challenge.handler';
import { LoginWithCodeHandler } from '@/application/handlers/login-with-code.handler';
import { UserEntity, UserRole } from '@/domain/entities/user.entity';
import { OrganizationEntity } from '@/domain/entities/organization.entity';
import { TierLevel } from '@/domain/value-objects/organization-tier';
import type { IUserRepository } from '@/domain/repositories/iuser-repository';
import type { IOrganizationRepository } from '@/domain/repositories/iorganization-repository';
import type { Email } from '@/domain/value-objects/email';

/** The tenant the attacker wants in to. Pre-existing, owned by somebody else. */
const VICTIM_ORG_ID = 'b3f1c2d4-5e6a-47b8-9c0d-1e2f3a4b5c6d';
const VICTIM_ORG_NAME = 'Victim Corp';

const PRIVILEGED_ROLES = ['admin', 'owner'];

// ---------------------------------------------------------------------------
// In-memory repository doubles
// ---------------------------------------------------------------------------

function makeVictimOrg(): OrganizationEntity {
  return OrganizationEntity.create({ name: VICTIM_ORG_NAME, tier: TierLevel.ENTERPRISE });
}

interface Doubles {
  userRepository: IUserRepository;
  organizationRepository: IOrganizationRepository;
  savedUsers: UserEntity[];
  savedOrganizations: OrganizationEntity[];
  victimOrg: OrganizationEntity;
}

function makeDoubles(): Doubles {
  const savedUsers: UserEntity[] = [];
  const savedOrganizations: OrganizationEntity[] = [];
  const victimOrg = makeVictimOrg();

  const userRepository = {
    findByEmail: async (_email: Email) => null,
    save: async (user: UserEntity) => {
      savedUsers.push(user);
    },
  } as unknown as IUserRepository;

  const organizationRepository = {
    // The victim organization exists and is findable by both selectors.
    findById: async (id: string) => (id === VICTIM_ORG_ID ? victimOrg : null),
    findByName: async (name: string) => (name === VICTIM_ORG_NAME ? victimOrg : null),
    save: async (organization: OrganizationEntity) => {
      savedOrganizations.push(organization);
    },
  } as unknown as IOrganizationRepository;

  return { userRepository, organizationRepository, savedUsers, savedOrganizations, victimOrg };
}

beforeEach(() => {
  getUserRolesMock.mockReset();
  assignRoleToUserMock.mockReset();
  ensureBaselineRoleMock.mockReset();
  prismaUserFindUniqueMock.mockReset();
  // The baseline grant succeeds and returns exactly what was granted.
  ensureBaselineRoleMock.mockImplementation(
    async (_userId, _organizationId, _reason) => [config.security.rbac.defaultRole]
  );
});

// ===========================================================================
// (a) + (b): the registration use case itself
// ===========================================================================

describe('RegisterUserHandler — cross-tenant join', () => {
  it('refuses to join a pre-existing organization named by organizationId', async () => {
    const doubles = makeDoubles();
    const handler = new RegisterUserHandler(doubles.userRepository, doubles.organizationRepository);

    const result = await handler.execute(
      new RegisterUserCommand(
        'attacker@evil.example',
        'SecureP@ssw0rd123',
        'Attacker',
        undefined,
        VICTIM_ORG_ID
      )
    );

    expect(result.success).toBe(false);
    // The victim tenant must be untouched: no user implanted anywhere.
    expect(doubles.savedUsers).toHaveLength(0);
    expect(result.organizationId).toBeUndefined();
  });

  it('refuses to join a pre-existing organization named by organizationName', async () => {
    const doubles = makeDoubles();
    const handler = new RegisterUserHandler(doubles.userRepository, doubles.organizationRepository);

    const result = await handler.execute(
      new RegisterUserCommand(
        'attacker2@evil.example',
        'SecureP@ssw0rd123',
        'Attacker',
        VICTIM_ORG_NAME,
        undefined
      )
    );

    expect(result.success).toBe(false);
    expect(doubles.savedUsers).toHaveLength(0);
  });

  it('never lands a registered user in an organization it did not create', async () => {
    const doubles = makeDoubles();
    const handler = new RegisterUserHandler(doubles.userRepository, doubles.organizationRepository);

    await handler.execute(
      new RegisterUserCommand(
        'attacker3@evil.example',
        'SecureP@ssw0rd123',
        'Attacker',
        undefined,
        VICTIM_ORG_ID
      )
    );

    for (const user of doubles.savedUsers) {
      expect(user.organizationId).not.toBe(doubles.victimOrg.id);
    }
  });
});

describe('RegisterUserHandler — role baseline', () => {
  it('does not write a privileged role on the user record', async () => {
    const doubles = makeDoubles();
    const handler = new RegisterUserHandler(doubles.userRepository, doubles.organizationRepository);

    const result = await handler.execute(
      new RegisterUserCommand('newcomer@example.com', 'SecureP@ssw0rd123', 'Newcomer')
    );

    expect(result.success).toBe(true);
    expect(doubles.savedUsers).toHaveLength(1);

    const persisted = doubles.savedUsers[0].toPersistence();
    expect(PRIVILEGED_ROLES).not.toContain(persisted.role);
    expect(persisted.role).toBe(UserRole.VIEWER);
  });

  it('creates a real user_roles grant for the configured baseline role', async () => {
    const doubles = makeDoubles();
    const handler = new RegisterUserHandler(doubles.userRepository, doubles.organizationRepository);

    const result = await handler.execute(
      new RegisterUserCommand('newcomer2@example.com', 'SecureP@ssw0rd123', 'Newcomer')
    );

    // The production fingerprint of the bug was `users.role='admin'` with ZERO
    // user_roles rows. A grant must actually be written.
    expect(ensureBaselineRoleMock).toHaveBeenCalledTimes(1);
    const [grantedUserId, grantedOrgId] = ensureBaselineRoleMock.mock.calls[0];
    expect(grantedUserId).toBe(result.userId);
    expect(grantedOrgId).toBe(result.organizationId);

    expect(result.roles).toEqual([config.security.rbac.defaultRole]);
  });

  it('still completes a legitimate signup: creates a fresh organization', async () => {
    const doubles = makeDoubles();
    const handler = new RegisterUserHandler(doubles.userRepository, doubles.organizationRepository);

    const result = await handler.execute(
      new RegisterUserCommand('founder@startup.example', 'SecureP@ssw0rd123', 'Founder')
    );

    expect(result.success).toBe(true);
    expect(result.userId).toBeTruthy();
    expect(doubles.savedOrganizations).toHaveLength(1);
    expect(result.organizationId).toBe(doubles.savedOrganizations[0].id);
    expect(result.organizationId).not.toBe(doubles.victimOrg.id);
  });

  it('fails the signup when the baseline grant errors (fail closed, no token minted)', async () => {
    const doubles = makeDoubles();
    ensureBaselineRoleMock.mockRejectedValue(new Error('roles table unavailable'));
    const handler = new RegisterUserHandler(doubles.userRepository, doubles.organizationRepository);

    const result = await handler.execute(
      new RegisterUserCommand('degraded@example.com', 'SecureP@ssw0rd123', 'Degraded')
    );

    // Fail closed: the signup is refused outright rather than proceeding with
    // no roles (which `getUserRoles` would then re-attempt and fail on again).
    expect(result.success).toBe(false);
    expect(result.roles).toBeUndefined();
  });
});

// ===========================================================================
// (a) + (c): the actual HTTP route, including the signed token
// ===========================================================================

interface StubHandlerState {
  executed: RegisterUserCommand[];
  result: {
    success: boolean;
    userId?: string;
    organizationId?: string;
    roles?: string[];
    error?: string;
  };
  /** What LoginUserHandler returns, i.e. what the `users.role` column says. */
  loginResult?: {
    success: boolean;
    userId?: string;
    email?: string;
    organizationId?: string;
    role?: string;
    roles?: string[];
    error?: string;
  };
}

async function buildServer(state: StubHandlerState): Promise<FastifyInstance> {
  container.reset();

  container.registerInstance(RegisterUserHandler, {
    execute: async (command: RegisterUserCommand) => {
      state.executed.push(command);
      return state.result;
    },
  } as unknown as RegisterUserHandler);

  container.registerInstance(LoginUserHandler, {
    execute: async () => state.loginResult ?? { success: false, error: 'not configured' },
  } as unknown as LoginUserHandler);

  // The route resolves these at registration time; it never calls them here.
  const inert = { execute: async () => ({ success: false }) };
  container.registerInstance(
    RequestEmailChallengeHandler,
    inert as unknown as RequestEmailChallengeHandler
  );
  container.registerInstance(LoginWithCodeHandler, inert as unknown as LoginWithCodeHandler);

  const server = Fastify({ logger: false });
  const { authRoutesClean } = await import('@/routes/auth/auth-routes-clean');
  await server.register(authRoutesClean);
  await server.ready();
  return server;
}

const NEW_USER_ID = '11111111-2222-3333-4444-555555555555';
const NEW_ORG_ID = '99999999-8888-7777-6666-555555555555';

function decodeRoles(accessToken: string): unknown {
  const decoded = jwt.verify(accessToken, config.security.jwtSecret, {
    issuer: config.security.jwtIssuer,
    audience: config.security.jwtAudience,
  }) as Record<string, unknown>;
  return decoded.roles;
}

describe('POST /v1/auth/register (route)', () => {
  // NOTE: main's defense against a caller-supplied organizationId is at the
  // HANDLER level (ORGANIZATION_JOIN_REQUIRES_INVITATION, pinned by the
  // handler tests above), not at the route: the route forwards the selector
  // and the handler refuses it. Route-level rejection was proposed in the
  // original branch but was not adopted.

  it('mints a JWT whose roles claim comes from real grants, not a literal admin', async () => {
    const state: StubHandlerState = {
      executed: [],
      result: { success: true, userId: NEW_USER_ID, organizationId: NEW_ORG_ID, roles: ['viewer'] },
    };
    getUserRolesMock.mockResolvedValue(['viewer']);
    prismaUserFindUniqueMock.mockResolvedValue({
      id: NEW_USER_ID,
      email: 'founder@startup.example',
      name: 'Founder',
      organizationId: NEW_ORG_ID,
    });
    const server = await buildServer(state);

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'founder@startup.example',
          password: 'SecureP@ssw0rd123',
          name: 'Founder',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);

      const claimedRoles = decodeRoles(body.tokens.accessToken);
      expect(claimedRoles).toEqual(['viewer']);
      expect(claimedRoles).not.toContain('admin');
      expect(claimedRoles).not.toContain('owner');

      // The response body must agree with the token, with no admin fallback.
      expect(body.user.roles).toEqual(['viewer']);
    } finally {
      await server.close();
    }
  });

  it('mints a token with NO roles when the RBAC tables hold no grants', async () => {
    const state: StubHandlerState = {
      executed: [],
      result: { success: true, userId: NEW_USER_ID, organizationId: NEW_ORG_ID, roles: [] },
    };
    // This is the exact pre-fix fallback that forged `['admin']`.
    getUserRolesMock.mockResolvedValue([]);
    prismaUserFindUniqueMock.mockResolvedValue({
      id: NEW_USER_ID,
      email: 'norole@startup.example',
      name: 'No Role',
      organizationId: NEW_ORG_ID,
    });
    const server = await buildServer(state);

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'norole@startup.example',
          password: 'SecureP@ssw0rd123',
          name: 'No Role',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);

      expect(decodeRoles(body.tokens.accessToken)).toEqual([]);
      expect(body.user.roles).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('still returns 201 with the granted roles when the post-registration grant read fails', async () => {
    const state: StubHandlerState = {
      executed: [],
      result: { success: true, userId: NEW_USER_ID, organizationId: NEW_ORG_ID, roles: ['viewer'] },
    };
    // The handler tolerates a failed baseline grant on purpose; `getUserRoles`
    // re-attempts it and rethrows. Unguarded, that turned a persisted
    // registration into a 500 the caller could never retry (409 forever).
    getUserRolesMock.mockRejectedValue(new Error('roles table unavailable'));
    prismaUserFindUniqueMock.mockResolvedValue({
      id: NEW_USER_ID,
      email: 'degraded@startup.example',
      name: 'Degraded',
      organizationId: NEW_ORG_ID,
    });
    const server = await buildServer(state);

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'degraded@startup.example',
          password: 'SecureP@ssw0rd123',
          name: 'Degraded',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(decodeRoles(body.tokens.accessToken)).toEqual(['viewer']);
      expect(body.user.roles).toEqual(['viewer']);
    } finally {
      await server.close();
    }
  });

  it('still completes a legitimate self-service signup end to end', async () => {
    const state: StubHandlerState = {
      executed: [],
      result: { success: true, userId: NEW_USER_ID, organizationId: NEW_ORG_ID, roles: ['viewer'] },
    };
    getUserRolesMock.mockResolvedValue(['viewer']);
    prismaUserFindUniqueMock.mockResolvedValue({
      id: NEW_USER_ID,
      email: 'founder@startup.example',
      name: 'Founder',
      organizationId: NEW_ORG_ID,
    });
    const server = await buildServer(state);

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'founder@startup.example',
          password: 'SecureP@ssw0rd123',
          name: 'Founder',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.user.id).toBe(NEW_USER_ID);
      expect(body.user.organizationId).toBe(NEW_ORG_ID);
      expect(body.tokens.accessToken).toBeTruthy();
      expect(body.tokens.refreshToken).toBeTruthy();
      expect(body.tokens.expiresIn).toBeGreaterThan(0);
      expect(state.executed).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

// ===========================================================================
// The surviving variant: the same outcome via POST /v1/auth/login
// ===========================================================================

describe('POST /v1/auth/login (route)', () => {
  const IMPLANTED_USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  function implantedAccountState(): StubHandlerState {
    return {
      executed: [],
      result: { success: false },
      // LoginUserHandler reads the legacy `users.role` column verbatim. This is
      // the production fingerprint of the register bug: role column says admin,
      // zero `user_roles` rows.
      loginResult: {
        success: true,
        userId: IMPLANTED_USER_ID,
        email: 'implanted@evil.example',
        organizationId: VICTIM_ORG_ID,
        role: 'admin',
        roles: ['admin'],
      },
    };
  }

  async function login(server: FastifyInstance) {
    return server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'implanted@evil.example', password: 'SecureP@ssw0rd123' },
    });
  }

  it('mints the roles claim from real grants, not from the legacy users.role column', async () => {
    const state = implantedAccountState();
    // What the RBAC tables actually say about this principal.
    getUserRolesMock.mockResolvedValue(['viewer']);
    const server = await buildServer(state);

    try {
      const response = await login(server);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      const claimedRoles = decodeRoles(body.tokens.accessToken);
      expect(claimedRoles).toEqual(['viewer']);
      expect(claimedRoles).not.toContain('admin');
      expect(claimedRoles).not.toContain('owner');
    } finally {
      await server.close();
    }
  });

  it('never lets the token claim and the response body disagree', async () => {
    const state = implantedAccountState();
    getUserRolesMock.mockResolvedValue(['viewer']);
    const server = await buildServer(state);

    try {
      const body = JSON.parse((await login(server)).body);

      // Disagreement between these two is the signature of two different
      // sources: the body from grants, the claim from the role column.
      expect(body.user.roles).toEqual(decodeRoles(body.tokens.accessToken));
      expect(body.user.roles).toEqual(['viewer']);
    } finally {
      await server.close();
    }
  });

  it('reads the grants for the principal being authenticated', async () => {
    const state = implantedAccountState();
    getUserRolesMock.mockResolvedValue(['viewer']);
    const server = await buildServer(state);

    try {
      await login(server);

      expect(getUserRolesMock).toHaveBeenCalledWith(IMPLANTED_USER_ID, VICTIM_ORG_ID);
    } finally {
      await server.close();
    }
  });
});
