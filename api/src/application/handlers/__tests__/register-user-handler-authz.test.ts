// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Security tests for RegisterUserHandler.
 *
 * `POST /v1/auth/register` is UNAUTHENTICATED and the request body carries
 * `organizationId` / `organizationName`. The handler used to join whatever
 * organization the caller named and stamp `users.role = 'admin'` on the new row
 * without ever creating a `user_roles` grant — i.e. any anonymous caller could
 * implant an "admin" into an arbitrary tenant. It was only neutered by the very
 * RBAC bug this change removes, so it has to be closed in the same commit.
 *
 * Two rules are enforced here, and both are absolute:
 *
 *   1. anonymous registration NEVER attaches to a pre-existing organization —
 *      not even an empty one. "Empty" is not a proxy for "unowned": a freshly
 *      provisioned tenant whose first user has not been materialized yet is
 *      exactly that shape (internal-acting-user.ts), so an anonymous caller who
 *      knows or guesses an id or a name would land inside a real customer's org.
 *
 *   2. anonymous registration NEVER grants a super-role. The account gets the
 *      configured BASELINE role. Minting `owner` (or `admin`) here would hand an
 *      unverified internet caller `secrets:manage`, `quotas:override`, a
 *      `superRole` that short-circuits `requirePermission`, and the
 *      `requireRole('admin','owner')`-gated `/v1/tools/*` shell surface.
 *      Owner is bootstrapped by an operator: `pnpm run rbac:grant-owner`.
 */

import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assignRoleToUserMock, ensureBaselineRoleMock } = vi.hoisted(() => ({
  assignRoleToUserMock: vi.fn(),
  ensureBaselineRoleMock: vi.fn(),
}));

vi.mock('@/services/rbac-service', () => ({
  assignRoleToUser: assignRoleToUserMock,
  ensureBaselineRole: ensureBaselineRoleMock,
}));

vi.mock('@/utils/sanitizers', () => ({
  sanitizeHTML: (value: string) => value,
}));

import {
  RegisterUserHandler,
  ORGANIZATION_JOIN_REQUIRES_INVITATION,
} from '@/application/handlers/register-user.handler';
import { RegisterUserCommand } from '@/application/commands/register-user.command';
import { UserRole } from '@/domain/entities/user.entity';

const EXISTING_ORG_ID = '63632c52-6e75-45a3-aac6-1d91008a216b';

interface SavedUser {
  id: string;
  role: string;
  organizationId: string;
}

function makeHandler(options: {
  orgById?: { id: string } | null;
  orgByName?: { id: string } | null;
}): { handler: RegisterUserHandler; saved: SavedUser[]; savedOrgs: string[] } {
  const saved: SavedUser[] = [];
  const savedOrgs: string[] = [];

  const userRepository = {
    findByEmail: vi.fn(async () => null),
    save: vi.fn(async (user: { id: string; role: string; organizationId: string }) => {
      saved.push({ id: user.id, role: user.role, organizationId: user.organizationId });
    }),
  };

  const organizationRepository = {
    findById: vi.fn(async () => options.orgById ?? null),
    findByName: vi.fn(async () => options.orgByName ?? null),
    save: vi.fn(async (organization: { id: string }) => {
      savedOrgs.push(organization.id);
    }),
  };

  const handler = new RegisterUserHandler(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    userRepository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    organizationRepository as any
  );

  return { handler, saved, savedOrgs };
}

beforeEach(() => {
  assignRoleToUserMock.mockReset();
  ensureBaselineRoleMock.mockReset();
  assignRoleToUserMock.mockResolvedValue(['owner']);
  ensureBaselineRoleMock.mockResolvedValue(['viewer']);
});

describe('RegisterUserHandler — anonymous cross-tenant implant', () => {
  it('refuses to join an existing organization named by id', async () => {
    const { handler, saved, savedOrgs } = makeHandler({ orgById: { id: EXISTING_ORG_ID } });

    const result = await handler.execute(
      new RegisterUserCommand(
        'attacker@example.com',
        'Sup3rStr0ng!Passw0rd',
        'Attacker',
        undefined,
        EXISTING_ORG_ID
      )
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(ORGANIZATION_JOIN_REQUIRES_INVITATION);
    // No user row, no organization, and certainly no grant.
    expect(saved).toHaveLength(0);
    expect(savedOrgs).toHaveLength(0);
    expect(assignRoleToUserMock).not.toHaveBeenCalled();
    expect(ensureBaselineRoleMock).not.toHaveBeenCalled();
  });

  it('refuses an EMPTY existing organization too (emptiness is not ownership)', async () => {
    // The org exists and has zero members — previously admitted. A tenant whose
    // first user has not been materialized is exactly this shape.
    const { handler, saved } = makeHandler({ orgById: { id: EXISTING_ORG_ID } });

    const result = await handler.execute(
      new RegisterUserCommand(
        'attacker@example.com',
        'Sup3rStr0ng!Passw0rd',
        'Attacker',
        undefined,
        EXISTING_ORG_ID
      )
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(ORGANIZATION_JOIN_REQUIRES_INVITATION);
    expect(saved).toHaveLength(0);
  });

  it('refuses to join an existing organization resolved by name', async () => {
    const { handler, saved, savedOrgs } = makeHandler({ orgByName: { id: EXISTING_ORG_ID } });

    const result = await handler.execute(
      new RegisterUserCommand(
        'attacker@example.com',
        'Sup3rStr0ng!Passw0rd',
        'Attacker',
        'Victim Corp'
      )
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(ORGANIZATION_JOIN_REQUIRES_INVITATION);
    expect(saved).toHaveLength(0);
    expect(savedOrgs).toHaveLength(0);
  });

  it('reports "Organization not found" for an id that does not exist', async () => {
    const { handler, saved } = makeHandler({ orgById: null });

    const result = await handler.execute(
      new RegisterUserCommand(
        'someone@example.com',
        'Sup3rStr0ng!Passw0rd',
        'Someone',
        undefined,
        EXISTING_ORG_ID
      )
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Organization not found');
    expect(saved).toHaveLength(0);
  });
});

describe('RegisterUserHandler — role provisioning', () => {
  it('never stamps ADMIN on the declared column', async () => {
    const { handler, saved } = makeHandler({});

    const result = await handler.execute(
      new RegisterUserCommand('founder@example.com', 'Sup3rStr0ng!Passw0rd', 'Founder')
    );

    expect(result.success).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0].role).toBe(UserRole.VIEWER);
    expect(saved[0].role).not.toBe(UserRole.ADMIN);
  });

  it('grants the BASELINE role — never owner — to the first user of a new organization', async () => {
    const { handler, savedOrgs } = makeHandler({});

    const result = await handler.execute(
      new RegisterUserCommand('founder@example.com', 'Sup3rStr0ng!Passw0rd', 'Founder')
    );

    expect(result.success).toBe(true);
    expect(savedOrgs).toHaveLength(1);

    // The structural point: this path must not be able to mint a super-role,
    // so it never calls the primitive that can.
    expect(assignRoleToUserMock).not.toHaveBeenCalled();
    expect(ensureBaselineRoleMock).toHaveBeenCalledTimes(1);
    const [, , assignedBy] = ensureBaselineRoleMock.mock.calls[0];
    expect(assignedBy).toBe('self-registration:new-org');

    // The route mints the JWT from this — never from a hardcoded assumption.
    expect(result.roles).toEqual(['viewer']);
  });

  it('creates a named organization when the name is free', async () => {
    const { handler, savedOrgs } = makeHandler({ orgByName: null });

    const result = await handler.execute(
      new RegisterUserCommand(
        'founder@example.com',
        'Sup3rStr0ng!Passw0rd',
        'Founder',
        'Brand New Corp'
      )
    );

    expect(result.success).toBe(true);
    expect(savedOrgs).toHaveLength(1);
    expect(ensureBaselineRoleMock).toHaveBeenCalledTimes(1);
    expect(assignRoleToUserMock).not.toHaveBeenCalled();
  });
});
